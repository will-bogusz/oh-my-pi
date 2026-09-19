/**
 * What a driver reply is said to mean: the readers that take a reply off the
 * wire and the sentences composed from what they read. Nothing here touches
 * the driver or the session; `cua-session.ts` supplies the call and the
 * session facts and prints what comes back.
 */
import type { ComputerActionResult, ComputerCommitVerdict, ComputerElementSnapshot, ComputerTarget } from "./types";

export type Wire = Record<string, unknown>;
function record(value: unknown): Wire | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Wire) : undefined;
}
/**
 * A subrole that ends in its own role's stem says nothing the row has not
 * already printed — `AXRow`/`AXTableRow`, `AXWindow`/`AXStandardWindow` — and
 * a captured 1558-node Notes window carries 164 of those against 9 that name a
 * different control class, 3.1 kB of a 33 kB tree under a 50 kB cap. The
 * driver's own markdown drops them on the same predicate; the snapshot keeps
 * the raw value either way, so `find` is unaffected.
 */
export function specificRole(element: ComputerElementSnapshot): string {
	const subrole = element.subrole;
	return subrole === undefined || subrole.endsWith(element.role.slice(2)) ? element.role : subrole;
}
/**
 * Three rewrites of driver-authored text, all about a call the caller has to
 * be able to type. The driver advertises its own wire vocabulary in refusal
 * text and escalation advice (`delivery_mode: "foreground"`) where the prelude
 * takes `{ delivery: "foreground" }`. It names a screenshot as the only check
 * for an unverified pixel dispatch, which on this surface is the expensive
 * one — an AX read answers the same question and the model followed the
 * sentence literally, spending a capture where `observe({ query })` would have
 * done. And the keystroke paths name a screenshot for a field whose `AXValue`
 * they could not read at all: there a capture really is the only witness, so
 * that one keeps the screenshot and only gains the spelling of the call that
 * takes one. The last one deletes rather than restates: `bring_to_front` is
 * not a call this surface has, and the disabled-control refusal offered it as
 * half of a two-route sentence whose other half this file rewrites — so the
 * translation made exactly the followable half of untrue advice easier to
 * follow. What is true of that refusal is composed from its own state by
 * the refusal rows of the table. Structured details stay verbatim on the
 * error's context.
 */
