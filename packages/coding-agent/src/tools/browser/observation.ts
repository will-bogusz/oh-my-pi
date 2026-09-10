import type { CDPSession } from "puppeteer-core";

/**
 * Observation model shared by the tab worker: serializing Chrome's raw
 * accessibility payloads into displayable nodes, keeping element refs stable
 * across observations, rendering the tree, and diffing it against the previous
 * one. Pure functions only — the worker owns sessions, frames and timing.
 */

/** The CDP session and document an accessibility node was read from. */
export interface AxFrame {
	/** Session owning the node's frame: every action on the node dispatches here. */
	readonly session: CDPSession;
	readonly frameId: string;
	/** Document generation: distinguishes equal backend ids across frames and navigations. */
	readonly loaderId: string;
}

/** The `Accessibility.AXNode` fields the serializer reads, structurally compatible with CDP's. */
export interface AxPayload {
	nodeId: string;
	ignored: boolean;
	role?: { value?: unknown };
	name?: { value?: unknown };
	value?: { value?: unknown };
	description?: { value?: unknown };
	properties?: readonly { name: string; value: { value?: unknown } }[];
	childIds?: readonly string[];
	backendDOMNodeId?: number;
}

/** One serialized accessibility node: puppeteer's `SerializedAXNode` shape, read over CDP. */
export interface AxNode {
	role: string;
	name?: string;
	value?: string | number;
	description?: string;
	keyshortcuts?: string;
	roledescription?: string;
	valuetext?: string;
	url?: string;
	disabled?: boolean;
	expanded?: boolean;
	focused?: boolean;
	modal?: boolean;
	multiline?: boolean;
	multiselectable?: boolean;
	readonly?: boolean;
	required?: boolean;
	selected?: boolean;
	busy?: boolean;
	checked?: boolean | "mixed";
	pressed?: boolean | "mixed";
	level?: number;
	children?: AxNode[];
	/** The DOM node behind this accessibility node, in its own frame's id space. */
	backendNodeId?: number;
	/** Loader of the document the node belongs to. */
	loaderId?: string;
	/** Session and frame the node came from; absent only on hand-built fixtures. */
	frame?: AxFrame;
}

/** Roles whose children Chrome exposes as implementation detail, not content. */
const TEXT_ONLY_ROLES: Record<string, true> = { LineBreak: true, text: true, InlineTextBox: true, StaticText: true };
/** Roles the ARIA/HTML specs give presentational children only. */
const PRESENTATIONAL_CHILD_ROLES: Record<string, true> = {
	"doc-cover": true,
	"graphics-symbol": true,
	img: true,
	image: true,
	Meter: true,
	scrollbar: true,
	slider: true,
	separator: true,
	progressbar: true,
};
const CONTROL_ROLES: Record<string, true> = {
	button: true,
	checkbox: true,
	ColorWell: true,
	combobox: true,
	DisclosureTriangle: true,
	listbox: true,
	menu: true,
	menubar: true,
	menuitem: true,
	menuitemcheckbox: true,
	menuitemradio: true,
	radio: true,
	scrollbar: true,
	searchbox: true,
	slider: true,
	spinbutton: true,
	switch: true,
	tab: true,
	textbox: true,
	tree: true,
	treeitem: true,
};
const LANDMARK_ROLES: Record<string, true> = {
	banner: true,
	complementary: true,
	contentinfo: true,
	form: true,
	main: true,
	navigation: true,
	region: true,
	search: true,
};

/** A payload plus the derived state the interesting-node filter needs. */
interface AxTreeNode {
	payload: AxPayload;
	properties: Map<string, unknown>;
	role: string;
	name: string;
	description: string;
	children: AxTreeNode[];
	/** Document of the iframe this node owns, already serialized. */
	embedded?: AxNode;
	focusableChild?: boolean;
}

function treeNode(payload: AxPayload): AxTreeNode {
	const properties = new Map<string, unknown>();
	for (const property of payload.properties ?? []) properties.set(property.name.toLowerCase(), property.value.value);
	if (payload.name) properties.set("name", payload.name.value);
	if (payload.value) properties.set("value", payload.value.value);
	if (payload.description) properties.set("description", payload.description.value);
	return {
		payload,
		properties,
		role: typeof payload.role?.value === "string" ? payload.role.value : "Unknown",
		name: typeof payload.name?.value === "string" ? payload.name.value : "",
		description: typeof payload.description?.value === "string" ? payload.description.value : "",
		children: [],
	};
}

