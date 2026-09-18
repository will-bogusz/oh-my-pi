import * as os from "node:os";
import * as path from "node:path";
import type { DesktopCapabilities, DesktopDisplay } from "@oh-my-pi/pi-natives";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { resizeImage } from "../../utils/image-resize";
import { ToolError, throwIfAborted } from "../tool-errors";
import type { ComputerBackend, ComputerBackendFactory } from "./backend";
import { type CuaDriver, type CuaDriverFactory, type CuaToolResult, spawnVendoredCuaDriver } from "./driver";
import {
	classifyWindow,
	describeInterruption,
	rosterInterruption,
	sampleWindowRoster,
	type WindowRosterSample,
} from "./interruption";
import { appWindows, isCaptureLeaseArtifact } from "./roster";
import { PERFORMABLE_ACTIONS, observedActions, semanticAction } from "./semantic-actions";
import type {
	ActionOptions,
	ComputerActionResult,
	ComputerBounds,
	ComputerElementSnapshot,
	ComputerImage,
	ComputerInterruption,
	ComputerLaunchOptions,
	ComputerObservation,
	ComputerRelatedWindow,
	ComputerOperationContext,
	ComputerTarget,
	ComputerWindowIdentity,
	ObserveOptions,
	WindowResolveOptions,
	WindowSelector,
} from "./types";

type Context = ComputerOperationContext;
type Wire = Record<string, unknown>;
interface Reply {
	result: CuaToolResult;
	data: Wire;
}
interface Binding {
	window: ComputerWindowIdentity;
	token: string;
	snapshotId: string;
	element: ComputerElementSnapshot;
	/** An app's own action names, each against the wire string that invokes it. */
	customActions: ReadonlyMap<string, string>;
	doubleClickAtCenter: boolean;
}
interface TreeNote {
	depth: number;
	text: string;
}
interface TreeRow {
	depth: number;
	element: ComputerElementSnapshot;
	notes?: readonly TreeNote[];
}
/**
 * A subrole that ends in its own role's stem says nothing the row has not
 * already printed — `AXRow`/`AXTableRow`, `AXWindow`/`AXStandardWindow` — and
 * a captured 1558-node Notes window carries 164 of those against 9 that name a
 * different control class, 3.1 kB of a 33 kB tree under a 50 kB cap. The
 * driver's own markdown drops them on the same predicate; the snapshot keeps
 * the raw value either way, so `find` is unaffected.
 */
function renderedSubrole(element: ComputerElementSnapshot): string {
	const subrole = element.subrole;
	if (subrole === undefined || subrole.endsWith(element.role.slice(2))) return "";
	return ` subrole=${subrole}`;
}
function treeRows(rows: readonly TreeRow[], indent: number): string {
	return rows
		.flatMap(({ depth, element, notes }) => [
			`${"  ".repeat(depth + indent)}- [${element.ref}] ${element.role} ${JSON.stringify(element.label)}${renderedSubrole(element)}${element.value !== undefined ? ` value=${JSON.stringify(element.value)}` : ""}${element.placeholder !== undefined ? ` placeholder=${JSON.stringify(element.placeholder)}` : ""}${element.description !== undefined ? ` description=${JSON.stringify(element.description)}` : ""}${element.help !== undefined ? ` help=${JSON.stringify(element.help)}` : ""}${element.enabled !== undefined ? ` enabled=${element.enabled}` : ""}${element.selected !== undefined ? ` selected=${element.selected}` : ""}${element.actions?.length ? ` actions=${JSON.stringify(element.actions)}` : ""}`,
			...(notes ?? []).map(note => `${"  ".repeat(note.depth + indent)}- ${note.text}`),
		])
		.join("\n");
}
const COLLAPSED_TREE_ROW = /^((?: {2})*)- (\d+ of \d+ rows are scrolled out of view and were not read)$/;
const INDEXED_TREE_ROW = /^(?: {2})*- \[(\d+)\] /;
function collapsedRowNotes(markdown: unknown): ReadonlyMap<number, TreeNote[]> {
	const notes = new Map<number, TreeNote[]>();
	if (typeof markdown !== "string") return notes;
	let anchor = -1;
	for (const line of markdown.split("\n")) {
		const indexed = INDEXED_TREE_ROW.exec(line);
		if (indexed) {
			anchor = Number(indexed[1]);
			continue;
		}
		const collapsed = COLLAPSED_TREE_ROW.exec(line);
		if (!collapsed) continue;
		const note = { depth: collapsed[1]!.length / 2, text: collapsed[2]! };
		const listed = notes.get(anchor);
		if (listed) listed.push(note);
		else notes.set(anchor, [note]);
	}
	return notes;
}
/**
 * One window's live capture. `image` is what the model was shown, sized to
 * the window's own point grid; `sdkWidth`/`sdkHeight` are the pixels the
 * driver delivered, which is the space its pixel rungs read coordinates in.
 * Actions are given window points and converted against both.
 */
interface Frame {
	window: ComputerWindowIdentity;
	image: ComputerImage;
	sdkWidth: number;
	sdkHeight: number;
}
interface PrimaryDisplay {
	uuid: string;
	nativeId: number;
	bounds: ComputerBounds;
	scale: number;
}
interface DesktopFrame {
	display: PrimaryDisplay;
	image: ComputerImage;
}
type VerificationStatus = "satisfied" | "unsatisfied" | "unknown";
interface VerificationResult {
	status: VerificationStatus;
	stable: boolean;
	elapsed_ms: number;
	samples: number;
	predicates: {
		index: number;
		status: VerificationStatus;
		unknown_reason: string | null;
		observed_json: string | null;
	}[];
}
export interface CuaSessionOptions {
	display?: string;
	/** Spawns the driver child; a dead child is replaced through this on the next call. */
	spawn?: CuaDriverFactory;
	/** WindowServer roster used for interruption checks; tests inject a quiet desktop. */
	sampleRoster?: () => WindowRosterSample;
	/**
	 * Host the driver child runs on. The driver is a local child, so this is
	 * `process.platform`; tests pin it to exercise the other backend.
	 */
	platform?: NodeJS.Platform;
}
function object(value: unknown, name: string): Wire {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolError(`Malformed Cua ${name}`);
	return value as Wire;
}
function number(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolError(`Malformed Cua ${name}`);
	return value;
}
function string(value: unknown, name: string): string {
	if (typeof value !== "string") throw new ToolError(`Malformed Cua ${name}`);
	return value;
}
/** Signal 0 probes existence without delivering anything; EPERM still means alive. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
/** CGWindow owner that hosts macOS CrashReporter alerts ("<app> quit unexpectedly"). */
const CRASH_ALERT_HOST = "usernotificationcenter";
/** The pid a failed `launch_app` reports in its error details, if any. */
function launchedPid(error: unknown): number | undefined {
	const pid = error instanceof ToolError ? error.context?.pid : undefined;
	return typeof pid === "number" ? pid : undefined;
}
function crashAlertGuidance(pid: number, alert: ComputerInterruption): string {
	return `Launched app (pid ${pid}) exited and ${describeInterruption(alert)} — a crash report. Do not relaunch; acquire {id:"${alert.windowId}",pid:${alert.pid}}, observe it, press its "Ignore" button, then tell the user.`;
}
function relatedWindows(value: unknown): readonly ComputerRelatedWindow[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new ToolError("Malformed Cua related windows");
	return Object.freeze(
		value.map(value => {
			const row = object(value, "related window");
			const pid = number(row.pid, "related window PID");
			const id = number(row.window_id, "related window ID");
			if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(id) || id <= 0 || row.relation !== "sheet")
				throw new ToolError("Malformed Cua related window identity");
			return Object.freeze({
				id: String(id),
				pid,
				title: string(row.title, "related window title"),
				relation: "sheet" as const,
			});
		}),
	);
}
function bounds(value: unknown): ComputerBounds {
	const row = object(value, "bounds");
	return Object.freeze({
		x: number(row.x, "bounds.x"),
		y: number(row.y, "bounds.y"),
		width: number(row.width ?? row.w, "bounds.width"),
		height: number(row.height ?? row.h, "bounds.height"),
	});
}
function sameBounds(a: ComputerBounds, b: ComputerBounds): boolean {
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
/** Whether the second rectangle is drawn wholly inside the first, in points. */
function encloses(outer: ComputerBounds, inner: ComputerBounds): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.width <= outer.x + outer.width &&
		inner.y + inner.height <= outer.y + outer.height
	);
}
function pointPair(point: unknown): [number, number] {
	if (Array.isArray(point) && point.length === 2) return [Number(point[0]), Number(point[1])];
	if (point !== null && typeof point === "object") {
		const row = point as Wire;
		if (Object.keys(row).length === 2 && typeof row.x === "number" && typeof row.y === "number")
			return [row.x, row.y];
	}
	throw new ToolError(
		`InvalidCoordinates: a point is [x, y] or { x, y } in points read off the last screenshot, not ${JSON.stringify(point)}`,
	);
}
function customActions(value: unknown): ReadonlyMap<string, string> {
	const actions = new Map<string, string>();
	if (!Array.isArray(value)) return actions;
	for (const listed of value) {
		if (typeof listed === "string") {
			if (listed) actions.set(listed, listed);
			continue;
		}
		if (listed === null || typeof listed !== "object") continue;
		const row = listed as Wire;
		const name = typeof row.name === "string" ? row.name.trim() : "";
		if (!name) continue;
		actions.set(name, typeof row.raw === "string" && row.raw ? row.raw : name);
	}
	return actions;
}
/**
 * Byte budget for one saved capture. Well above what a UI frame at point size
 * costs as JPEG, because `resizeImage` pays a tight budget in dimensions and
 * a capture that shrank to save bytes would no longer be its window's grid.
 */
const CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
/** A captured surface in points: a window's bounds, or a display's mode. */
interface Surface {
	width: number;
	height: number;
}
/**
 * Image pixels per point for one capture. Retina captures come in at the
 * backing scale and are brought back down to the surface's own point grid, so
 * what the model measures on the image is what an action takes. Only a
 * surface too large for the transport's frame budget goes below 1.
 */
function captureScale(context: Context, surface: Surface): number {
	if (!(surface.width > 0) || !(surface.height > 0)) return 1;
	const area = context.maxPixels > 0 ? Math.sqrt(context.maxPixels / (surface.width * surface.height)) : 1;
	return Math.min(1, context.maxWidth / surface.width, context.maxHeight / surface.height, area);
}
function primaryDisplay(data: Wire, capture = false): PrimaryDisplay | undefined {
	// Stock 0.23.2 has dimensions only. They cannot identify a display.
	if (data.display_identity === undefined || data.screen_origin === undefined) return undefined;
	const identity = object(data.display_identity, "display_identity");
	const origin = object(data.screen_origin, "screen_origin");
	const uuid = string(identity.uuid, "display UUID");
	const nativeId = number(identity.native_id, "display native_id");
	const width = number(capture ? data.screen_width : data.width, "screen width");
	const height = number(capture ? data.screen_height : data.height, "screen height");
	const scale = number(data.scale_factor, "screen scale_factor");
	if (!uuid || !Number.isSafeInteger(nativeId) || nativeId < 1 || width <= 0 || height <= 0 || scale <= 0)
		throw new ToolError("Malformed Cua primary display identity/geometry");
	return Object.freeze({
		uuid,
		nativeId,
		scale,
		bounds: Object.freeze({
			x: number(origin.x, "screen origin x"),
			y: number(origin.y, "screen origin y"),
			width,
			height,
		}),
	});
}
function sameDisplay(a: PrimaryDisplay, b: PrimaryDisplay): boolean {
	return a.uuid === b.uuid && a.nativeId === b.nativeId && a.scale === b.scale && sameBounds(a.bounds, b.bounds);
}
function windowArgs(window: Pick<ComputerWindowIdentity, "id" | "pid">): Wire {
	const id = Number(window.id);
	if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(window.pid) || window.pid < 1)
		throw new ToolError("Invalid exact Cua window identity");
	return { pid: window.pid, window_id: id };
}
/**
 * Names each backend does not know, mapped to the one it does. The macOS
 * driver's modifier set is `cmd|command|shift|option|alt|ctrl|control|fn`
 * (`tools/hotkey.rs`) and the X11 driver's is `shift|ctrl|control|alt|super|
 * meta|win` (`input/mod.rs: key_name_to_keysym`), so the same chord has two
 * spellings. An unknown name is not a refusal on the macOS keystroke path: the
 * modifier is dropped and the base key types on its own, which is how `super+a`
 * typed "a" into a name field during the bench.
 */
const MACOS_KEY_ALIASES: Readonly<Record<string, string>> = {
	super: "cmd",
	meta: "cmd",
	win: "cmd",
	windows: "cmd",
};
const X11_KEY_ALIASES: Readonly<Record<string, string>> = {
	cmd: "super",
	command: "super",
	windows: "super",
	option: "alt",
};
/** DOM key names; both drivers spell the arrows bare. */
const ARROW_KEY = /^arrow(up|down|left|right)$/;
function chordKeys(chord: string | string[], platform: NodeJS.Platform): string[] {
	const keys = Array.isArray(chord) ? [...chord] : chord.split("+").map(key => key.trim());
	if (!keys.length || keys.some(key => !key)) throw new ToolError("Invalid key chord");
	const aliases = platform === "darwin" ? MACOS_KEY_ALIASES : X11_KEY_ALIASES;
	return keys.map(key => {
		const lower = key.toLowerCase();
		return ARROW_KEY.exec(lower)?.[1] ?? aliases[lower] ?? key;
	});
}
function delivery(options: ActionOptions): Wire {
	return { delivery_mode: options.delivery ?? "background" };
}
function foreground(options: { delivery?: "background" | "foreground" }): void {
	if (options.delivery !== "foreground") throw new ToolError("This desktop operation requires delivery: 'foreground'");
}
/** The tools that deliver keystrokes: one delivery route per window, not per call. */
const KEYBOARD_TOOLS: Record<string, true> = { hotkey: true, press_key: true, type_text: true };
const DETECT_WINDOW_CHANGE_TOOLS: Record<string, true> = {
	click: true,
	drag: true,
	hotkey: true,
	press_key: true,
	scroll: true,
	set_value: true,
	type_text: true,
};
/**
 * Two rewrites of driver-authored text, both about a route the caller has to
 * be able to type. The driver advertises its own wire vocabulary in refusal
 * text and escalation advice (`delivery_mode: "foreground"`) where the prelude
 * takes `{ delivery: "foreground" }`; and it names a screenshot as the only
 * check for an unverified pixel dispatch, which on this surface is the
 * expensive one — an AX read answers the same question and the model followed
 * the sentence literally, spending a capture where `observe({ query })` would
 * have done. Rewriting at the boundary keeps both executable as written.
 * Structured details stay verbatim on the error's context.
 */
