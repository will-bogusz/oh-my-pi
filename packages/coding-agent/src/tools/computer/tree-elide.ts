/**
 * Structure-aware elision for computer observation text.
 *
 * Observations render as a pre-order accessibility tree, two spaces of indent
 * per level (`cua-session.ts`):
 *
 * ```
 * - [n12] AXButton "Save" value="" enabled=true selected=false actions=["press"]
 * ```
 *
 * A byte-window cut over that text removes a contiguous band of lines, and the
 * band a large web page produces is exactly where the dialog controls live —
 * the bench's T7 print pane was fetched and then elided away. This module
 * instead removes the least load-bearing parts until the text fits: redundant
 * and over-long `value=` text, then rows that carry neither text nor an action,
 * then the deepest subtrees, keeping rows that carry a real action for last.
 */
import type { StructuralElisionResult } from "../../session/streaming-output";

/** A rendered tree row: indent, ref, role, then the attribute run. */
const ROW_PATTERN = /^((?:  )*)- \[([^\]\s]+)\] (\S+)(.*)$/;
/** Attribute name at the start of the remaining attribute run. */
const ATTRIBUTE_PATTERN = /^ ([a-z]+)=/;
/** Actions only container roles advertise; they say nothing about the node. */
const AMBIENT_ACTIONS: Record<string, true> = { cancel: true };
/** Roles that only ever decorate, whatever they claim to support. */
const SEPARATOR_ROLES: Record<string, true> = { AXSeparator: true, AXSplitter: true, AXMenuItemSeparator: true };
/** `value=` lengths tried in order; dropping the attribute is a later resort. */
const VALUE_LIMITS = [512, 256, 96, 32];

interface Row {
	/** Index of this row's line in the source text. */
	line: number;
	depth: number;
	role: string;
	label: string;
	/** `[valueStart, valueEnd)` spans ` value=<json>` inside the row's line. */
	valueStart: number;
	valueEnd: number;
	valueText: string;
	hasValue: boolean;
	/** Carries placeholder, description or help text. */
	hasProse: boolean;
	/** Carries an action that is not offered by every node alike. */
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

/** Scan the JSON array token at `from` (strings inside may hold brackets). */
function scanJsonArray(text: string, from: number): number {
	if (text.charCodeAt(from) !== 91) return -1;
	for (let index = from + 1; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 34) {
			const end = scanJsonString(text, index);
			if (end < 0) return -1;
			index = end - 1;
			continue;
		}
		if (code === 93) return index + 1;
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
 * Parse one rendered row, following the render's attribute order rather than
 * searching for attribute names — a label or value may contain anything.
 * Returns undefined when the line is not a row.
 */
function parseRow(line: string, index: number): Row | undefined {
	const match = ROW_PATTERN.exec(line);
	if (!match) return undefined;
	const rest = match[4];
	const restOffset = line.length - rest.length;
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
	if (rest.charCodeAt(0) === 32 && rest.charCodeAt(1) === 34) {
		const end = scanJsonString(rest, 1);
		if (end > 0) {
			row.label = String(parseJson(rest.substring(1, end)) ?? "");
			pos = end;
		}
	}
	while (pos < rest.length) {
		const attribute = ATTRIBUTE_PATTERN.exec(rest.substring(pos));
		if (!attribute) break;
		const name = attribute[1];
		const valuePos = pos + attribute[0].length;
		const code = rest.charCodeAt(valuePos);
		let end: number;
		if (code === 34) end = scanJsonString(rest, valuePos);
		else if (code === 91) end = scanJsonArray(rest, valuePos);
		else {
			const space = rest.indexOf(" ", valuePos);
			end = space < 0 ? rest.length : space;
		}
		if (end < 0) break;
		if (name === "value" && code === 34) {
			row.hasValue = true;
			row.valueStart = restOffset + pos;
			row.valueEnd = restOffset + end;
			row.valueText = String(parseJson(rest.substring(valuePos, end)) ?? "");
		} else if (name === "actions" && code === 91) {
			const actions = parseJson(rest.substring(valuePos, end));
			if (Array.isArray(actions))
				row.actionable = actions.some(action => typeof action === "string" && AMBIENT_ACTIONS[action] !== true);
		} else if (code === 34 && end > valuePos + 2) {
			row.hasProse = true;
		}
		pos = end;
	}
	row.separator = SEPARATOR_ROLES[row.role] === true || (row.role === "AXMenuItem" && row.label.trim() === "");
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
			rewriteValue(row, ` value=${JSON.stringify(row.valueText)}`);
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