function hasFocusableChild(node: AxTreeNode): boolean {
	if (node.focusableChild === undefined) {
		node.focusableChild = node.children.some(
			child => child.properties.get("focusable") === true || hasFocusableChild(child),
		);
	}
	return node.focusableChild;
}

function isLeafNode(node: AxTreeNode): boolean {
	if (!node.children.length) return true;
	const editable = node.properties.has("editable");
	const richlyEditable = node.properties.get("editable") === "richtext";
	const plainTextField = richlyEditable ? false : editable || node.role === "textbox" || node.role === "searchbox";
	if (plainTextField || TEXT_ONLY_ROLES[node.role]) return true;
	if (PRESENTATIONAL_CHILD_ROLES[node.role]) return true;
	if (hasFocusableChild(node)) return false;
	return node.role === "heading" && Boolean(node.name);
}

/** Chrome's own "would a screen reader announce this" test, as puppeteer's serializer applies it. */
function isInteresting(node: AxTreeNode, insideControl: boolean): boolean {
	if (node.role === "Ignored" || node.properties.get("hidden") === true || node.payload.ignored) return false;
	if (LANDMARK_ROLES[node.role]) return true;
	const live = node.properties.get("live");
	if (
		node.properties.get("focusable") === true ||
		node.properties.get("editable") === "richtext" ||
		node.properties.get("busy") === true ||
		(typeof live === "string" && live !== "off") ||
		node.properties.get("modal") === true ||
		node.properties.has("errormessage") ||
		node.properties.has("details") ||
		node.properties.has("roledescription")
	)
		return true;
	if (CONTROL_ROLES[node.role]) return true;
	if (insideControl) return false;
	return isLeafNode(node) && Boolean(node.name || node.description);
}

function collectInteresting(collection: Set<AxTreeNode>, node: AxTreeNode, insideControl: boolean): void {
	if (isInteresting(node, insideControl) || node.embedded) collection.add(node);
	if (isLeafNode(node)) return;
	const nested = insideControl || CONTROL_ROLES[node.role] === true;
	for (const child of node.children) collectInteresting(collection, child, nested);
}

const AX_STRING_PROPERTIES = ["name", "value", "description", "keyshortcuts", "roledescription", "valuetext", "url"] as const;
const AX_BOOLEAN_PROPERTIES = [
	"disabled",
	"expanded",
	"focused",
	"modal",
	"multiline",
	"multiselectable",
	"readonly",
	"required",
	"selected",
	"busy",
] as const;

function serialize(node: AxTreeNode, frame: AxFrame): AxNode {
	const serialized: AxNode = { role: node.role, backendNodeId: node.payload.backendDOMNodeId, loaderId: frame.loaderId, frame };
	for (const key of AX_STRING_PROPERTIES) {
		const value = node.properties.get(key);
		if (value !== undefined) serialized[key] = String(value);
	}
	for (const key of AX_BOOLEAN_PROPERTIES) {
		// A RootWebArea reports whether its frame has focus, not whether focus is on the node.
		if (key === "focused" && node.role === "RootWebArea") continue;
		if (node.properties.has(key)) serialized[key] = Boolean(node.properties.get(key));
	}
	for (const key of ["checked", "pressed"] as const) {
		if (!node.properties.has(key)) continue;
		const value = node.properties.get(key);
		serialized[key] = value === "mixed" ? "mixed" : value === "true" || value === true;
	}
	const level = node.properties.get("level");
	if (level !== undefined) serialized.level = Number(level);
	return serialized;
}

function serializeTree(node: AxTreeNode, frame: AxFrame, interesting: Set<AxTreeNode> | undefined): AxNode[] {
	const children: AxNode[] = [];
	for (const child of node.children) children.push(...serializeTree(child, frame, interesting));
	if (interesting && !interesting.has(node)) return children;
	const serialized = serialize(node, frame);
	if (node.embedded) children.push(node.embedded);
	if (children.length) serialized.children = children;
	return [serialized];
}

/**
 * Serialize one frame's `Accessibility.getFullAXTree` payloads into a node tree,
 * splicing each embedded document under the iframe element that owns it.
 * `includeAll` keeps every node; otherwise only the ones a screen reader would
 * announce survive, which is what makes the default tree readable.
 */
