/** Every wire spelling of the actions `perform` dispatches, by the name it takes. */
const SEMANTIC_ACTION_BY_ALIAS: Record<string, string> = {
	AXPress: "press",
	press: "press",
	Invoke: "press",
	AXShowMenu: "show_menu",
	show_menu: "show_menu",
	AXPick: "pick",
	pick: "pick",
	AXConfirm: "confirm",
	confirm: "confirm",
	AXCancel: "cancel",
	cancel: "cancel",
	AXOpen: "open",
	open: "open",
};

/** The action names `perform` dispatches on every row, whatever that row advertises. */
export const PERFORMABLE_ACTIONS: readonly string[] = Object.freeze([
	...new Set(Object.values(SEMANTIC_ACTION_BY_ALIAS)),
]);

/** The semantic name this alias dispatches as; undefined when it names none. */
export function semanticAction(action: string): string | undefined {
	return Object.hasOwn(SEMANTIC_ACTION_BY_ALIAS, action) ? SEMANTIC_ACTION_BY_ALIAS[action] : undefined;
}

/**
 * Roles where a plain click selects instead of pressing. The pointer itself is
 * the evidence: a background click at a reminder row's centre moved the
 * selection and left the reminder incomplete, and the row did not advertise
 * `AXPress` at all — the cell inside it did. Listing `press` first on such a
 * row invited a click's verb to be read as the row's action, and a bench spent
 * 6 cells per run pressing rows it meant to select. The action stays reachable
 * through `perform("press")`, which is where an explicitly named action
 * belongs.
 */
const SELECTS_ON_CLICK: Record<string, true> = { AXRow: true, AXCell: true, AXListItem: true };

export function observedActions(role: string, ...lists: readonly unknown[]): readonly string[] | undefined {
	const reported = lists.filter(list => Array.isArray(list)) as readonly unknown[][];
	if (!reported.length) return undefined;
	const secondary = SELECTS_ON_CLICK[role] === true;
	const actions: string[] = [];
	for (const action of reported.flat()) {
		if (typeof action !== "string" || !action) continue;
		const name = semanticAction(action) ?? action;
		if (secondary && name === "press") continue;
		if (!actions.includes(name)) actions.push(name);
	}
	return Object.freeze(actions);
}
