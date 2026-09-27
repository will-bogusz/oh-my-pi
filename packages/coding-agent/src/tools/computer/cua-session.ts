import * as os from "node:os";
import * as path from "node:path";
import type { DesktopCapabilities, DesktopDisplay } from "@oh-my-pi/pi-natives";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { resizeImage } from "../../utils/image-resize";
import { renderNode, type TreeNode } from "../observed-tree";
import { throwIfAborted } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ComputerBackend, ComputerBackendFactory } from "./backend";
import { type CuaDriver, type CuaDriverFactory, type CuaToolResult, spawnVendoredCuaDriver } from "./driver";
import {
	classifyWindow,
	describeInterruption,
	rosterInterruption,
	sampleWindowRoster,
	type WindowRosterSample,
} from "./interruption";
import {
	actionEvidence,
	deadElement,
	escalation,
	type Facts,
	INCOMPLETE_TYPING,
	incompleteNote,
	MENU_BAR_ROLES,
	MENU_REFUSAL_SEGMENT,
	menuBarRoute,
	menuRefusalItems,
	menuSubmenuListing,
	preludeVocabulary,
	readReply,
	refusalNote,
	renderedRole,
	SEARCH_FIELD,
	specificRole,
	UNPROBED_DRAG,
	unproven,
	type Wire,
	type WriteFacts,
	writeNote,
} from "./render";
import { appWindows } from "./roster";
import { normalizeQuery, reopenRoute } from "./selectors";
import { PERFORMABLE_ACTIONS, observedActions, semanticAction } from "./semantic-actions";
import type {
	ActionOptions,
	TypeOptions,
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
interface Reply {
	result: CuaToolResult;
	data: Wire;
}
/**
 * What a row is, independently of the reference that reached it: its own
 * role, label and value, the path of roles and labels above it, and its
 * position among the siblings that share its role. Role and label alone are
 * not an identity — measured, `AXCheckBox "Mark as completed"` matched three
 * rows of one Reminders list, and the single match at this layer was a
 * different reminder.
 */
interface ElementIdentity {
	role: string;
	label: string;
	value?: string;
	path: readonly string[];
	ordinal: number;
}
interface Binding {
	window: ComputerWindowIdentity;
	token: string;
	snapshotId: string;
	element: ComputerElementSnapshot;
	identity: ElementIdentity;
	/** An app's own action names, each against the wire string that invokes it. */
	customActions: ReadonlyMap<string, string>;
	doubleClickAtCenter: boolean;
}
interface TreeNote {
	depth: number;
	text: string;
	/**
	 * Text the window itself renders, as opposed to a note this session wrote
	 * about the row. A query reads the first and not the second: "5 of 12 rows
	 * are scrolled out of view" is the harness talking.
	 */
	content?: true;
}
interface TreeRow {
	depth: number;
	element: ComputerElementSnapshot;
	notes?: readonly TreeNote[];
}
/** What a query found in the sheets drawn modal over the window being read. */
interface SheetCensus {
	/** `sheet "Save" (window 42)`, however many the walk reported. */
	label: string;
	rows: number;
	matched: number;
}
/**
 * Where a row sits, independently of what it holds: its role, its label, the
 * chain of roles and labels above it and its position among the siblings
 * that share its role. A dead ref's census counts the rows of a fresh tree
 * that sit where it did; nothing is ever re-addressed by it.
 */
function placeKey(identity: ElementIdentity): string {
	return JSON.stringify([identity.role, identity.label, identity.ordinal, identity.path]);
}
/**
 * Descendants printed under one matched row. A matched container answered
 * with its own existence and nothing else: the bench asked an open popover
 * for its contents, was told `AXPopover ""` and 121 rows hidden, and spent
 * two cells recovering — one of them re-querying with five guessed words.
 *
 * 12 is the smallest bound that keeps every expansion the leg's own queries
 * ask for whole (the widest is the 10-row popover above, replayed under the
 * literal semantics this reads) while bounding the row a query can land on
 * by accident: a window title or a role matches the root, whose subtree is
 * the whole tree in 119 of 129 walks, and container subtrees reach 333 rows.
 */
const SUBTREE_MAX_ROWS = 12;
/**
 * Rows a window the app opened is printed with under its opener. A save or
 * open panel runs to hundreds of rows; its buttons and fields come first.
 */
const INLINE_WINDOW_ROWS = 40;
/**
 * The rows a query keeps: every row one of its literals matches
 * (case-insensitive substring over what the row prints, including the
 * window's own text carried beneath it), the ancestors that place it, and
 * what the matched row itself holds, bounded by `SUBTREE_MAX_ROWS` and
 * counted where the bound bit. Projecting here keeps one semantics for both
 * platforms and lets the observation say what it hid.
 *
 * The literals arrive already normalised, so a string is one substring and
 * nothing about the row's own text is unsearchable: splitting the string on
 * `|` first made a query unable to ask for a pipe — a Chrome tab titled
 * "Order Status | Peptaura" could not be named — and made one parameter mean
 * two things. Alternation lives in the parameter instead, as an array.
 */
function projectRows(
	rows: readonly TreeRow[],
	query: readonly string[],
): { rows: TreeRow[]; matched: number; shown: number } {
	const hits = (row: TreeRow): boolean => {
		const haystack = [
			row.element.role,
			row.element.subrole,
			row.element.label,
			row.element.value,
			row.element.placeholder,
			row.element.description,
			row.element.help,
			...(row.notes ?? []).filter(note => note.content === true).map(note => note.text),
		]
			.filter((text): text is string => typeof text === "string" && text.length > 0)
			.join("\n")
			.toLowerCase();
		return query.some(literal => haystack.includes(literal));
	};
	const kept = new Set<number>();
	const open: number[] = [];
	// Where each row's own subtree ends, from the same stack that places its
	// ancestors: a row is a container exactly when the next row is deeper.
	const ends = new Array<number>(rows.length).fill(rows.length);
	const matches: number[] = [];
	rows.forEach((row, index) => {
		while (open.length && rows[open[open.length - 1]!]!.depth >= row.depth) ends[open.pop()!] = index;
		if (hits(row)) {
			matches.push(index);
			kept.add(index);
			for (const ancestor of open) kept.add(ancestor);
		}
		open.push(index);
	});
	const capped = new Map<number, number>();
	let shown = 0;
	matches.forEach((match, order) => {
		const end = ends[match]!;
		// The deeper match is the specific answer: expanding a match that
		// contains another one re-prints the tree around it.
		if ((matches[order + 1] ?? end) < end) return;
		const last = Math.min(end, match + 1 + SUBTREE_MAX_ROWS);
		for (let index = match + 1; index < last; index++) kept.add(index);
		shown += last - match - 1;
		if (end > last) capped.set(match, end - last);
	});
	const projected: TreeRow[] = [];
	rows.forEach((row, index) => {
		if (!kept.has(index)) return;
		const suppressed = capped.get(index);
		if (suppressed === undefined) {
			projected.push(row);
			return;
		}
		// A note, not a row: the elider reads it as prose, so the count
		// survives even where the rows it counts were dropped again.
		projected.push({
			...row,
			notes: [
				...(row.notes ?? []),
				{
					depth: row.depth + 1,
					text: `${suppressed} more row${suppressed === 1 ? "" : "s"} under this one ${
						suppressed === 1 ? "was" : "were"
					} not shown — drop the query to read them.`,
				},
			],
		});
	});
	return { rows: projected, matched: matches.length, shown };
}
/** The role a provider gives a window's own root row, in both vocabularies. */
const WINDOW_ROW_ROLES: Record<string, true> = { AXWindow: true, frame: true, window: true };
/**
 * Whether one reply's two titles for the same window disagree: the roster's,
 * which the reply's header prints, and the one the window's own tree row
 * carries. A settled window publishes the same string twice — the roster
 * reads the window server's name for it and the walk reads the app's — so a
 * pair that disagrees is a window caught mid-transition, with a header
 * describing the state the tree has not reached yet (the bench read `Notes:
 * Search` over a tree titled `Bench – 80 notes`, the pre-search list, and
 * spent a cell on the re-observe that returned the found row).
 *
 * One title containing the other is agreement, not disagreement: an app that
 * suffixes its document name or drops an em-dash section between the two
 * surfaces is not mid-anything, and re-sampling it every time would tax
 * every chained read of that window.
 */
function titlesDisagree(title: string, rows: readonly TreeRow[]): boolean {
	const row = rows.find(entry => WINDOW_ROW_ROLES[entry.element.role] === true)?.element.label;
	if (row === undefined) return false;
	const header = title.trim().toLowerCase();
	const tree = row.trim().toLowerCase();
	if (!header || !tree) return false;
	return !header.includes(tree) && !tree.includes(header);
}
/** A window caught mid-transition is re-sampled once: the settle, and the whole budget for it. */
const RESAMPLE_SETTLE_MS = 250;
const RESAMPLE_BUDGET_MS = 1000;
/** The window's frame moved while it was being read, so the read describes no one frame. */
class GeometryChangedError extends ToolError {}
/**
 * Actions every row of some family advertises, whatever it does: `press` on
 * a menu item, `show_menu` on any node with a context menu, the scroll and
 * UI-visibility verbs AppKit publishes on everything. Printing them cost one
 * print-pane walk 46 kB of `actions=["press","show_menu"]` without naming
 * anything a reader could not have assumed, and `perform` dispatches them on
 * rows that never advertised them anyway. What is left is what this app
 * authored: `open`, an app's own verb.
 */
const IMPLICIT_ACTIONS: Record<string, true> = {
	press: true,
	show_menu: true,
	confirm: true,
	cancel: true,
	pick: true,
	AXShowDefaultUI: true,
	AXShowAlternateUI: true,
	AXRaise: true,
	AXScrollToVisible: true,
	AXScrollLeftByPage: true,
	AXScrollRightByPage: true,
	AXScrollUpByPage: true,
	AXScrollDownByPage: true,
};
/** One walked row in the grammar both observation surfaces print. */
function rowNode(depth: number, element: ComputerElementSnapshot): TreeNode {
	const states: string[] = [];
	// Said only where they carry news: a row is enabled and unselected until
	// it says otherwise, and the old render spent two words per row on that.
	if (element.enabled === false) states.push("disabled");
	if (element.selected === true) states.push("selected");
	if (element.settable === true) states.push("settable");
	const extras: string[] = [];
	if (element.placeholder !== undefined) extras.push(`placeholder=${JSON.stringify(element.placeholder)}`);
	const actions = element.actions?.filter(action => IMPLICIT_ACTIONS[action] !== true) ?? [];
	if (actions.length) extras.push(`actions=${actions.join(",")}`);
	// The tooltip is this row's description when it has none of its own; one
	// that repeats the label is the label twice, and the renderer drops it.
	const description = element.description ?? element.help;
	const value = element.value === "" || element.value === element.label ? undefined : element.value;
	return {
		depth,
		role: renderedRole(specificRole(element)),
		name: element.label,
		...(value === undefined ? {} : { value }),
		...(description === undefined ? {} : { description }),
		states,
		...(extras.length ? { extras } : {}),
	};
}
/**
 * The length one line of a window's own text prints to. A window renders
 * prose nobody asked it for — one print pane carried an 8.5 kB article
 * paragraph — and a text row exists to say what the window says, not to
 * deliver the document: `read` and the page itself are the routes to that.
 */
const TEXT_ROW_MAX = 160;
function capText(text: string): string {
	return text.length > TEXT_ROW_MAX ? `${text.slice(0, TEXT_ROW_MAX)}\u2026` : text;
}
function treeRows(rows: readonly TreeRow[], indent: number): string {
	return rows
		.flatMap(({ depth, element, notes }) => [
			`${"  ".repeat(depth + indent)}${renderNode(rowNode(depth, element), element.ref)}`,
			// A row the window rendered prints as one; a note this session wrote
			// about the tree is parenthesised, so the two never read alike.
			...(notes ?? []).map(
				note => `${"  ".repeat(note.depth + indent)}${note.content === true ? note.text : `(${note.text})`}`,
			),
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
const DISPLAY_TREE_ROW = /^((?: {2})*)- (?!\[)(\S.*)$/;
/** The driver's own grammar for a node it gave no action: role, optional label, optional value. */
const DISPLAY_NODE = /^(AX\w+)(?: "((?:[^"\\]|\\.)*)")?(?: = "((?:[^"\\]|\\.)*)")?/;
function jsonBody(body: string | undefined): string {
	if (!body) return "";
	try {
		return String(JSON.parse(`"${body}"`));
	} catch {
		return body;
	}
}
/** One display-only markdown line, in the grammar the rows around it print. */
function displayRow(line: string): string | undefined {
	const parsed = DISPLAY_NODE.exec(line);
	// A line the driver wrote in some other shape is still text the window
	// showed: print it whole rather than lose it to a grammar mismatch.
	if (!parsed) return `text ${JSON.stringify(capText(line))}`;
	const label = jsonBody(parsed[2]);
	const value = jsonBody(parsed[3]);
	// Static text carries its string as a value and usually has no label at
	// all, so the value is the name unless the node named itself first.
	const name = label || value;
	if (!name) return undefined;
	return renderNode(
		{
			depth: 0,
			role: renderedRole(parsed[1]!),
			name: capText(name),
			...(value && value !== name ? { value: capText(value) } : {}),
			states: [],
		},
		undefined,
	);
}
/**
 * The text a window renders without offering any action on it — a version
 * string, a heading, a status line, the label of a row that is not selectable
 * — anchored to the nearest actionable row above it. The driver's structured
 * `elements` array carries actionable nodes alone (`element_index: null` for
 * the rest) and prints the others only in its markdown, so a tree built from
 * `elements` said nothing about text the window was plainly showing, and the
 * model went to the pixels for a string it had already been sent.
 *
 * Every such line is printed, because what a window says is half of what it
 * is and a reader that has to screenshot for it pays far more than the rows
 * cost. A query filters them: then the question is whether this window says
 * one particular thing, not what it says.
 */
function displayTextNotes(markdown: unknown, query: readonly string[] | undefined): ReadonlyMap<number, TreeNote[]> {
	const notes = new Map<number, TreeNote[]>();
	if (typeof markdown !== "string") return notes;
	let anchor = -1;
	for (const line of markdown.split("\n")) {
		const indexed = INDEXED_TREE_ROW.exec(line);
		if (indexed) {
			anchor = Number(indexed[1]);
			continue;
		}
		const display = DISPLAY_TREE_ROW.exec(line);
		if (!display || COLLAPSED_TREE_ROW.test(line)) continue;
		const text = displayRow(display[2]!);
		if (text === undefined) continue;
		if (query !== undefined && !query.some(literal => text.toLowerCase().includes(literal))) continue;
		const note = { depth: display[1]!.length / 2, text, content: true as const };
		const listed = notes.get(anchor);
		if (listed) listed.push(note);
		else notes.set(anchor, [note]);
	}
	return notes;
}
/**
 * How to reach the rows a walk did not read. Scrolling always works; the
 * window's own search field is the cheaper route, and this observation is the
 * only thing that knows whether there is one — the footer named it on every
 * clipped list, so a caller went hunting for a control the tree never printed
 * and paid 2 cells a run for the hunt. A field the walk reports disabled is
 * not a route either: a window that is not key publishes its search control
 * as `enabled=false` and refuses the write.
 */
function searchRoute(rows: readonly TreeRow[]): string {
	const field = rows.find(row => specificRole(row.element) === SEARCH_FIELD && row.element.enabled !== false)?.element;
	return field === undefined
		? "Scroll the list to reach them."
		: `Scroll the list, or narrow it with this window's own search field: win.ref(${JSON.stringify(
				field.ref,
			)}).type("<query>").`;
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
/**
 * The windows this walk drew into its own tree because the application
 * reports them modal over the one that was asked for. A tolerant read: an
 * unrecognised row costs the reply nothing, because the only thing this
 * decides is whether a gained window is announced as somewhere to go or as
 * something already in front of the caller.
 */
function modalWindows(value: unknown): ReadonlySet<string> | undefined {
	if (!Array.isArray(value)) return undefined;
	const ids = new Set<string>();
	for (const row of value) {
		if (typeof row !== "object" || row === null) continue;
		const id = (row as Wire).window_id;
		if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) ids.add(String(id));
	}
	return ids.size ? ids : undefined;
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
const DETECT_WINDOW_CHANGE_TOOLS: Record<string, true> = {
	click: true,
	drag: true,
	hotkey: true,
	press_key: true,
	scroll: true,
	set_value: true,
	type_text: true,
};
function unsupported(operation: string): never {
	throw new ToolError(`Unsupported Cua operation: ${operation}`);
}
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
 * Display enumeration/capture/input cover the primary display only.
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
	 * Which live pids the apps roster gives each bundle id it was asked about,
	 * lower-cased. Read on a miss and consulted by the roster filter, which is
	 * synchronous and runs again inside one acquisition.
	 */
	readonly #bundlePids = new Map<string, ReadonlySet<number>>();
	/**
	 * Windows one of this session's dispatches has changed since their last
	 * read. A tree walked while the app is still applying that change is a
	 * window mid-transition, which is worth one re-sample; a window nothing
	 * touched is not, however its two titles read. Set by the dispatch, spent
	 * by the next read of that window.
	 */
	readonly #mutated = new Set<string>();
	/** Windows whose hidden-menu-bar hint an observation has already printed. */
	readonly #menuBarHinted = new Set<string>();
	/**
	 * Windows an app opened while one of its windows was being worked in, by
	 * id, each against that opener: they render under it on every read while
	 * they stay on screen, and its handle drives their refs.
	 */
	readonly #inline = new Map<string, string>();
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
			unsupported: linux
				? ["displays", "desktop-root input", "interruption detection"]
				: ["secondary display enumeration/capture/input"],
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
			// The window macOS injects into a process under a screen-capture
			// lease: on layer 0, indistinguishable from an app window in every
			// field a roster row carries, and nobody's. Only the driver holding
			// the lease can name it, and it does — so this reads its
			// classification instead of re-deriving it from title and geometry,
			// which also hid an app window that happened to share both.
			if (row.kind === "system_overlay") {
				artifacts.add(String(number(row.window_id, "window_id")));
				continue;
			}
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
				// Two kinds only the driver can name: a display's desktop surface
				// (the icons, filed at the desktop icon level with no AXWindow of
				// its own) and a window its own application reports modal, which
				// blocks that application and nothing else. Every other kind is
				// classified here from the owner, and an owner's off-screen
				// placeholder window is not the panel itself.
				kind:
					row.kind === "desktop"
						? ("desktop" as const)
						: row.kind === "app-modal"
							? ("app-modal" as const)
							: onScreen.has(String(row.window_id))
								? classifyWindow({ app: string(row.app_name, "app_name") })
								: ("other" as const),
			};
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
				// A display's desktop surface is filed under Finder and is never a
				// window of the app a selector names — by name or by the pid a
				// launch answered with; it is acquired by kind or by its exact id.
				(window.kind !== "desktop" ||
					selector.kind === "desktop" ||
					selector.id !== undefined ||
					(selector.app === undefined && selector.pid === undefined)) &&
				(selector.app === undefined ||
					window.app.toLowerCase().includes(selector.app.toLowerCase()) ||
					this.#bundlePids.get(selector.app.toLowerCase())?.has(window.pid) === true) &&
				(selector.title === undefined || window.title.toLowerCase().includes(selector.title.toLowerCase())) &&
				(selector.kind === undefined || window.kind === selector.kind),
		);
	}
	/**
	 * Which live processes an app bundle id names. A window roster reports the
	 * display name and nothing else (`list_windows` `app_name`), so the
	 * identifier `launch_app` takes and a model reaches for when a display
	 * name is ambiguous — `{ app: "com.apple.systempreferences" }` — matched
	 * no window however long it waited, and read as "that app is not running".
	 * The apps roster is the one place the two are tied together. It is read
	 * only after the name itself matched nothing, so a name that matched pays
	 * for none of this, and the answer is remembered for the re-filters the
	 * same acquisition runs.
	 */
	async #bundleIdPids(bundleId: string): Promise<ReadonlySet<number>> {
		const pids = new Set<number>();
		try {
			const { data } = await this.#call("list_apps", {});
			if (Array.isArray(data.apps))
				for (const value of data.apps) {
					if (typeof value !== "object" || value === null) continue;
					const row = value as Wire;
					if (
						typeof row.bundle_id === "string" &&
						row.bundle_id.toLowerCase() === bundleId.toLowerCase() &&
						typeof row.pid === "number" &&
						row.pid > 0
					)
						pids.add(row.pid);
				}
		} catch (error) {
			if (!(error instanceof ToolError)) throw error;
		}
		this.#bundlePids.set(bundleId.toLowerCase(), pids);
		return pids;
	}
	async #windows(selector: WindowSelector = {}): Promise<ComputerWindowIdentity[]> {
		const { data } = await this.#call("list_windows", selector.pid === undefined ? {} : { pid: selector.pid });
		const sample = this.#roster();
		const matches = this.#windowRoster(data, selector, sample);
		if (matches.length || selector.app === undefined) return matches;
		return (await this.#bundleIdPids(selector.app)).size ? this.#windowRoster(data, selector, sample) : matches;
	}
	/**
	 * Acquisition is the first call of every native run, so both failures name
	 * their own way out. Nothing matched: an `{ app }` selector may name an app
	 * that is not running, which `{ launch: true }` starts and acquires in the
	 * same call. What else is open is not named here — the runtime appends that
	 * roster to every miss it reports, because only it knows whether a launch
	 * was refused, impossible, or opened nothing. Several matched: one line per
	 * candidate with the exact id to acquire, so picking one costs no
	 * `windows()` round trip.
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
		return `- id ${JSON.stringify(window.id)} pid ${window.pid} ${window.app} ${JSON.stringify(window.title)} ${
			window.bounds.width
		}×${window.bounds.height} at (${window.bounds.x},${window.bounds.y})${
			window.onScreen === false ? " offscreen" : ""
		}${window.kind !== undefined && window.kind !== "other" ? ` kind=${window.kind}` : ""}`;
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
		desktop: boolean,
	): ToolError {
		const app = matches[0]?.app ?? roster[0]?.app ?? "The target process";
		const rows = matches.length ? matches : roster;
		const backed = roster.filter(window => window.axBacked !== false);
		return new ToolError(
			`${app}: pid ${pid} has ${roster.length} WindowServer row${roster.length === 1 ? "" : "s"}${
				desktop ? " besides the display's desktop surface" : ""
			} and ${
				backed.length
					? `${backed.length} accessibility window${backed.length === 1 ? "" : "s"}, none of them among the ${rows.length} this selector matched`
					: "no accessibility window"
			}; every input route to ${rows.length === 1 ? "it" : "them"} is refused. ${
				backed.length
					? `Acquire one of its accessibility windows by id instead: ${appWindows(backed)}.`
					: `Bring it to this Space, or, if it opens windows for a document or folder, ${reopenRoute(app)}; then acquire again.`
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
		// The desktop is behind every window by construction and is acquired
		// by name (`{ kind: "desktop" }`), never as an app's front window.
		const shown = matches.filter(window => window.minimized !== true && window.kind !== "desktop");
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
					// Readability is a per-row fact: a desktop surface is AX-backed
					// without being an AXWindow, so `ax.windows` being empty does not
					// mean every row is dead — only a match set with no backed row is.
					const applicationWindows = matches.filter(window => window.axBacked !== false);
					if (!applicationWindows.length)
						throw this.#inputDead(
							pid!,
							matches,
							annotated,
							this.#windowRoster(data, { pid, kind: "desktop" }, sample).length > 0,
						);
					// AX and CG are sequential snapshots. Missing CG identities mean
					// the mapping cannot safely disambiguate this acquisition.
					if ([...ax.windows.keys()].every(id => roster.some(window => window.id === id))) matches = applicationWindows;
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
	 * One window by selector: an exact `{ id, pid }` re-resolves a handle the
	 * caller already holds (every prelude window method carries one), anything
	 * else acquires a window.
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
	/** Retires every ref of this window: each read the caller asks for starts a new generation. */
	#invalidate(window: Pick<ComputerWindowIdentity, "id" | "pid">): void {
		for (const [ref, binding] of this.#elements)
			if (binding.window.id === window.id && binding.window.pid === window.pid) this.#elements.delete(ref);
	}
	/**
	 * Every refusal this session composes itself carries the same structured
	 * payload a driver refusal does: a guarded dispatch that catches one had
	 * only the message string, and a caught `StaleRef` read as an addressing
	 * problem rather than a row that is gone.
	 */
	#binding(ref: string, window?: ComputerWindowIdentity): Binding {
		const binding = this.#elements.get(ref);
		if (this.#closed || !binding)
			throw new ToolError(`StaleRef: ${ref} — ${this.#staleSheetRefs.get(ref) ?? "observe the window again"}`, {
				code: "stale_element_ref",
				effect: "not_dispatched",
				ref,
				...(window === undefined ? {} : { window_id: window.id, pid: window.pid }),
			});
		if (
			window &&
			(binding.window.pid !== window.pid ||
				(binding.window.id !== window.id &&
					this.#sheets.get(binding.window.id)?.parent !== window.id &&
					this.#inline.get(binding.window.id) !== window.id))
		)
			throw new ToolError("WrongWindow: element belongs to a different PID/window", {
				code: "wrong_window",
				effect: "not_dispatched",
				ref,
				element_window_id: binding.window.id,
				element_pid: binding.window.pid,
				window_id: window.id,
				pid: window.pid,
			});
		return binding;
	}
	element(ref: string, window?: ComputerWindowIdentity): ComputerElementSnapshot {
		return this.#binding(ref, window).element;
	}
	elementWindow(ref: string): ComputerWindowIdentity {
		return this.#binding(ref).window;
	}

	async observe(
		context: Context,
		window: ComputerWindowIdentity,
		options: ObserveOptions = {},
	): Promise<ComputerObservation> {
		// One normalisation for the walk, the projection and the sheet census:
		// the literals every matcher in this read tests against.
		const query = options.query === undefined ? undefined : normalizeQuery(options.query);
		return this.#schedule(context, "observe", false, async () => {
			const read = {
				include_accessibility_tree: true,
				include_screenshot: options.screenshot === true,
				max_depth: options.maxDepth,
				max_elements: options.maxElements,
			};
			// A read chained onto a mutation can reach the app mid-transition,
			// and the reply says so itself: the header's title and the tree's
			// own window row disagree. One re-sample returns the settled tree in
			// the same cell, which is what the model spent its next cell on.
			let settling = this.#mutated.delete(window.id);
			const started = Date.now();
			this.#invalidate(window);
			// A read the window's frame moved under (seen right after a launch)
			// is refused by the geometry check. It minted nothing, so the same
			// window is simply read once more after the settle; a second move
			// stands. That re-read is the observation's one re-sample.
			let { reply, current } = await this.#state(context, window, read).catch(async (error: unknown) => {
				if (!(error instanceof GeometryChangedError)) throw error;
				settling = false;
				await Bun.sleep(RESAMPLE_SETTLE_MS);
				throwIfAborted(context.signal);
				return await this.#state(context, window, read);
			});
			let walked = this.#walk(current, reply, options, query);
			if (settling && titlesDisagree(current.title, walked.rows)) {
				const settle = Math.min(RESAMPLE_SETTLE_MS, RESAMPLE_BUDGET_MS - (Date.now() - started));
				if (settle > 0) {
					await Bun.sleep(settle);
					throwIfAborted(context.signal);
					this.#invalidate(window);
					({ reply, current } = await this.#state(context, window, read));
					walked = this.#walk(current, reply, options, query);
				}
			}
			const { menuBarRows, snapshotId } = walked;
			const projected = query === undefined ? undefined : projectRows(walked.rows, query);
			const rows = projected?.rows ?? walked.rows;
			// Only the walker knows whether it clipped the tree, and both pinned
			// builds say so in `truncated` whenever a walk ran. Equal
			// returned/total counts prove nothing: both count what the walk
			// reached, so every budget-capped walk would call itself complete.
			const complete =
				reply.data.ax_walk_timed_out !== true &&
				reply.data.ax_walk_stop_reason == null &&
				reply.data.truncated === false;
			const observation: ComputerObservation = {
				snapshotId,
				window: current,
				elements: rows.map(row => row.element),
				complete,
				// Why the walk stopped short, where the reply says so: the Linux
				// driver names it; a budget the caller set is proven hit when the
				// walk returned that many rows. Timeouts, stop reasons and
				// scrolled-out rows print their own lines below.
				...(reply.data.truncated === true && typeof reply.data.truncation_reason === "string"
					? { truncation: reply.data.truncation_reason }
					: reply.data.truncated === true &&
							options.maxElements !== undefined &&
							typeof reply.data.returned_element_count === "number" &&
							reply.data.returned_element_count >= options.maxElements
						? { truncation: "element budget reached" }
						: {}),
				backgroundInput: reply.data.background_input ?? null,
				relatedWindows: relatedWindows(reply.data.related_windows),
				tree: "",
			};
			// This window's sheets, as of this walk: a sheet that has gone away
			// must stop excluding an id acquisition could pick, and the refs it
			// minted must say which surface took them with it. Read before the
			// window's own rows are judged, because while a sheet is modal it is
			// the surface the question is about: a census of the rows it covers
			// is not an answer, and the bench was told to scroll a sidebar that
			// the sheet holding its match had made unreachable.
			const attached = observation.relatedWindows ?? [];
			for (const [id, sheet] of this.#sheets)
				if (sheet.parent === current.id && !attached.some(row => row.id === id)) this.#retireSheet(id, sheet.title);
			const sheets: string[] = [];
			const names: string[] = [];
			let modal: SheetCensus | undefined;
			for (const sheet of attached) {
				this.#sheets.set(sheet.id, { parent: current.id, title: sheet.title });
				// A sheet the roster listed before it reported attaching (the
				// read right after the command that opened it) was taken for a
				// window this app opened; it prints once, as the sheet, or the
				// second walk's refs would retire the ones printed here.
				this.#inline.delete(sheet.id);
				let block = `sheet ${JSON.stringify(sheet.title)} (window ${sheet.id}) — modal over window ${current.id}`;
				try {
					const nested = await this.#sheetRows(context, sheet, options, query);
					observation.elements.push(...nested.map(row => row.element));
					if (nested.length) block += `\n${treeRows(nested, 1)}`;
					if (query !== undefined) {
						names.push(`${JSON.stringify(sheet.title)} (window ${sheet.id})`);
						modal = {
							label: `sheet${names.length === 1 ? "" : "s"} ${names.join(", ")}`,
							rows: (modal?.rows ?? 0) + nested.length,
							matched: (modal?.matched ?? 0) + projectRows(nested, query).matched,
						};
					}
				} catch (error) {
					if (!(error instanceof ToolError)) throw error;
					block += ` — its own walk failed: ${error.message}`;
				}
				sheets.push(block);
			}
			const parent = rows.length
				? treeRows(rows, 0)
				: typeof reply.data.degraded_reason === "string"
					? reply.data.degraded_reason
					: query !== undefined
						? this.#queryMiss(current, reply, options, complete, walked.rows.length, modal)
						: "No accessibility elements returned; completeness is unknown.";
			// A projection hides controls the next step may need (the bench lost
			// a Save button and an add menu to one); the count says so, and says
			// how much of what the matched rows hold it printed under them.
			const hidden =
				projected !== undefined && projected.matched > 0 && walked.rows.length > rows.length
					? `Query ${JSON.stringify(options.query)} matched ${projected.matched} of ${walked.rows.length} rows (ancestors kept${
							projected.shown > 0 ? `, ${projected.shown} row${projected.shown === 1 ? "" : "s"} shown under them` : ""
						}); ${walked.rows.length - rows.length} hidden — drop the query to read them.`
					: undefined;
			// Said once per window: the route is the prompt's to teach, and the
			// same sentence on every read was the largest line of boilerplate.
			const menuBarHint = menuBarRows > 0 && !this.#menuBarHinted.has(current.id);
			if (menuBarHint) this.#menuBarHinted.add(current.id);
			observation.tree = [
				...sheets,
				parent,
				hidden,
				menuBarHint
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
				observation.tree += `\n${reply.data.collapsed_rows} row(s) are scrolled out of view and were not read. ${searchRoute(
					rows,
				)}`;
			// Document apps: the app's own dirty bit and file path (absent = the app
			// reports neither). AX value writes never reach disk, so this is how the
			// model tells "text changed" from "saved". A line is printed only for
			// a fact: a path, or unsaved changes.
			if (typeof reply.data.document_path === "string") observation.documentPath = reply.data.document_path;
			if (typeof reply.data.document_edited === "boolean") observation.documentEdited = reply.data.document_edited;
			if (observation.documentPath !== undefined || observation.documentEdited === true)
				observation.tree += `\nDocument: ${observation.documentPath ?? "(path unknown)"}${observation.documentEdited === true ? " — unsaved changes" : ""}`;
			// Windows this app opened while this one was being worked in render
			// under it, like its sheets, for as long as they stay on screen: the
			// caller drives them through this handle's refs instead of spending
			// a call to acquire each one.
			const roster = this.#lastRoster.get(current.pid) ?? [];
			for (const window of this.#gained(current.pid, roster, current.id, modalWindows(reply.data.modal_windows)))
				this.#inline.set(window.id, current.id);
			const inline = roster.filter(window => this.#inline.get(window.id) === current.id && window.onScreen !== false);
			for (const [id, opener] of this.#inline)
				if (opener === current.id && !inline.some(window => window.id === id)) this.#inline.delete(id);
			for (const window of inline) {
				let block = `window ${window.id} ${JSON.stringify(window.title)} — opened by this app, driven through this window's refs`;
				try {
					const nested = await this.#sheetRows(context, window, options, query);
					const shown = nested.slice(0, INLINE_WINDOW_ROWS);
					observation.elements.push(...shown.map(row => row.element));
					if (shown.length) block += `\n${treeRows(shown, 1)}`;
					if (nested.length > shown.length)
						block += `\n  (${nested.length - shown.length} more rows; computer.window(${JSON.stringify(window.id)}) reads it whole)`;
				} catch (error) {
					if (!(error instanceof ToolError)) throw error;
					block += ` — its own walk failed: ${error.message}`;
				}
				observation.tree += `\n${block}`;
			}
			// An observation is the model's picture of the environment; a system
			// prompt over it is part of that picture even though the AX tree of
			// the target window looks entirely normal underneath.
			observation.interruptedBy = this.#interruption();
			if (observation.interruptedBy)
				observation.tree += `\n⚠️ Interrupted: ${describeInterruption(observation.interruptedBy)}. Actions on any window are refused until it is answered; tell the user what is asking.`;
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
	 *
	 * A modal sheet moves the whole census onto itself. What it covers is not
	 * reachable until it is answered, so the rows behind it are neither the
	 * place to look nor the place to scroll — the bench was told to scroll 22
	 * out-of-view rows of the window under an open panel that held its match.
	 */
	#queryMiss(
		window: ComputerWindowIdentity,
		reply: Reply,
		options: ObserveOptions,
		complete: boolean,
		rowsRead: number,
		modal?: SheetCensus,
	): string {
		const query = JSON.stringify(options.query);
		const widen = `widen it — a query is a case-insensitive substring; pass an array to search for any of several`;
		if (modal)
			return modal.matched > 0
				? `No row of window ${window.id} itself matched query ${query}; ${modal.matched} row(s) of the ${modal.label} modal over it match and are printed above — work in the sheet while it is up.`
				: `No row matched query ${query} in the ${modal.label} modal over window ${window.id} ${JSON.stringify(
						window.title,
					)} (${window.app}): its walk read ${modal.rows} row${modal.rows === 1 ? "" : "s"}. Next: drop the query to read the sheet whole, or ${widen}. The window behind it takes no input until the sheet is answered, so its own rows are not the place to look.`;
		const read =
			typeof reply.data.total_element_count === "number"
				? reply.data.total_element_count
				: typeof reply.data.element_count === "number"
					? reply.data.element_count
					: rowsRead || undefined;
		const collapsed = typeof reply.data.collapsed_rows === "number" ? reply.data.collapsed_rows : 0;
		const verdict = reply.data.truncated === true ? "truncated" : complete ? "complete" : "not proven complete";
		const text = typeof reply.data.tree_markdown === "string" ? " and every line of text it renders" : "";
		const walked =
			read === undefined
				? `the walk reported no row count${text}`
				: `the walk read ${read} actionable row${read === 1 ? "" : "s"}${text}`;
		const next =
			collapsed > 0
				? `scroll the list first — ${collapsed} row(s) are out of view and were not read — or drop the query to read what is on screen`
				: `drop the query to read the whole tree, or ${widen}${
						options.menubar === true ? "" : "; observe({ menubar: true }) adds the menu bar"
					}`;
		return `No row matched query ${query} under window ${window.id} ${JSON.stringify(
			window.title,
		)} (${window.app})${options.menubar === true ? " and its menu bar" : ""}: ${walked} and reported the tree ${verdict}. Next: ${next}.`;
	}
	#walk(
		window: ComputerWindowIdentity,
		reply: Reply,
		options: ObserveOptions,
		query?: readonly string[],
	): { rows: TreeRow[]; menuBarRows: number; snapshotId: string } {
		if (!Array.isArray(reply.data.elements)) throw new ToolError("Malformed Cua elements");
		// A real window can have no matching AXWindow at all (canvas/custom UI).
		// Preserve visual access without fabricating an actionable SDK snapshot.
		const snapshotId = typeof reply.data.snapshot_id === "string" ? reply.data.snapshot_id : "unavailable";
		if (snapshotId === "unavailable" && reply.data.elements.length)
			throw new ToolError("Cua elements have no snapshot identity");
		const rows: TreeRow[] = [];
		const roots = new Map<string, number>();
		const ancestry: { depth: number; key: string; siblings: Map<string, number> }[] = [];
		const collapsed =
			typeof reply.data.collapsed_rows === "number" && reply.data.collapsed_rows > 0
				? collapsedRowNotes(reply.data.tree_markdown)
				: undefined;
		// What the window says: the markdown is the one place the driver prints
		// a node it gave no action, and a tree of the controls alone leaves out
		// the version string, the status line and every label beside them.
		const text = displayTextNotes(reply.data.tree_markdown, query);
		// The menu bar is a fifth of a macOS tree (22 kB of one 31 kB walk),
		// every row of it advertises `press`, and every such press is refused
		// because a menu bar item reports `AXEnabled` only while its menu is
		// open. `menu(path)` drives it instead, so the rows stay out unless
		// they are asked for, and a ref is never minted for one.
		// A menu bar's descendants are known by ancestry where the driver
		// reports `parent_index` (the desktop surface's icons sit deeper than
		// the menu bar without being under it), by depth where it does not.
		const menuBarIndices = new Set<number>();
		const ancestryReported = reply.data.elements.some(
			value => typeof value === "object" && value !== null && typeof (value as Wire).parent_index === "number",
		);
		let menuBarDepth: number | undefined;
		let menuBarRows = 0;
		for (const value of reply.data.elements) {
			const row = object(value, "element");
			const depth = typeof row.depth === "number" ? Math.max(0, Math.min(50, Math.floor(row.depth))) : 0;
			const index = typeof row.element_index === "number" ? row.element_index : undefined;
			const parent = typeof row.parent_index === "number" ? row.parent_index : undefined;
			// With ancestry reported, a row without a parent index hangs off a
			// non-actionable node and is a root of its own, never a menu row.
			const underMenuBar = ancestryReported
				? parent !== undefined && menuBarIndices.has(parent)
				: menuBarDepth !== undefined && depth > menuBarDepth;
			if (underMenuBar) {
				if (index !== undefined) menuBarIndices.add(index);
				menuBarRows++;
				continue;
			}
			menuBarDepth = undefined;
			if (options.menubar !== true && MENU_BAR_ROLES[string(row.role, "role")] === true) {
				menuBarDepth = depth;
				if (index !== undefined) menuBarIndices.add(index);
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
			const role = string(row.role, "role");
			const actions = observedActions(row.background_actions ?? row.actions, [...custom.keys()]);
			const element = Object.freeze({
				ref,
				pid: window.pid,
				windowId: window.id,
				role,
				label: typeof row.label === "string" ? row.label : "",
				...(typeof row.subrole === "string" && row.subrole ? { subrole: row.subrole } : {}),
				...(typeof row.value === "string" ? { value: row.value } : {}),
				...(typeof row.placeholder === "string" ? { placeholder: row.placeholder } : {}),
				// Semantics the provider authored but role/label do not carry. An
				// empty string is the driver's way of saying "none"; the driver
				// already drops a description that repeats the label, and one
				// that repeats the value is as much noise.
				...(typeof row.help === "string" && row.help ? { help: row.help } : {}),
				...(typeof row.description === "string" && row.description && row.description !== row.value
					? { description: row.description }
					: {}),
				...(typeof row.enabled === "boolean" ? { enabled: row.enabled } : {}),
				...(typeof row.selected === "boolean" ? { selected: row.selected } : {}),
				// A control whose value the provider will accept. Said only where
				// it is true, because it is the difference between a row to write
				// to and a row to drive with keys: a date area or a stepper reads
				// like a text field and refuses typing.
				...(row.value_settable === true ? { settable: true as const } : {}),
				...(actions?.length ? { actions } : {}),
				...(row.frame ? { bounds: bounds(row.frame) } : {}),
			});
			while (ancestry.length && ancestry[ancestry.length - 1]!.depth >= depth) ancestry.pop();
			const siblings = ancestry[ancestry.length - 1]?.siblings ?? roots;
			const ordinal = siblings.get(role) ?? 0;
			siblings.set(role, ordinal + 1);
			const identity: ElementIdentity = {
				role,
				label: element.label,
				...(element.value === undefined ? {} : { value: element.value }),
				path: ancestry.map(entry => entry.key),
				ordinal,
			};
			ancestry.push({ depth, key: `${role} ${JSON.stringify(element.label)}`, siblings: new Map() });
			this.#elements.set(ref, {
				window,
				token,
				snapshotId,
				element,
				identity,
				customActions: custom,
				doubleClickAtCenter: reply.data.element_double_click === "left_center_v1",
			});
			const anchored = index ?? -1;
			const notes = [...(collapsed?.get(anchored) ?? []), ...(text?.get(anchored) ?? [])];
			rows.push(notes.length ? { depth, element, notes } : { depth, element });
		}
		return { rows, menuBarRows, snapshotId };
	}
	async #sheetRows(
		context: Context,
		sheet: Pick<ComputerWindowIdentity, "id" | "pid">,
		options: ObserveOptions,
		query?: readonly string[],
	): Promise<TreeRow[]> {
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
		return this.#walk(window, reply, options, query).rows;
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
			throw new GeometryChangedError("StaleFrame: window geometry changed during observation");
		return { reply, current: after };
	}
	/**
	 * Write one delivered capture at the surface's own point size and hand it
	 * to the model. The driver already caps what it sends, so the resize here
	 * is a no-op on the window path and the only downscale on the desktop
	 * path, which has no cap of its own. The byte budget is deliberately
	 * loose: a capture that loses dimensions to compression would silently
	 * leave the point grid the coordinate contract rests on.
	 *
	 * `surface` is the rect the pixels cover, which is the window's own
	 * frame only while nothing is hanging over it, and `origin` is where
	 * that rect's top-left sits in the window's points — zero, or negative
	 * once the capture reaches outside the window.
	 */
	async #saveImage(
		context: Context,
		reply: Reply,
		target: string,
		silent: boolean,
		kind: "window" | "display",
		surface?: Surface,
		label?: string,
		origin?: { x: number; y: number },
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
			originX: origin?.x ?? 0,
			originY: origin?.y ?? 0,
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
		// What the pixels are of. The window server draws the popovers and
		// menus an application hangs over a window into that window's
		// capture, so the frame is wider than the window whenever one is
		// open; reading the image against the window's own bounds is what
		// labelled a 0.77x picture "1 px = 1 window point". Absent on the
		// platforms that do not publish it, where the window is the frame.
		const covered = reply.data.screenshot_content_bounds === undefined
			? window.bounds
			: bounds(reply.data.screenshot_content_bounds);
		const image = await this.#saveImage(
			context,
			reply,
			window.id,
			silent,
			"window",
			covered,
			`${window.app}: ${window.title || "Untitled window"}`,
			{ x: covered.x - window.bounds.x, y: covered.y - window.bounds.y },
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
			return this.#windowImage(context, current, reply, options.silent === true);
		});
	}
	/**
	 * One action's target. A point is window-local, in points — the same grid
	 * an element's own bounds are in — and the driver reads its pixel rungs in
	 * the frame it delivered. So the conversion moves the point into that
	 * frame first (`image.originX/Y` is where the frame's top-left sits in the
	 * window's points, zero unless the capture reached outside the window) and
	 * then scales it by the delivered pixels over the frame's points: identity
	 * whenever the capture is the window, point-for-point.
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
			x: ((x - frame.image.originX) * frame.sdkWidth) / frame.image.pointWidth,
			y: ((y - frame.image.originY) * frame.sdkHeight) / frame.image.pointHeight,
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
	 * What the pid put on screen that the caller has never seen: its
	 * on-screen windows that its last observation did not have. `observed` is
	 * the window being read, which is looked at rather than announced, and
	 * `rendered` the windows that walk already drew into its own tree. A
	 * display's desktop surface is no window an app opened.
	 */
	#gained(
		pid: number,
		roster: readonly ComputerWindowIdentity[],
		observed?: string,
		rendered?: ReadonlySet<string>,
	): ComputerWindowIdentity[] {
		const before = this.#observedRoster.get(pid);
		if (!before) return [];
		return roster.filter(
			window =>
				window.onScreen !== false &&
				window.kind !== "desktop" &&
				!before.has(window.id) &&
				!this.#sheets.has(window.id) &&
				window.id !== observed &&
				rendered?.has(window.id) !== true,
		);
	}
	/**
	 * An action's windows the pid gained, as a fact about the app: which
	 * window, and nothing about what to do with it. The handle it acted
	 * through is never rebound; the next read of the opener renders them.
	 */
	async #openedWindows(pid: number | undefined): Promise<string | undefined> {
		if (pid === undefined || !this.#observedRoster.has(pid)) return undefined;
		let roster: ComputerWindowIdentity[];
		try {
			roster = await this.#windows({ pid });
		} catch (error) {
			if (!(error instanceof ToolError)) throw error;
			return undefined;
		}
		const opened = this.#gained(pid, roster);
		if (!opened.length) return undefined;
		return opened
			.map(
				window => `pid ${pid} gained window ${window.id} (${JSON.stringify(window.title)}) since your last observation.`,
			)
			.join("\n");
	}
	/** Whether this session's own roster holds the window that id names. */
	#holdsWindow(id: string): boolean {
		for (const rows of this.#lastRoster.values()) if (rows.some(row => row.id === id)) return true;
		return false;
	}
	#refForToken(token: unknown): string | undefined {
		if (typeof token !== "string") return undefined;
		for (const [ref, binding] of this.#elements) if (binding.token === token) return ref;
		return undefined;
	}
	/** What the renderer needs of this call and of the window it addressed. */
	#facts(tool: string, text: string, args: Wire, addressed = this.#refForToken(args.element_token)): Facts {
		const windowId = typeof args.window_id === "number" ? String(args.window_id) : undefined;
		const rows: (readonly [string, ComputerElementSnapshot])[] = [];
		if (windowId !== undefined)
			for (const [ref, binding] of this.#elements)
				if (binding.window.id === windowId) rows.push([ref, binding.element]);
		return {
			tool,
			text,
			foreground: args.delivery_mode === "foreground",
			windowId,
			pid: typeof args.pid === "number" ? args.pid : undefined,
			addressed,
			element: addressed === undefined ? undefined : this.#elements.get(addressed)?.element,
			rows,
			captured: windowId !== undefined && this.#frames.has(windowId),
			holds: id => this.#holdsWindow(id),
			sheets: this.#sheets,
		};
	}
	/**
	 * One dispatch and its reply, said once: the driver's own sentence, then
	 * the line each renderer has to add, a window the app gained meanwhile,
	 * and system UI that appeared while it ran. The pre-dispatch gate cleared
	 * the screen a moment ago, so a blocking window found now appeared while
	 * this action ran; the action is not retracted, and the next mutation is
	 * refused until it goes away. Whatever the reply leaves unproven, and any
	 * line composed here, rides the must-show flag, so the cell prints it even
	 * where the code drops the returned value.
	 */
	async #action(name: string, args: Wire): Promise<ComputerActionResult> {
		let called: Reply;
		try {
			called = await this.#call(
				name,
				DETECT_WINDOW_CHANGE_TOOLS[name] === true ? { ...args, detect_window_change: false } : args,
			);
		} catch (error) {
			if (!(error instanceof ToolError)) throw error;
			const reply = readReply(error.context);
			const lines = [
				error.message,
				actionEvidence(reply, typeof args.delivery_mode === "string" ? args.delivery_mode : undefined),
				refusalNote(reply, this.#facts(name, error.message, args)),
			];
			throw new ToolError(lines.filter(line => line !== undefined).join("\n"), error.context);
		}
		const { result, data } = called;
		const reply = readReply(data);
		const interruptedBy = this.#interruption();
		// The driver writes its own advice in wire vocabulary on the success path
		// too ("click this control's pixel center with delivery_mode:foreground");
		// a next step is only executable if it is spelled the way the caller types.
		const reported = preludeVocabulary(result.text);
		const escalated = escalation(reply, this.#facts(name, reported, args));
		const opened = await this.#openedWindows(typeof args.pid === "number" ? args.pid : undefined);
		// A window one of this session's dispatches changed is re-read once if
		// the next walk catches it mid-transition.
		if (
			DETECT_WINDOW_CHANGE_TOOLS[name] === true &&
			typeof args.window_id === "number" &&
			reply.effect !== "not_dispatched"
		)
			this.#mutated.add(String(args.window_id));
		const notes = [
			escalated,
			opened,
			interruptedBy
				? `⚠️ Interrupted while acting: ${describeInterruption(interruptedBy)}. Stop and tell the user; further actions are refused until it is answered.`
				: undefined,
		].filter(line => line !== undefined);
		return {
			text: [reported, ...notes].filter(Boolean).join("\n"),
			effect: reply.effect ?? "unverifiable",
			evidence: data.evidence ?? null,
			route: reply.route ?? "cua-sdk",
			delivery: data.delivery ?? args.delivery_mode ?? "background",
			...(reply.committed === undefined ? {} : { committed: reply.committed }),
			...(escalated === undefined ? {} : { escalation: escalated }),
			...(notes.length > 0 || reply.effect === undefined || unproven(reply) ? { mustShow: true } : {}),
			interruptedBy,
			data,
		};
	}
	/**
	 * A ref whose element the platform can no longer reach. The refusal is
	 * about one row and says nothing about the window, yet throwing it
	 * discarded the whole tree: every bench refusal of this shape was
	 * followed by a bare `observe()` whose only job was to recover what the
	 * throw dropped. So the window is read once — the caller has to re-read
	 * it either way — and the reply is the ordinary non-throwing shape for
	 * "this did not land": nothing dispatched, the current tree in hand, and a
	 * census of what the fresh tree holds where the dead row sat. Nothing is
	 * re-addressed: the caller names the row it means.
	 *
	 * That walk is this session's, not the caller's, so it retires only the
	 * dead ref. Every other ref stays bound to the exact element its
	 * observation minted it for: one whose element died too refuses the same
	 * way, and one whose element lives still reaches exactly that element.
	 *
	 * Only where a re-read can answer, which the reply says (`deadElement`).
	 */
	async #deadElement(
		error: ToolError,
		args: Wire,
		target: ComputerTarget | undefined,
		recover: { context: Context; window: ComputerWindowIdentity } | undefined,
	): Promise<ComputerActionResult | undefined> {
		const reply = readReply(error.context);
		if (!deadElement(reply)) return undefined;
		if (recover === undefined || typeof target !== "string" || typeof args.element_token !== "string")
			return undefined;
		const binding = this.#elements.get(target);
		this.#elements.delete(target);
		let rows: readonly TreeRow[];
		try {
			const { reply: state, current } = await this.#state(recover.context, recover.window, {
				include_accessibility_tree: true,
				include_screenshot: false,
			});
			throwIfAborted(recover.context.signal);
			rows = this.#walk(current, state, {}).rows;
		} catch (failed) {
			if (!(failed instanceof ToolError)) throw failed;
			return undefined;
		}
		const snapshot = binding?.element;
		const named =
			snapshot === undefined
				? target
				: `${target} (${snapshot.role}${snapshot.label ? ` ${JSON.stringify(snapshot.label)}` : ""})`;
		const identity = binding?.identity;
		const under = identity?.path.at(-1);
		const fresh = rows.flatMap(row => {
			const minted = this.#elements.get(row.element.ref)?.identity;
			return minted === undefined ? [] : [minted];
		});
		const place = identity === undefined ? undefined : placeKey(identity);
		const placed = place === undefined ? 0 : fresh.filter(row => placeKey(row) === place).length;
		const sameName =
			identity === undefined
				? 0
				: fresh.filter(row => row.role === identity.role && row.label === identity.label).length;
		const census =
			identity === undefined
				? "no identity for it was recorded"
				: sameName === 0
					? "no row of the fresh tree carries its role and label"
					: `the fresh tree has ${sameName} row(s) with its role and label, ${
							placed ? `${placed} of them` : "none"
						} in the same position${under ? ` under ${under}` : ""}`;
		const readdress = rows.length
			? `${target} is retired; the tree below carries new refs for this window — address the row you mean by its new ref. Your other refs keep the exact elements they were minted for until your next observe.`
			: `${target} is retired and this walk minted no refs to address — observe the window again (win.observe()) once it has rows.`;
		const text = `${reply.code}: ${named} no longer exists in window ${recover.window.id} and nothing was dispatched — ${census}. ${readdress}\n${
			rows.length ? treeRows(rows, 0) : "No accessibility elements returned; completeness is unknown."
		}`;
		return {
			text,
			effect: "not_dispatched",
			evidence: null,
			delivery: args.delivery_mode ?? null,
			...(reply.route === undefined ? {} : { route: reply.route }),
			mustShow: true,
			data: reply.data,
		};
	}
	/** Dispatch that can answer a refusal the reply's own row explains. */
	async #dispatch(
		name: string,
		args: Wire,
		target: ComputerTarget | undefined,
		recover?: { context: Context; window: ComputerWindowIdentity },
	): Promise<ComputerActionResult> {
		// The addressed row as its observation printed it, read before a
		// dead-element recovery retires its binding.
		const element = typeof target === "string" ? this.#elements.get(target)?.element : undefined;
		try {
			return await this.#action(name, args);
		} catch (error) {
			// An aborted call is not a ToolError and keeps its own identity.
			if (!(error instanceof ToolError)) throw error;
			const gone = await this.#deadElement(error, args, target, recover);
			if (gone !== undefined) return gone;
			const route = menuBarRoute(element);
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
				return this.#dispatch(name, { ...this.#target(current, target), ...args }, target, {
					context,
					window: current,
				});
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
					{ context, window: current },
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
	 * What a write is now known to be, said once with its own reply: the
	 * driver's sentence and the write renderer's one line, which rides the
	 * must-show flag so a cell that drops the returned value still prints it.
	 * The field is named as the observation printed it before the dispatch.
	 */
	async #write(
		window: ComputerWindowIdentity,
		operation: "setValue" | "type",
		target: ComputerTarget | undefined,
		value: string,
		dispatched: Promise<ComputerActionResult>,
	): Promise<ComputerActionResult> {
		const element = typeof target === "string" ? this.#elements.get(target)?.element : undefined;
		const facts = (text: string): WriteFacts => ({
			...this.#facts(
				operation === "type" ? "type_text" : "set_value",
				text,
				{ window_id: Number(window.id), pid: window.pid },
				typeof target === "string" ? target : undefined,
			),
			element,
			operation,
			target,
		});
		try {
			const result = await dispatched;
			const note = writeNote(result, facts(result.text));
			if (note === undefined) return result;
			return { ...result, text: result.text ? `${result.text}\n${note}` : note, mustShow: true };
		} catch (error) {
			if (!(error instanceof ToolError) || !error.message.startsWith(INCOMPLETE_TYPING)) throw error;
			const note = incompleteNote(facts(error.message), value, error.message, readReply(error.context));
			throw new ToolError(`${error.message}\n${note}`, error.context);
		}
	}
	type(
		context: Context,
		window: ComputerWindowIdentity,
		text: string,
		target?: ComputerTarget,
		options: TypeOptions = {},
	): Promise<ComputerActionResult> {
		// The caret goes to the driver as given: it places it through AX, reads
		// it back and refuses with a typed code when it cannot, so the session
		// has nothing to add.
		const caret = options.caret === undefined ? {} : { caret: options.caret };
		return this.#write(
			window,
			"type",
			target,
			text,
			this.#targetAction(context, "type_text", window, target, { text, ...caret, ...delivery(options) }),
		);
	}
	setValue(
		context: Context,
		window: ComputerWindowIdentity,
		ref: string,
		value: string,
	): Promise<ComputerActionResult> {
		return this.#write(
			window,
			"setValue",
			ref,
			value,
			this.#targetAction(context, "set_value", window, ref, { value }),
		);
	}
	press(
		context: Context,
		window: ComputerWindowIdentity,
		chord: string | string[],
		target?: ComputerTarget,
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		const keys = chordKeys(chord, this.#platform);
		return this.#targetAction(context, keys.length === 1 ? "press_key" : "hotkey", window, target, {
			...(keys.length === 1 ? { key: keys[0] } : { keys }),
			...delivery(options),
		});
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
			return { ...result, text: [result.text, UNPROBED_DRAG].filter(Boolean).join("\n"), mustShow: true };
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
	 * The titles the refused path could have named, as the driver lists them
	 * for the level it stopped resolving at. Nothing is walked for them.
	 */
	#menuNames(menuPath: string[], error: ToolError): string | undefined {
		const reply = readReply(error.context);
		if (reply.code !== "menu_path_unavailable" || !reply.items?.length) return undefined;
		const refused = MENU_REFUSAL_SEGMENT.exec(error.message);
		const failed = reply.failedSegment ?? (refused ? Number(refused[1]) : undefined);
		if (failed === undefined || failed >= menuPath.length) return undefined;
		return menuRefusalItems(menuPath, failed, reply.items, refused?.[2] === "is ambiguous");
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
				const reply = readReply(result.data);
				if (!reply.items?.length) return result;
				return {
					...result,
					text: menuSubmenuListing(reply.resolvedPath ?? menuPath, reply.items),
					mustShow: true,
				};
			} catch (error) {
				// An aborted call is not a ToolError and keeps its own identity;
				// a refusal the driver lists no items for stays exactly as written.
				if (!(error instanceof ToolError)) throw error;
				const names = this.#menuNames(menuPath, error);
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
			const raised = await this.#action("bring_to_front", windowArgs(current));
			const holder = refusalNote(
				readReply(raised.data),
				this.#facts("bring_to_front", raised.text, windowArgs(current)),
			);
			if (holder === undefined) return raised;
			return { ...raised, text: raised.text ? `${raised.text}\n${holder}` : holder };
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
			// An app that traps at startup queues a CrashReporter alert
			// (UserNotificationCenter) a moment after launch_app returns, so the
			// crash surfaces as an interruption naming the alert instead of a
			// "launched" result that invites a retry. Only a launched process that
			// is already gone can have raised it, so only then is it waited for
			// (macOS-only; see #watchCrashAlert) — a live launch pays nothing.
			if (!result.interruptedBy && pid !== undefined && !processAlive(pid))
				result.interruptedBy = await this.#watchCrashAlert(context, pid);
			if (result.interruptedBy) {
				result.mustShow = true;
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
				this.#desktopFrame = undefined;
			}
		})();
		return this.#closing;
	}
}

/** Default backend factory: one vendored driver child per session. */
export const createCuaBackend: ComputerBackendFactory = options =>
	CuaComputerSession.create({ display: options.display });
