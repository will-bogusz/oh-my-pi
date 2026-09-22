/**
 * Structure-aware elision for computer observation text.
 *
 * Observations render as a pre-order accessibility tree, two spaces of indent
 * per level, in the grammar `observed-tree.ts` gives both surfaces
 * (`cua-session.ts`):
 *
 * ```
 * n12 button "Save" = "value" (tooltip) [disabled] actions=open
 *   text "Saved 2 minutes ago"
 *   (5 of 12 rows are scrolled out of view and were not read)
 * ```
 *
 * A byte-window cut over that text removes a contiguous band of lines, and the
 * band a large web page produces is exactly where the dialog controls live —
 * the bench's T7 print pane was fetched and then elided away. This module
 * instead removes the least load-bearing parts until the text fits: redundant
 * and over-long value text, then rows that carry neither text nor an action,
 * then the deepest subtrees, keeping rows that carry a real action for last.
 */
import type { StructuralElisionResult } from "@oh-my-pi/pi-tui/tools/streaming-output";

/** A rendered tree row: indent, the ref when it has one, then its role. */
const ROW_PATTERN = /^((?: {2})*)(?:(n\d+) )?([a-z][a-z0-9]*)(?= |$)/;
/** An app's own actions, the only ones the grammar prints. */
const ACTIONS_PATTERN = / actions=\S+/;
/** A value this row will accept: a field to write to is a row to act on. */
const SETTABLE_PATTERN = / \[[^\]]*\bsettable\b/;
/**
 * Roles a dispatch lands on. The old render named actions on nearly every row
 * — `show_menu` is published by anything with a context menu — so the elider
 * read "carries an action" off the `actions=` list. The grammar prints only
 * the actions an app authored, so what a row offers is now its role: these
 * are the ones a click, a keystroke or a menu pick can do something with.
 */
const CONTROL_ROLES: Record<string, true> = {
	button: true,
	popupbutton: true,
	menubutton: true,
	menuitem: true,
	menubaritem: true,
	checkbox: true,
	radiobutton: true,
	togglebutton: true,
	toggle: true,
	switch: true,
	link: true,
	tab: true,
	tabbutton: true,
	textfield: true,
	textarea: true,
	securetextfield: true,
	searchfield: true,
	combobox: true,
	slider: true,
	stepper: true,
	incrementor: true,
	disclosuretriangle: true,
	colorwell: true,
	datetimearea: true,
};
/** Roles that only ever decorate, whatever they claim to support. */
const SEPARATOR_ROLES: Record<string, true> = { separator: true, splitter: true, menuitemseparator: true };
/** Value lengths tried in order; dropping the value is a later resort. */
const VALUE_LIMITS = [512, 256, 96, 32];

interface Row {
	/** Index of this row's line in the source text. */
	line: number;
	depth: number;
	role: string;
	label: string;
	/** `[valueStart, valueEnd)` spans ` = <json>` inside the row's line. */
	valueStart: number;
	valueEnd: number;
	valueText: string;
	hasValue: boolean;
	/** Carries placeholder, description or help text. */
	hasProse: boolean;
	/** Something can be dispatched on this row: its role, its own actions, or a writable value. */
	actionable: boolean;
	separator: boolean;
	/** Exclusive row index where this row's subtree ends. */
	subtreeEnd: number;
	/** Some row in this subtree is actionable. */
	subtreeActionable: boolean;
	/** Some row in this subtree carries a label, a value or prose. */
	subtreeText: boolean;
	dropped: boolean;
	valueElided: boolean;
}

/** Scan the JSON string token at `from`; returns its exclusive end or -1. */
function scanJsonString(text: string, from: number): number {
	if (text.charCodeAt(from) !== 34) return -1;
	for (let index = from + 1; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 92) {
			index++;
			continue;
		}
		if (code === 34) return index + 1;
	}
	return -1;
}

function parseJson(token: string): unknown {
	try {
		return JSON.parse(token);
	} catch {
		return undefined;
	}
}

