/**
 * What a driver reply is said to mean: the readers that take a reply off the
 * wire and the few sentences composed from what they read. Nothing here
 * touches the driver or the session; `cua-session.ts` supplies the call and
 * the session facts and prints what comes back.
 *
 * Three renderers, each keyed on contract fields: `escalation` on the rung a
 * dispatched action's reply names, `refusalNote` on a refusal's code, and
 * `writeNote` on a write's commit verdict and effect. Each says one line or
 * nothing; the driver's own sentence stays the reply's account of itself.
 */
import type { ComputerCommitVerdict, ComputerElementSnapshot, ComputerTarget } from "./types";

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
 * The role a row prints under: the platform name without its `AX` prefix,
 * lower-cased, and static text under the browser's word for the same node.
 * Only the rendering changes — `ComputerElementSnapshot.role` keeps the
 * platform spelling, so a query and every refusal still name `AXTextField`,
 * and `find()` accepts either spelling.
 */
export function renderedRole(role: string): string {
	if (role === "AXStaticText") return "text";
	return (role.startsWith("AX") ? role.slice(2) : role).toLowerCase();
}
/**
 * Driver prose rewritten into a call the caller can type. Both pinned builds
 * advertise their wire vocabulary in refusal text and escalation advice
 * (`delivery_mode: "foreground"`) where the prelude takes
 * `{ delivery: "foreground" }`. The macOS build also names a screenshot as
 * the check for an unverified pixel dispatch, which on this surface is the
 * expensive one — an AX read answers the same question — and names one for
 * a keystroke field whose `AXValue` it could not read, where a capture really
 * is the only witness and only the spelling of the call is added.
 * Structured details stay verbatim on the error's context.
 */
const DELIVERY_MODE_VOCABULARY = /delivery_mode\s*:\s*"(background|foreground)"/g;
const SCREENSHOT_CHECK = /not driver-verified\s*[—-]\s*confirm via screenshot/g;
const SCREENSHOT_WITNESS = /verify via screenshot/g;
export function preludeVocabulary<T>(value: T): T {
	if (typeof value === "string")
		return value
			.replace(DELIVERY_MODE_VOCABULARY, '{ delivery: "$1" }')
			.replace(
				SCREENSHOT_CHECK,
				"not driver-verified — confirm with observe({ query }) or, on a pixel surface, a screenshot",
			)
			.replace(SCREENSHOT_WITNESS, "confirm with observe({ screenshot: true })") as T;
	if (Array.isArray(value)) return value.map(entry => preludeVocabulary(entry)) as T;
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, preludeVocabulary(entry)])) as T;
	return value;
}
/** macOS rows whose `AXPress` needs the menu already open; see `menuBarRoute`. */
export const MENU_BAR_ROLES: Record<string, true> = { AXMenuBar: true, AXMenuBarItem: true };
/** Rows whose `AXEnabled` tracks the command's applicability, not focus or delivery. */
const MENU_ROLES: Record<string, true> = {
	AXMenu: true,
	AXMenuBar: true,
	AXMenuBarItem: true,
	AXMenuItem: true,
};
/** macOS reports a search field as this subrole on a plain `AXTextField`. */
export const SEARCH_FIELD = "AXSearchField";
/** `invoke_menu` names the path segment it stopped resolving at in its message. */
export const MENU_REFUSAL_SEGMENT = /path segment (\d+) (was not found|is ambiguous)/;
/** Titles a listing names before it counts the rest. */
const MENU_TITLE_LIMIT = 40;
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
/**
 * `invoke_menu` refuses a path it cannot resolve with the items of the level
 * it stopped at, which is exactly what an observation cannot show: a closed
 * menu reports its items `AXEnabled=false`, so they never reach the tree.
 */
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
 * The escalation a reply names. `target` is the rung the driver would take
 * instead — typed replies spell it `target`, and the refusal payloads of both
 * pinned builds still spell it `recommended`; `reason` is a contract token
 * (`delivery_failed`, `effect_unconfirmed`) on a typed reply and the driver's
 * own prose otherwise.
 */
