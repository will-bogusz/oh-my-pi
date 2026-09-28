import type { DesktopWindow } from "@oh-my-pi/pi-natives";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Titled windows named per app in a miss; the rest are counted. */
const WINDOWS_PER_APP = 3;
/** Titled windows named for an app the selector's `app` matched: those are the candidates. */
const WINDOWS_PER_MATCHED_APP = 10;

/**
 * `"74" Reminders "Todo"`: the id in the form `window()` accepts verbatim (ids
 * are opaque strings, not always digits), then app and title.
 */
export function windowLabel(window: DesktopWindow): string {
	return `${JSON.stringify(window.id)} ${window.app} ${JSON.stringify(window.title)}`;
}

/**
 * The window a `window()` selector that is not a filter names: the window
 * with that id; for a string only, else the one open window whose app or
 * title equals it (case-insensitive), announced through `note`. A number is
 * always an id. Throws naming the `{ app }`/`{ title }` filters when no
 * window or several windows match.
 */
export function resolveWindowId(
	windows: readonly DesktopWindow[],
	selector: string | number,
	note: (text: string) => void,
): DesktopWindow {
	const id = String(selector);
	const exact = windows.find(window => window.id === id);
	if (exact) return exact;
	const quoted = JSON.stringify(id);
	if (typeof selector === "number") {
		throw new ToolError(
			`no window has id ${quoted}; pass an id listed below, or filter with window({ app }) / window({ title }).\n${describeWindowMiss(windows, undefined)}`,
		);
	}
	const needle = id.trim().toLocaleLowerCase();
	const named = needle
		? windows.filter(
				window => window.app.toLocaleLowerCase() === needle || window.title.toLocaleLowerCase() === needle,
			)
		: [];
	if (named.length === 1) {
		const window = named[0]!;
		const field = window.app.toLocaleLowerCase() === needle ? "app" : "title";
		note(
			`${quoted} is not a window id; it is the ${field} of exactly one open window, so resolved to window ${windowLabel(window)}. Pass ids as window(${JSON.stringify(window.id)}); filter with window({ app }) / window({ title }).`,
		);
		return window;
	}
	if (named.length > 1) {
		throw new ToolError(
			`${quoted} is not a window id, and ${named.length} open windows have that app or title; pass one's id, or narrow with window({ app, title }):\n${named.map(windowLabel).join("\n")}`,
		);
	}
	throw new ToolError(
		`no window has id ${quoted}, and no open window's app or title is ${quoted}; filter with window({ app }) / window({ title }), or pass an id listed below.\n${describeWindowMiss(windows, id)}`,
	);
}

/**
 * What a window selector that matched nothing could have meant: every app
 * with an open window and the windows it has, candidates for the selector's
 * `app` first and in full, so the next call can name an exact id (or conclude
 * the app has no window) without listing windows first.
 */
export function describeWindowMiss(windows: readonly DesktopWindow[], app: string | undefined): string {
	if (windows.length === 0) return "No windows are open.";
	const needle = app?.toLocaleLowerCase();
	const byApp = new Map<string, DesktopWindow[]>();
	for (const window of windows) {
		const group = byApp.get(window.app);
		if (group) group.push(window);
		else byApp.set(window.app, [window]);
	}
	const matched = (name: string): boolean => needle !== undefined && name.toLocaleLowerCase().includes(needle);
	const focusedApp = windows.find(window => window.focused)?.app;
	const apps = [...byApp.keys()].sort((left, right) => {
		const rank = (name: string): number => (matched(name) ? 0 : name === focusedApp ? 1 : 2);
		return rank(left) - rank(right) || left.localeCompare(right);
	});
	const lines = apps.map(name => {
		const group = byApp.get(name)!;
		// A candidate app's untitled windows are named too: one may be the target.
		const shown = matched(name)
			? [...group].sort((left, right) => Number(left.title.trim() === "") - Number(right.title.trim() === ""))
			: group.filter(window => window.title.trim() !== "");
		const limit = matched(name) ? WINDOWS_PER_MATCHED_APP : WINDOWS_PER_APP;
		const named = shown
			.slice(0, limit)
			.map(
				window =>
					`${JSON.stringify(window.id)} ${window.title.trim() === "" ? "(untitled)" : JSON.stringify(window.title)}${window.focused ? " (focused)" : ""}`,
			);
		const rest = group.length - named.length;
		if (rest > 0) named.push(`${rest} ${named.length > 0 ? "more" : "untitled"}`);
		return `- ${name}: ${named.join(", ")}`;
	});
	const note =
		needle !== undefined && !apps.some(matched)
			? `No open window belongs to an app matching ${JSON.stringify(app)}.\n`
			: "";
	return `${note}Open windows by app ("id" "title"; \`computer.windows({ app })\` lists all):\n${lines.join("\n")}`;
}