export function buildAxTree(
	payloads: readonly AxPayload[],
	frame: AxFrame,
	options: { includeAll: boolean; embedded?: ReadonlyMap<number, AxNode> },
): AxNode | null {
	const byId = new Map<string, AxTreeNode>();
	for (const payload of payloads) byId.set(payload.nodeId, treeNode(payload));
	for (const node of byId.values()) {
		for (const childId of node.payload.childIds ?? []) {
			const child = byId.get(childId);
			if (child) node.children.push(child);
		}
		const backendNodeId = node.payload.backendDOMNodeId;
		if (backendNodeId !== undefined) node.embedded = options.embedded?.get(backendNodeId);
	}
	const root = byId.values().next().value;
	if (!root) return null;
	if (options.includeAll) return serializeTree(root, frame, undefined)[0] ?? null;
	const interesting = new Set<AxTreeNode>();
	collectInteresting(interesting, root, false);
	return serializeTree(root, frame, interesting)[0] ?? null;
}

const INTERACTIVE_AX_ROLES: Record<string, true> = {
	button: true,
	link: true,
	textbox: true,
	combobox: true,
	listbox: true,
	option: true,
	checkbox: true,
	radio: true,
	switch: true,
	tab: true,
	menuitem: true,
	menuitemcheckbox: true,
	menuitemradio: true,
	slider: true,
	spinbutton: true,
	searchbox: true,
	treeitem: true,
};

/** Nodes the model can act on: control roles or anything carrying a state. */
export function isInteractiveNode(node: AxNode): boolean {
	if (INTERACTIVE_AX_ROLES[node.role]) return true;
	return (
		node.checked !== undefined ||
		node.pressed !== undefined ||
		node.selected !== undefined ||
		node.expanded !== undefined ||
		node.focused === true
	);
}

/** Roles that only exist as Chromium's internal text layout; their parent already carries the text. */
const LAYOUT_ROLES: Record<string, true> = { Ignored: true, InlineTextBox: true, LineBreak: true };
/** Structural roles that add nothing to the tree when unnamed: children are hoisted. */
const TRANSPARENT_ROLES: Record<string, true> = { generic: true, none: true, presentation: true, GenericContainer: true };

export interface ObservedNode {
	depth: number;
	role: string;
	name: string;
	value?: string | number;
	description?: string;
	keyshortcuts?: string;
	url?: string;
	states: string[];
	actionable: boolean;
	/** Set on the boundary line of an embedded document: the iframe's host. */
	iframe?: string;
	/** The snapshot node behind an actionable line; absent on iframe boundaries. */
	ax?: AxNode;
}

function nodeStates(node: AxNode): string[] {
	const states: string[] = [];
	const tristate = (label: string, value: boolean | "mixed" | undefined) => {
		if (value === undefined) return;
		states.push(value === true ? label : `${label}=${String(value)}`);
	};
	if (node.disabled) states.push("disabled");
	tristate("checked", node.checked);
	tristate("pressed", node.pressed);
	tristate("selected", node.selected);
	tristate("expanded", node.expanded);
	if (node.required) states.push("required");
	if (node.readonly) states.push("readonly");
	if (node.multiselectable) states.push("multiselectable");
	if (node.multiline) states.push("multiline");
	if (node.modal) states.push("modal");
	if (node.focused) states.push("focused");
	return states;
}

function frameHost(root: AxNode): string {
	const url = root.url ?? "";
	try {
		const parsed = new URL(url);
		return parsed.host || parsed.protocol;
	} catch {
		return url || root.name || "";
	}
}

/**
 * Flatten a snapshot into display order. The page's own root is implied by the
 * header; an iframe's root becomes a `[iframe host]` boundary line with the
 * embedded document indented beneath it, so cross-origin content reads inline.
 */