/**
 * Parse one rendered row, following the render's own order rather than
 * searching for attribute names — a label or value may hold anything.
 * Returns undefined when the line is not a row: a header, a footer, and a
 * parenthesised note are all prose this module never drops.
 */
function parseRow(line: string, index: number): Row | undefined {
	const match = ROW_PATTERN.exec(line);
	if (!match) return undefined;
	const rest = line.slice(match[0].length);
	// A row either carries a ref or names itself. Without one of the two the
	// line is this session's own prose, which reads as lowercase words.
	if (match[2] === undefined && !rest.startsWith(' "')) return undefined;
	const row: Row = {
		line: index,
		depth: match[1].length / 2,
		role: match[3],
		label: "",
		valueStart: -1,
		valueEnd: -1,
		valueText: "",
		hasValue: false,
		hasProse: false,
		actionable: false,
		separator: false,
		subtreeEnd: 0,
		subtreeActionable: false,
		subtreeText: false,
		dropped: false,
		valueElided: false,
	};
	let pos = 0;
	if (rest.startsWith(' "')) {
		const end = scanJsonString(rest, 1);
		if (end > 0) {
			row.label = String(parseJson(rest.substring(1, end)) ?? "");
			pos = end;
		}
	}
	if (rest.startsWith(' = "', pos)) {
		const end = scanJsonString(rest, pos + 3);
		if (end > 0) {
			row.hasValue = true;
			row.valueStart = match[0].length + pos;
			row.valueEnd = match[0].length + end;
			row.valueText = String(parseJson(rest.substring(pos + 3, end)) ?? "");
			pos = end;
		}
	}
	// What is left is the description, the states and the surface's extras,
	// none of which can be confused with a label or a value now that both are
	// consumed: a description is parenthesised, a placeholder is named.
	const tail = rest.slice(pos);
	row.hasProse = tail.includes(" (") || tail.includes(' placeholder="');
	row.actionable = CONTROL_ROLES[row.role] === true || ACTIONS_PATTERN.test(tail) || SETTABLE_PATTERN.test(tail);
	row.separator = SEPARATOR_ROLES[row.role] === true || (row.role === "menuitem" && row.label.trim() === "");
	return row;
}

/** Bytes a line occupies in the joined text, its newline included. */
function lineBytes(text: string): number {
	return Buffer.byteLength(text, "utf-8") + 1;
}

/**
 * Remove the least load-bearing parts of a rendered observation until it fits
 * `budget` bytes. Returns undefined when the text is not a rendered tree,
 * already fits, or cannot be brought under budget structurally — the inline
 * cap then falls back to its byte-window cut.
 */