const DELIVERY_MODE_VOCABULARY = /delivery_mode\s*:\s*"(background|foreground)"/g;
const SCREENSHOT_CHECK = /not driver-verified\s*[—-]\s*confirm via screenshot/g;
function preludeVocabulary<T>(value: T): T {
	if (typeof value === "string")
		return value
			.replace(DELIVERY_MODE_VOCABULARY, '{ delivery: "$1" }')
			.replace(
				SCREENSHOT_CHECK,
				"not driver-verified — confirm with observe({ query }) or, on a pixel surface, a screenshot",
			) as T;
	if (Array.isArray(value)) return value.map(entry => preludeVocabulary(entry)) as T;
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, preludeVocabulary(entry)])) as T;
	return value;
}
function unsupported(operation: string): never {
	throw new ToolError(`Unsupported Cua operation: ${operation}`);
}
/** macOS rows whose `AXPress` needs the menu already open; see `#menuBarRoute`. */
const MENU_BAR_ROLES: Record<string, true> = { AXMenuBar: true, AXMenuBarItem: true };
/**
 * `invoke_menu` refuses with the failing segment's index and nothing else:
 * `path segment 1 was not found`. The titles it could not match are exactly
 * the ones an observation cannot show either — a closed menu reports its
 * items `AXEnabled=false`, so the driver withholds their element index and
 * `elements[]` carries only the few that are enabled while the menu is shut
 * (Contacts' File menu arrives as "Close All · Import… · Export", without the
 * "New Card" the caller was reaching for). Every row, display-only ones
 * included, is in `tree_markdown` of the same reply, so the menu bar is read
 * from there and the refusal names what the menus actually offer.
 */
const MENU_REFUSAL_SEGMENT = /path segment (\d+) (was not found|is ambiguous)/;
const MENU_ROW = /^(\s*)- (?:\[\d+\] )?(AXMenuBarItem|AXMenuBar|AXMenuItem|AXMenu)(?: "((?:[^"\\]|\\.)*)")?(?: |$)/;
/** Titles a refusal lists before it counts the rest. */
const MENU_TITLE_LIMIT = 40;
interface MenuNode {
	title: string;
	items: MenuNode[];
}
/**
 * The menu bar of one rendered driver tree. An untitled `AXMenu` container
 * between an item and its own items is transparent, exactly as the driver's
 * own path resolution treats it (`semantic_children`), so a node's `items`
 * are the titles a path segment can name under it.
 */
function menuBarTree(markdown: string): MenuNode[] {
	const roots: MenuNode[] = [];
	let base: number | undefined;
	const stack: { indent: number; node: MenuNode }[] = [];
	for (const line of markdown.split("\n")) {
		const row = MENU_ROW.exec(line);
		const indent = row ? row[1]!.length : 0;
		if (base === undefined) {
			if (row?.[2] !== "AXMenuBar") continue;
			base = indent;
			stack.push({ indent, node: { title: "", items: roots } });
			continue;
		}
		// The menu bar is one sibling of the window's own subtree; the first row
		// at or above its indent ends it, matched or not.
		if (!row || indent <= base) break;
		while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
		const parent = stack[stack.length - 1]!.node;
		if (row[2] === "AXMenu" || row[2] === "AXMenuBar") {
			stack.push({ indent, node: parent });
			continue;
		}
		const node: MenuNode = { title: (row[3] ?? "").trim(), items: [] };
		parent.items.push(node);
		stack.push({ indent, node });
	}
	return roots;
}
/** The items under one exactly-resolved path, or undefined when it does not resolve. */
function menuItemsAt(roots: readonly MenuNode[], path: readonly string[]): readonly MenuNode[] | undefined {
	let items: readonly MenuNode[] = roots;
	for (const segment of path) {
		const matches = items.filter(node => node.title === segment.trim());
		if (matches.length !== 1) return undefined;
		items = matches[0]!.items;
	}
	return items;
}
function menuTitles(items: readonly MenuNode[]): string {
	const listed = items.slice(0, MENU_TITLE_LIMIT).map(node => node.title || "(untitled)");
	return `${listed.join(" · ")}${items.length > listed.length ? ` · (+${items.length - listed.length} more)` : ""}`;
}
/**
 * The deepest level of the refused path the rendered tree actually carries,
 * and its items. The menu bar is the last sibling the walker reaches, so a
 * deeper walk does not buy submenu items — it spends the budget inside the
 * window and loses the bar entirely (Contacts: `max_depth: 3` renders the
 * whole bar in ~0.4 s, `max_depth: 5` gives up after 10 s without ever
 * reaching it). One level of items is what a refusal can reliably name.
 */
const MENU_WALK_DEPTH = 3;
function menuListing(
	roots: readonly MenuNode[],
	prefix: readonly string[],
): { trail: readonly string[]; items: readonly MenuNode[] } {
	for (let depth = prefix.length; depth > 0; depth--) {
		const items = menuItemsAt(roots, prefix.slice(0, depth));
		if (items?.length) return { trail: prefix.slice(0, depth), items };
	}
	return { trail: [], items: [] };
}
/**
 * What the menu bar offers where the path stopped resolving: the top-level
 * titles, plus the items of the deepest prefix the tree carries. Segments are
 * matched exactly, so the listing is the whole answer — ellipsis characters,
 * capitals and all.
 */
function menuRefusalNames(markdown: string, path: readonly string[], failed: number, ambiguous: boolean): string {
	const roots = menuBarTree(markdown);
	if (!roots.length) return "";
	const segment = path[failed] ?? "";
	const listing = menuListing(roots, path.slice(0, failed));
	const trail = listing.trail.join(" › ");
	return `Menu path ${JSON.stringify(path)} ${
		ambiguous ? `matches more than one ${JSON.stringify(segment)}` : `has no ${JSON.stringify(segment)}`
	}${failed ? ` under ${path.slice(0, failed).join(" › ")}` : " in the menu bar"}. Menus: ${menuTitles(roots)}.${
		listing.items.length ? ` ${trail}: ${menuTitles(listing.items)}.` : ""
	} Segment titles are matched exactly.`;
}
interface MenuItem {
	title: string;
	enabled?: boolean;
	submenu?: boolean;
	shortcut?: string;
}
function menuItems(value: unknown): MenuItem[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items: MenuItem[] = [];
	for (const listed of value) {
		if (listed === null || typeof listed !== "object") continue;
		const row = listed as Wire;
		if (typeof row.title !== "string") continue;
		items.push({
			title: row.title.trim(),
			...(typeof row.enabled === "boolean" ? { enabled: row.enabled } : {}),
			...(row.has_submenu === true ? { submenu: true } : {}),
			...(typeof row.shortcut === "string" && row.shortcut ? { shortcut: row.shortcut } : {}),
		});
	}
	return items;
}
function menuItemTitles(items: readonly MenuItem[]): string {
	const listed = items
		.slice(0, MENU_TITLE_LIMIT)
		.map(
			item =>
				`${item.title || "(untitled)"}${item.shortcut ? ` (${item.shortcut})` : ""}${
					item.enabled === false ? " (disabled)" : ""
				}${item.submenu ? " ›" : ""}`,
		);
	return `${listed.join(" · ")}${items.length > listed.length ? ` · (+${items.length - listed.length} more)` : ""}`;
}
function menuSubmenuListing(path: readonly string[], items: readonly MenuItem[]): string {
	const leaf = items.find(item => !item.submenu) ?? items[0]!;
	return `${path.join(" › ")} is a submenu; nothing was invoked. Its items: ${menuItemTitles(items)}. Invoke one with win.menu(${JSON.stringify([...path, leaf.title])}, { delivery: "foreground" }); a name marked › lists its own items the same way.`;
}
function menuRefusalItems(
	path: readonly string[],
	failed: number,
	items: readonly MenuItem[],
	ambiguous: boolean,
): string {
	const trail = path.slice(0, failed);
	return `Menu path ${JSON.stringify(path)} ${
		ambiguous
			? `matches more than one ${JSON.stringify(path[failed] ?? "")}`
			: `has no ${JSON.stringify(path[failed] ?? "")}`
	}${trail.length ? ` under ${trail.join(" › ")}` : " in the menu bar"}. ${
		trail.length ? trail.join(" › ") : "Menus"
	}: ${menuItemTitles(items)}. Segment titles are matched exactly.`;
}
/**
 * The driver's own escalation advice: the rung it believes would land, on a
 * reply whose text does not say so. A background chord always answers
 * `Pressed cmd+n on pid 92857.` with `escalation: { target: "foreground",
 * reason: "delivery_failed" }` in the structured payload alone — the bench
 * read the sentence, watched nothing happen, and never learned the route.
 * Only targets this surface can type are named; anything else stays in
 * `data` rather than becoming advice the caller cannot follow.
 */
const ESCALATION_ROUTES: Readonly<Record<string, (text: string) => string>> = {
	foreground: () => 'the route it names is { delivery: "foreground" } — re-run the action that way',
	pixel: pixelEscalation,
	snapshot: () => "observe the window again (win.observe()) and address the row that walk mints for this control",
};
/** The untyped `recommended` spelling of a contract target, keyed on what the driver still writes. */
const ESCALATION_TARGET_ALIASES: Readonly<Record<string, string>> = { get_window_state: "snapshot" };
/**
 * What to say instead once the session has taken the rung over: naming
 * `{ delivery: "foreground" }` told the caller to qualify the re-run, and an
 * explicit rung wins over the remembered one by design, so the advice asked
 * for the one call shape that cannot consume what was just recorded. This
 * line survives a reply that already spells the rung, where a restatement
 * would be dropped: the driver's own sentence instructs exactly the bypass,
 * so the correction is the point rather than noise.
 */
const ROUTE_ALREADY_TAKEN = "re-run it as-is; this window's keystrokes now take the foreground route";
/**
 * The driver watches a dispatched action for a fixed window and calls a
 * target that did not move in time a suspected no-op. On Contacts that window
 * expired before the app opened the menu the press had already asked for, and
 * the coordinate rung the escalation names is the one that app swallows — the
 * run that recovered simply observed again. So the advice leads with the
 * cheap route that worked and keeps pixels as the fallback, and it quotes the
 * window the driver actually watched, since that is the whole basis of the
 * doubt. Both spellings appear in the wild: the released driver says "no
 * change observed within N ms", ours says how long it watched.
 */
const NO_CHANGE_WINDOW = /watched for (\d+) ms after the dispatch|no change observed within (\d+) ms/;
function pixelEscalation(text: string): string {
	const window = NO_CHANGE_WINDOW.exec(text);
	const ms = window?.[1] ?? window?.[2];
	const doubt = ms ? `the driver saw no change within ${ms} ms` : "the driver could not confirm this landed";
	return `${doubt} — observe() once; if the tree is unchanged, click the control's own centre off a screenshot`;
}
function escalationTarget(data: Wire): string | undefined {
	const escalation = data.escalation;
	if (!escalation || typeof escalation !== "object" || Array.isArray(escalation)) return undefined;
	const row = escalation as Wire;
	// `target` is the contract's field; `recommended` is what the untyped
	// replies still write, and both name the same rung.
	const target = typeof row.target === "string" ? row.target : row.recommended;
	if (typeof target !== "string") return undefined;
	return ESCALATION_TARGET_ALIASES[target] ?? target;
}
function escalationRoute(data: Wire, text: string, remembered: boolean): string | undefined {
	const target = escalationTarget(data);
	if (target === undefined) return undefined;
	const route = remembered ? ROUTE_ALREADY_TAKEN : ESCALATION_ROUTES[target]?.(text);
	if (route === undefined || (!remembered && text.includes(`delivery: "${target}"`))) return undefined;
	const escalation = data.escalation as Wire;
	const reason = typeof escalation.reason === "string" ? escalation.reason : undefined;
	return `⚠️ The driver escalates this action${reason ? ` (${reason})` : ""}: ${route}.`;
}
/** The rung a reply names, in either shape the drivers report it: a bare string or `{ mode }`. */
function evidenceDelivery(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const mode = (value as Wire).mode;
	return typeof mode === "string" ? mode : undefined;
}
/**
 * What the driver reported about an action that threw, and only that: the
 * route it took, the rung it delivered on, what it believes happened, and the
 * rung it would escalate to. Each field is printed when the reply carries it.
 * A defaulted line said `route=cua-sdk delivery=background effect=refused` of
 * a `win.menu` refusal that named no route, was dispatched by a tool with no
 * rung field at all, and reported no effect — three observations the reply
 * never made. The rung the call asked for is a fact about the call, not about
 * the delivery, and says so. Nothing is walked to produce this.
 */
function actionEvidence(details: unknown, args: Wire): string | undefined {
	const data = details !== null && typeof details === "object" && !Array.isArray(details) ? (details as Wire) : {};
	const route = typeof data.route === "string" ? data.route : typeof data.path === "string" ? data.path : undefined;
	const delivered = evidenceDelivery(data.delivery);
	const requested = typeof args.delivery_mode === "string" ? args.delivery_mode : undefined;
	const target = escalationTarget(data);
	const fields = [
		route === undefined ? undefined : `route=${route}`,
		delivered === undefined
			? requested === undefined
				? undefined
				: `requested=${requested}`
			: `delivery=${delivered}`,
		typeof data.effect === "string" ? `effect=${data.effect}` : undefined,
		target !== undefined && ESCALATION_ROUTES[target] !== undefined ? `escalation=${target}` : undefined,
	].filter(field => field !== undefined);
	return fields.length ? `Evidence: ${fields.join(" ")}` : undefined;
}
const FOCUS_HOLDING_REFUSALS: Record<string, true> = {
	delivery_failed: true,
	menu_path_unavailable: true,
	same_pid_keyboard_ambiguity: true,
};
function refusalDetails(details: unknown): Wire {
	const data = details !== null && typeof details === "object" && !Array.isArray(details) ? (details as Wire) : {};
	const nested = data.refusal;
	if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return data;
	return { ...data, ...(nested as Wire) };
}
/**
 * `set_value` writes `AXValue` and then drives the app's own end-of-edit
 * gesture, reporting in `committed` whether the value survived it. Only that
 * flag separates a written field from a lost one: a value the app's editing
 * pipeline never accepted still reads back correctly through the AX tree, and
 * a Save-panel filename written that way was discarded. The flag is
 * contract-optional — a driver that reports none renders nothing — and the
 * driver's own reason sentence rides along with it when there is one.
 */