export function flattenSnapshot(root: AxNode, options: { includeAll: boolean }): ObservedNode[] {
	const nodes: ObservedNode[] = [];
	const visit = (node: AxNode, depth: number, parentName: string): void => {
		const children = node.children ?? [];
		if (LAYOUT_ROLES[node.role]) return;
		if (node.role === "Iframe") {
			const embedded = children.find(child => child.role === "RootWebArea");
			if (embedded) {
				nodes.push({
					depth,
					role: "iframe",
					name: (node.name ?? "").trim(),
					states: [],
					actionable: false,
					iframe: frameHost(embedded),
				});
				for (const child of embedded.children ?? []) visit(child, depth + 1, "");
				return;
			}
		}
		if (node.role === "RootWebArea" || (TRANSPARENT_ROLES[node.role] && !node.name)) {
			for (const child of children) visit(child, depth, parentName);
			return;
		}
		const role = node.role === "StaticText" ? "text" : node.role;
		const name = (node.name ?? "").trim();
		// A link's or heading's text child only repeats the name it was computed from.
		if (role === "text" && (name === "" || name === parentName)) return;
		const actionable = node.backendNodeId !== undefined && (options.includeAll || isInteractiveNode(node));
		nodes.push({
			depth,
			role,
			name,
			value: node.value,
			description: node.description,
			keyshortcuts: node.keyshortcuts,
			url: options.includeAll ? node.url : undefined,
			states: nodeStates(node),
			actionable,
			ax: node,
		});
		for (const child of children) visit(child, depth + 1, name);
	};
	visit(root, 0, "");
	return nodes;
}

/** Roles a "Loading…" label marks as a spinner; a heading or link that starts with the word is content. */
const SPINNER_ROLES: Record<string, true> = { StaticText: true, text: true, img: true, image: true, status: true, alert: true, generic: true, paragraph: true };

/** Whether the page still shows a loading indicator the observation should wait out. */
export function hasBusyIndicator(root: AxNode): boolean {
	const busy = (node: AxNode): boolean => {
		if (node.busy === true) return true;
		// A progressbar with a value is a meter; only an indeterminate one is "still loading".
		if (node.role === "progressbar" && node.value === undefined && node.valuetext === undefined) return true;
		if (SPINNER_ROLES[node.role] && /^loading\b/i.test((node.name ?? "").trim())) return true;
		return (node.children ?? []).some(busy);
	};
	return busy(root);
}

/** Identity of the DOM node behind a snapshot node, unique across frames for one document lifetime. */
export function axNodeKey(node: AxNode): string | undefined {
	if (node.backendNodeId === undefined) return undefined;
	return `${node.loaderId ?? ""}:${node.backendNodeId}`;
}

export interface RefRecord {
	role: string;
	name: string;
	/** Position among same role+name nodes of the observation that last saw it. */
	position: number;
	nodeKey?: string;
}

/** Position of every entry among the ones sharing its role+name, in order. */
export function roleNamePositions(entries: readonly { role: string; name: string }[]): number[] {
	const seen = new Map<string, number>();
	return entries.map(entry => {
		const key = `${entry.role}\u0000${entry.name}`;
		const position = seen.get(key) ?? 0;
		seen.set(key, position + 1);
		return position;
	});
}

/**
 * Give each actionable node its ref: the number a previous observation minted
 * for the same DOM node, else for the same role+name+position (a re-render
 * that replaced the node), else a fresh one. Numbers are never reused, so a
 * ref means the same element for the whole tab lifetime.
 */
export function matchRefs(
	nodes: readonly { role: string; name: string; nodeKey?: string }[],
	previous: ReadonlyMap<number, RefRecord>,
	mint: () => number,
): number[] {
	const byNode = new Map<string, number>();
	const byKey = new Map<string, number>();
	for (const [ref, record] of previous) {
		if (record.nodeKey) byNode.set(record.nodeKey, ref);
		byKey.set(`${record.role}\u0000${record.name}\u0000${record.position}`, ref);
	}
	const positions = roleNamePositions(nodes);
	const refs: (number | undefined)[] = nodes.map(() => undefined);
	const claimed = new Set<number>();
	nodes.forEach((node, index) => {
		const ref = node.nodeKey ? byNode.get(node.nodeKey) : undefined;
		if (ref !== undefined && !claimed.has(ref)) {
			refs[index] = ref;
			claimed.add(ref);
		}
	});
	nodes.forEach((node, index) => {
		if (refs[index] !== undefined) return;
		const ref = byKey.get(`${node.role}\u0000${node.name}\u0000${positions[index]}`);
		if (ref !== undefined && !claimed.has(ref)) {
			refs[index] = ref;
			claimed.add(ref);
		}
	});
	return refs.map(ref => ref ?? mint());
}

export interface TreeLine {
	/** Diff identity: the ref for actionable nodes, else the ancestor path plus role/name/position. */
	key: string;
	depth: number;
	text: string;
	ref?: number;
}

