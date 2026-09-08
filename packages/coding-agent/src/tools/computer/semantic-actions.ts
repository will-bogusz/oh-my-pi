export const SEMANTIC_ACTION_ALIASES: Record<string, readonly string[]> = {
	press: ["AXPress", "press", "Invoke"],
	show_menu: ["AXShowMenu", "show_menu"],
	pick: ["AXPick", "pick"],
	confirm: ["AXConfirm", "confirm"],
	cancel: ["AXCancel", "cancel"],
	open: ["AXOpen", "open"],
};

export function observedSemanticActions(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return Object.freeze(
		Object.entries(SEMANTIC_ACTION_ALIASES)
			.filter(([, aliases]) => value.some(action => typeof action === "string" && aliases.includes(action)))
			.map(([action]) => action),
	);
}
