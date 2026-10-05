import type { DesktopWindow } from "@oh-my-pi/pi-natives";

/** Rows of one `ax()` tree keyed by ref, without indentation or list bullet, in tree order. */
export type TreeRows = Map<string, string>;

/** Most lines one summary lists; the rest are counted and left to `ax()`. */
const MAX_LINES = 30;

const REF = / \[ref=(e\d+)\]/;

export function treeRows(text: string): TreeRows {
	const rows: TreeRows = new Map();
	for (const line of text.split("\n")) {
		const ref = REF.exec(line)?.[1];
		if (ref) rows.set(ref, line.trimStart().replace(/^- /, ""));
	}
	return rows;
}

function windowLabel(window: DesktopWindow): string {
	return `${window.app} ${JSON.stringify(window.title)} [${window.id}]${window.focused ? " (focused)" : ""}`;
}

/** What one input changed, as the lines an input helper returns. */
export interface ChangeReport {
	/** The input, e.g. `press e14`. */
	label: string;
	windowsBefore: readonly DesktopWindow[];
	windowsAfter: readonly DesktopWindow[];
	/** The window read back after the input, as listed after it. */
	target?: DesktopWindow;
	/** The target's rows at its last read; absent when it was never read. */
	before?: TreeRows;
	/** The target's rows read after the input. */
	after?: TreeRows;
}

/**
 * Windows opened, closed or newly focused, then the target's rows changed
 * (`~`, with the old row), added (`+`) or removed (`-`); a target never read
 * before lists every row as added. Past {@link MAX_LINES} the remaining
 * changes are counted, not listed.
 */
export function describeChanges(report: ChangeReport): string {
	const lines: string[] = [];
	const beforeIds = new Set(report.windowsBefore.map(window => window.id));
	const afterIds = new Set(report.windowsAfter.map(window => window.id));
	for (const window of report.windowsAfter) {
		if (!beforeIds.has(window.id)) lines.push(`opened window ${windowLabel(window)}`);
	}
	for (const window of report.windowsBefore) {
		if (!afterIds.has(window.id)) lines.push(`closed window ${windowLabel({ ...window, focused: false })}`);
	}
	const focusedBefore = report.windowsBefore.find(window => window.focused)?.id;
	const focusedAfter = report.windowsAfter.find(window => window.focused);
	if (focusedAfter && focusedAfter.id !== focusedBefore && beforeIds.has(focusedAfter.id)) {
		lines.push(`focus moved to ${windowLabel(focusedAfter)}`);
	}
	const { target, before, after } = report;
	if (after) {
		const previous = before ?? new Map<string, string>();
		const changes = lines.length;
		for (const [ref, row] of after) {
			const old = previous.get(ref);
			if (old === undefined) lines.push(`+ ${row}`);
			else if (old !== row) lines.push(`~ ${row} (was: ${old.replace(REF, "")})`);
		}
		for (const [ref, row] of previous) {
			if (!after.has(ref)) lines.push(`- ${row}`);
		}
		if (lines.length === changes) lines.push("no change in its accessibility tree");
	} else if (lines.length === 0) {
		lines.push("no window opened, closed or focused");
	}
	const shown = lines.slice(0, MAX_LINES);
	if (lines.length > shown.length) {
		shown.push(`… ${lines.length - shown.length} more changes; ax() shows the whole tree`);
	}
	const header = target ? `${report.label} → ${windowLabel(target)}:` : `${report.label}:`;
	return [header, ...shown].join("\n");
}