const DELIVERY_MODE_VOCABULARY = /delivery_mode\s*:\s*"(background|foreground)"/g;
const SCREENSHOT_CHECK = /not driver-verified\s*[—-]\s*confirm via screenshot/g;
const SCREENSHOT_WITNESS = /verify via screenshot/g;
const BRING_TO_FRONT_ADVICE = /,?\s*(?:or|and)\s+call bring_to_front first/g;
export function preludeVocabulary<T>(value: T): T {
	if (typeof value === "string")
		return value
			.replace(DELIVERY_MODE_VOCABULARY, '{ delivery: "$1" }')
			.replace(
				SCREENSHOT_CHECK,
				"not driver-verified — confirm with observe({ query }) or, on a pixel surface, a screenshot",
			)
			.replace(SCREENSHOT_WITNESS, "confirm with observe({ screenshot: true })")
			.replace(BRING_TO_FRONT_ADVICE, "") as T;
	if (Array.isArray(value)) return value.map(entry => preludeVocabulary(entry)) as T;
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, preludeVocabulary(entry)])) as T;
	return value;
}
/** macOS rows whose `AXPress` needs the menu already open; see `menuBarRoute`. */
export const MENU_BAR_ROLES: Record<string, true> = { AXMenuBar: true, AXMenuBarItem: true };
/** Rows whose `AXEnabled` tracks the command's applicability; see the disabled refusal rows. */
const MENU_ROLES: Record<string, true> = {
	AXMenu: true,
	AXMenuBar: true,
	AXMenuBarItem: true,
	AXMenuItem: true,
};
/** macOS reports a search field as this subrole on a plain `AXTextField`. */
export const SEARCH_FIELD = "AXSearchField";
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
export const MENU_REFUSAL_SEGMENT = /path segment (\d+) (was not found|is ambiguous)/;
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
export const MENU_WALK_DEPTH = 3;
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
export function menuRefusalNames(
	markdown: string,
	path: readonly string[],
	failed: number,
	ambiguous: boolean,
): string {
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
export function menuItems(value: unknown): MenuItem[] | undefined {
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
export function menuSubmenuListing(path: readonly string[], items: readonly MenuItem[]): string {
	const leaf = items.find(item => !item.submenu) ?? items[0]!;
	return `${path.join(" › ")} is a submenu; nothing was invoked. Its items: ${menuItemTitles(items)}. Invoke one with win.menu(${JSON.stringify([...path, leaf.title])}, { delivery: "foreground" }); a name marked › lists its own items the same way.`;
}
export function menuRefusalItems(
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
 * The escalation a reply names. `target` is the contract's field; `recommended`
 * is what the untyped replies still write, in the driver's older spellings
 * (`get_window_state`, `px`), and both name the same rung. `reason` is a
 * contract token (`delivery_failed`, `effect_unconfirmed`) on a typed reply and
 * the fork's own prose on an untyped one; it is rendered in front of the route
 * and it decides one of them.
 */
export interface Escalation {
	readonly target: string;
	readonly reason: string | undefined;
}
const ESCALATION_TARGET_ALIASES: Readonly<Record<string, string>> = { get_window_state: "snapshot", px: "pixel" };
function readEscalation(data: Wire): Escalation | undefined {
	const row = record(data.escalation);
	if (row === undefined) return undefined;
	const target = typeof row.target === "string" ? row.target : row.recommended;
	if (typeof target !== "string") return undefined;
	return {
		target: ESCALATION_TARGET_ALIASES[target] ?? target,
		reason: typeof row.reason === "string" ? row.reason : undefined,
	};
}
/**
 * The app's own window drawn in front of the one a call addressed. Before
 * 0.9.0 `bring_to_front` reported it in `observed.process_frontmost_ordinary_
 * window_id` alone; `obscured_by` is contract vocabulary rather than a
 * generated type, so every field is read defensively.
 */
export interface Panel {
	readonly id: string;
	/** It publishes no accessibility window of its own. */
	readonly blind: boolean;
	readonly title: string | undefined;
	readonly role: string | undefined;
	readonly subrole: string | undefined;
}
function readPanel(data: Wire): Panel | undefined {
	const observed = record(data.observed) ?? {};
	const row = record(data.obscured_by) ?? {};
	const id =
		typeof row.window_id === "number"
			? String(row.window_id)
			: typeof observed.process_frontmost_ordinary_window_id === "number"
				? String(observed.process_frontmost_ordinary_window_id)
				: undefined;
	if (id === undefined) return undefined;
	return {
		id,
		blind: row.ax_backed === false,
		title: typeof row.title === "string" && row.title ? row.title : undefined,
		role: typeof row.role === "string" && row.role ? row.role : undefined,
		subrole: typeof row.subrole === "string" && row.subrole ? row.subrole : undefined,
	};
}
/**
 * `set_value` and `type_text` write a value and then judge whether the app's
 * own editing pipeline kept it, reporting that judgement in `committed`. Only
 * that verdict separates a written field from a lost one: a value the pipeline
 * never accepted still reads back correctly through the AX tree, and a
 * Save-panel filename written that way was discarded. The contract publishes
 * it as one of three words; the stock 0.28.0 binary published a boolean, whose
 * two states are the two decided verdicts. A driver that judges none reports
 * nothing.
 */
const COMMIT_VERDICTS: Readonly<Record<string, ComputerCommitVerdict>> = {
	committed: "committed",
	not_committed: "not_committed",
	unproven: "unproven",
};
function commitVerdict(value: unknown): ComputerCommitVerdict | undefined {
	if (typeof value === "string") return COMMIT_VERDICTS[value];
	if (typeof value === "boolean") return value ? "committed" : "not_committed";
	return undefined;
}
/** The rung a reply names, in either shape the drivers report it: a bare string or `{ mode }`. */
function evidenceDelivery(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	const mode = record(value)?.mode;
	return typeof mode === "string" ? mode : undefined;
}
const strings = (value: unknown): readonly string[] | undefined =>
	Array.isArray(value) ? value.filter((segment): segment is string => typeof segment === "string") : undefined;
/**
 * One action reply as the contract types it, read off the wire once. A
 * refusal nests its own row under `refusal`; it is folded over the envelope,
 * so the same reader serves a success, a refusal and the reply of a
 * `bring_to_front` that names the window in front.
 */
export interface ActionReply {
	/** The details as the driver sent them, a nested `refusal` folded over the envelope. */
	readonly data: Wire;
	/** The refusal's code; absent on a success. */
	readonly code: string | undefined;
	readonly effect: string | undefined;
	readonly route: string | undefined;
	/** The rung it delivered on. */
	readonly delivery: string | undefined;
	readonly committed: ComputerCommitVerdict | undefined;
	readonly escalation: Escalation | undefined;
	readonly evidence: unknown;
	/** The evidence carries the driver's read-back of the value it wrote. */
	readonly readBack: boolean;
	/** The menu titles a `menu_command` reply dispatched, top level first. */
	readonly menuPath: readonly string[] | undefined;
	/** A background refusal's own route, where it names one. */
	readonly advice: string | undefined;
	readonly panel: Panel | undefined;
	readonly focusedWindowId: string | undefined;
	readonly frontInProcess: boolean;
	/** The addressed row's role, where the refusal names it. */
	readonly role: string | undefined;
	/** `invoke_menu`: the segment its path stopped resolving at, and the items of that level. */
	readonly failedSegment: number | undefined;
	readonly items: readonly MenuItem[] | undefined;
	readonly resolvedPath: readonly string[] | undefined;
}
/** Whether the reply carries the driver's read-back of the value it wrote. */
function valueReadBack(evidence: unknown): boolean {
	const rows = Array.isArray(evidence) ? (evidence as unknown[]) : [evidence];
	return rows.some(row => record(row)?.kind === "value_readback");
}
export function readReply(details: unknown): ActionReply {
	const envelope = record(details) ?? {};
	const nested = record(envelope.refusal);
	const data = nested === undefined ? envelope : { ...envelope, ...nested };
	const menuPath = data.route === "menu_command" ? strings(data.menu_path) : undefined;
	return {
		data,
		code: typeof data.code === "string" ? data.code : undefined,
		effect: typeof data.effect === "string" ? data.effect : undefined,
		route: typeof data.route === "string" ? data.route : typeof data.path === "string" ? data.path : undefined,
		delivery: evidenceDelivery(data.delivery),
		committed: commitVerdict(data.committed),
		escalation: readEscalation(data),
		evidence: data.evidence,
		readBack: valueReadBack(data.evidence),
		menuPath: menuPath?.length ? menuPath : undefined,
		advice: typeof data.advice === "string" ? data.advice : undefined,
		panel: readPanel(data),
		focusedWindowId: typeof data.focused_window_id === "number" ? String(data.focused_window_id) : undefined,
		frontInProcess: data.front_in_process === true,
		role: typeof data.role === "string" ? data.role : undefined,
		failedSegment: typeof data.failed_segment === "number" ? data.failed_segment : undefined,
		items: menuItems(data.items),
		resolvedPath: strings(data.resolved_path),
	};
}
/** The tools that deliver keystrokes: one delivery route per window, not per call. */
export const KEYBOARD_TOOLS: Record<string, true> = { hotkey: true, press_key: true, type_text: true };
/**
 * What the session knows that a sentence needs: the call it made and what it
 * holds for the window the call addressed. Nothing here is read off the reply.
 */
export interface Facts {
	/** The driver tool the call went to. */
	readonly tool: string;
	/** The driver's own sentence in prelude vocabulary; for a refusal, the message thrown. */
	readonly text: string;
	/** The call asked for the foreground rung. */
	readonly foreground: boolean;
	readonly windowId: string | undefined;
	readonly pid: number | undefined;
	/** The row the call addressed, by its ref, and its element as the observation minted it. */
	readonly addressed: string | undefined;
	readonly element: ComputerElementSnapshot | undefined;
	/** This window's rows, as its current observation minted them. */
	readonly rows: readonly (readonly [ref: string, element: ComputerElementSnapshot])[];
	/** A capture of this window is live. */
	readonly captured: boolean;
	/** The session's roster holds the window that id names. */
	readonly holds: (id: string) => boolean;
	/** Attached sheets by window id, each against the window that reported it. */
	readonly sheets: ReadonlyMap<string, { readonly parent: string }>;
}
/** A write's facts: the operation, what it addressed, and whether its reply rendered an escalation. */
export interface WriteFacts extends Facts {
	readonly operation: "setValue" | "type";
	readonly target: ComputerTarget | undefined;
	/** The driver doubts this rung landed and names another. */
	readonly escalated: boolean;
}
/**
 * The escalation targets this surface renders a call for. A target with no
 * renderer stays in `data`: the advice the caller cannot follow is worse than
 * none.
 */
const RENDERED_TARGETS: Record<string, true> = { element: true, foreground: true, pixel: true, snapshot: true };
/** Effects a driver reports when it dispatched and doubts the target reacted. */
const UNDELIVERED_EFFECTS: Record<string, true> = { no_observed_change: true, suspected_noop: true };
/** Refusals whose keyboard focus is held by another window of the same app. */
const FOCUS_HOLDING_REFUSALS: Record<string, true> = {
	delivery_failed: true,
	menu_path_unavailable: true,
	same_pid_keyboard_ambiguity: true,
};
/** Roles that take typed text, in both providers' vocabularies. */
const TEXT_INPUT_ROLES: Record<string, true> = {
	AXComboBox: true,
	AXSearchField: true,
	AXTextArea: true,
	AXTextField: true,
	entry: true,
	"password text": true,
	text: true,
};
/**
 * The columns a reply is keyed on: the contract's own values first (refusal
 * code, escalation target and reason, route, verdict, effect), then what the
 * call was and what the reply says of it. A row of the table names the values
 * it answers; the first row whose every named column matches says its piece.
 */
interface Case {
	readonly target: string | undefined;
	readonly reason: string | undefined;
	readonly verdict: ComputerCommitVerdict | undefined;
	readonly effect: string | undefined;
	/** The reply names a rung, and one this surface renders a call for (or none). */
	readonly escalates: boolean;
	readonly rendered: boolean;
	/** The call. */
	readonly keyboard: boolean;
	readonly foreground: boolean;
	readonly windowed: boolean;
	/** What the reply says of it. */
	readonly noop: boolean;
	readonly unproven: boolean;
	/** The reply carries a write verdict, which the write path answers. */
	readonly judged: boolean;
	/** Keystrokes the driver dispatched as the app's own menu command. */
	readonly menuCommand: boolean;
	/** The driver's own sentence already spells the foreground rung. */
	readonly spelled: boolean;
	/** `element_disabled`, typed or in the pre-0.9.0 prose. */
	readonly disabled: boolean;
	readonly typed: boolean;
	/** The disabled row is a menu row, whose `AXEnabled` tracks the command's applicability. */
	readonly menuRow: boolean;
	/** The foreground rung was already in force. */
	readonly fronted: boolean;
	/** An app window of its own is drawn in front of the addressed one. */
	readonly panel: boolean;
	/** The reply says another window of the app holds keyboard focus. */
	readonly focusHeld: boolean;
	/** Writes. */
	readonly readBack: boolean;
	readonly query: boolean;
	readonly operation: "setValue" | "type" | undefined;
	readonly escalated: boolean;
}
function caseOf(reply: ActionReply, facts: Facts | WriteFacts): Case {
	const target = reply.escalation?.target;
	const keyboard = KEYBOARD_TOOLS[facts.tool] === true;
	const disabled = reply.code === "element_disabled" || facts.text.includes("AXEnabled=false");
	const role = facts.element?.role ?? reply.role;
	const writing = "operation" in facts;
	return {
		target,
		reason: reply.escalation?.reason,
		verdict: reply.committed,
		effect: reply.effect,
		escalates: target !== undefined,
		rendered: target === undefined || RENDERED_TARGETS[target] === true,
		keyboard,
		foreground: facts.foreground,
		windowed: facts.windowId !== undefined,
		noop: reply.effect !== undefined && UNDELIVERED_EFFECTS[reply.effect] === true,
		unproven: reply.effect !== "confirmed",
		judged: reply.committed !== undefined,
		menuCommand: keyboard && reply.menuPath !== undefined,
		spelled: facts.text.includes('delivery: "foreground"'),
		disabled,
		typed: reply.code === "element_disabled",
		menuRow: disabled && role !== undefined && MENU_ROLES[role] === true,
		fronted: facts.foreground || reply.frontInProcess,
		panel: facts.windowId !== undefined && reply.panel !== undefined && reply.panel.id !== facts.windowId,
		focusHeld:
			(reply.code !== undefined && FOCUS_HOLDING_REFUSALS[reply.code] === true) ||
			reply.focusedWindowId !== undefined,
		readBack: reply.readBack,
		query: facts.element?.role === SEARCH_FIELD || facts.element?.subrole === SEARCH_FIELD,
		operation: writing ? facts.operation : undefined,
		escalated: writing && facts.escalated,
	};
}
/** The sentences a reply gets, by what it is for: the rung it escalates to, the note a refusal needs, what a write is now known to be. */
type Slot = "escalation" | "refusal" | "write";
interface Row {
	readonly slot: Slot;
	readonly when: Partial<Case>;
	readonly say: (reply: ActionReply, facts: Facts) => string | undefined;
}
const FOREGROUND_ROUTE = 'the route it names is { delivery: "foreground" } — re-run the action that way';
const OBSERVE_ROUTE = "observe the window again (win.observe()) and address the row that walk mints for this control";
const KEYBOARD_READ_ROUTE =
	'observe the window (win.observe()) to read what the keystrokes did — a read changes nothing — or observe({ menubar: true }) and drive the command with win.menu([...], { delivery: "foreground" })';
/**
 * What to say instead once the session has taken the rung over: naming
 * `{ delivery: "foreground" }` told the caller to qualify the re-run, and an
 * explicit rung wins over the remembered one by design, so the advice asked
 * for the one call shape that cannot consume what was just recorded. This
 * line survives a reply that already spells the rung, where a restatement
 * would be dropped: the driver's own sentence instructs exactly the bypass,
 * so the correction is the point rather than noise.
 *
 * Which of the two depends on what the escalation doubts, because the
 * caller's own rule is that a mutation which may have landed is never
 * re-fired. `delivery_failed` says the post never went out, so re-running it
 * is the whole advice. Contract 0.9.0 defaults an unprobed post to
 * `effect_unconfirmed` instead, which says nothing about delivery — measured
 * against the bare re-run, the model read the pair as a contradiction and
 * refused the retry ("the active computer-use constraint prohibits following
 * unverified delivery with foreground input"), so that reason gets the read
 * first, which changes nothing, and the re-run only if the window shows the
 * keystrokes never arrived.
 */
const ROUTE_ALREADY_TAKEN = "re-run it as-is; this window's keystrokes now take the foreground route";
const ROUTE_ALREADY_TAKEN_UNPROVEN =
	"the keystrokes may have landed: observe the window first (win.observe()) and only if it shows nothing re-run the action — this window's keystrokes now take the foreground route";
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
function pixelRoute(facts: Facts): string {
	const window = NO_CHANGE_WINDOW.exec(facts.text);
	const ms = window?.[1] ?? window?.[2];
	const doubt = ms ? `the driver saw no change within ${ms} ms` : "the driver could not confirm this landed";
	return `${doubt} — observe() once; if the tree is unchanged, ${
		facts.captured
			? "click the control's own centre in the capture this window already has"
			: "capture the window (observe({ screenshot: true })) and click the control's own centre"
	}`;
}
/**
 * The text rows this window's current observation holds that a write can
 * land on. A row the app publishes `AXEnabled=false` refuses the write —
 * T11 was sent at `AXTextField "" subrole=AXSearchField enabled=false`
 * and answered `type_text_incomplete: delivered 0 of 22` — so a disabled
 * row is no candidate, whatever its role.
 */
function textRefs(facts: Facts): string[] {
	const refs: string[] = [];
	for (const [ref, element] of facts.rows) {
		if (element.enabled === false) continue;
		if (
			TEXT_INPUT_ROLES[element.role] === true ||
			(element.subrole !== undefined && TEXT_INPUT_ROLES[element.subrole] === true)
		)
			refs.push(ref);
	}
	return refs;
}
/**
 * Where the text of this call can be written instead of posted at a
 * window: the addressed row when the call carried one, else the text rows
 * this window's own observation holds. A window-scoped keystroke that
 * cannot be read back is the case the driver has no answer for — its
 * `element` target means exactly "address the field", which only this side
 * can spell, because only this side minted the ref.
 */
function fieldRoute(facts: Facts): string | undefined {
	if (facts.addressed !== undefined)
		return `write the field instead of posting keystrokes at it: win.ref(${JSON.stringify(facts.addressed)}).setValue("<value>")`;
	const refs = textRefs(facts);
	if (!refs.length) return undefined;
	if (refs.length === 1) {
		const ref = JSON.stringify(refs[0]);
		return `address the field itself: win.ref(${ref}).type("<text>") or win.ref(${ref}).setValue("<value>")`;
	}
	return `address the field itself — this window's observation holds ${refs.length} text rows (${refs
		.slice(0, 4)
		.join(", ")}): win.ref("<ref>").type("<text>") or win.ref("<ref>").setValue("<value>")`;
}
/** The menu route, named only when this window's own observation carries its menu bar. */
function menuRoute(facts: Facts): string | undefined {
	const titles: string[] = [];
	for (const [, element] of facts.rows)
		if (element.role === "AXMenuBarItem" && element.label && !titles.includes(element.label))
			titles.push(element.label);
	if (!titles.length) return undefined;
	return `drive the command from the menu this window's observation carries (${titles
		.slice(0, 8)
		.join(" · ")}): win.menu(["<menu>", "<item>"], { delivery: "foreground" })`;
}
/** The read that changes nothing: a keystroke's is spelled with the menu bar beside it. */
const readRoute = (facts: Facts): string => (KEYBOARD_TOOLS[facts.tool] === true ? KEYBOARD_READ_ROUTE : OBSERVE_ROUTE);
/**
 * The foreground rung already carried these keystrokes and the driver still
 * could not verify them: re-sending them lands nothing new, so the route is
 * the field, the menu or a read. Typing names the field first, a chord the
 * menu.
 */
const carried = (_reply: ActionReply, facts: Facts): string =>
	`the foreground rung already carried these keystrokes and the driver still could not verify them, so re-sending them lands nothing new — ${
		(facts.tool === "type_text"
			? (fieldRoute(facts) ?? menuRoute(facts))
			: (menuRoute(facts) ?? fieldRoute(facts))) ?? readRoute(facts)
	}`;
const BACKGROUND_RUNG =
	'these keystrokes went out in the background, which leaves this window not the app\'s key window — re-run with { delivery: "foreground" }, which makes it key first';
/**
 * The app's own window drawn in front of the one this call addressed, as
 * the calls that reach it. A reply that names that window in its own prose
 * gets only the calls added; one that does not gets the identity too. The
 * acquisition is named only for a window this session's roster holds: T11
 * was told to acquire window 19083, the capture lease's own indicator, which
 * the roster hides and `computer.window` answers with `Missing computer
 * window`.
 */
function obscuringPanel(reply: ActionReply, facts: Facts): string {
	const panel = reply.panel!;
	const target = facts.windowId!;
	const call = `computer.window(${JSON.stringify(panel.id)})`;
	const unheld = `this session's roster holds no window ${panel.id} to acquire`;
	const held = facts.holds(panel.id);
	if (facts.text.includes(`window ${panel.id}`)) {
		if (panel.blind)
			return `Dismiss it with press("Escape"); ${call} cannot acquire a window that publishes no accessibility window of its own.`;
		return held
			? `Acquire it with ${call} and act there, or dismiss it with press("Escape").`
			: `Dismiss it with press("Escape") — ${unheld}.`;
	}
	const title = panel.title === undefined ? "untitled" : JSON.stringify(panel.title);
	const subrole = panel.subrole === undefined ? "" : `/${panel.subrole}`;
	const owner = facts.pid === undefined ? "the app's" : `pid ${facts.pid}'s`;
	const named = `window ${panel.id} (${panel.role === undefined ? title : `${panel.role}${subrole}, ${title}`})`;
	const covered = `Pixel targets on window ${target} stay covered until it goes away.`;
	if (panel.blind)
		return `${named} is ${owner} own front window and publishes no accessibility window, so it can never become the focused one and reveal() cannot move it: dismiss it with press("Escape") or act on its pixels.`;
	return held
		? `${named} is ${owner} own window, drawn in front of window ${target}: acquire it with ${call} and act there, or dismiss it with press("Escape"). ${covered}`
		: `${named} is ${owner} own window, drawn in front of window ${target}: dismiss it with press("Escape") — ${unheld}. ${covered}`;
}
/** The sheet holding keyboard focus instead of the addressed window: the one the reply names, else the one attached to it. */
function focusHolder(reply: ActionReply, facts: Facts): string | undefined {
	const target = facts.windowId!;
	const focused =
		reply.focusedWindowId !== undefined && reply.focusedWindowId !== target ? reply.focusedWindowId : undefined;
	const sheet = focused ?? [...facts.sheets].find(([, row]) => row.parent === target)?.[0];
	if (sheet === undefined) return undefined;
	const relation = facts.sheets.get(sheet);
	return `window ${sheet}${
		relation ? ` — a sheet attached to ${relation.parent} —` : ""
	} holds keyboard focus, not window ${target}; drive it with computer.window(${JSON.stringify(sheet)}) and press its own buttons.`;
}
/**
 * The element a write addressed, by the role and name the observation
 * printed for it. Never its value: a contact card's phone row carries the
 * number it holds as its own `AXLabel`, so labelling the field with it made
 * the sentence name the value being replaced instead of the field.
 */
export function writeField(facts: WriteFacts): string {
	const { target, element } = facts;
	let where: string;
	if (target === undefined) where = "the window's focused element";
	else if (typeof target !== "string")
		where = Array.isArray(target) ? `(${target[0]},${target[1]})` : `(${target.x},${target.y})`;
	else if (element === undefined) where = target;
	else {
		const name = element.label && element.label !== element.value ? element.label : element.placeholder;
		const role = specificRole(element);
		where = name ? `${target} ${role} ${JSON.stringify(name)}` : `${target} ${role}`;
	}
	return `${facts.operation} on ${where}`;
}
/**
 * Where a value this field cannot publish can still be read. The driver
 * names the kind of surface it would escalate to; which route this session
 * can offer for it is the session's own fact, so a target it has no route
 * for names no route at all rather than a tool the caller cannot reach.
 */
function writeWitness(reply: ActionReply, facts: Facts): string {
	const target = reply.escalation?.target;
	if (target === "snapshot")
		return "observe() the window and read the control the app updates instead; this field will publish nothing either way";
	if (target === "pixel" || target === "page" || facts.captured)
		return "capture the window and read the value off its own pixels";
	return "the app's own output is the only witness";
}
const NOT_COMMITTED_REASON = /not committed:\s*([^.]+)/i;
const field = (facts: Facts): string => writeField(facts as WriteFacts);
/**
 * The table. One row per thing a reply can turn out to be, keyed on the
 * contract's own values and on the call; the first row whose every named
 * column matches says its piece, and a row that says nothing ends the walk.
 *
 * Escalation rows compose the route this reply's own state leaves open: the
 * rung this call already took, what the escalation doubts, whether the call
 * was scoped to an element, the rows the window's current observation holds
 * and whether its frame is live. Measured against a table keyed on the target
 * alone: a chord that had already been escalated to foreground and came back
 * unverified was told to re-run as-is (6/6 inert on Notes' Find chord), and a
 * coordinate rung was named for a window with no capture, where a pixel action
 * refuses before dispatch. A background chord that moved nothing still has the
 * rung that lands — a foreground dispatch makes the window key, which is what a
 * not-key window's controls were waiting for — so it goes ahead of the menu,
 * the field and a read. A chord the driver dispatched as the app's own menu
 * command had the window made key for it; the foreground rung has nothing more
 * to make key, so it is never the route there.
 *
 * Refusal rows say what a driver cannot: the call for the window it found in
 * front, the rung for a control whose window is not the app's key one, and
 * the sheet holding focus. `AXEnabled` is the app's own applicability, and the
 * pre-0.9.0 refusal named two rungs regardless — byte-identical on background
 * and foreground, on a frontmost window and behind a panel, in all four
 * measured states; the typed refusal composes that sentence itself, so the
 * precondition arms are composed here only for the untyped shape.
 *
 * Write rows: five materially different outcomes used to render
 * byte-identically — a value the app took, one it echoed without taking, one
 * it discarded outright, one nothing could read, and one that arrived
 * half-typed — so 22 proven writes and the single real loss were
 * indistinguishable in the model's context. A proven write says nothing: the
 * verdict, a confirmed effect, the driver's own read-back and no escalation are
 * the whole proof. Every other rung names what is known and what to do about
 * it, and only the rungs where a re-read can still learn something ask for one.
 */
const TABLE: readonly Row[] = [
	// A target this surface has no call for stays in `data`.
	{ slot: "escalation", when: { rendered: false }, say: () => undefined },
	// A reply that carries a write verdict and points at the field: the write path answers it.
	{ slot: "escalation", when: { target: "element", judged: true }, say: () => undefined },
	{
		slot: "escalation",
		when: { menuCommand: true, target: "element" },
		say: (_reply, facts) =>
			`${fieldRoute(facts) ?? `address the control the command targets — this session holds no text row for window ${facts.windowId ?? "(unknown)"}, so observe it first and write the row that walk mints`}, or raise the window (win.raise()) and keep it key before re-running`,
	},
	{
		slot: "escalation",
		when: { menuCommand: true, noop: true },
		say: (reply, facts) =>
			`the driver dispatched these keystrokes as the menu command ${reply.menuPath!.join(
				" > ",
			)} with the window key and still saw no reaction, so re-sending them on any rung lands nothing new — ${
				fieldRoute(facts) ?? readRoute(facts)
			}`,
	},
	{ slot: "escalation", when: { menuCommand: true }, say: () => undefined },
	// The foreground rung already carried these keystrokes: whatever rung the reply names, or none where nothing moved.
	{ slot: "escalation", when: { keyboard: true, foreground: true, unproven: true, escalates: true }, say: carried },
	{ slot: "escalation", when: { keyboard: true, foreground: true, unproven: true, noop: true }, say: carried },
	// This window's keystrokes now take the foreground rung; the session records it.
	{
		slot: "escalation",
		when: { target: "foreground", keyboard: true, windowed: true, reason: "delivery_failed" },
		say: () => ROUTE_ALREADY_TAKEN,
	},
	{
		slot: "escalation",
		when: { target: "foreground", keyboard: true, windowed: true },
		say: () => ROUTE_ALREADY_TAKEN_UNPROVEN,
	},
	{
		slot: "escalation",
		when: { target: "foreground", foreground: true },
		say: (_reply, facts) =>
			`this action already ran with { delivery: "foreground" }, so the rung it names is the one that just answered — ${
				menuRoute(facts) ?? fieldRoute(facts) ?? readRoute(facts)
			}`,
	},
	{ slot: "escalation", when: { target: "foreground", spelled: true }, say: () => undefined },
	{ slot: "escalation", when: { target: "foreground" }, say: () => FOREGROUND_ROUTE },
	{
		slot: "escalation",
		when: { target: "element", keyboard: true, noop: true, foreground: false },
		say: () => BACKGROUND_RUNG,
	},
	{
		slot: "escalation",
		when: { target: "element" },
		say: (_reply, facts) =>
			fieldRoute(facts) ??
			`address the field itself — this session holds no text row for window ${facts.windowId ?? "(unknown)"}, so observe it first and write the row that walk mints`,
	},
	{ slot: "escalation", when: { target: "pixel" }, say: (_reply, facts) => pixelRoute(facts) },
	{ slot: "escalation", when: { target: "snapshot" }, say: () => OBSERVE_ROUTE },
	{
		slot: "escalation",
		when: { target: undefined, keyboard: true, noop: true, foreground: false },
		say: () => BACKGROUND_RUNG,
	},

	{ slot: "refusal", when: { panel: true }, say: obscuringPanel },
	{
		slot: "refusal",
		when: { disabled: true, target: "foreground", foreground: false },
		say: () =>
			'retry with { delivery: "foreground" } — the window is not the app\'s key window and a foreground dispatch makes it key first.',
	},
	{
		slot: "refusal",
		when: { disabled: true, typed: false, menuRow: true },
		say: (reply, facts) =>
			`That ${facts.element?.role ?? reply.role} is disabled by the app's own current state: a menu row's AXEnabled tracks the command's applicability, not focus or delivery. Satisfy the command's precondition (a selection, a document, a mode) or pick another item.`,
	},
	{
		slot: "refusal",
		when: { disabled: true, typed: false, fronted: true },
		say: () =>
			`That control reports AXEnabled=false with { delivery: "foreground" } already in force, so the rung is not what refused and no activation changes it: satisfy its precondition or choose another control.`,
	},
	{ slot: "refusal", when: { windowed: true, focusHeld: true }, say: focusHolder },

	{
		slot: "write",
		when: { verdict: "not_committed" },
		say: (_reply, facts) =>
			`${field(facts)}: not committed — ${
				NOT_COMMITTED_REASON.exec(facts.text)?.[1]?.trim() ?? "the driver reported no reason"
			}. The app kept its own value; write it another way.`,
	},
	{
		slot: "write",
		when: { effect: "unverifiable" },
		say: (reply, facts) =>
			`${field(facts)}: the field publishes no readable value, so nothing read this write back — ${writeWitness(reply, facts)}.`,
	},
	{
		slot: "write",
		when: { verdict: "unproven", readBack: true, query: true },
		say: (_reply, facts) =>
			`${field(facts)}: the value reads back as written, but a read-back is echoed by the control whether or not the app took it — check the app's own output: the rows this query filtered, not the field.`,
	},
	{
		slot: "write",
		when: { verdict: "unproven", readBack: true, operation: "type" },
		say: (_reply, facts) =>
			`${field(facts)}: the value reads back as written, but this field's app takes its value at end-of-edit, which typing does not deliver — press Tab or Return, or write it with setValue.`,
	},
	{
		slot: "write",
		when: { verdict: "unproven", readBack: true },
		say: (_reply, facts) =>
			`${field(facts)}: the value reads back as written, but nothing observed the app take it, and this field's app takes its value at end-of-edit — press Tab or Return on it.`,
	},
	{
		slot: "write",
		when: { verdict: "committed", effect: "confirmed", readBack: true, escalated: false },
		say: () => undefined,
	},
	{
		slot: "write",
		when: { verdict: undefined },
		say: (_reply, facts) =>
			`${field(facts)}: nothing in the reply says whether the app kept this value — read the field back before building on it.`,
	},
	{
		slot: "write",
		when: { verdict: "unproven" },
		say: (_reply, facts) =>
			`${field(facts)}: the driver could not tell whether the app kept this value — read the field back before building on it.`,
	},
	{
		slot: "write",
		when: { verdict: "committed", readBack: true, escalated: true },
		say: (_reply, facts) =>
			`${field(facts)}: the driver judged the value committed but doubts this route landed and names another — read the field back before building on it.`,
	},
	{
		slot: "write",
		when: { verdict: "committed", readBack: true },
		say: (reply, facts) =>
			`${field(facts)}: the driver judged the value committed but reported the effect as ${reply.effect} — read the field back before building on it.`,
	},
	{
		slot: "write",
		when: { verdict: "committed" },
		say: (_reply, facts) =>
			`${field(facts)}: the driver judged the value committed but nothing in the reply read it back — read the field back before building on it.`,
	},
];
function say(slot: Slot, reply: ActionReply, facts: Facts): string | undefined {
	const kase = caseOf(reply, facts);
	for (const row of TABLE) {
		if (row.slot !== slot) continue;
		let matches = true;
		for (const column of Object.keys(row.when) as (keyof Case)[])
			if (row.when[column] !== kase[column]) {
				matches = false;
				break;
			}
		if (matches) return row.say(reply, facts);
	}
	return undefined;
}
/**
 * One decision per reply: the rung this window's keystrokes now take and the
 * sentence for it. A reply that carries a write verdict and points at the
 * field says nothing here — the write path answers that one, with the field
 * and the value in hand.
 */
export function escalation(reply: ActionReply, facts: Facts): string | undefined {
	const route = say("escalation", reply, facts);
	if (route === undefined) return undefined;
	if (reply.escalation === undefined) return `⚠️ The driver reports no observed change: ${route}.`;
	const reason = reply.escalation.reason;
	return `⚠️ The driver escalates this action${reason ? ` (${reason})` : ""}: ${route}.`;
}
/** The note a refusal needs beside the driver's own sentence, or none. */
export function refusalNote(reply: ActionReply, facts: Facts): string | undefined {
	return say("refusal", reply, facts);
}
/**
 * One sentence for what a write is now known to be, or none. The verdict,
 * effect and evidence are the result's own, which the action already
 * defaulted; a dead ref's recovery answers with `not_dispatched` over the
 * refusal it recovered from.
 */
export function writeNote(result: ComputerActionResult, facts: WriteFacts): string | undefined {
	const reply = {
		...readReply(result.data),
		effect: result.effect,
		committed: result.committed,
		readBack: valueReadBack(result.evidence),
	};
	return say("write", reply, facts);
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
export function menuBarRoute(element: ComputerElementSnapshot | undefined): string | undefined {
	if (!element || MENU_BAR_ROLES[element.role] !== true) return undefined;
	return `\nThat ref is a ${element.role}: an AX action on it only lands while its menu is already open, and no delivery mode opens one. Drive the menu instead: win.menu([${
		element.label ? JSON.stringify(element.label) : '"<menu>"'
	}, "<item>"], { delivery: "foreground" }).`;
}
/**
 * Refusals about one row rather than about the window: the platform could not
 * prove the addressed element belongs to the target window, or found its
 * reference dead. `element_outside_target_window` is reported for both on
 * drivers before 0.9.0. A code belongs here only if a reply of it that names
 * no route means a re-read answers: the session reads the window on a silent
 * reply by design, and `element_disabled` — whose disabled-by-app-state arms
 * name no route in either field — would then be answered with a tree the
 * control reads identically in. The route is read from whichever field
 * carries it: `advice` on a background refusal, the escalation target on the
 * ungated AX route, which is a tool error payload with no `advice` at all.
 */
const DEAD_ELEMENT_REFUSALS: Record<string, true> = {
	element_no_longer_exists: true,
	element_outside_target_window: true,
};
export function deadElement(reply: ActionReply): boolean {
	if (reply.code === undefined || DEAD_ELEMENT_REFUSALS[reply.code] !== true) return false;
	const route = reply.advice ?? reply.escalation?.target;
	return route === undefined || route === "snapshot";
}
/**
 * The driver's own activation sentence on the menu-command route names one
 * of two things: the application was fronted, or only its window was made
 * key (the app was already frontmost). The closed contract carries only
 * `delivery.mode: foreground` for both, so the distinction is read off the
 * sentence the driver composed from what it did.
 */
const APP_FRONTED = /was not the frontmost application, so it was fronted/;
const WINDOW_MADE_KEY = /so it was made key for the dispatch|was already key/;
/**
 * The reply line for keystrokes the driver dispatched as the app's menu
 * command: measured on Notes, the model reading `Pressed cmd+option+f` never
 * learned that the chord had become `Edit > Find > Note List Search…` with
 * the window made key, nor whether an app it was driving in the background
 * had been brought to the front for it.
 */
export function menuCommandLine(reply: ActionReply, text: string): string | undefined {
	if (reply.menuPath === undefined) return undefined;
	const verb = reply.effect === "suspected_noop" ? "Dispatched" : "Delivered";
	const fronted = APP_FRONTED.test(text) ? "yes" : WINDOW_MADE_KEY.test(text) ? "no" : undefined;
	return `${verb} as menu command ${reply.menuPath.join(" > ")}${fronted === undefined ? "" : ` (app fronted: ${fronted})`}`;
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
export function actionEvidence(reply: ActionReply, requested: string | undefined): string | undefined {
	const target = reply.escalation?.target;
	const fields = [
		reply.route === undefined ? undefined : `route=${reply.route}`,
		reply.delivery === undefined
			? requested === undefined
				? undefined
				: `requested=${requested}`
			: `delivery=${reply.delivery}`,
		reply.effect === undefined ? undefined : `effect=${reply.effect}`,
		target !== undefined && RENDERED_TARGETS[target] === true ? `escalation=${target}` : undefined,
	].filter(field => field !== undefined);
	return fields.length ? `Evidence: ${fields.join(" ")}` : undefined;
}
/**
 * A partial `type_text` is the one refusal that still wrote: the field holds
 * neither its old value nor the requested one, and the driver names how many
 * characters it delivered. The remainder is what the caller has to send, and
 * slicing it by codepoint is the work the reply left undone — a model asked to
 * "retry only the remaining suffix" retyped the whole string instead.
 */
export const INCOMPLETE_TYPING = "type_text_incomplete";
const INCOMPLETE_DELIVERY = /delivered (\d+) of (\d+) character/;
export function incompleteNote(field: string, value: string, message: string): string {
	const counts = INCOMPLETE_DELIVERY.exec(message);
	const characters = [...value];
	const delivered = counts ? Number(counts[1]) : undefined;
	if (delivered === undefined || Number(counts?.[2]) !== characters.length)
		return `${field}: the typing stopped part-way, so the field holds neither its old value nor the one asked for — read it back and type what is missing.`;
	return `${field}: ${delivered} of ${characters.length} characters landed, so the field holds neither its old value nor the one asked for — type only the remainder: ${JSON.stringify(
		characters.slice(delivered).join(""),
	)}.`;
}
export const UNPROBED_DRAG =
	"Delivered; the driver reported no effect evidence for this drag — observe the window to confirm it moved anything.";
