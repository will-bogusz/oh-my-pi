import type { CDPSession } from "puppeteer-core";
import type { TreeNode } from "../observed-tree";

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
	/** A table or grid part the page makes clickable although no widget role says so (see `TABLE_PART_ROLES`). */
	clickTarget?: boolean;
	/**
	 * An embedded document whose frame did not answer this read in time: it
	 * carries only the frame's `url`, and its content is left out until a later
	 * read gets an answer.
	 */
	unanswered?: boolean;
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

/**
 * Table and grid parts (Chrome reports a table without headers as a layout
 * table). Webmail and admin lists open an item only by clicking its row or
 * cell, so a part the page made focusable or clickable is a click target; a
 * plain data table's parts are not.
 */
const TABLE_PART_ROLES: Record<string, true> = {
	row: true,
	gridcell: true,
	cell: true,
	rowheader: true,
	columnheader: true,
	LayoutTableRow: true,
	LayoutTableCell: true,
};

/** Whether a frame has table parts whose click targets only the DOM can name. */
export function hasTableParts(payloads: readonly AxPayload[]): boolean {
	return payloads.some(
		payload =>
			!payload.ignored &&
			payload.backendDOMNodeId !== undefined &&
			typeof payload.role?.value === "string" &&
			TABLE_PART_ROLES[payload.role.value] === true,
	);
}

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
	clickTarget: boolean;
}