export interface Escalation {
	readonly target: string;
	readonly reason: string | undefined;
}
function readEscalation(data: Wire): Escalation | undefined {
	const row = record(data.escalation);
	if (row === undefined) return undefined;
	const target = typeof row.target === "string" ? row.target : row.recommended;
	if (typeof target !== "string") return undefined;
	return { target, reason: typeof row.reason === "string" ? row.reason : undefined };
}
/** The app's own window drawn in front of the one a call addressed (`obscured_by`). */
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
 * own editing pipeline kept it. Only that verdict separates a written field
 * from a lost one: a value the pipeline never accepted still reads back
 * correctly through the AX tree. A driver that judges none reports nothing.
 */
const COMMIT_VERDICTS: Readonly<Record<string, ComputerCommitVerdict>> = {
	committed: "committed",
	not_committed: "not_committed",
	unproven: "unproven",
};
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
	/**
	 * A typed refusal's own verdict on re-sending the same call. `false` is
	 * the driver saying it proved the rung cannot land — the caller has to
	 * change route, not slice the payload.
	 */
	readonly retryable: boolean | undefined;
	/** A background refusal's own route, where it names one. */
	readonly advice: string | undefined;
	readonly panel: Panel | undefined;
	readonly focusedWindowId: string | undefined;
	/** The foreground rung was already in force for the refused dispatch. */
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
const strings = (value: unknown): readonly string[] | undefined =>
	Array.isArray(value) ? value.filter((segment): segment is string => typeof segment === "string") : undefined;
