/**
 * The row grammar every observation surface prints.
 *
 * A web accessibility tree and a macOS one describe the same kinds of thing —
 * a role, a name, a value, a few states — and the model reads both in the same
 * session. Two grammars for that taxed every read and every prompt: the native
 * side spelled `- [n12] AXButton "Save" value="" enabled=true selected=false
 * actions=["press"]` where the browser said `e12 button "Save"`, and nothing in
 * the difference carried information. This module renders both, so a row means
 * the same thing whichever surface produced it and the model learns one shape.
 *
 * Refs stay each surface's own business: the caller passes the token it minted
 * (`e26` from a ref that survives re-renders, `n5` from a generation-bound one)
 * and the prefix its ranges read in.
 */

/**
 * One node as a row prints it. `extras` are the trailing attributes only one
 * surface has — the native side's `actions=` and `placeholder=` — kept out of
 * the grammar proper so both surfaces share everything they do have in common.
 */
export interface TreeNode {
	depth: number;
	role: string;
	name: string;
	value?: string | number;
	url?: string;
	description?: string;
	keyshortcuts?: string;
	states: readonly string[];
	/** Surface-specific attributes, printed space-separated after the states. */
	extras?: readonly string[];
	/** Set on the boundary line of an embedded document: the iframe's host. */
	iframe?: string;
}

export interface TreeLine {
	/** Diff identity: the ref for actionable nodes, else the ancestor path plus role/name/position. */
	key: string;
	depth: number;
	text: string;
	ref?: number;
}

/** One node as the model reads it: `e26 tab "Contributions" = "value" (description) [selected]`. */
export function renderNode(node: TreeNode, ref: string | undefined): string {
	if (node.iframe !== undefined) return `[iframe ${node.iframe}]`;
	const parts: string[] = [];
	if (ref !== undefined) parts.push(ref);
	parts.push(node.role);
	if (node.name) parts.push(JSON.stringify(node.name));
	if (node.value !== undefined && node.value !== "") parts.push(`= ${JSON.stringify(String(node.value))}`);
	if (node.url) parts.push(`-> ${node.url}`);
	if (node.description && node.description !== node.name) parts.push(`(${node.description})`);
	if (node.keyshortcuts) parts.push(`(key: ${node.keyshortcuts})`);
	if (node.states.length) parts.push(`[${node.states.join(", ")}]`);
	if (node.extras?.length) parts.push(...node.extras);
	return parts.join(" ");
}

/** Render lines with diff keys; `refs[i]` is the ref of node i when it is actionable. */
export function buildTreeLines(
	nodes: readonly TreeNode[],
	refs: readonly (number | undefined)[],
	prefix: string,
): TreeLine[] {
	const lines: TreeLine[] = [];
	const ancestors: string[] = [];
	const siblings = new Map<string, number>();
	nodes.forEach((node, index) => {
		ancestors.length = node.depth;
		const parent = ancestors[node.depth - 1] ?? "";
		const ref = refs[index];
		let key: string;
		if (ref !== undefined) {
			key = `${prefix}${ref}`;
		} else {
			const base = `${parent}/${node.iframe !== undefined ? `iframe:${node.iframe}` : `${node.role}:${node.name}`}`;
			const position = siblings.get(base) ?? 0;
			siblings.set(base, position + 1);
			key = `${base}#${position}`;
		}
		ancestors[node.depth] = key;
		lines.push({ key, depth: node.depth, text: renderNode(node, ref === undefined ? undefined : `${prefix}${ref}`), ref });
	});
	return lines;
}

export function renderTree(header: string, lines: readonly TreeLine[]): string {
	const out = [header];
	for (const line of lines) out.push(`${"  ".repeat(line.depth)}${line.text}`);
	return out.join("\n");
}

/** `e12, e40-e47` for a set of ref numbers. */
export function formatRefRanges(refs: readonly number[], prefix: string): string {
	const sorted = [...refs].sort((a, b) => a - b);
	const ranges: string[] = [];
	for (let i = 0; i < sorted.length; ) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
		ranges.push(
			j > i + 1
				? `${prefix}${sorted[i]}-${prefix}${sorted[j]}`
				: sorted
						.slice(i, j + 1)
						.map(n => `${prefix}${n}`)
						.join(", "),
		);
		i = j + 1;
	}
	return ranges.join(", ");
}

/**
 * Only what changed since the previous observation: added (`+`) and changed
 * (`~`) lines under their unchanged ancestors, then the removed refs and the
 * unchanged count. Text nodes have no ref, so a text change reads as one
 * added line and one more removed node. `fullHint` names the call that prints
 * the whole tree again, in the caller's own vocabulary.
 */
export function renderTreeDiff(
	header: string,
	previous: readonly TreeLine[],
	current: readonly TreeLine[],
	options: { prefix: string; fullHint: string },
): string {
	const before = new Map(previous.map(line => [line.key, line]));
	const after = new Map(current.map(line => [line.key, line]));
	const out = [header];
	const body: string[] = [];
	const emitted = new Set<string>();
	const ancestors: TreeLine[] = [];
	let unchanged = 0;
	for (const line of current) {
		ancestors.length = line.depth;
		ancestors[line.depth] = line;
		const old = before.get(line.key);
		const marker = old === undefined ? "+" : old.text !== line.text ? "~" : undefined;
		if (marker === undefined) {
			unchanged++;
			continue;
		}
		for (let depth = 0; depth < line.depth; depth++) {
			const ancestor = ancestors[depth];
			if (!ancestor || emitted.has(ancestor.key)) continue;
			emitted.add(ancestor.key);
			body.push(`  ${"  ".repeat(ancestor.depth)}${ancestor.text}`);
		}
		emitted.add(line.key);
		body.push(`${marker} ${"  ".repeat(line.depth)}${line.text}`);
	}
	const removedRefs: number[] = [];
	let removedOther = 0;
	for (const line of previous) {
		if (after.has(line.key)) continue;
		if (line.ref !== undefined) removedRefs.push(line.ref);
		else removedOther++;
	}
	if (body.length === 0 && removedRefs.length === 0 && removedOther === 0) {
		out.push(`no change since the previous observation (${unchanged} nodes)`);
		return out.join("\n");
	}
	out.push(`diff vs previous observation (+ added, ~ changed; ${options.fullHint})`);
	out.push(...body);
	if (removedRefs.length || removedOther) {
		const parts: string[] = [];
		if (removedRefs.length) parts.push(formatRefRanges(removedRefs, options.prefix));
		if (removedOther) parts.push(`${removedOther} unreferenced node${removedOther === 1 ? "" : "s"}`);
		out.push(`removed: ${parts.join(", ")}`);
	}
	out.push(`unchanged: ${unchanged} node${unchanged === 1 ? "" : "s"}`);
	return out.join("\n");
}