function treeNode(payload: AxPayload, clickable: ReadonlySet<number> | undefined): AxTreeNode {
	const properties = new Map<string, unknown>();
	for (const property of payload.properties ?? []) properties.set(property.name.toLowerCase(), property.value.value);
	if (payload.name) properties.set("name", payload.name.value);
	if (payload.value) properties.set("value", payload.value.value);
	if (payload.description) properties.set("description", payload.description.value);
	const role = typeof payload.role?.value === "string" ? payload.role.value : "Unknown";
	const backendNodeId = payload.backendDOMNodeId;
	return {
		payload,
		properties,
		role,
		name: typeof payload.name?.value === "string" ? payload.name.value : "",
		description: typeof payload.description?.value === "string" ? payload.description.value : "",
		children: [],
		clickTarget:
			TABLE_PART_ROLES[role] === true &&
			(properties.get("focusable") === true ||
				(backendNodeId !== undefined && clickable?.has(backendNodeId) === true)),
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
	if (CONTROL_ROLES[node.role] || node.clickTarget) return true;
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
	if (node.clickTarget) serialized.clickTarget = true;
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
 * announce survive, which is what makes the default tree readable. `clickable`
 * holds the backend ids the DOM marks as click targets (a click listener or a
 * pointer cursor of its own).
 */
export function buildAxTree(
	payloads: readonly AxPayload[],
	frame: AxFrame,
	options: { includeAll: boolean; embedded?: ReadonlyMap<number, AxNode>; clickable?: ReadonlySet<number> },
): AxNode | null {
	const byId = new Map<string, AxTreeNode>();
	for (const payload of payloads) byId.set(payload.nodeId, treeNode(payload, options.clickable));
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

/** Nodes the model can act on: control roles, clickable table parts, or anything carrying a state. */
export function isInteractiveNode(node: AxNode): boolean {
	if (INTERACTIVE_AX_ROLES[node.role] || node.clickTarget) return true;
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
/** Chromium-internal role names the model reads by their plain equivalent. */
const DISPLAY_ROLES: Record<string, string> = { StaticText: "text", LayoutTableRow: "row", LayoutTableCell: "cell" };

export interface ObservedNode extends TreeNode {
	states: string[];
	actionable: boolean;
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
					iframe: embedded.unanswered
						? `${frameHost(embedded)} (not answering; its content is left out of this read)`
						: frameHost(embedded),
				});
				for (const child of embedded.children ?? []) visit(child, depth + 1, "");
				return;
			}
		}
		if (node.role === "RootWebArea" || (TRANSPARENT_ROLES[node.role] && !node.name)) {
			for (const child of children) visit(child, depth, parentName);
			return;
		}
		const role = DISPLAY_ROLES[node.role] ?? node.role;
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

/**
 * The display subtrees rooted at the nodes `inScope` accepts, each re-rooted at
 * depth 0. A root's descendants in display order come along whether or not
 * `inScope` knows them, which is how an iframe's document follows its element.
 */
export function scopeNodes(nodes: readonly ObservedNode[], inScope: (node: ObservedNode) => boolean): ObservedNode[] {
	const scoped: ObservedNode[] = [];
	let rootDepth: number | undefined;
	for (const node of nodes) {
		if (rootDepth !== undefined && node.depth > rootDepth) {
			scoped.push({ ...node, depth: node.depth - rootDepth });
			continue;
		}
		rootDepth = inScope(node) ? node.depth : undefined;
		if (rootDepth !== undefined) scoped.push({ ...node, depth: 0 });
	}
	return scoped;
}

/** Controls, and the nodes on the path down to one; everything else is dropped. */
export function compactNodes(nodes: readonly ObservedNode[]): ObservedNode[] {
	const kept = new Set<number>();
	const open: number[] = [];
	nodes.forEach((node, index) => {
		while (open.length > 0 && nodes[open[open.length - 1]!]!.depth >= node.depth) open.pop();
		if (node.actionable) {
			for (const ancestor of open) kept.add(ancestor);
			kept.add(index);
		}
		open.push(index);
	});
	return nodes.filter((_, index) => kept.has(index));
}

/** Roles a loading label marks as a spinner; a heading or link that says "loading" is content. */
const SPINNER_ROLES: Record<string, true> = { StaticText: true, text: true, img: true, image: true, status: true, alert: true, generic: true, paragraph: true };
/** Wording a loader shows, anywhere in a short name: "Loading…", "Content loading", "Please wait". */
const LOADER_TEXT = /\b(?:loading|please wait|one moment|just a moment)\b/i;
/** A loader label is a few words; a longer name is a sentence about loading. */
const LOADER_NAME_MAX_CHARS = 64;
/** Landmarks around the page's content: a loader there never stands for the content itself. */
const PERIPHERAL_ROLES: Record<string, true> = {
	banner: true,
	contentinfo: true,
	navigation: true,
	complementary: true,
};
/**
 * Text a loader's page may carry besides it and still be "only a loader". A
 * page with more has its content, so a permanent "Loading…" footer or a
 * "Loading more…" sentinel under an article never holds the observation.
 */
const LOADER_CONTENT_MAX_CHARS = 300;

/** Characters of leaf text under `node`, skipping loaders and the landmarks around the content. */
function contentChars(node: AxNode, loaders: ReadonlySet<AxNode>): number {
	if (loaders.has(node) || PERIPHERAL_ROLES[node.role]) return 0;
	if (!node.children?.length) return (node.name ?? "").trim().length;
	let total = 0;
	for (const child of node.children) total += contentChars(child, loaders);
	return total;
}

/**
 * Whether the page still shows a loading indicator the observation should wait out.
 *
 * `aria-busy` and an indeterminate progressbar are the page saying so. Loader
 * text is weaker: it counts only outside the landmarks around the content, and
 * only while the content it sits in — its `main`, else the whole page — has
 * little text besides loaders.
 */
export function hasBusyIndicator(root: AxNode): boolean {
	const loaders = new Set<AxNode>();
	const scopes = new Set<AxNode>();
	const busy = (node: AxNode, scope: AxNode | undefined): boolean => {
		if (node.busy === true) return true;
		// A progressbar with a value is a meter; only an indeterminate one is "still loading".
		if (node.role === "progressbar" && node.value === undefined && node.valuetext === undefined) return true;
		const inner = PERIPHERAL_ROLES[node.role] ? undefined : node.role === "main" ? node : scope;
		const name = (node.name ?? "").trim();
		if (inner && SPINNER_ROLES[node.role] && name.length <= LOADER_NAME_MAX_CHARS && LOADER_TEXT.test(name)) {
			loaders.add(node);
			scopes.add(inner);
		}
		return (node.children ?? []).some(child => busy(child, inner));
	};
	if (busy(root, root)) return true;
	return [...scopes].some(scope => contentChars(scope, loaders) <= LOADER_CONTENT_MAX_CHARS);
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

/** The header line of a browser observation: where the tab is, and what it is looking at. */
export interface TreeHeader {
	url: string;
	title?: string;
	scroll: { y: number; scrollHeight: number };
	focused?: string;
	/** The settle budget ran out while the page kept replacing its document: the tree may already be gone. */
	navigating?: boolean;
	/** The settle budget ran out while the page still showed a loading indicator: content may still arrive. */
	loading?: boolean;
}

export function renderHeader(header: TreeHeader): string {
	const parts = [`url: ${header.url}`];
	if (header.title) parts.push(`title: ${header.title}`);
	parts.push(`scroll: ${header.scroll.y}/${header.scroll.scrollHeight}`);
	if (header.focused) parts.push(`focused: ${header.focused}`);
	if (header.navigating) parts.push("still navigating (the page kept replacing its document; observe again)");
	if (header.loading)
		parts.push("may still be loading (a loading indicator outlasted the settle wait; observe again)");
	return parts.join(" | ");
}

/** Same document when only the fragment differs. */
export function sameDocument(a: string, b: string): boolean {
	const strip = (url: string) => {
		const hash = url.indexOf("#");
		return hash >= 0 ? url.slice(0, hash) : url;
	};
	return strip(a) === strip(b);
}
