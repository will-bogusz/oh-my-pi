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
 * Every action the row advertises, under the name `perform` dispatches it by.
 * A row whose `press` was withheld — list rows, cells, list items, where a
 * plain click selects instead — was told to the model twice over: 147 cells
 * in one leg printed `help="Perform press or select Return to open note."`
 * beside an `actions=` list with no `press` in it. Which gesture selects is a
 * property of the dispatch, and the driver decides and states it per
 * dispatch; a row's list is what the row offers.
 */
export function observedActions(...lists: readonly unknown[]): readonly string[] | undefined {
	const reported = lists.filter(list => Array.isArray(list)) as readonly unknown[][];
	if (!reported.length) return undefined;
	const actions: string[] = [];
	for (const action of reported.flat()) {
		if (typeof action !== "string" || !action) continue;
		const name = semanticAction(action) ?? action;
		if (!actions.includes(name)) actions.push(name);
	}
	return Object.freeze(actions);
}