export function readReply(details: unknown): ActionReply {
	const envelope = record(details) ?? {};
	const nested = record(envelope.refusal);
	const data = nested === undefined ? envelope : { ...envelope, ...nested };
	// Both pinned builds send the rung as `{ mode }` and the verdict as one of
	// three words.
	const mode = record(data.delivery)?.mode;
	return {
		data,
		code: typeof data.code === "string" ? data.code : undefined,
		effect: typeof data.effect === "string" ? data.effect : undefined,
		route: typeof data.route === "string" ? data.route : undefined,
		delivery: typeof mode === "string" ? mode : undefined,
		committed: typeof data.committed === "string" ? COMMIT_VERDICTS[data.committed] : undefined,
		escalation: readEscalation(data),
		evidence: data.evidence,
		readBack: valueReadBack(data.evidence),
		retryable: typeof data.retryable === "boolean" ? data.retryable : undefined,
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
/** The tools that deliver keystrokes. */
const KEYBOARD_TOOLS: Record<string, true> = { hotkey: true, press_key: true, type_text: true };
/**
 * Effects that mean the driver dispatched without proving the target
 * reacted: the element never advertised the action, or only part of the
 * payload went out.
 */
const UNDELIVERED_EFFECTS: Record<string, true> = { partial: true, suspected_noop: true };
/**
 * Whether a reply leaves its own delivery unproven: an undelivered effect,
 * an app action whose outcome the driver cannot read, or a written value the
 * app is not known to have kept. Such a reply's text has to reach the cell
 * even where the cell drops the returned value.
 */
export function unproven(reply: ActionReply): boolean {
	return (
		(reply.effect !== undefined && (UNDELIVERED_EFFECTS[reply.effect] === true || reply.effect === "unverifiable")) ||
		(reply.committed !== undefined && reply.committed !== "committed") ||
		reply.escalation !== undefined
	);
}
/**
 * What the session knows that a sentence needs: the call it made and what it
 * holds for the window the call addressed. Nothing here is read off the reply.
 */
export interface Facts {
	/** The driver tool the call went to. */
	readonly tool: string;
	/** The driver's own sentence; for a refusal, the message thrown. */
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
/** A write's facts: the operation and what it addressed. */
export interface WriteFacts extends Facts {
	readonly operation: "setValue" | "type";
	readonly target: ComputerTarget | undefined;
}
/**
 * The escalation targets this surface renders a call for. A target with no
 * renderer stays in `data`: the advice the caller cannot follow is worse than
 * none.
 */
const RENDERED_TARGETS: Record<string, true> = { element: true, foreground: true, pixel: true, snapshot: true };
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
 * The text rows this window's current observation holds that a write can
 * land on. A row the app publishes `AXEnabled=false` refuses the write, so a
 * disabled row is no candidate, whatever its role.
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
 * this window's own observation holds. The driver's `element` target means
 * exactly "address the field", which only this side can spell, because only
 * this side minted the ref.
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
/**
 * The call a named rung is taken with. `snapshot` has none: a read is the
 * whole of that advice, and the read comes first on every rung anyway.
 */
function escalationRoute(target: string, facts: Facts): string | undefined {
	switch (target) {
		case "element":
			return (
				fieldRoute(facts) ??
				`address the field itself — observe window ${facts.windowId ?? "(unknown)"} and write the row it mints`
			);
		case "pixel":
			return `click the control's own centre in ${
				facts.captured ? "the capture this window already has" : "a fresh capture (observe({ screenshot: true }))"
			}`;
		case "foreground":
			return facts.foreground ? undefined : 're-run it with { delivery: "foreground" }';
		default:
			return undefined;
	}
}
/**
 * The route a dispatched action's reply names, as the call that takes it —
 * keyed on the escalation's `target`. `delivery_failed` says the post never
 * went out, so the named rung is the whole advice. Any other doubt is about a
 * dispatch that may have landed: the read comes first, and the named rung
 * only if the window shows nothing happened, because re-sending an action
 * that landed does it twice. Background keystrokes the driver saw move
 * nothing name no rung of their own; they reach only the app's key window,
 * which is what the foreground rung makes this one. A write's element
 * escalation is answered by its verdict (`writeNote`).
 */
export function escalation(reply: ActionReply, facts: Facts): string | undefined {
	const target = reply.escalation?.target;
	if (target === "element" && reply.committed !== undefined) return undefined;
	const keyboard = KEYBOARD_TOOLS[facts.tool] === true;
	const route =
		target !== undefined
			? escalationRoute(target, facts)
			: keyboard && !facts.foreground && reply.effect !== undefined && UNDELIVERED_EFFECTS[reply.effect] === true
				? 're-run them with { delivery: "foreground" }, which makes this window key first — background keystrokes reach only the app\'s key window'
				: undefined;
	if (route === undefined) return undefined;
	if (reply.escalation?.reason === "delivery_failed") return `Not delivered: ${route}.`;
	return `Delivery unproven: observe first — it may have landed; only if the window shows no change, ${route}.`;
}
/**
 * The app's own window drawn in front of the one this call addressed, as
 * the calls that reach it. The acquisition is named only for a window this
 * session's roster holds: the capture lease's own indicator is hidden from
 * the roster, and `computer.window` answers it with `Missing computer window`.
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
 * A disabled control, keyed on what refused: the key-window precondition,
 * which the foreground rung satisfies, or the app's own state, which no rung
 * changes — a menu row's `AXEnabled` tracks the command's applicability.
 */
function disabledNote(reply: ActionReply, facts: Facts): string | undefined {
	if (reply.escalation?.target === "foreground" && !facts.foreground)
		return 'retry with { delivery: "foreground" } — the window is not the app\'s key window and a foreground dispatch makes it key first.';
	const role = facts.element?.role ?? reply.role;
	if (role !== undefined && MENU_ROLES[role] === true)
		return `That ${role} is disabled by the app's own current state: a menu row's AXEnabled tracks the command's applicability, not focus or delivery. Satisfy the command's precondition (a selection, a document, a mode) or pick another item.`;
	return undefined;
}
/**
 * The note a refusal needs beside the driver's own sentence, keyed on its
 * code: the app window drawn in front, the disabled control, or the window
 * holding keyboard focus. Nothing was dispatched, so each names the route
 * that can land.
 */
export function refusalNote(reply: ActionReply, facts: Facts): string | undefined {
	if (facts.windowId !== undefined && reply.panel !== undefined && reply.panel.id !== facts.windowId)
		return obscuringPanel(reply, facts);
	if (reply.code === "element_disabled") return disabledNote(reply, facts);
	if (facts.windowId !== undefined && reply.code !== undefined && FOCUS_HOLDING_REFUSALS[reply.code] === true)
		return focusHolder(reply, facts);
	return undefined;
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
 * What a write is now known to be, keyed on the driver's commit verdict and
 * effect — one line, or nothing for a write the driver read back committed.
 * A control showing the written text proves the text is in the control,
 * never that the app took it, so no line here calls a write landed; and
 * every line ends at a read, because rewriting a value to find out whether
 * it stuck is the one probe that can double it.
 */
export function writeNote(result: { effect: string; committed?: ComputerCommitVerdict; evidence: unknown }, facts: WriteFacts): string | undefined {
	const field = writeField(facts);
	const readBack = valueReadBack(result.evidence);
	switch (result.committed) {
		case "committed":
			return result.effect === "confirmed" && readBack
				? undefined
				: `${field}: the driver judged the value committed but ${
						readBack ? `reported the effect as ${result.effect}` : "nothing in the reply read it back"
					} — read the field back before building on it.`;
		case "not_committed":
			return `${field}: not committed — read it back (win.observe()); if the control still shows the old value, write it another way.`;
		case "unproven":
			return readBack
				? `${field}: the value reads back as written, which proves the text is in the control, not that the app took it — judge by the app's own output.`
				: `${field}: the driver could not prove the app kept this value — read the window back and judge by the app's own output.`;
		default:
			if (result.effect === "unverifiable")
				return `${field}: the field publishes no readable value, so nothing read this write back — the app's own output is the only witness.`;
			if (result.effect === "not_dispatched") return undefined;
			return `${field}: nothing in the reply says whether the app kept this value — read the field back before building on it.`;
	}
}
/**
 * A menu bar item reports `AXEnabled` only while its own menu is open, so
 * the driver refuses the press before dispatch — and no delivery mode opens
 * a menu. The route that does drive these rows is `menu(path)`, which the
 * driver has no way to name because it addressed one element, not a path.
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
 * reference dead. A code belongs here only if a reply of it that names no
 * route means a re-read answers. The route is read from whichever field
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
 * What the driver reported about an action that threw, and only that: the
 * route it took, the rung it delivered on, what it believes happened, and the
 * rung it would escalate to. Each field is printed when the reply carries it;
 * the rung the call asked for is a fact about the call, not about the
 * delivery, and says so.
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
 * slicing it by codepoint is the work the reply left undone.
 *
 * A refusal the driver marks `retryable: false` is the opposite finding: it
 * probed the target and it never took keyboard focus, so the same keystrokes
 * land nothing again however they are sliced. This one carries the call that
 * writes the value without keystrokes, which only this side can spell.
 */
export const INCOMPLETE_TYPING = "type_text_incomplete";
const INCOMPLETE_DELIVERY = /delivered (\d+) of (\d+) character/;
export function incompleteNote(facts: WriteFacts, value: string, message: string, reply: ActionReply): string {
	const name = writeField(facts);
	if (reply.retryable === false) {
		const route =
			facts.addressed === undefined
				? (fieldRoute(facts) ?? "write the value into the field instead of posting keystrokes at it")
				: `write it without keystrokes: win.ref(${JSON.stringify(facts.addressed)}).setValue(${JSON.stringify(value)})`;
		return `${name}: nothing landed, so the field still holds its old value and re-sending these keystrokes lands nothing again — ${route}${
			facts.foreground ? "" : ', or re-run this call with { delivery: "foreground" }'
		}.`;
	}
	const counts = INCOMPLETE_DELIVERY.exec(message);
	const characters = [...value];
	const delivered = counts ? Number(counts[1]) : undefined;
	if (delivered === undefined || Number(counts?.[2]) !== characters.length)
		return `${name}: the typing stopped part-way, so the field holds neither its old value nor the one asked for — read it back and type what is missing.`;
	return `${name}: ${delivered} of ${characters.length} characters landed, so the field ${
		delivered === 0 ? "still holds its old value" : "holds neither its old value nor the one asked for"
	} — type only the remainder: ${JSON.stringify(characters.slice(delivered).join(""))}.`;
}
export const UNPROBED_DRAG =
	"Delivered; the driver reported no effect evidence for this drag — observe the window to confirm it moved anything.";