const NOT_COMMITTED_REASON = /not committed:\s*([^.]+)/i;
function commitNote(committed: boolean, text: string): string {
	if (committed) return "committed=true";
	const reason = NOT_COMMITTED_REASON.exec(text)?.[1]?.trim();
	return `committed=false — ${reason ?? "the driver reported no reason"}. The app may still hold its own value; read it back before relying on it.`;
}
/**
 * A partial `type_text` is the one refusal that still wrote: the driver names
 * how many characters it delivered and the suffix to retry, so the field holds
 * neither its old value nor the requested one.
 */
const INCOMPLETE_TYPING = "type_text_incomplete";
const UNPROBED_DRAG =
	"Delivered; the driver reported no effect evidence for this drag — observe the window to confirm it moved anything.";

/**
 * Maps computer operations onto `cua-driver` tools over one supervised child.
 * All desktop work, including capture, happens in the driver process.
 *
 * Operations are serialized per session. Aborting an operation's signal
 * cancels the driver call cooperatively and the session stays usable; a
 * child that exits (crash, or killed after ignoring a cancel) is respawned by
 * the next operation, with element refs and pixel frames invalidated.
 *
 * Coordinates are points, never capture pixels: window actions take
 * window-local points and desktop actions display points, which is also the
 * grid every capture is delivered on and the grid element bounds are
 * reported in. The driver's own rungs read the frame it delivered, so each
 * dispatch converts points into that frame.
 *
 * Driver window hover is only cursor decoration and focused-window identity is
 * unavailable. Display enumeration/capture/input cover the primary display only.
 * Desktop pixels require the driver's display identity/origin extension; stock
 * observations remain usable as images but never authorize coordinate dispatch.
 * Desktop drags are straight two-point gestures. Desktop scroll accepts only
 * one-axis multiples of 120 pixels (the driver's line notch), up to 50 notches.
 */
export class CuaComputerSession implements ComputerBackend {
	readonly #spawn: CuaDriverFactory;
	readonly #sampleRoster: () => WindowRosterSample;
	readonly #platform: NodeJS.Platform;
	readonly #elements = new Map<string, Binding>();
	readonly #frames = new Map<string, Frame>();
	/**
	 * The file each observed window said it was showing, by window id. Only
	 * `get_window_state` reads `AXDocument`, so this is what acquisition knows
	 * about a candidate without walking it again.
	 */
	readonly #documents = new Map<string, string>();
	/**
	 * Attached sheets by window id, each against the window that reported it.
	 * Only `get_window_state` sees the relation — a sheet is an ordinary
	 * CGWindow row of its app — so acquisition reads it out of what the last
	 * observation of the parent said, and the parent replaces its own entries
	 * every time it is observed.
	 */
	readonly #sheets = new Map<string, { parent: string; title: string }>();
	readonly #staleSheetRefs = new Map<string, string>();
	/**
	 * Each pid's on-screen ids as of its last observation, its rows as of the
	 * last roster read, and the driver's capture-lease windows, which are nobody's.
	 */
	readonly #observedRoster = new Map<number, ReadonlySet<string>>();
	readonly #lastRoster = new Map<number, readonly ComputerWindowIdentity[]>();
	#leaseArtifacts: ReadonlySet<string> = new Set();
	/**
	 * What each window's writes left unproven, one sentence per write, in the
	 * order they were made. The next read of that window reports and clears them.
	 */
	readonly #writes = new Map<string, Set<string>>();
	/**
	 * Windows whose keyboard delivery the driver escalated to foreground. The
	 * escalation is a fact about the window — a surface whose background route
	 * dropped the last chord drops the next one too — but the driver attaches
	 * it per dispatch, so every callsite was told again: five escalations in
	 * one bench task, obeyed 5/5, three of them repeating what the same run
	 * had already been told. Cleared when the window is acquired again, or
	 * when a foreground dispatch on it is refused.
	 */
	readonly #escalatedKeyboard = new Set<string>();
	readonly capabilities: DesktopCapabilities & Record<string, unknown>;
	#driver: CuaDriver;
	/**
	 * Monotonic source of public element refs (`n1`, `n2`, …). Never reset: a
	 * respawn clears `#elements`, and a counter that restarted would hand a
	 * dead ref from the previous child a live binding in the new one.
	 */
	#refSeq = 0;
	#tail: Promise<unknown> = Promise.resolve();
	/** Signal of the operation currently holding the serialized tail. */
	#signal?: AbortSignal;
	#closed = false;
	#closing?: Promise<void>;
	#desktopFrame?: DesktopFrame;

	private constructor(
		driver: CuaDriver,
		spawn: CuaDriverFactory,
		sampleRoster: () => WindowRosterSample,
		permissions: Wire,
		platform: NodeJS.Platform,
	) {
		this.#driver = driver;
		this.#spawn = spawn;
		this.#sampleRoster = sampleRoster;
		this.#platform = platform;
		// The two backends answer `check_permissions` with disjoint keys:
		// macOS reports TCC grants (`accessibility`, `screen_recording`),
		// Linux reports reachability (`x11`, `wayland`, `atspi`, `xsend_event`).
		// Nothing is synthesized: an unreported key stays false.
		const linux = platform === "linux";
		const x11 = permissions.x11 === true;
		const atspi = permissions.atspi === true;
		const accessibility = permissions.accessibility === true;
		const capture = linux ? x11 : permissions.screen_recording === true;
		const input = linux ? x11 : accessibility;
		const ax = linux ? atspi : accessibility;
		// X11 has no permission model; reachability is the booleans above.
		const state = (granted: boolean): string => (linux ? "not-applicable" : granted ? "granted" : "not-granted");
		this.capabilities = Object.freeze({
			backend: "cua-driver",
			displayServer: linux ? (permissions.wayland === true ? "wayland" : "x11") : "macos",
			capture,
			input,
			ax,
			backgroundWindowInput: linux ? atspi || x11 : accessibility,
			deliveryModes: ["background", "foreground"],
			capturePermission: state(capture),
			inputPermission: state(input),
			axPermission: state(ax),
			displayCount: 0,
			permissions: Object.freeze({ ...permissions }),
			driver: Object.freeze({ version: driver.version, transport: "mcp --direct" }),
			displayCountKnown: false,
			displayEnumeration: "primary only; other display count is unknown",
			captureScope: "exact window or primary display",
			coordinates:
				"window actions take window-local points, desktop actions display points; captures are delivered on that same grid, so a coordinate read off a screenshot needs no arithmetic",
			desktopCoordinates: linux
				? "unavailable; the Linux driver reports no display identity, so desktop-root input is refused"
				: "primary display only; requires current UUID, native id, origin, size and scale metadata",
			desktopDrag: "exactly two points; the driver interpolates one straight drag",
			windowDrag:
				"foreground only; each end is an element ref (needs its own observed bounds and a current window screenshot) or a window point; durationMs integer 0–10000 (default 500), steps integer 1–200 (default 20); background drag is unavailable",
			desktopScroll: "one axis per action; pixel deltas must be multiples of 120, up to 6000",
			backgroundInput: linux
				? 'toolkit-dependent; a typed background_unavailable refusal means nothing was dispatched — retry with { delivery: "foreground" }'
				: "best effort; use observation backgroundInput and fresh evidence, never assume delivery",
			elementRefLifetime:
				"Exact driver snapshot, PID and window; re-observe after StaleRef. AX traversals can evict driver snapshots.",
			unsupported: linux
				? ["window hover", "focusedWindow", "displays", "desktop-root input", "interruption detection"]
				: ["window hover", "focusedWindow", "secondary display enumeration/capture/input"],
		});
	}

	static async create(options: CuaSessionOptions = {}): Promise<CuaComputerSession> {
		if (options.display && !["all", "primary"].includes(options.display))
			unsupported(`display selector '${options.display}'`);
		const platform = options.platform ?? process.platform;
		const spawn = options.spawn ?? spawnVendoredCuaDriver;
		const driver = await spawn();
		try {
			const permissions = await driver.callTool("check_permissions", { prompt: false });
			if (permissions.isError) throw new ToolError(permissions.text);
			const reported = object(JSON.parse(permissions.structuredJson ?? "{}"), "permissions");
			// Without an X11 connection the Linux driver answers every window
			// call with an opaque X error; its own report says what is missing.
			if (platform === "linux" && reported.x11 !== true) throw new ToolError(permissions.text);
			return new CuaComputerSession(driver, spawn, options.sampleRoster ?? sampleWindowRoster, reported, platform);
		} catch (error) {
			await driver.kill({ force: true });
			throw error;
		}
	}

