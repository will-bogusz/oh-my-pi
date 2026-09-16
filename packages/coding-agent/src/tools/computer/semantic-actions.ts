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

/** The action names `perform` dispatches; every other observed name is a label. */
export const PERFORMABLE_ACTIONS: readonly string[] = Object.freeze([
	...new Set(Object.values(SEMANTIC_ACTION_BY_ALIAS)),
]);

export function observedActions(...lists: readonly unknown[]): readonly string[] | undefined {
	const reported = lists.filter(list => Array.isArray(list)) as readonly unknown[][];
	if (!reported.length) return undefined;
	const actions: string[] = [];
	for (const action of reported.flat()) {
		if (typeof action !== "string" || !action) continue;
		const name = Object.hasOwn(SEMANTIC_ACTION_BY_ALIAS, action) ? SEMANTIC_ACTION_BY_ALIAS[action]! : action;
		if (!actions.includes(name)) actions.push(name);
	}
	return Object.freeze(actions);
}
