import type { ComputerWindowIdentity } from "./types";

/** Rows a listing names before it counts the rest. */
const LISTED_WINDOWS = 12;
/** Owners whose windows are plumbing: XPC hosts, panel services, agents. */
const SERVICE_APP = /Service$/;

/** One listed window, standing for the run of identical ones behind it. */
interface RosterRow {
	id: string;
	app: string;
	title: string;
	count: number;
}

/**
 * Windows ranked and collapsed the way a person names them: titled ones
 * first, frontmost first, then their untitled neighbours one row per app.
 * `zIndex` is the driver's own stacking report, higher towards the front,
 * where it has one at all; a row without one may not be ordered against the
 * array, so it sorts last and keeps the roster's own sequence. Repeats
 * collapse to a count — a dozen identical document windows do not say
 * anything twelve times.
 */
function rankedRows(windows: readonly ComputerWindowIdentity[]): RosterRow[] {
	const ranked = [...windows].sort(
		(a, b) => (b.zIndex ?? Number.MIN_SAFE_INTEGER) - (a.zIndex ?? Number.MIN_SAFE_INTEGER),
	);
	const titled = new Map<string, RosterRow>();
	const untitled = new Map<string, RosterRow>();
	for (const window of ranked) {
		const rows = window.title ? titled : untitled;
		const key = window.title ? `${window.app}\u0000${window.title}` : window.app;
		const row = rows.get(key);
		if (row) row.count += 1;
		else rows.set(key, { id: window.id, app: window.app, title: window.title, count: 1 });
	}
	return [...titled.values(), ...untitled.values()];
}

/** Every row leads with the id that acquires it; the tail is a count. */
function listed(rows: readonly RosterRow[], name: (row: RosterRow) => string): string {
	const shown = rows
		.slice(0, LISTED_WINDOWS)
		.map(row => `[${row.id}] ${name(row)}${row.count > 1 ? ` (x ${row.count})` : ""}`);
	return `${shown.join(", ")}${rows.length > shown.length ? `, and ${rows.length - shown.length} more` : ""}`;
}

/**
 * What is open, inside the failure that needs it. Recovery from a miss has
 * always been the same `computer.windows()` round trip, so the roster that
 * call would return is spent here instead — filtered as well as ranked,
 * because a working Mac reported 124 rows for the twelve windows it actually
 * had: XPC service owners and everything off screen are left to
 * `computer.windows()`.
 */
export function openWindows(windows: readonly ComputerWindowIdentity[]): string {
	if (windows.length === 0) return "Nothing is open.";
	const rows = rankedRows(windows.filter(window => window.onScreen !== false && !SERVICE_APP.test(window.app)));
	if (rows.length === 0)
		return `No app window is on screen; computer.windows() lists ${windows.length} service or off-screen row${
			windows.length === 1 ? "" : "s"
		}.`;
	return `Open windows: ${listed(rows, row => `${row.app}${row.title ? ` — ${JSON.stringify(row.title)}` : ""}`)}.`;
}

/**
 * Windows of one app, whose name every row would otherwise repeat: the
 * listing an acquisition uses to name what it passed over. Nothing is
 * filtered out here — every row is a window the caller may acquire by its id,
 * including the off-screen and untitled ones acquisition did not choose.
 */
export function appWindows(windows: readonly ComputerWindowIdentity[]): string {
	return listed(rankedRows(windows), row => JSON.stringify(row.title));
}
