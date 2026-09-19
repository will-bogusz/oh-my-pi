/**
 * What a driver reply is said to mean: the readers that take a reply off the
 * wire and the sentences composed from what they read. Nothing here touches
 * the driver or the session; `cua-session.ts` supplies the call and the
 * session facts and prints what comes back.
 */
import type { ComputerCommitVerdict } from "./types";

export type Wire = Record<string, unknown>;
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
 * `#disabledControl`. Structured details stay verbatim on the error's context.
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
/** macOS rows whose `AXPress` needs the menu already open; see `#menuBarRoute`. */
export const MENU_BAR_ROLES: Record<string, true> = { AXMenuBar: true, AXMenuBarItem: true };
/** Rows whose `AXEnabled` tracks the command's applicability; see `#disabledControl`. */
export const MENU_ROLES: Record<string, true> = {
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
 * The escalation targets this surface renders a call for. A target with no
 * renderer stays in `data`: the advice the caller cannot follow is worse than
 * none. The sentence itself is composed by `#escalationRoute`, which knows
 * the rung this call already took, the rows the current observation holds and
 * whether a frame is live — a table keyed on the target alone told a chord
 * that had already run foreground to run foreground.
 */
export const RENDERED_TARGETS: Record<string, true> = { element: true, foreground: true, pixel: true, snapshot: true };
export const FOREGROUND_ROUTE = 'the route it names is { delivery: "foreground" } — re-run the action that way';
export const OBSERVE_ROUTE =
	"observe the window again (win.observe()) and address the row that walk mints for this control";
export const KEYBOARD_READ_ROUTE =
	'observe the window (win.observe()) to read what the keystrokes did — a read changes nothing — or observe({ menubar: true }) and drive the command with win.menu([...], { delivery: "foreground" })';
/** Effects a driver reports when it dispatched and doubts the target reacted. */
export const UNDELIVERED_EFFECTS: Record<string, true> = { no_observed_change: true, suspected_noop: true };
/** Roles that take typed text, in both providers' vocabularies. */
export const TEXT_INPUT_ROLES: Record<string, true> = {
	AXComboBox: true,
	AXSearchField: true,
	AXTextArea: true,
	AXTextField: true,
	entry: true,
	"password text": true,
	text: true,
};
/** The untyped `recommended` spelling of a contract target, keyed on what the driver still writes. */
const ESCALATION_TARGET_ALIASES: Readonly<Record<string, string>> = { get_window_state: "snapshot", px: "pixel" };
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
export const ROUTE_ALREADY_TAKEN = "re-run it as-is; this window's keystrokes now take the foreground route";
export const ROUTE_ALREADY_TAKEN_UNPROVEN =
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
export function pixelEscalation(text: string, captured: boolean): string {
	const window = NO_CHANGE_WINDOW.exec(text);
	const ms = window?.[1] ?? window?.[2];
	const doubt = ms ? `the driver saw no change within ${ms} ms` : "the driver could not confirm this landed";
	return `${doubt} — observe() once; if the tree is unchanged, ${
		captured
			? "click the control's own centre in the capture this window already has"
			: "capture the window (observe({ screenshot: true })) and click the control's own centre"
	}`;
}
export function escalationTarget(data: Wire): string | undefined {
	const escalation = data.escalation;
	if (!escalation || typeof escalation !== "object" || Array.isArray(escalation)) return undefined;
	const row = escalation as Wire;
	// `target` is the contract's field; `recommended` is what the untyped
	// replies still write, and both name the same rung.
	const target = typeof row.target === "string" ? row.target : row.recommended;
	if (typeof target !== "string") return undefined;
	return ESCALATION_TARGET_ALIASES[target] ?? target;
}
/**
 * What the escalation doubts: a contract token (`delivery_failed`,
 * `effect_unconfirmed`) on a typed reply, the fork's own prose on an untyped
 * one. It is rendered in front of the route and it decides one of them, so
 * both readings come from the same field.
 */
export function escalationReason(data: Wire): string | undefined {
	const escalation = data.escalation;
	if (!escalation || typeof escalation !== "object" || Array.isArray(escalation)) return undefined;
	const reason = (escalation as Wire).reason;
	return typeof reason === "string" ? reason : undefined;
}
/** The rung a reply names, in either shape the drivers report it: a bare string or `{ mode }`. */
function evidenceDelivery(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const mode = (value as Wire).mode;
	return typeof mode === "string" ? mode : undefined;
}
/**
 * The menu titles a `menu_command` reply says it dispatched, top level first.
 * Contract 0.10.0 publishes them as `menu_path` beside the route; the route
 * alone says the keystrokes became the app's own menu command, the path says
 * which.
 */
export function menuCommandPath(data: Wire): readonly string[] | undefined {
	if (data.route !== "menu_command" || !Array.isArray(data.menu_path)) return undefined;
	const path = data.menu_path.filter((segment): segment is string => typeof segment === "string");
	return path.length ? path : undefined;
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
export function menuCommandLine(data: Wire, text: string): string | undefined {
	const path = menuCommandPath(data);
	if (path === undefined) return undefined;
	const verb = data.effect === "suspected_noop" ? "Dispatched" : "Delivered";
	const fronted = APP_FRONTED.test(text) ? "yes" : WINDOW_MADE_KEY.test(text) ? "no" : undefined;
	return `${verb} as menu command ${path.join(" > ")}${fronted === undefined ? "" : ` (app fronted: ${fronted})`}`;
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
export function actionEvidence(details: unknown, args: Wire): string | undefined {
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
		target !== undefined && RENDERED_TARGETS[target] === true ? `escalation=${target}` : undefined,
	].filter(field => field !== undefined);
	return fields.length ? `Evidence: ${fields.join(" ")}` : undefined;
}
/**
 * Refusals about one row rather than about the window: the platform could not
 * prove the addressed element belongs to the target window, or found its
 * reference dead. `element_outside_target_window` is reported for both on
 * drivers before 0.9.0. A code belongs here only if a reply of it that names
 * no route means a re-read answers: `#deadElement` reads the window on a
 * silent reply by design, and `element_disabled` — whose disabled-by-app-state
 * arms name no route in either field — would then be answered with a tree the
 * control reads identically in.
 */
export const DEAD_ELEMENT_REFUSALS: Record<string, true> = {
	element_no_longer_exists: true,
	element_outside_target_window: true,
};
export const FOCUS_HOLDING_REFUSALS: Record<string, true> = {
	delivery_failed: true,
	menu_path_unavailable: true,
	same_pid_keyboard_ambiguity: true,
};
export function refusalDetails(details: unknown): Wire {
	const data = details !== null && typeof details === "object" && !Array.isArray(details) ? (details as Wire) : {};
	const nested = data.refusal;
	if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return data;
	return { ...data, ...(nested as Wire) };
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
export function commitVerdict(value: unknown): ComputerCommitVerdict | undefined {
	if (typeof value === "string") return COMMIT_VERDICTS[value];
	if (typeof value === "boolean") return value ? "committed" : "not_committed";
	return undefined;
}
export const NOT_COMMITTED_REASON = /not committed:\s*([^.]+)/i;
/** Whether the reply carries the driver's read-back of the value it wrote. */
export function valueReadBack(evidence: unknown): boolean {
	const rows = Array.isArray(evidence) ? (evidence as unknown[]) : [evidence];
	return rows.some(row => row !== null && typeof row === "object" && (row as Wire).kind === "value_readback");
}
/** Everything a write reply decided, as the write path read it off the wire. */
interface WriteReport {
	/** The operation and the field it addressed: `setValue on n7 AXTextField "Street"`. */
	field: string;
	operation: "setValue" | "type";
	committed?: ComputerCommitVerdict;
	effect: string;
	/** The driver read the value back after writing it. */
	readBack: boolean;
	/** The driver doubts this rung landed and names another. */
	escalated: boolean;
	/** The app's own reason for discarding the value, in the driver's words. */
	reason?: string;
	/** What can still see a value this field does not publish. */
	witness: string;
	/** A search field's value is a query: the app answers it in its own output. */
	query: boolean;
}
/**
 * One sentence for what a write is now known to be, or none. Five materially
 * different outcomes used to render byte-identically — a value the app took,
 * one it echoed without taking, one it discarded outright, one nothing could
 * read, and one that arrived half-typed — so 22 proven writes and the single
 * real loss were indistinguishable in the model's context, and every one of
 * them was told to re-read the field.
 *
 * A proven write says nothing: the verdict, a confirmed effect, the driver's
 * own read-back and no escalation are the whole proof, and a caveat on top of
 * it costs a cell. Every other rung names what is known and what to do about
 * it, and only the rungs where a re-read can still learn something ask for one
 * — re-reading an echoed value returns the echo, and re-reading a field that
 * publishes no value returns nothing.
 */
export function commitNote(write: WriteReport): string | undefined {
	if (write.committed === "not_committed")
		return `${write.field}: not committed — ${
			write.reason ?? "the driver reported no reason"
		}. The app kept its own value; write it another way.`;
	if (write.effect === "unverifiable")
		return `${write.field}: the field publishes no readable value, so nothing read this write back — ${write.witness}.`;
	if (write.committed === "unproven" && write.readBack)
		return write.query
			? `${write.field}: the value reads back as written, but a read-back is echoed by the control whether or not the app took it — check the app's own output: the rows this query filtered, not the field.`
			: write.operation === "type"
				? `${write.field}: the value reads back as written, but this field's app takes its value at end-of-edit, which typing does not deliver — press Tab or Return, or write it with setValue.`
				: `${write.field}: the value reads back as written, but nothing observed the app take it, and this field's app takes its value at end-of-edit — press Tab or Return on it.`;
	if (write.committed === "committed" && write.effect === "confirmed" && write.readBack && !write.escalated)
		return undefined;
	if (write.committed === undefined)
		return `${write.field}: nothing in the reply says whether the app kept this value — read the field back before building on it.`;
	if (write.committed === "unproven")
		return `${write.field}: the driver could not tell whether the app kept this value — read the field back before building on it.`;
	return `${write.field}: the driver judged the value committed ${
		write.readBack
			? write.escalated
				? "but doubts this route landed and names another"
				: `but reported the effect as ${write.effect}`
			: "but nothing in the reply read it back"
	} — read the field back before building on it.`;
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