	/** The live child, replacing one that exited. Cached refs and frames die with the old child. */
	async #liveDriver(): Promise<CuaDriver> {
		if (this.#driver.alive) return this.#driver;
		logger.warn("cua-driver child is gone; respawning", { previousPid: this.#driver.pid });
		this.#driver = await this.#spawn();
		this.#elements.clear();
		this.#frames.clear();
		this.#documents.clear();
		this.#desktopFrame = undefined;
		return this.#driver;
	}

	#guard(context: Context): void {
		throwIfAborted(context.signal);
		if (this.#closed) throw new ToolError("Computer session is closed");
	}
	/**
	 * The only place interruption detection is decided. Every caller — the
	 * pre-dispatch gate, observations, action replies and `launch`'s crash
	 * watch — goes through here, and off macOS it is always "no sample".
	 *
	 * The WindowServer roster is a macOS concept: `pi-natives` has no other
	 * implementation, and X11 has no equivalent of a layer-1000 SecurityAgent
	 * window. Leaving the gate to an empty roster would state the same
	 * behaviour by accident; this states it.
	 */
	#roster(): WindowRosterSample | undefined {
		return this.#platform === "darwin" ? this.#sampleRoster() : undefined;
	}
	#interruption(): ComputerInterruption | undefined {
		const sample = this.#roster();
		return sample && rosterInterruption(sample);
	}
	/**
	 * Pre-dispatch gate for every mutation. While a system prompt owns the
	 * screen an action either lands invisibly behind it (background routes are
	 * pid-addressed and AX writes bypass the WindowServer) or lands *in* it
	 * (foreground delivery posts to the HID tap, which is the password field).
	 * Both are wrong, so nothing is dispatched.
	 *
	 * One exemption: an AX action aimed at a crash alert this session caused
	 * (`#crashAlerts`, recorded by `launch`) — that is how the agent presses
	 * "Ignore" on the report for its own crashed app instead of leaving it
	 * on the user's screen.
	 */
	#refuseWhenInterrupted(name: string, crashAlertTarget?: string): void {
		const interruption = this.#interruption();
		if (!interruption) return;
		if (
			crashAlertTarget !== undefined &&
			interruption.windowId === crashAlertTarget &&
			interruption.app.trim().toLowerCase() === CRASH_ALERT_HOST &&
			this.#crashAlerts.has(crashAlertTarget)
		)
			return;
		throw new ToolError(
			`Interrupted: ${describeInterruption(interruption)}. '${name}' was not dispatched; tell the user what is asking and wait for them. Never type, click or send keys at it. Reading is still allowed: acquire {id:"${interruption.windowId}",pid:${interruption.pid}} and observe it to see what it says — the system alert host also carries crash reports and other alerts, and the user needs to know which one it is.`,
			{ interruptedBy: interruption },
		);
	}
	/** Window ids of CrashReporter alerts raised by apps this session launched; see `launch`. */
	readonly #crashAlerts = new Set<string>();
	/**
	 * `crashAlertTarget`: only the AX semantic route (`perform`) passes its
	 * window id, so the crash-alert exemption can never reach a keystroke,
	 * pointer or value write — those routes have no business on any alert.
	 */
	async #schedule<T>(
		context: Context,
		name: string,
		mutation: boolean,
		dispatch: () => Promise<T>,
		crashAlertTarget?: string,
	): Promise<T> {
		if (mutation && context.readOnly) throw new ToolError(`read-only run: '${name}' requires read_only: false`);
		this.#guard(context);
		const run = async (): Promise<T> => {
			this.#guard(context);
			if (mutation) this.#refuseWhenInterrupted(name, crashAlertTarget);
			this.#signal = context.signal;
			try {
				const value = await dispatch();
				throwIfAborted(context.signal);
				return value;
			} finally {
				this.#signal = undefined;
			}
		};
		const pending = this.#tail.then(run, run);
		this.#tail = pending.catch(() => undefined);
		return pending;
	}
	async #call(name: string, args: Wire): Promise<Reply> {
		const result = await (await this.#liveDriver()).callTool(name, args, this.#signal);
		if (result.isError) {
			let details: Wire | undefined;
			try {
				details = result.structuredJson ? object(JSON.parse(result.structuredJson), `${name} error`) : undefined;
			} catch {
				// Malformed optional details must not replace the original SDK failure.
			}
			const code = result.errorCode ?? (typeof details?.error === "string" ? details.error : "CuaError");
			// A typed refusal (`background_unavailable`, `foreground_unavailable`)
			// carries the driver's own reason and the one escalation that works.
			// Both survive verbatim; only the route is restated in the vocabulary
			// the caller can actually type. Nothing is retried here.
			throw new ToolError(
				`${code}: ${preludeVocabulary(result.text)}${details ? `\nDetails: ${JSON.stringify(preludeVocabulary(details))}` : ""}`,
				details,
			);
		}
		return { result, data: object(JSON.parse(result.structuredJson ?? "{}"), `${name} result`) };
	}
	/**
	 * Cua enumerates CGWindow layer 0 only, which is exactly where the system
	 * panels are not: a keychain prompt is a layer-1000 SecurityAgent window.
	 * The WindowServer sample supplies `kind` for the rows Cua does report and
	 * contributes the classified rows it cannot see, with their real geometry —
	 * Cua reports a placeholder rectangle and `onScreen: false` for the
	 * off-screen ghost windows those owners also keep.
	 */
	#windowRoster(data: Wire, selector: WindowSelector, sample?: WindowRosterSample): ComputerWindowIdentity[] {
		if (!Array.isArray(data.windows)) throw new ToolError("Malformed Cua window roster");
		const onScreen = new Map((sample?.windows ?? []).map(window => [window.id, window]));
		const windows: ComputerWindowIdentity[] = [];
		const artifacts = new Set<string>();
		for (const value of data.windows) {
			const row = object(value, "window");
			// X11 reports a titled window whose owner set no `_NET_WM_PID` with
			// `pid: null` (contract-legal). Every driver call is pid-addressed,
			// so such a row names nothing this session can observe or act on.
			if (row.pid === null) continue;
			const window = {
				id: String(number(row.window_id, "window_id")),
				pid: number(row.pid, "pid"),
				app: string(row.app_name, "app_name"),
				title: string(row.title, "title"),
				bounds: bounds(row.bounds),
				onScreen: typeof row.is_on_screen === "boolean" ? row.is_on_screen : undefined,
				// Contract-optional and absent on Linux; only macOS stacks system
				// panels on a layer. Unknown stays unknown.
				...(typeof row.layer === "number" ? { layer: row.layer } : {}),
				// The driver's own stacking report, higher towards the front. Null
				// means it has none, and no order may be read out of the array.
				...(typeof row.z_index === "number" ? { zIndex: row.z_index } : {}),
				...(typeof row.ax_backed === "boolean" ? { axBacked: row.ax_backed } : {}),
				...(typeof row.main === "boolean" ? { main: row.main } : {}),
				...(typeof row.minimized === "boolean" ? { minimized: row.minimized } : {}),
				// An owner's off-screen placeholder window is not the panel itself.
				kind: onScreen.has(String(row.window_id))
					? classifyWindow({ app: string(row.app_name, "app_name") })
					: ("other" as const),
			};
			if (isCaptureLeaseArtifact(window)) {
				artifacts.add(window.id);
				continue;
			}
			windowArgs(window);
			windows.push(Object.freeze(window));
		}
		if (sample) {
			const known = new Set(windows.map(window => window.id));
			for (const row of sample.windows) {
				const kind = classifyWindow(row);
				// Menus, tooltips, the Dock and the rest of the accessory layers
				// stay out for the reason Cua filters them: they swamp the roster.
				if (kind === "other" || known.has(row.id)) continue;
				windows.push(
					Object.freeze({
						id: row.id,
						pid: row.pid,
						app: row.app,
						title: row.title,
						bounds: Object.freeze({ x: row.x, y: row.y, width: row.width, height: row.height }),
						onScreen: true,
						layer: row.layer,
						kind,
					}),
				);
			}
		}
		this.#leaseArtifacts = artifacts;
		for (const [pid, rows] of Map.groupBy(windows, window => window.pid)) this.#lastRoster.set(pid, rows);
		return windows.filter(
			window =>
				(selector.id === undefined || window.id === selector.id) &&
				(selector.pid === undefined || window.pid === selector.pid) &&
				(selector.app === undefined || window.app.toLowerCase().includes(selector.app.toLowerCase())) &&
				(selector.title === undefined || window.title.toLowerCase().includes(selector.title.toLowerCase())),
		);
	}
	async #windows(selector: WindowSelector = {}): Promise<ComputerWindowIdentity[]> {
		const { data } = await this.#call("list_windows", selector.pid === undefined ? {} : { pid: selector.pid });
		return this.#windowRoster(data, selector, this.#roster());
	}
	/**
	 * Acquisition is the first call of every native run, so both failures name
	 * their own way out. Nothing matched: an `{ app }` selector may name an app
	 * that is not running, which `{ launch: true }` starts and acquires in the
	 * same call. What else is open is not named here — the runtime appends that
	 * roster to every miss it reports, because only it knows whether a launch
	 * was refused, impossible, or opened nothing. Several matched: one line per
	 * candidate with the exact id to acquire, so picking one costs no
	 * `windows()` round trip. Document windows are the ambiguous case that a
	 * title cannot settle (two restored Automator workflows, one of them
	 * "Untitled"), so the file an earlier observation of that window reported
	 * is printed beside it.
	 */
	#unresolved(selector: string | WindowSelector, matches: ComputerWindowIdentity[]): ToolError {
		const named = JSON.stringify(selector);
		const app = typeof selector === "string" ? undefined : selector.app;
		if (!matches.length)
			return new ToolError(
				`Missing computer window ${named}: nothing matches it.${
					app === undefined
						? ""
						: ` If ${JSON.stringify(app)} is not running yet, launch and acquire it in one call with computer.window(${named}, { launch: true }).`
				}`,
			);
		return new ToolError(
			`Ambiguous computer window ${named}: ${matches.length} windows match. Acquire one by its exact id, e.g. computer.window(${JSON.stringify(matches[0]!.id)}):\n${matches
				.map(window => this.#candidate(window))
				.join("\n")}`,
		);
	}
	#candidate(window: ComputerWindowIdentity): string {
		const document = this.#documents.get(window.id);
		return `- id ${JSON.stringify(window.id)} pid ${window.pid} ${window.app} ${JSON.stringify(window.title)} ${
			window.bounds.width
		}×${window.bounds.height} at (${window.bounds.x},${window.bounds.y})${
			window.onScreen === false ? " offscreen" : ""
		}${window.kind !== undefined && window.kind !== "other" ? ` kind=${window.kind}` : ""}${
			document === undefined ? "" : ` document=${document}`
		}`;
	}
	#accessibilityWindows(
		data: Wire,
		pid: number,
	): { complete: boolean; windows: Map<string, Pick<ComputerWindowIdentity, "main" | "minimized">> } | undefined {
		const metadata = data.accessibility_windows;
		if (metadata === undefined) return undefined;
		const ax = object(metadata, "accessibility window metadata");
		if (ax.pid !== pid) throw new ToolError("Mismatched Cua accessibility window process");
		if (!Array.isArray(ax.windows)) throw new ToolError("Malformed Cua accessibility window roster");
		const windows = new Map<string, Pick<ComputerWindowIdentity, "main" | "minimized">>();
		for (const value of ax.windows) {
			const row = object(value, "accessibility window");
			const id = number(row.window_id, "accessibility window_id");
			if (!Number.isInteger(id) || id <= 0 || id > 0xffff_ffff || row.role !== "AXWindow")
				throw new ToolError("Malformed Cua accessibility window identity");
			if (this.#leaseArtifacts.has(String(id))) continue;
			windows.set(String(id), {
				...(typeof row.main === "boolean" ? { main: row.main } : {}),
				...(typeof row.minimized === "boolean" ? { minimized: row.minimized } : {}),
			});
		}
		return { complete: ax.complete === true, windows };
	}
	#withAccessibility(
		windows: readonly ComputerWindowIdentity[],
		ax: { complete: boolean; windows: Map<string, Pick<ComputerWindowIdentity, "main" | "minimized">> },
	): ComputerWindowIdentity[] {
		return windows.map(window => {
			const row = ax.windows.get(window.id);
			const backed = row !== undefined ? true : ax.complete ? false : undefined;
			if (backed === undefined && row === undefined) return window;
			return Object.freeze({ ...window, axBacked: window.axBacked ?? backed, ...row });
		});
	}
	#inputDead(
		pid: number,
		matches: readonly ComputerWindowIdentity[],
		roster: readonly ComputerWindowIdentity[],
	): ToolError {
		const app = matches[0]?.app ?? roster[0]?.app ?? "The target process";
		const rows = matches.length ? matches : roster;
		const backed = roster.filter(window => window.axBacked !== false);
		return new ToolError(
			`${app}: pid ${pid} has ${roster.length} WindowServer row${roster.length === 1 ? "" : "s"} and ${
				backed.length
					? `${backed.length} accessibility window${backed.length === 1 ? "" : "s"}, none of them among the ${rows.length} this selector matched`
					: "no accessibility window"
			}; every input route to ${rows.length === 1 ? "it" : "them"} is refused. ${
				backed.length
					? `Acquire one of its accessibility windows by id instead: ${appWindows(backed)}.`
					: "Bring it to this Space or reopen its document, then acquire again."
			}\n${rows.map(window => this.#candidate(window)).join("\n")}`,
		);
	}
	/**
	 * Frontmost of several matches. `main` is the app's own answer and settles
	 * it, including for the untitled windows a title cannot; a minimized
	 * window is behind every window that is not. `z_index` is the driver's
	 * stacking report and only comparable while every candidate carries one;
	 * the WindowServer sample, ordered front to back, is the fallback.
	 * Neither: stacking order is genuinely unknown and nothing may be picked.
	 * One candidate has nothing to order and needs neither.
	 */
	#frontmost(matches: readonly ComputerWindowIdentity[]): ComputerWindowIdentity | undefined {
		if (matches.length === 1) return matches[0];
		const shown = matches.filter(window => window.minimized !== true);
		const live = shown.length ? shown : matches;
		const main = live.filter(window => window.main === true);
		const ranked = main.length ? main : live;
		if (ranked.length === 1) return ranked[0];
		if (ranked.length > 1 && ranked.every(window => window.zIndex !== undefined))
			return ranked.reduce((front, window) => (window.zIndex! > front.zIndex! ? window : front));
		for (const row of this.#roster()?.windows ?? []) {
			const match = ranked.find(window => window.id === row.id);
			if (match) return match;
		}
		return undefined;
	}
	/**
	 * An app's own windows are not interchangeable, and `{ app: "Automator" }`
	 * means the document the user is working in. Its panels, inspectors and
	 * attached sheets run in the same process and match the same selector, and
	 * a sheet stacks above the document it belongs to while being driven
	 * through that document's own refs — acquiring one costs a step and lands
	 * on the wrong window. So a document window is on screen, carries a title,
	 * and is not a sheet: `#sheets` is how a sheet is known at all, because
	 * only `get_window_state` reports the relation and a window roster does not.
	 */
	#isDocument(window: ComputerWindowIdentity): boolean {
		return window.onScreen !== false && window.title !== "" && !this.#sheets.has(window.id);
	}
	/**
	 * `note`: several matches are the app's own doing (two restored documents
	 * of one workflow), and a model that has never seen the ids cannot pick
	 * between them. Where a note can be delivered, acquisition takes the front
	 * document window — the one the user is working in — and names the rest,
	 * so picking another costs no `windows()` round trip. Without a note
	 * (every internal re-resolution of an exact id/pid, where several matches
	 * mean something is wrong) it refuses.
	 */
	async #window(selector: string | WindowSelector, note?: (text: string) => void): Promise<ComputerWindowIdentity> {
		const filter = typeof selector === "string" ? { id: selector } : selector;
		let matches = await this.#windows(filter);
		const pid = matches[0]?.pid;
		if (filter.id === undefined && matches.length > 1 && matches.every(window => window.pid === pid)) {
			// WindowServer can include invisible app helpers, and a row no
			// AXWindow claims takes no input at all. Only a complete, exact
			// AXWindows mapping may narrow or refuse; visibility, title, size and
			// stacking order are not evidence of window ownership.
			const { data } = await this.#call("list_windows", { pid, include_accessibility_metadata: true });
			const sample = this.#roster();
			const roster = this.#windowRoster(data, { pid }, sample);
			matches = this.#windowRoster(data, filter, sample).filter(window => window.pid === pid);
			const ax = this.#accessibilityWindows(data, pid);
			if (ax) {
				matches = this.#withAccessibility(matches, ax);
				if (ax.complete && matches.length) {
					const annotated = this.#withAccessibility(roster, ax);
					if (!ax.windows.size) throw this.#inputDead(pid!, matches, annotated);
					// AX and CG are sequential snapshots. Missing CG identities mean
					// the mapping cannot safely disambiguate this acquisition.
					if ([...ax.windows.keys()].every(id => roster.some(window => window.id === id))) {
						const applicationWindows = matches.filter(window => window.axBacked !== false);
						if (!applicationWindows.length) throw this.#inputDead(pid!, matches, annotated);
						matches = applicationWindows;
					}
				}
			}
		}
		if (matches.length === 1) return matches[0]!;
		const documents = matches.filter(window => this.#isDocument(window));
		const front = note ? this.#frontmost(documents.length ? documents : matches) : undefined;
		if (!front || !note) throw this.#unresolved(selector, matches);
		note(
			`Ambiguous computer window ${JSON.stringify(selector)}: ${matches.length} windows match; acquired the ${
				documents.length ? "front document window" : "frontmost window"
			}, id ${JSON.stringify(front.id)} ${JSON.stringify(front.title)}; also open: ${appWindows(
				matches.filter(window => window !== front),
			)} — acquire one by its exact id to work on it instead.`,
		);
		return front;
	}
	#current(window: Pick<ComputerWindowIdentity, "id" | "pid">): Promise<ComputerWindowIdentity> {
		return this.#window({ id: window.id, pid: window.pid });
	}
	async #listedWindows(selector: WindowSelector): Promise<ComputerWindowIdentity[]> {
		const windows = await this.#windows(selector);
		const pid = windows[0]?.pid;
		if (pid === undefined || windows.some(window => window.pid !== pid || window.axBacked !== undefined))
			return windows;
		const { data } = await this.#call("list_windows", { pid, include_accessibility_metadata: true });
		const sample = this.#roster();
		const roster = this.#windowRoster(data, selector, sample);
		const ax = this.#accessibilityWindows(data, pid);
		return ax ? this.#withAccessibility(roster, ax) : roster;
	}
	windows(context: Context, selector: WindowSelector = {}): Promise<ComputerWindowIdentity[]> {
		return this.#schedule(context, "windows", false, () => this.#listedWindows(selector));
	}
	/**
	 * Re-resolution of a handle the caller already holds. Every prelude window
	 * method carries a `window` step to rehydrate its handle, so this runs
	 * before each of them and keeps what the session inferred about driving
	 * the window; `acquire` is the call that starts over on it.
	 */
	window(
		context: Context,
		selector: string | WindowSelector,
		options: WindowResolveOptions = {},
	): Promise<ComputerWindowIdentity> {
		return this.#schedule(context, "window", false, () =>
			this.#window(selector, options.ambiguous === "throw" ? undefined : text => context.emitText(text)),
		);
	}
	/**
	 * Acquisition is the caller starting again on this window, so what the
	 * session inferred about how to drive it does not outlive it: the sheet
	 * that made background delivery fail may be gone, and the driver is the
	 * one that gets to say so.
	 */
	acquire(
		context: Context,
		selector: string | WindowSelector,
		options: WindowResolveOptions = {},
	): Promise<ComputerWindowIdentity> {
		return this.#schedule(context, "window", false, async () => {
			const window = await this.#window(
				selector,
				options.ambiguous === "throw" ? undefined : text => context.emitText(text),
			);
			this.#escalatedKeyboard.delete(window.id);
			return window;
		});
	}
	apps(context: Context): Promise<unknown> {
		return this.#schedule(context, "apps", false, async () => (await this.#call("list_apps", {})).data);
	}
	displays(context: Context): Promise<DesktopDisplay[]> {
		return this.#schedule(context, "displays", false, async () => {
			const display = await this.#primaryDisplay();
			if (!display) unsupported("display identity is unavailable in this SDK");
			return [
				{
					id: display.uuid,
					name: "Primary display",
					...display.bounds,
					scale: display.scale,
					pixelX: 0,
					pixelY: 0,
					pixelWidth: Math.round(display.bounds.width * display.scale),
					pixelHeight: Math.round(display.bounds.height * display.scale),
					isPrimary: true,
				},
			];
		});
	}
	focusedWindow(context: Context): Promise<ComputerWindowIdentity | null> {
		return this.#schedule(context, "focusedWindow", false, async () =>
			unsupported("focusedWindow; stacking order does not prove keyboard focus"),
		);
	}
	#invalidate(window: Pick<ComputerWindowIdentity, "id" | "pid">): void {
		for (const [ref, binding] of this.#elements)
			if (binding.window.id === window.id && binding.window.pid === window.pid) this.#elements.delete(ref);
	}
	#binding(ref: string, window?: ComputerWindowIdentity): Binding {
		const binding = this.#elements.get(ref);
		if (this.#closed || !binding)
			throw new ToolError(`StaleRef: ${this.#staleSheetRefs.get(ref) ?? "observe the window again"}`);
		if (
			window &&
			(binding.window.pid !== window.pid ||
				(binding.window.id !== window.id && this.#sheets.get(binding.window.id)?.parent !== window.id))
		)
			throw new ToolError("WrongWindow: element belongs to a different PID/window");
		return binding;
	}
	element(ref: string, window?: ComputerWindowIdentity): ComputerElementSnapshot {
		return this.#binding(ref, window).element;
	}
	elementWindow(ref: string): ComputerWindowIdentity {
		return this.#binding(ref).window;
	}

	observe(
		context: Context,
		window: ComputerWindowIdentity,
		options: ObserveOptions = {},
	): Promise<ComputerObservation> {
		return this.#schedule(context, "observe", false, async () => {
			const { reply, current } = await this.#state(context, window, {
				include_accessibility_tree: true,
				include_screenshot: options.screenshot === true,
				max_depth: options.maxDepth,
				max_elements: options.maxElements,
				query: options.query,
			});
			const { rows, menuBarRows, snapshotId } = this.#walk(current, reply, options);
			// Only the walker knows whether it clipped the tree. `truncated` is its
			// explicit verdict and `elements_complete` its older positive proof.
			// Equal returned/total counts prove nothing: both count what the walk
			// reached, so every budget-capped walk called itself complete. Without
			// a verdict a requested `maxElements` is a budget the walk may have
			// hit, and no count can argue that away.
			const walkFinished = reply.data.ax_walk_timed_out !== true && reply.data.ax_walk_stop_reason == null;
			const countedWhole =
				typeof reply.data.returned_element_count === "number" &&
				reply.data.returned_element_count === reply.data.total_element_count;
			const complete =
				walkFinished &&
				(typeof reply.data.truncated === "boolean"
					? !reply.data.truncated
					: reply.data.elements_complete === true || (options.maxElements === undefined && countedWhole));
			const observation: ComputerObservation = {
				snapshotId,
				window: current,
				elements: rows.map(row => row.element),
				complete,
				backgroundInput: reply.data.background_input ?? null,
				relatedWindows: relatedWindows(reply.data.related_windows),
				tree: "",
			};
			const parent = rows.length
				? treeRows(rows, 0)
				: typeof reply.data.degraded_reason === "string"
					? reply.data.degraded_reason
					: options.query !== undefined
						? this.#queryMiss(current, reply, options, complete)
						: "No accessibility elements returned; completeness is unknown.";
			// This window's sheets, as of this walk: a sheet that has gone away
			// must stop excluding an id acquisition could pick, and the refs it
			// minted must say which surface took them with it.
			const attached = observation.relatedWindows ?? [];
			for (const [id, sheet] of this.#sheets)
				if (sheet.parent === current.id && !attached.some(row => row.id === id)) this.#retireSheet(id, sheet.title);
			const sheets: string[] = [];
			for (const sheet of attached) {
				this.#sheets.set(sheet.id, { parent: current.id, title: sheet.title });
				let block = `sheet ${JSON.stringify(sheet.title)} (window ${sheet.id}) — modal over window ${current.id}`;
				try {
					const nested = await this.#sheetRows(context, sheet, options);
					observation.elements.push(...nested.map(row => row.element));
					if (nested.length) block += `\n${treeRows(nested, 1)}`;
				} catch (error) {
					if (!(error instanceof ToolError)) throw error;
					block += ` — its own walk failed: ${error.message}`;
				}
				sheets.push(block);
			}
			observation.tree = [
				...sheets,
				parent,
				menuBarRows
					? `Menu bar hidden (${menuBarRows} rows): its items only respond while their own menu is open, so drive it with win.menu(["<menu>", "<item>"], { delivery: "foreground" }); observe({ menubar: true }) shows them.`
					: undefined,
			]
				.filter(line => line !== undefined)
				.join("\n");
			if (reply.data.ax_walk_timed_out === true)
				observation.tree +=
					"\nAccessibility observation reached its time limit. The walk has finished; omitted controls and values remain unknown.";
			else if (reply.data.ax_walk_stop_reason != null)
				observation.tree +=
					"\nAccessibility observation stopped because a native request could not complete. The walk has finished; omitted controls and values remain unknown.";
			if (typeof reply.data.collapsed_rows === "number" && reply.data.collapsed_rows > 0)
				observation.tree += `\n${reply.data.collapsed_rows} row(s) are scrolled out of view and were not read. Scroll the list or use the window's search field to reach them.`;
			// Document apps: the app's own dirty bit and file path (absent = the app
			// reports neither). AX value writes never reach disk, so this is how the
			// model tells "text changed" from "saved".
			if (typeof reply.data.document_path === "string") observation.documentPath = reply.data.document_path;
			// Kept for the next ambiguous acquisition of this app: a document
			// window's file identifies it where its title does not.
			if (observation.documentPath === undefined) this.#documents.delete(current.id);
			else this.#documents.set(current.id, observation.documentPath);
			if (typeof reply.data.document_edited === "boolean") observation.documentEdited = reply.data.document_edited;
			if (observation.documentPath !== undefined || observation.documentEdited !== undefined)
				observation.tree += `\nDocument: ${observation.documentPath ?? "(path unknown)"}${observation.documentEdited === undefined ? "" : observation.documentEdited ? " — unsaved changes" : " — no unsaved changes flagged"}`;
			const opened = await this.#openedWindows(current.pid, {
				roster: this.#lastRoster.get(current.pid) ?? [],
				observed: current.id,
			});
			if (opened !== undefined) observation.tree += `\n${opened}`;
			// An observation is the model's picture of the environment; a system
			// prompt over it is part of that picture even though the AX tree of
			// the target window looks entirely normal underneath.
			observation.interruptedBy = this.#interruption();
			if (observation.interruptedBy)
				observation.tree += `\n⚠️ Interrupted: ${describeInterruption(observation.interruptedBy)}. Actions on any window are refused until it is answered; tell the user what is asking.`;
			// The write that decided what this tree means may have been dispatched
			// by a cell that displayed only this read.
			const doubted = this.#doubtedWrites(current.id);
			if (doubted.length) observation.tree = `${doubted.join("\n")}\n${observation.tree}`;
			this.#observedRoster.set(
				current.pid,
				new Set((this.#lastRoster.get(current.pid) ?? []).filter(row => row.onScreen !== false).map(row => row.id)),
			);
			if (options.screenshot) {
				try {
					observation.screenshot = await this.#windowImage(context, current, reply, options.silent === true);
				} catch (error) {
					throwIfAborted(context.signal);
					observation.screenshotError = error instanceof Error ? error.message : String(error);
				}
			}
			return observation;
		});
	}
	/**
	 * A query that matched nothing, answered with what was searched. The empty
	 * answer named neither the query nor the tree it ran against, and the bench
	 * followed 79 % of them with another guessed word — so the rows the walk
	 * read, its own verdict on the tree and the scroll state are what this says,
	 * because those are what decide whether to widen the query or scroll first.
	 */
	#queryMiss(window: ComputerWindowIdentity, reply: Reply, options: ObserveOptions, complete: boolean): string {
		const read =
			typeof reply.data.total_element_count === "number"
				? reply.data.total_element_count
				: typeof reply.data.element_count === "number"
					? reply.data.element_count
					: undefined;
		const collapsed = typeof reply.data.collapsed_rows === "number" ? reply.data.collapsed_rows : 0;
		const verdict = reply.data.truncated === true ? "truncated" : complete ? "complete" : "not proven complete";
		const walked =
			read === undefined
				? "the walk reported no row count"
				: `the walk read ${read} actionable row${read === 1 ? "" : "s"}`;
		const next =
			collapsed > 0
				? `scroll the list first — ${collapsed} row(s) are out of view and were not read — or drop the query to read what is on screen`
				: `drop the query to read the whole tree, or widen it to a substring one of those rows carries${
						options.menubar === true ? "" : "; observe({ menubar: true }) adds the menu bar"
					}`;
		return `No row matched query ${JSON.stringify(options.query)} under window ${window.id} ${JSON.stringify(
			window.title,
		)} (${window.app})${options.menubar === true ? " and its menu bar" : ""}: ${walked} and reported the tree ${verdict}. Next: ${next}.`;
	}
	#walk(
		window: ComputerWindowIdentity,
		reply: Reply,
		options: ObserveOptions,
	): { rows: TreeRow[]; menuBarRows: number; snapshotId: string } {
		if (!Array.isArray(reply.data.elements)) throw new ToolError("Malformed Cua elements");
		// A real window can have no matching AXWindow at all (canvas/custom UI).
		// Preserve visual access without fabricating an actionable SDK snapshot.
		const snapshotId = typeof reply.data.snapshot_id === "string" ? reply.data.snapshot_id : "unavailable";
		if (snapshotId === "unavailable" && reply.data.elements.length)
			throw new ToolError("Cua elements have no snapshot identity");
		const rows: TreeRow[] = [];
		const collapsed =
			typeof reply.data.collapsed_rows === "number" && reply.data.collapsed_rows > 0
				? collapsedRowNotes(reply.data.tree_markdown)
				: undefined;
		// The menu bar is a fifth of a macOS tree (22 kB of one 31 kB walk),
		// every row of it advertises `press`, and every such press is refused
		// because a menu bar item reports `AXEnabled` only while its menu is
		// open. `menu(path)` drives it instead, so the rows stay out unless
		// they are asked for, and a ref is never minted for one.
		let menuBarDepth: number | undefined;
		let menuBarRows = 0;
		for (const value of reply.data.elements) {
			const row = object(value, "element");
			const depth = typeof row.depth === "number" ? Math.max(0, Math.min(50, Math.floor(row.depth))) : 0;
			if (menuBarDepth !== undefined && depth > menuBarDepth) {
				menuBarRows++;
				continue;
			}
			menuBarDepth = undefined;
			if (options.menubar !== true && MENU_BAR_ROLES[string(row.role, "role")] === true) {
				menuBarDepth = depth;
				menuBarRows++;
				continue;
			}
			const token = string(row.element_token, "element_token");
			// `#elements` is the only binding: it carries the exact window, driver
			// snapshot and element token, and rejects a ref it does not hold. The
			// ref itself only has to be unique for this session's lifetime.
			const ref = `n${++this.#refSeq}`;
			if (row.background_actions != null && !Array.isArray(row.background_actions))
				throw new ToolError("Malformed Cua background actions");
			if (row.custom_actions != null && !Array.isArray(row.custom_actions))
				throw new ToolError("Malformed Cua custom actions");
			const custom = customActions(row.custom_actions);
			const actions = observedActions(row.background_actions ?? row.actions, [...custom.keys()]);
			const element = Object.freeze({
				ref,
				pid: window.pid,
				windowId: window.id,
				role: string(row.role, "role"),
				label: typeof row.label === "string" ? row.label : "",
				...(typeof row.subrole === "string" && row.subrole ? { subrole: row.subrole } : {}),
				...(typeof row.value === "string" ? { value: row.value } : {}),
				...(typeof row.placeholder === "string" ? { placeholder: row.placeholder } : {}),
				// Semantics the provider authored but role/label do not carry. An
				// empty string is the driver's way of saying "none", and a
				// description that merely repeats the label is pure noise.
				...(typeof row.help === "string" && row.help ? { help: row.help } : {}),
				...(typeof row.description === "string" &&
				row.description &&
				row.description !== row.label &&
				row.description !== row.value
					? { description: row.description }
					: {}),
				...(typeof row.enabled === "boolean" ? { enabled: row.enabled } : {}),
				...(typeof row.selected === "boolean" ? { selected: row.selected } : {}),
				...(actions?.length ? { actions } : {}),
				...(row.frame ? { bounds: bounds(row.frame) } : {}),
			});
			this.#elements.set(ref, {
				window,
				token,
				snapshotId,
				element,
				customActions: custom,
				doubleClickAtCenter: reply.data.element_double_click === "left_center_v1",
			});
			const notes = collapsed?.get(typeof row.element_index === "number" ? row.element_index : -1);
			rows.push(notes?.length ? { depth, element, notes } : { depth, element });
		}
		return { rows, menuBarRows, snapshotId };
	}
	async #sheetRows(context: Context, sheet: ComputerRelatedWindow, options: ObserveOptions): Promise<TreeRow[]> {
		const window = await this.#window({ id: sheet.id, pid: sheet.pid });
		throwIfAborted(context.signal);
		this.#invalidate(window);
		const reply = await this.#call("get_window_state", {
			...windowArgs(window),
			include_accessibility_tree: true,
			include_screenshot: false,
			max_elements: options.maxElements,
		});
		if (reply.data.pid !== window.pid || String(reply.data.window_id) !== window.id)
			throw new ToolError("WrongWindow: Cua sheet observation identity mismatch");
		return this.#walk(window, reply, options).rows;
	}
	#retireSheet(id: string, title: string): void {
		this.#sheets.delete(id);
		for (const [ref, binding] of this.#elements) {
			if (binding.window.id !== id) continue;
			this.#elements.delete(ref);
			this.#staleSheetRefs.set(
				ref,
				`sheet ${JSON.stringify(title)} (window ${id}) is gone; observe the window that had it again`,
			);
		}
	}
	async #state(
		context: Context,
		window: ComputerWindowIdentity,
		args: Wire,
	): Promise<{ reply: Reply; current: ComputerWindowIdentity }> {
		// Cua keeps one rendering lease per session. A screenshot request may stop
		// the previous window's stream even when the new capture fails, so it
		// drops every frame. An AX-only read captures nothing and invalidates
		// nothing: pixels stay valid until the window's own geometry moves,
		// which `#target` checks against the live bounds on every use.
		if (args.include_screenshot === true) this.#frames.clear();
		if (args.include_accessibility_tree !== false) this.#invalidate(window);
		const current = await this.#current(window);
		throwIfAborted(context.signal);
		// The driver caps the capture's long edge for us, so the window's own
		// point grid is produced once, from the raw Retina frame, instead of
		// being resampled again here out of a frame it already shrank.
		const capture =
			args.include_screenshot === true
				? {
						max_dimension: Math.max(
							1,
							Math.round(
								Math.max(current.bounds.width, current.bounds.height) * captureScale(context, current.bounds),
							),
						),
					}
				: {};
		const reply = await this.#call("get_window_state", { ...windowArgs(current), ...args, ...capture });
		if (reply.data.pid !== current.pid || String(reply.data.window_id) !== current.id)
			throw new ToolError("WrongWindow: Cua observation identity mismatch");
		const after = await this.#current(current);
		if (!sameBounds(current.bounds, after.bounds))
			throw new ToolError("StaleFrame: window geometry changed during observation");
		return { reply, current: after };
	}
	/**
	 * Write one delivered capture at the surface's own point size and hand it
	 * to the model. The driver already caps what it sends, so the resize here
	 * is a no-op on the window path and the only downscale on the desktop
	 * path, which has no cap of its own. The byte budget is deliberately
	 * loose: a capture that loses dimensions to compression would silently
	 * leave the point grid the coordinate contract rests on.
	 */
	async #saveImage(
		context: Context,
		reply: Reply,
		target: string,
		silent: boolean,
		kind: "window" | "display",
		surface?: Surface,
		label?: string,
	): Promise<ComputerImage> {
		if (reply.result.images.length !== 1) throw new ToolError("Screenshot unavailable or ambiguous");
		const source = reply.result.images[0]!;
		const width = number(reply.data.screenshot_width, "screenshot_width");
		const height = number(reply.data.screenshot_height, "screenshot_height");
		const points = surface ?? { width, height };
		const scale = captureScale(context, points);
		const resized = await resizeImage(
			{ type: "image", data: source.dataBase64, mimeType: source.mimeType },
			{
				maxWidth: Math.min(width, Math.max(1, Math.round(points.width * scale))),
				maxHeight: Math.min(height, Math.max(1, Math.round(points.height * scale))),
				minDimension: 1,
				maxBytes: CAPTURE_MAX_BYTES,
				excludeWebP: true,
			},
		);
		if (resized.decodeFailed || resized.originalWidth !== width || resized.originalHeight !== height)
			throw new ToolError("Screenshot dimensions do not match its SDK coordinate frame");
		const destination = path.join(
			os.tmpdir(),
			`omp-computer-${crypto.randomUUID()}.${resized.mimeType === "image/png" ? "png" : "jpg"}`,
		);
		await Bun.write(destination, resized.buffer);
		throwIfAborted(context.signal);
		const image = Object.freeze({
			path: destination,
			width: resized.width,
			height: resized.height,
			sourceWidth: width,
			sourceHeight: height,
			surface: kind,
			pointWidth: points.width,
			pointHeight: points.height,
			scale: resized.width / points.width,
			target,
			...(label ? { label } : {}),
		});
		context.emitImage(image, { type: "image", data: resized.data, mimeType: resized.mimeType }, silent);
		return image;
	}
	async #windowImage(
		context: Context,
		window: ComputerWindowIdentity,
		reply: Reply,
		silent: boolean,
	): Promise<ComputerImage> {
		// `screenshot_frame_valid` is a contract-optional tri-state: macOS sets
		// it true on success, Linux only ever sets it false on a capture error.
		// A valid frame is therefore "not denied, one image part, and geometry
		// to bind it to" — absence is not failure and never fabricates pixels.
		if (
			reply.data.screenshot_frame_valid === false ||
			reply.result.images.length !== 1 ||
			reply.data.window_bounds === undefined
		) {
			const failure = reply.data.screenshot_error;
			if (failure && typeof failure === "object" && !Array.isArray(failure)) {
				const details = failure as Wire;
				// The driver bounds its capture-start wait; the accessibility tree in
				// the same reply is still good, only the pixels are missing.
				if (details.code === "capture_timeout")
					throw new ToolError(
						`capture_timeout: the window did not deliver a frame within ${String(details.waited_ms ?? "?")} ms; accessibility state is still current — retry the screenshot or continue with refs`,
						details,
					);
				if (typeof details.code === "string" && typeof details.reason === "string")
					throw new ToolError(`${details.code}: ${details.reason}`);
			}
			throw new ToolError("Screenshot unavailable: the driver did not provide a valid image");
		}
		if (!sameBounds(bounds(reply.data.window_bounds), window.bounds))
			throw new ToolError("StaleFrame: Cua did not provide a valid matching screenshot frame");
		const image = await this.#saveImage(
			context,
			reply,
			window.id,
			silent,
			"window",
			window.bounds,
			`${window.app}: ${window.title || "Untitled window"}`,
		);
		this.#frames.set(window.id, {
			window,
			image,
			sdkWidth: number(reply.data.screenshot_width, "screenshot_width"),
			sdkHeight: number(reply.data.screenshot_height, "screenshot_height"),
		});
		return image;
	}
	captureWindow(
		context: Context,
		window: ComputerWindowIdentity,
		options: { silent?: boolean } = {},
	): Promise<ComputerImage> {
		return this.#schedule(context, "captureWindow", false, async () => {
			const { current, reply } = await this.#state(context, window, {
				include_accessibility_tree: false,
				include_screenshot: true,
			});
			// An image carries no text of its own, so an unproven write goes in
			// front of the pixels it is true of.
			for (const doubt of this.#doubtedWrites(current.id)) context.emitText(doubt);
			return this.#windowImage(context, current, reply, options.silent === true);
		});
	}
	/**
	 * One action's target. A point is window-local, in points — the same grid
	 * the capture is delivered on and the same grid an element's own bounds
	 * are in, so a coordinate read off the screenshot and a coordinate derived
	 * from the tree mean the same thing. The driver reads its pixel rungs in
	 * the frame it delivered, so the conversion is that frame over the
	 * window's points: identity whenever the capture is point-for-point.
	 */
	#target(window: ComputerWindowIdentity, target?: ComputerTarget): Wire {
		if (typeof target === "string") {
			const ref = this.#binding(target, window);
			return { ...windowArgs(ref.window), element_token: ref.token, snapshot_id: ref.snapshotId };
		}
		if (!target) return windowArgs(window);
		const frame = this.#frames.get(window.id);
		if (!frame || frame.window.pid !== window.pid || !sameBounds(frame.window.bounds, window.bounds)) {
			this.#frames.delete(window.id);
			throw new ToolError("StaleFrame: capture the exact window again before a pixel action");
		}
		const area = frame.window.bounds;
		const [x, y] = pointPair(target);
		if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= area.width || y >= area.height)
			throw new ToolError(
				`InvalidCoordinates: (${x}, ${y}) is outside the window's ${Math.round(area.width)}×${Math.round(area.height)} pt frame`,
			);
		return {
			...windowArgs(window),
			x: (x * frame.sdkWidth) / area.width,
			y: (y * frame.sdkHeight) / area.height,
		};
	}
	/**
	 * Modifiers and click counts are a pixel-route capability here: the element
	 * route posts a bare AX press that carries neither. The ref's own observed
	 * bounds name the point — its centre, moved out of global desktop
	 * coordinates into the window's own, so the action is checked against the
	 * same live frame a model-supplied point would be. Without bounds or
	 * without a frame there is no honest point, and only then is the click
	 * refused.
	 */
	#elementPoint(window: ComputerWindowIdentity, element: ComputerElementSnapshot): ComputerTarget | undefined {
		const frame = this.#frames.get(window.id);
		const box = element.bounds;
		if (!frame || !box) return undefined;
		const area = frame.window.bounds;
		return [box.x + box.width / 2 - area.x, box.y + box.height / 2 - area.y];
	}
	/** One end of a drag: a ref is the point its own bounds name, a point is itself. */
	#dragEnd(window: ComputerWindowIdentity, end: ComputerTarget, side: "from" | "to"): ComputerTarget {
		if (typeof end !== "string") return end;
		const point = this.#elementPoint(window, this.#binding(end, window).element);
		if (!point)
			unsupported(
				`drag ${side} an element with no observed bounds or no current window screenshot; capture the window again (observe({ screenshot: true })) and drag window points`,
			);
		return point;
	}
	/**
	 * What the pid put on screen that the caller has never seen. The handle it
	 * acted through is never rebound — a window it did not ask for is a fact
	 * about the app, not a new target — so the id and the call that acquires
	 * it are named and the choice stays the caller's. Read on both paths: a
	 * dialog that renders asynchronously (Chrome's print, save and open
	 * panels, 24 episodes in the bench corpus) appears seconds after the
	 * action that asked for it, so an action-only diff never named it and the
	 * model hunted it by hand. The observe path spends the roster the walk's
	 * own window resolution already read; `read.observed` is this walk's
	 * window, which is being looked at rather than announced.
	 */
	async #openedWindows(
		pid: number | undefined,
		read?: { roster: readonly ComputerWindowIdentity[]; observed: string },
	): Promise<string | undefined> {
		if (pid === undefined) return undefined;
		const before = this.#observedRoster.get(pid);
		if (!before) return undefined;
		let after = read?.roster;
		if (after === undefined)
			try {
				after = await this.#windows({ pid });
			} catch (error) {
				if (!(error instanceof ToolError)) throw error;
				return undefined;
			}
		const opened = after.filter(
			window =>
				window.onScreen !== false &&
				!before.has(window.id) &&
				!this.#sheets.has(window.id) &&
				window.id !== read?.observed,
		);
		if (!opened.length) return undefined;
		const attached = opened.length > 1 ? await this.#attachedTo(pid, opened) : undefined;
		return opened
			.filter(window => attached?.get(window.id) === undefined)
			.flatMap(window => [
				`pid ${pid} gained window ${window.id} (${JSON.stringify(window.title)}) since your last observation — acquire it with computer.window(${JSON.stringify(window.id)}).`,
				...opened
					.filter(row => attached?.get(row.id) === window.id)
					.map(
						row =>
							`  window ${row.id} (${JSON.stringify(row.title)}) is attached to it — no accessibility window of its own — and renders inside its parent's tree; observe window ${window.id}, not this id.`,
					),
			])
			.join("\n");
	}
	/**
	 * Which of these newly gained rows are attached surfaces, each against the
	 * gained window it hangs on. Only an observation of the parent reports the
	 * relation, which is exactly what has not happened for a window that
	 * appeared this instant — and announcing a sheet beside its own parent
	 * sent the bench into a tree rooted at `AXSheet` that cost a cell to
	 * recover from. So the AXWindows mapping says which rows are windows at
	 * all, and containment says whose surface this is: a sheet is drawn inside
	 * the window it belongs to. Anything neither settles stays a window.
	 */
	async #attachedTo(pid: number, opened: readonly ComputerWindowIdentity[]): Promise<ReadonlyMap<string, string>> {
		const attached = new Map<string, string>();
		let annotated: readonly ComputerWindowIdentity[];
		try {
			const { data } = await this.#call("list_windows", { pid, include_accessibility_metadata: true });
			const ax = this.#accessibilityWindows(data, pid);
			if (!ax) return attached;
			annotated = this.#withAccessibility(this.#windowRoster(data, { pid }, this.#roster()), ax);
		} catch (error) {
			if (!(error instanceof ToolError)) throw error;
			return attached;
		}
		const rows = opened.map(window => annotated.find(row => row.id === window.id) ?? window);
		const windows = rows.filter(row => row.axBacked === true);
		for (const row of rows) {
			if (row.axBacked === true) continue;
			const hosts = windows.filter(host => encloses(host.bounds, row.bounds));
			if (hosts.length === 1) attached.set(row.id, hosts[0]!.id);
		}
		return attached;
	}
	#focusHolder(details: unknown, args: Wire): string | undefined {
		const data = refusalDetails(details);
		const code = typeof data.code === "string" ? data.code : undefined;
		if ((code === undefined || FOCUS_HOLDING_REFUSALS[code] !== true) && data.focused_window_id === undefined)
			return undefined;
		const target = typeof args.window_id === "number" ? String(args.window_id) : undefined;
		if (target === undefined) return undefined;
		const focused =
			typeof data.focused_window_id === "number" && String(data.focused_window_id) !== target
				? String(data.focused_window_id)
				: undefined;
		const sheet = focused ?? [...this.#sheets].find(([, row]) => row.parent === target)?.[0];
		if (sheet === undefined) return undefined;
		const relation = this.#sheets.get(sheet);
		return `window ${sheet}${
			relation ? ` — a sheet attached to ${relation.parent} —` : ""
		} holds keyboard focus, not window ${target}; drive it with computer.window(${JSON.stringify(sheet)}) and press its own buttons.`;
	}
	/**
	 * The rung the driver names is the whole fact: a keyboard escalation
	 * spells its `reason` as a contract token (`delivery_failed`) or as the
	 * prose sentence the fork's `hotkey`/`type_text` emit, so only the target
	 * is a route. A refused foreground dispatch is not a route to keep
	 * taking, whoever chose it.
	 */
	#keyboardEscalation(name: string, args: Wire, details: Wire, refused: boolean): boolean {
		if (KEYBOARD_TOOLS[name] !== true || typeof args.window_id !== "number") return false;
		const window = String(args.window_id);
		if (refused && args.delivery_mode === "foreground") {
			this.#escalatedKeyboard.delete(window);
			return false;
		}
		if (escalationTarget(details) !== "foreground") return false;
		this.#escalatedKeyboard.add(window);
		return true;
	}
	/**
	 * The pre-dispatch gate cleared the screen a moment ago, so any blocking
	 * window found now appeared while this action ran — a prompt the action
	 * itself provoked, or the user's own. The action is not retracted; the
	 * result says the environment changed under it, and the next mutation is
	 * refused until the panel goes away.
	 */
	async #action(name: string, args: Wire): Promise<ComputerActionResult> {
		let reply: Reply;
		try {
			reply = await this.#call(
				name,
				DETECT_WINDOW_CHANGE_TOOLS[name] === true ? { ...args, detect_window_change: false } : args,
			);
		} catch (error) {
			if (!(error instanceof ToolError)) throw error;
			this.#keyboardEscalation(name, args, refusalDetails(error.context), true);
			const lines = [error.message, actionEvidence(error.context, args), this.#focusHolder(error.context, args)];
			throw new ToolError(lines.filter(line => line !== undefined).join("\n"), error.context);
		}
		const { result, data } = reply;
		const interruptedBy = this.#interruption();
		const committed = typeof data.committed === "boolean" ? data.committed : undefined;
		// The driver writes its own advice in wire vocabulary on the success path
		// too ("click this control's pixel center with delivery_mode:foreground");
		// a next step is only executable if it is spelled the way the caller types.
		const reported = preludeVocabulary(result.text);
		const escalation = escalationRoute(data, reported, this.#keyboardEscalation(name, args, data, false));
		const opened = await this.#openedWindows(typeof args.pid === "number" ? args.pid : undefined);
		return {
			text: [
				reported,
				committed === undefined ? undefined : commitNote(committed, reported),
				escalation,
				opened,
				interruptedBy
					? `⚠️ Interrupted while acting: ${describeInterruption(interruptedBy)}. Stop and tell the user; further actions are refused until it is answered.`
					: undefined,
			]
				.filter(line => line !== undefined)
				.join("\n"),
			effect: typeof data.effect === "string" ? data.effect : "unverifiable",
			evidence: data.evidence ?? null,
			route: typeof data.route === "string" ? data.route : typeof data.path === "string" ? data.path : "cua-sdk",
			delivery: data.delivery ?? args.delivery_mode ?? "background",
			...(committed === undefined ? {} : { committed }),
			...(escalation === undefined ? {} : { escalation }),
			interruptedBy,
			data,
		};
	}
	/**
	 * A menu bar item reports `AXEnabled` only while its own menu is open, so
	 * the driver refuses the press before dispatch — and neither escalation it
	 * suggests (foreground delivery, `bring_to_front`) opens a menu. Every
	 * macOS tree carries these rows advertising `press`, and the route that
	 * does drive them is `menu(path)`, which the driver has no way to name
	 * because it addressed one element, not a path. The ref's own role is what
	 * identifies the case; the driver's text survives in front of it.
	 */
	#menuBarRoute(target: ComputerTarget | undefined): string | undefined {
		if (typeof target !== "string") return undefined;
		const element = this.#elements.get(target)?.element;
		if (!element || MENU_BAR_ROLES[element.role] !== true) return undefined;
		return `\nThat ref is a ${element.role}: an AX action on it only lands while its menu is already open, and no delivery mode opens one. Drive the menu instead: win.menu([${
			element.label ? JSON.stringify(element.label) : '"<menu>"'
		}, "<item>"], { delivery: "foreground" }).`;
	}
	/** Dispatch that can name the route a refused menu bar action actually needs. */
	async #dispatch(name: string, args: Wire, target: ComputerTarget | undefined): Promise<ComputerActionResult> {
		try {
			return await this.#action(name, args);
		} catch (error) {
			// An aborted call is not a ToolError and keeps its own identity.
			if (!(error instanceof ToolError)) throw error;
			const route = this.#menuBarRoute(target);
			if (route === undefined) throw error;
			throw new ToolError(`${error.message}${route}`, error.context);
		}
	}
	#targetAction(
		context: Context,
		name: string,
		window: ComputerWindowIdentity,
		target: ComputerTarget | undefined,
		args: Wire,
		crashAlertTarget?: string,
	): Promise<ComputerActionResult> {
		return this.#schedule(
			context,
			name,
			true,
			async () => {
				const current = await this.#current(window);
				throwIfAborted(context.signal);
				return this.#dispatch(name, { ...this.#target(current, target), ...args }, target);
			},
			crashAlertTarget,
		);
	}
	click(
		context: Context,
		window: ComputerWindowIdentity,
		target: ComputerTarget,
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(
			context,
			"click",
			true,
			async () => {
				const current = await this.#current(window);
				throwIfAborted(context.signal);
				let point = target;
				if (typeof target === "string") {
					const binding = this.#binding(target, current);
					const supportedDouble =
						binding.doubleClickAtCenter && options.count === 2 && (options.button ?? "left") === "left";
					if (options.modifiers?.length || ((options.count ?? 1) !== 1 && !supportedDouble)) {
						const centre = this.#elementPoint(current, binding.element);
						if (!centre)
							unsupported(
								"counted or modified click on an element with no observed bounds or no current window screenshot; capture the window again and click its centre in window points",
							);
						point = centre;
					}
				}
				return this.#dispatch(
					"click",
					{
						...this.#target(current, point),
						...delivery(options),
						button: options.button,
						count: options.count,
						modifier: options.modifiers,
					},
					target,
				);
			},
			// A background click on an element ref is the AX press route, so it
			// may address a crash alert this session caused (see the gate). A
			// counted or modified click leaves that route for pixels, which have
			// no business on an alert.
			typeof target === "string" &&
				!options.modifiers?.length &&
				(options.count ?? 1) === 1 &&
				options.delivery !== "foreground"
				? window.id
				: undefined,
		);
	}
	/**
	 * A write nothing proved, held against the window it was made on. Both
	 * write routes answer `effect: "confirmed"` with a value readback for a
	 * value the app's editing pipeline took and for one it discarded, and the
	 * reply carrying that doubt is the cell's to drop: the bench wrote a
	 * Save-panel filename, chained an `observe` behind it in the same cell, and
	 * the only signal it had was never displayed. So the doubt outlives its own
	 * call and is spent on the next read of that window — the observation or
	 * capture whose conclusions would rest on the written value. Proof is the
	 * driver's own commit verdict on a reply that read the state back and names
	 * no better route; anything short of that is carried.
	 */
	async #write(
		window: ComputerWindowIdentity,
		operation: "setValue" | "type",
		target: ComputerTarget | undefined,
		dispatched: Promise<ComputerActionResult>,
	): Promise<ComputerActionResult> {
		const doubt = `${operation} on ${this.#writeTarget(target)} is not proven committed — re-read the field before building on it`;
		try {
			const result = await dispatched;
			if (result.committed !== true || result.effect !== "confirmed" || result.escalation !== undefined)
				this.#doubt(window.id, doubt);
			return result;
		} catch (error) {
			if (error instanceof ToolError && error.message.startsWith(INCOMPLETE_TYPING)) this.#doubt(window.id, doubt);
			throw error;
		}
	}
	/** The element a write addressed, as the observation the caller read named it. */
	#writeTarget(target: ComputerTarget | undefined): string {
		if (target === undefined) return "the window's focused element";
		if (typeof target !== "string") {
			const [x, y] = pointPair(target);
			return `(${x},${y})`;
		}
		const label = this.#elements.get(target)?.element.label;
		return label ? `${target} ${JSON.stringify(label)}` : target;
	}
	/** One sentence per unproven write, and never the same one twice. */
	#doubt(windowId: string, sentence: string): void {
		const doubts = this.#writes.get(windowId);
		if (doubts) doubts.add(sentence);
		else this.#writes.set(windowId, new Set([sentence]));
	}
	#doubtedWrites(windowId: string): readonly string[] {
		const doubts = this.#writes.get(windowId);
		if (!doubts) return [];
		this.#writes.delete(windowId);
		return [...doubts];
	}
	/**
	 * The keyboard route for this window: what the caller asked for, or the
	 * foreground rung the driver escalated to on this window and this session
	 * kept. The route is stated with the result — a background action that
	 * silently activates an app would otherwise be a surprise — and an
	 * explicit `{ delivery }` always wins, since the caller may be testing the
	 * rung the escalation gave up on.
	 */
	#keyboardRoute(window: ComputerWindowIdentity, options: ActionOptions): { wire: Wire; note?: string } {
		if (options.delivery !== undefined || !this.#escalatedKeyboard.has(window.id)) return { wire: delivery(options) };
		return {
			wire: { delivery_mode: "foreground" },
			note: "delivery: foreground (remembered from the driver's escalation on this window)",
		};
	}
	async #routed(dispatched: Promise<ComputerActionResult>, note: string | undefined): Promise<ComputerActionResult> {
		const result = await dispatched;
		if (note === undefined) return result;
		return { ...result, text: result.text ? `${result.text}\n${note}` : note };
	}
	type(
		context: Context,
		window: ComputerWindowIdentity,
		text: string,
		target?: ComputerTarget,
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		const route = this.#keyboardRoute(window, options);
		return this.#write(
			window,
			"type",
			target,
			this.#routed(this.#targetAction(context, "type_text", window, target, { text, ...route.wire }), route.note),
		);
	}
	setValue(
		context: Context,
		window: ComputerWindowIdentity,
		ref: string,
		value: string,
	): Promise<ComputerActionResult> {
		return this.#write(window, "setValue", ref, this.#targetAction(context, "set_value", window, ref, { value }));
	}
	press(
		context: Context,
		window: ComputerWindowIdentity,
		chord: string | string[],
		target?: ComputerTarget,
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		const keys = chordKeys(chord, this.#platform);
		const route = this.#keyboardRoute(window, options);
		return this.#routed(
			this.#targetAction(context, keys.length === 1 ? "press_key" : "hotkey", window, target, {
				...(keys.length === 1 ? { key: keys[0] } : { keys }),
				...route.wire,
			}),
			route.note,
		);
	}
	/**
	 * Exactly the names this ref's own row printed, plus the six semantic ones.
	 * Advertisement is the driver's fact and it dispatches any advertised name,
	 * so a narrower vocabulary here refused the verbatim AX names the tree
	 * renders — `AXShowDefaultUI` off a Chrome file row among them. The alias
	 * table is read on the way in as well as on the way out, and the refusal
	 * names this row's list rather than six verbs that may not be on it.
	 */
	perform(
		context: Context,
		window: ComputerWindowIdentity,
		ref: string,
		action: string,
	): Promise<ComputerActionResult> {
		const binding = this.#elements.get(ref);
		const custom = binding?.customActions.get(action);
		const semantic = semanticAction(action);
		const advertised = binding?.element.actions ?? [];
		if (custom === undefined && semantic === undefined && !advertised.includes(action))
			unsupported(
				`AX action '${action}' on ${ref}; that row advertises ${
					advertised.length ? advertised.join(" · ") : "no actions"
				}, and perform also dispatches ${PERFORMABLE_ACTIONS.join(" · ")}`,
			);
		return this.#targetAction(
			context,
			"click",
			window,
			ref,
			{ action: custom ?? semantic ?? action, delivery_mode: "background" },
			window.id,
		);
	}
	hover(
		context: Context,
		_window: ComputerWindowIdentity,
		_x: number,
		_y: number,
		_options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(context, "hover", true, async () =>
			unsupported("window hover; move_cursor only moves an overlay in window scope"),
		);
	}
	/**
	 * A drag is a pixel gesture on both backends — neither driver takes a pair
	 * of elements — so a ref end is resolved to the point its own observed
	 * bounds name, exactly as a modified click is. Refusing a ref outright
	 * would be a harness limit, not a platform one: `drag` reads as
	 * ref-capable beside `click(token | [x,y])` and was used that way.
	 */
	drag(
		context: Context,
		window: ComputerWindowIdentity,
		from: ComputerTarget,
		to: ComputerTarget,
		options: ActionOptions & { durationMs?: number; steps?: number } = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(context, "drag", true, async () => {
			if (options.delivery !== "foreground") unsupported("background drag on macOS Cua; no input was sent");
			if (
				options.durationMs !== undefined &&
				(!Number.isInteger(options.durationMs) || options.durationMs < 0 || options.durationMs > 10000)
			)
				throw new ToolError("Drag durationMs must be an integer from 0 to 10000");
			if (
				options.steps !== undefined &&
				(!Number.isInteger(options.steps) || options.steps < 1 || options.steps > 200)
			)
				throw new ToolError("Drag steps must be an integer from 1 to 200");
			const current = await this.#current(window);
			const start = this.#target(current, this.#dragEnd(current, from, "from"));
			const end = this.#target(current, this.#dragEnd(current, to, "to"));
			throwIfAborted(context.signal);
			const result = await this.#action("drag", {
				...windowArgs(current),
				from_x: start.x,
				from_y: start.y,
				to_x: end.x,
				to_y: end.y,
				duration_ms: options.durationMs,
				steps: options.steps,
				modifier: options.modifiers,
				button: options.button,
				...delivery(options),
			});
			if (result.evidence !== null || result.effect !== "unverifiable") return result;
			this.#doubt(
				current.id,
				"a drag was delivered with no effect reported — re-read this window before building on it",
			);
			return { ...result, text: [result.text, UNPROBED_DRAG].filter(Boolean).join("\n") };
		});
	}
	scroll(
		context: Context,
		window: ComputerWindowIdentity,
		direction: "up" | "down" | "left" | "right",
		target?: ComputerTarget,
		options: ActionOptions & { amount?: number; by?: "line" | "page" } = {},
	): Promise<ComputerActionResult> {
		return this.#targetAction(context, "scroll", window, target, {
			direction,
			amount: options.amount,
			by: options.by,
			...delivery(options),
		});
	}
	setFrame(context: Context, window: ComputerWindowIdentity, frame: ComputerBounds): Promise<ComputerActionResult> {
		return this.#schedule(context, "setFrame", true, async () => {
			const current = await this.#current(window);
			this.#frames.delete(window.id);
			this.#invalidate(window);
			throwIfAborted(context.signal);
			return this.#action("set_window_frame", {
				...windowArgs(current),
				x: frame.x,
				y: frame.y,
				width: frame.width,
				height: frame.height,
			});
		});
	}
	/**
	 * The titles the refused path could have named. The driver lists them
	 * itself where it reports `items` for the level it failed at; otherwise
	 * they are read from the rendered menu bar of the same window it just
	 * resolved against. Neither path mints a ref or invalidates one.
	 */
	async #menuNames(window: ComputerWindowIdentity, menuPath: string[], error: ToolError): Promise<string | undefined> {
		const refusal = refusalDetails(error.context);
		if (refusal.code !== "menu_path_unavailable") return undefined;
		const refused = MENU_REFUSAL_SEGMENT.exec(error.message);
		const failed =
			typeof refusal.failed_segment === "number" ? refusal.failed_segment : refused ? Number(refused[1]) : undefined;
		if (failed === undefined || failed >= menuPath.length) return undefined;
		const ambiguous = refused?.[2] === "is ambiguous";
		const listed = menuItems(refusal.items);
		if (listed?.length) return menuRefusalItems(menuPath, failed, listed, ambiguous);
		const { data: state } = await this.#call("get_window_state", {
			...windowArgs(window),
			include_accessibility_tree: true,
			include_screenshot: false,
			max_depth: MENU_WALK_DEPTH,
		});
		if (typeof state.tree_markdown !== "string") return undefined;
		return menuRefusalNames(state.tree_markdown, menuPath, failed, ambiguous) || undefined;
	}
	menu(
		context: Context,
		window: ComputerWindowIdentity,
		menuPath: string[],
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(context, "menu", true, async () => {
			foreground(options);
			const current = await this.#current(window);
			throwIfAborted(context.signal);
			try {
				const result = await this.#action("invoke_menu", { ...windowArgs(current), path: menuPath });
				const data = result.data !== null && typeof result.data === "object" ? (result.data as Wire) : {};
				const listed = menuItems(data.items);
				if (!listed?.length) return result;
				const resolved = Array.isArray(data.resolved_path)
					? data.resolved_path.filter((segment): segment is string => typeof segment === "string")
					: menuPath;
				return { ...result, text: menuSubmenuListing(resolved, listed) };
			} catch (error) {
				// An aborted call is not a ToolError and keeps its own identity;
				// a refusal the menu bar cannot explain stays exactly as written.
				if (!(error instanceof ToolError)) throw error;
				const names = await this.#menuNames(current, menuPath, error).catch(() => undefined);
				throwIfAborted(context.signal);
				if (names === undefined) throw error;
				throw new ToolError(`${error.message}\n${names}`, error.context);
			}
		});
	}
	verify(
		context: Context,
		window: Pick<ComputerWindowIdentity, "id" | "pid">,
		expect: Record<string, unknown>[],
		options: { timeoutMs?: number; stableSamples?: number } = {},
	): Promise<VerificationResult> {
		return this.#schedule(context, "verify", false, async () => {
			windowArgs(window);
			this.#invalidate(window);
			const { data } = await this.#call("verify_state", {
				...windowArgs(window),
				expect,
				timeout_ms: options.timeoutMs,
				stable_samples: options.stableSamples,
				include_screenshot: false,
			});
			const status = (value: unknown): VerificationStatus => {
				if (value !== "satisfied" && value !== "unsatisfied" && value !== "unknown")
					throw new ToolError("Malformed Cua verification status");
				return value;
			};
			if (typeof data.stable !== "boolean" || !Array.isArray(data.predicates))
				throw new ToolError("Malformed Cua verification");
			return {
				status: status(data.status),
				stable: data.stable,
				elapsed_ms: number(data.elapsed_ms, "elapsed_ms"),
				samples: number(data.samples, "samples"),
				predicates: data.predicates.map(value => {
					const row = object(value, "predicate outcome");
					return {
						index: number(row.index, "predicate index"),
						status: status(row.status),
						unknown_reason: row.unknown_reason === null ? null : string(row.unknown_reason, "unknown_reason"),
						observed_json: row.observed_json === null ? null : string(row.observed_json, "observed_json"),
					};
				}),
			};
		});
	}
	raise(context: Context, window: ComputerWindowIdentity): Promise<ComputerActionResult> {
		return this.#schedule(context, "raise", true, async () => {
			const current = await this.#current(window);
			throwIfAborted(context.signal);
			return this.#action("bring_to_front", windowArgs(current));
		});
	}
	screenshot(context: Context, options: { silent?: boolean } = {}): Promise<ComputerImage> {
		return this.#schedule(context, "screenshot", false, async () => {
			this.#desktopFrame = undefined;
			const before = await this.#primaryDisplay();
			throwIfAborted(context.signal);
			const reply = await this.#call("get_desktop_state", {});
			const captured = primaryDisplay(reply.data, true);
			const after = await this.#primaryDisplay();
			if (before || captured || after) {
				if (!before || !captured || !after || !sameDisplay(before, captured) || !sameDisplay(captured, after))
					throw new ToolError("StaleFrame: primary display identity/geometry changed during capture");
				if (
					reply.data.screenshot_width !== Math.round(captured.bounds.width * captured.scale) ||
					reply.data.screenshot_height !== Math.round(captured.bounds.height * captured.scale)
				)
					throw new ToolError("StaleFrame: primary screenshot dimensions do not match the display geometry");
			}
			// `get_desktop_state` has no cap of its own and always answers at the
			// display's native pixels, so this is where the desktop frame comes
			// back to display points. The reported mode size is what makes that
			// grid knowable even on a driver that cannot identify the display —
			// such a capture is a picture only, never a coordinate frame.
			const mode = { width: Number(reply.data.screen_width), height: Number(reply.data.screen_height) };
			const image = await this.#saveImage(
				context,
				reply,
				"primary",
				options.silent === true,
				"display",
				mode.width > 0 && mode.height > 0 ? mode : undefined,
			);
			if (captured) this.#desktopFrame = { display: captured, image };
			return image;
		});
	}
	async #primaryDisplay(): Promise<PrimaryDisplay | undefined> {
		return primaryDisplay((await this.#call("get_screen_size", {})).data);
	}
	async #desktopPoints(context: Context, points: ComputerPoint[]): Promise<{ x: number; y: number }[]> {
		const frame = this.#desktopFrame;
		if (!frame)
			throw new ToolError(
				"MissingFrame: capture the primary desktop with an SDK that reports display identity before coordinate input",
			);
		try {
			const current = await this.#primaryDisplay();
			if (!current || !sameDisplay(frame.display, current))
				throw new ToolError("StaleFrame: primary display identity/geometry changed; capture it again");
		} catch (error) {
			this.#desktopFrame = undefined;
			throw error;
		}
		throwIfAborted(context.signal);
		const area = frame.display.bounds;
		return points.map(point => {
			const [x, y] = pointPair(point);
			if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= area.width || y >= area.height)
				throw new ToolError(
					`InvalidCoordinates: (${x}, ${y}) is outside the primary display's ${Math.round(area.width)}×${Math.round(area.height)} pt frame`,
				);
			// Desktop rungs read the native display PNG, so display points are
			// multiplied back up by the capture's own backing scale.
			return {
				x: (x * frame.image.sourceWidth) / area.width,
				y: (y * frame.image.sourceHeight) / area.height,
			};
		});
	}
	desktopClick(context: Context, x: number, y: number, options: ActionOptions = {}): Promise<ComputerActionResult> {
		return this.#schedule(context, "desktopClick", true, async () => {
			foreground(options);
			if (options.count !== undefined && (!Number.isSafeInteger(options.count) || options.count < 1))
				throw new ToolError("Click count must be a positive integer");
			const [point] = await this.#desktopPoints(context, [[x, y]]);
			return this.#action("click", {
				scope: "desktop",
				...point,
				button: options.button,
				count: options.count,
				modifier: options.modifiers,
				delivery_mode: "foreground",
			});
		});
	}
	desktopMove(context: Context, x: number, y: number, options: ActionOptions = {}): Promise<ComputerActionResult> {
		return this.#schedule(context, "desktopMove", true, async () => {
			foreground(options);
			const [point] = await this.#desktopPoints(context, [[x, y]]);
			const result = await this.#action("move_cursor", { scope: "desktop", ...point });
			return { ...result, delivery: "foreground" };
		});
	}
	desktopDrag(context: Context, points: ComputerPoint[], options: ActionOptions = {}): Promise<ComputerActionResult> {
		return this.#schedule(context, "desktopDrag", true, async () => {
			foreground(options);
			if (points.length !== 2)
				unsupported("desktop drag with anything other than two points; the SDK cannot preserve a multi-point path");
			const [start, end] = await this.#desktopPoints(context, points);
			return this.#action("drag", {
				scope: "desktop",
				from_x: start!.x,
				from_y: start!.y,
				to_x: end!.x,
				to_y: end!.y,
				modifier: options.modifiers,
				button: options.button,
				delivery_mode: "foreground",
			});
		});
	}
	desktopScroll(
		context: Context,
		x: number,
		y: number,
		options: { dx?: number; dy?: number; delivery?: "background" | "foreground" } = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(context, "desktopScroll", true, async () => {
			foreground(options);
			const dx = options.dx ?? 0;
			const dy = options.dy ?? 0;
			if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx !== 0 && dy !== 0))
				unsupported("desktop scroll must use one finite axis per action");
			const delta = dx || dy;
			if (delta === 0)
				return {
					text: "Zero scroll delta; no input dispatched.",
					effect: "unchanged",
					evidence: null,
					route: "no-op",
					delivery: "foreground",
				};
			if (delta % 120 !== 0 || Math.abs(delta) > 6000)
				unsupported("desktop scroll deltas must be multiples of 120 pixels, up to 6000, matching SDK line notches");
			const [point] = await this.#desktopPoints(context, [[x, y]]);
			return this.#action("scroll", {
				scope: "desktop",
				...point,
				direction: dx ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up",
				amount: Math.abs(delta) / 120,
				by: "line",
				delivery_mode: "foreground",
			});
		});
	}
	desktopType(context: Context, text: string, options: ActionOptions = {}): Promise<ComputerActionResult> {
		return this.#schedule(context, "desktopType", true, async () => {
			foreground(options);
			return this.#action("type_text", { scope: "desktop", text, delivery_mode: "foreground" });
		});
	}
	desktopPress(
		context: Context,
		chord: string | string[],
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(context, "desktopPress", true, async () => {
			foreground(options);
			const keys = chordKeys(chord, this.#platform);
			return this.#action(keys.length === 1 ? "press_key" : "hotkey", {
				scope: "desktop",
				...(keys.length === 1 ? { key: keys[0] } : { keys }),
				delivery_mode: "foreground",
			});
		});
	}
	clipboardRead(context: Context): Promise<string> {
		return this.#schedule(context, "clipboardRead", false, async () => {
			const { data } = await this.#call("clipboard_read", { include_text: true });
			return string(data.text, "clipboard text (clipboard may contain no plain text)");
		});
	}
	clipboardWrite(context: Context, text: string): Promise<ComputerActionResult> {
		return this.#schedule(context, "clipboardWrite", true, () => this.#action("clipboard_write", { text }));
	}
	launch(context: Context, options: ComputerLaunchOptions): Promise<ComputerActionResult> {
		return this.#schedule(context, "launch", true, async () => {
			let result: ComputerActionResult;
			try {
				result = await this.#action("launch_app", {
					bundle_id: options.bundleId,
					name: options.name,
					urls: options.urls,
					creates_new_application_instance: options.newInstance,
				});
			} catch (error) {
				// The driver reports an app that died during launch as a failed launch
				// (LAUNCH_TARGET_CHANGED, process_running:false). Its crash alert still
				// lands on the user's screen a moment later, so watch for it here too.
				const pid = launchedPid(error);
				if (pid === undefined) throw error;
				const alert = await this.#watchCrashAlert(context, pid);
				if (!alert) throw error;
				throw new ToolError(
					`${error instanceof Error ? error.message : String(error)}\n${crashAlertGuidance(pid, alert)}`,
					{ interruptedBy: alert },
				);
			}
			const data = result.data as { pid?: unknown } | undefined;
			const pid = typeof data?.pid === "number" ? data.pid : undefined;
			// An app that traps at startup queues a CrashReporter alert (UserNotificationCenter)
			// a moment after launch_app returns. Watch briefly so the crash surfaces as an
			// interruption naming the alert instead of a "launched" result that invites a retry.
			// macOS-only: no other platform draws that alert, and polling an
			// always-empty roster would only cost the launch two seconds.
			for (let waited = 0; this.#platform === "darwin" && !result.interruptedBy && waited < 2_000; waited += 250) {
				await Bun.sleep(250);
				throwIfAborted(context.signal);
				result.interruptedBy = this.#interruption();
			}
			if (result.interruptedBy) {
				result.text +=
					pid !== undefined && this.#recordCrashAlert(pid, result.interruptedBy)
						? `\n⚠️ ${crashAlertGuidance(pid, result.interruptedBy)}`
						: `\n⚠️ Interrupted after launch: ${describeInterruption(result.interruptedBy)}. Tell the user what is asking and wait; actions are refused until it is answered.`;
			}
			return result;
		});
	}
	/** Poll up to 2 s for the crash alert of a launched app that already died; macOS-only. */
	async #watchCrashAlert(context: Context, pid: number): Promise<ComputerInterruption | undefined> {
		if (this.#platform !== "darwin") return undefined;
		for (let waited = 0; waited < 2_000; waited += 250) {
			await Bun.sleep(250);
			throwIfAborted(context.signal);
			const interruption = this.#interruption();
			if (interruption && this.#recordCrashAlert(pid, interruption)) return interruption;
		}
		return undefined;
	}
	/**
	 * The alert is this session's to dismiss only when the app it launched is
	 * already gone and the alert host is CrashReporter's: a live app that raised
	 * a permission prompt is the user's call.
	 */
	#recordCrashAlert(pid: number, interruption: ComputerInterruption): boolean {
		if (processAlive(pid) || interruption.app.trim().toLowerCase() !== CRASH_ALERT_HOST) return false;
		this.#crashAlerts.add(interruption.windowId);
		return true;
	}
	async drain(): Promise<void> {
		await this.#tail;
	}
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		this.#closing = (async () => {
			await this.#tail;
			try {
				await this.#driver.kill();
			} finally {
				this.#elements.clear();
				this.#frames.clear();
				this.#documents.clear();
				this.#desktopFrame = undefined;
			}
		})();
		return this.#closing;
	}
}

/** Default backend factory: one vendored driver child per session. */
export const createCuaBackend: ComputerBackendFactory = options =>
	CuaComputerSession.create({ display: options.display });
