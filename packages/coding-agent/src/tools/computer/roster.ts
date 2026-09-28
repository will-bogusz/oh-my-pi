import type { DesktopWindow } from "@oh-my-pi/pi-natives";

/** Titled windows named per app in a miss; the rest are counted. */
const WINDOWS_PER_APP = 3;
/** Titled windows named for an app the selector's `app` matched: those are the candidates. */
const WINDOWS_PER_MATCHED_APP = 10;

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
		const titled = group.filter(window => window.title.trim() !== "");
		const limit = matched(name) ? WINDOWS_PER_MATCHED_APP : WINDOWS_PER_APP;
		const named = titled
			.slice(0, limit)
			.map(window => `${window.id} ${JSON.stringify(window.title)}${window.focused ? " (focused)" : ""}`);
		const rest = group.length - named.length;
		if (rest > 0) named.push(`${rest} ${named.length > 0 ? "more" : "untitled"}`);
		return `- ${name}: ${named.join(", ")}`;
	});
	const note =
		needle !== undefined && !apps.some(matched)
			? `No open window belongs to an app matching ${JSON.stringify(app)}.\n`
			: "";
	return `${note}Open windows by app (id "title"):\n${lines.join("\n")}`;
}