export function elideObservationTree(text: string, budget: number): StructuralElisionResult | undefined {
	if (budget <= 0) return undefined;
	const lines = text.split("\n");
	const rows: Row[] = [];
	let bytes = -1; // the last line carries no newline
	for (const [index, line] of lines.entries()) {
		bytes += lineBytes(line);
		const row = parseRow(line, index);
		if (row) rows.push(row);
	}
	// A lone row is a degraded-reason line or a one-node dialog: no structure to
	// work with. Two already carry a parent/child shape worth pruning.
	if (rows.length < 2 || bytes <= budget) return undefined;

	// Pre-order walk: a row's subtree runs until the next row at or above its
	// own depth. Every drop below takes a whole subtree, so what survives stays
	// a tree — no row outlives its parent.
	const open: number[] = [];
	for (const [index, row] of rows.entries()) {
		while (open.length) {
			const parent = open[open.length - 1];
			if (rows[parent].depth < row.depth) break;
			rows[parent].subtreeEnd = index;
			open.pop();
		}
		open.push(index);
	}
	for (const index of open) rows[index].subtreeEnd = rows.length;
	for (let index = rows.length - 1; index >= 0; index--) {
		const row = rows[index];
		row.subtreeActionable = row.actionable;
		row.subtreeText = row.label.trim() !== "" || row.valueText.trim() !== "" || row.hasProse;
		// Direct children only: each carries its own subtree's verdict already.
		for (let child = index + 1; child < row.subtreeEnd; child = rows[child].subtreeEnd) {
			row.subtreeActionable ||= rows[child].subtreeActionable;
			row.subtreeText ||= rows[child].subtreeText;
		}
	}

	const texts = [...lines];
	let elidedRows = 0;
	let elidedValues = 0;

	const rewriteValue = (row: Row, replacement: string): void => {
		const line = texts[row.line];
		const next = line.substring(0, row.valueStart) + replacement + line.substring(row.valueEnd);
		bytes -= lineBytes(line) - lineBytes(next);
		texts[row.line] = next;
		row.valueEnd = row.valueStart + replacement.length;
		if (!row.valueElided) {
			row.valueElided = true;
			elidedValues++;
		}
	};

	const dropValue = (row: Row): void => {
		rewriteValue(row, "");
		row.hasValue = false;
		row.valueText = "";
	};

	const dropSubtree = (index: number): void => {
		for (let inner = index; inner < rows[index].subtreeEnd; inner++) {
			const row = rows[inner];
			if (row.dropped) continue;
			row.dropped = true;
			elidedRows++;
			bytes -= lineBytes(texts[row.line]);
		}
	};

	// Pass 1: a value repeating its own label, or an empty one, is pure weight.
	for (const row of rows) if (row.hasValue && (row.valueText === "" || row.valueText === row.label)) dropValue(row);

	// Pass 2: shorten long value text, progressively. Short values (a field's
	// contents, a pop-up's current selection) stay whole; dropping those is the
	// last resort below.
	for (const limit of VALUE_LIMITS) {
		if (bytes <= budget) break;
		for (const row of rows) {
			if (!row.hasValue || row.valueText.length <= limit) continue;
			row.valueText = `${row.valueText.substring(0, limit)}\u2026`;
			rewriteValue(row, ` = ${JSON.stringify(row.valueText)}`);
		}
	}

	// Pass 3: subtrees that carry neither text nor an action anywhere within —
	// empty AXImage/AXRow/AXCell wrappers — and separator leaves.
	if (bytes > budget) {
		for (const [index, row] of rows.entries()) {
			if (row.dropped) continue;
			const leafSeparator = row.separator && row.subtreeEnd === index + 1;
			if (leafSeparator || !(row.subtreeActionable || row.subtreeText)) dropSubtree(index);
		}
	}

	// Pass 4: deepest subtrees first, largest first within a depth, and only
	// once none are left, subtrees that hold an action.
	for (const actionable of [false, true]) {
		if (bytes <= budget) break;
		const candidates: number[] = [];
		for (const [index, row] of rows.entries())
			if (!row.dropped && row.depth > 0 && row.subtreeActionable === actionable) candidates.push(index);
		candidates.sort((left, right) => {
			if (rows[left].depth !== rows[right].depth) return rows[right].depth - rows[left].depth;
			return rows[right].subtreeEnd - right - (rows[left].subtreeEnd - left);
		});
		for (const index of candidates) {
			if (bytes <= budget) break;
			if (!rows[index].dropped) dropSubtree(index);
		}
	}

	// Last resort before handing the text back to the byte-window cut: the
	// value text of every row still standing.
	if (bytes > budget) for (const row of rows) if (row.hasValue && !row.dropped) dropValue(row);

	if (bytes > budget || (!elidedRows && !elidedValues)) return undefined;

	const dropped = new Set<number>();
	for (const row of rows) if (row.dropped) dropped.add(row.line);
	const summary: string[] = [];
	if (elidedRows) summary.push(`${elidedRows} row${elidedRows === 1 ? "" : "s"}`);
	if (elidedValues) summary.push(`${elidedValues} value${elidedValues === 1 ? "" : "s"}`);
	return {
		text: texts.filter((_, index) => !dropped.has(index)).join("\n"),
		notice: `[elided: ${summary.join(", ")}]`,
	};
}