/** One node as the model reads it: `e26 tab "Contributions" = "value" (description) [selected]`. */
export function renderNode(node: ObservedNode, ref: number | undefined): string {
	if (node.iframe !== undefined) return `[iframe ${node.iframe}]`;
	const parts: string[] = [];
	if (ref !== undefined) parts.push(`e${ref}`);
	parts.push(node.role);
	if (node.name) parts.push(JSON.stringify(node.name));
	if (node.value !== undefined && node.value !== "") parts.push(`= ${JSON.stringify(String(node.value))}`);
	if (node.url) parts.push(`-> ${node.url}`);
	if (node.description && node.description !== node.name) parts.push(`(${node.description})`);
	if (node.keyshortcuts) parts.push(`(key: ${node.keyshortcuts})`);
	if (node.states.length) parts.push(`[${node.states.join(", ")}]`);
	return parts.join(" ");
}

/** Render lines with diff keys; `refs[i]` is the ref of node i when it is actionable. */
export function buildTreeLines(nodes: readonly ObservedNode[], refs: readonly (number | undefined)[]): TreeLine[] {
	const lines: TreeLine[] = [];
	const ancestors: string[] = [];
	const siblings = new Map<string, number>();
	nodes.forEach((node, index) => {
		ancestors.length = node.depth;
		const parent = ancestors[node.depth - 1] ?? "";
		const ref = refs[index];
		let key: string;
		if (ref !== undefined) {
			key = `e${ref}`;
		} else {
			const base = `${parent}/${node.iframe !== undefined ? `iframe:${node.iframe}` : `${node.role}:${node.name}`}`;
			const position = siblings.get(base) ?? 0;
			siblings.set(base, position + 1);
			key = `${base}#${position}`;
		}
		ancestors[node.depth] = key;
		lines.push({ key, depth: node.depth, text: renderNode(node, ref), ref });
	});
	return lines;
}

export interface TreeHeader {
	url: string;
	title?: string;
	scroll: { y: number; scrollHeight: number };
	focused?: string;
}

export function renderHeader(header: TreeHeader): string {
	const parts = [`url: ${header.url}`];
	if (header.title) parts.push(`title: ${header.title}`);
	parts.push(`scroll: ${header.scroll.y}/${header.scroll.scrollHeight}`);
	if (header.focused) parts.push(`focused: ${header.focused}`);
	return parts.join(" | ");
}

export function renderTree(header: TreeHeader, lines: readonly TreeLine[]): string {
	const out = [renderHeader(header)];
	for (const line of lines) out.push(`${"  ".repeat(line.depth)}${line.text}`);
	return out.join("\n");
}

/** `e12, e40-e47` for a set of ref numbers. */
export function formatRefRanges(refs: readonly number[]): string {
	const sorted = [...refs].sort((a, b) => a - b);
	const ranges: string[] = [];
	for (let i = 0; i < sorted.length; ) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
		ranges.push(j > i + 1 ? `e${sorted[i]}-e${sorted[j]}` : sorted.slice(i, j + 1).map(n => `e${n}`).join(", "));
		i = j + 1;
	}
	return ranges.join(", ");
}

/**
 * Only what changed since the previous observation: added (`+`) and changed
 * (`~`) lines under their unchanged ancestors, then the removed refs and the
 * unchanged count. Text nodes have no ref, so a text change reads as one
 * added line and one more removed node.
 */
export function renderTreeDiff(header: TreeHeader, previous: readonly TreeLine[], current: readonly TreeLine[]): string {
	const before = new Map(previous.map(line => [line.key, line]));
	const after = new Map(current.map(line => [line.key, line]));
	const out = [renderHeader(header)];
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
	out.push("diff vs previous observation (+ added, ~ changed; observe({ diff: false }) for the full tree)");
	out.push(...body);
	if (removedRefs.length || removedOther) {
		const parts: string[] = [];
		if (removedRefs.length) parts.push(formatRefRanges(removedRefs));
		if (removedOther) parts.push(`${removedOther} unreferenced node${removedOther === 1 ? "" : "s"}`);
		out.push(`removed: ${parts.join(", ")}`);
	}
	out.push(`unchanged: ${unchanged} node${unchanged === 1 ? "" : "s"}`);
	return out.join("\n");
}

/** Same document when only the fragment differs. */
export function sameDocument(a: string, b: string): boolean {
	const strip = (url: string) => {
		const hash = url.indexOf("#");
		return hash >= 0 ? url.slice(0, hash) : url;
	};
	return strip(a) === strip(b);
}
