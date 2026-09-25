import { untilAborted } from "@oh-my-pi/pi-utils";
import type { CDPSession, Frame, Page } from "puppeteer-core";
import { _keyDefinitions } from "puppeteer-core/internal/common/USKeyboardLayout.js";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { type AxFrame, type AxNode, buildAxTree, hasTableParts } from "./observation";
import { type BrowserSelectOption, normalizeSelectOptions, SELECT_OPTIONS_SOURCE } from "./select-options";

/**
 * The browser primitives the observe → ref → act loop runs on: raw CDP keyed by
 * `backendNodeId` and the session that owns the node's frame. Nothing here
 * caches an execution-context id, a RemoteObject or an ElementHandle between
 * calls, so a navigation can never leave a ref pointing at a dead realm — the
 * failure mode that made a whole tab unusable until it was released and
 * re-claimed. The few operations that genuinely need a JS object resolve one,
 * use it and release it inside a single call.
 */

declare module "puppeteer-core" {
	interface Frame {
		/** Session serving this frame's target: its own for an OOPIF, the page's for everything else. */
		readonly client: CDPSession;
		/** CDP frame id (`@internal` upstream, present at runtime). */
		readonly _id: string;
	}
}

/** A DOM node addressed the only way that outlives a navigation: backend id plus owning session. */
export interface CdpNode {
	readonly session: CDPSession;
	readonly backendNodeId: number;
	/** How the caller names this node in errors, e.g. `e12`. */
	readonly label: string;
}

export interface Point {
	x: number;
	y: number;
}

export interface Rect extends Point {
	width: number;
	height: number;
}

const ORIGIN: Point = { x: 0, y: 0 };

/** Viewport and document geometry, in CSS pixels of the root frame. */
export interface PageLayout {
	viewport: { width: number; height: number };
	scroll: { x: number; y: number; scrollWidth: number; scrollHeight: number };
}

/**
 * A CDP call answered by a document that no longer exists. Chrome reports this
 * for a cross-document navigation that lands mid-call; it is the navigation
 * signal, never something to retry against the same document.
 */
export function isDocumentGoneError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("Inspected target navigated or closed") ||
		message.includes("Cannot find context with specified id") ||
		message.includes("Execution context was destroyed") ||
		message.includes("Execution context is not available") ||
		message.includes("uniqueContextId not found")
	);
}

export async function pageLayout(session: CDPSession, signal?: AbortSignal): Promise<PageLayout> {
	const metrics = await untilAborted(signal, () => session.send("Page.getLayoutMetrics"));
	const view = metrics.cssVisualViewport;
	return {
		viewport: { width: view.clientWidth, height: view.clientHeight },
		scroll: {
			x: view.pageX,
			y: view.pageY,
			scrollWidth: metrics.cssContentSize.width,
			scrollHeight: metrics.cssContentSize.height,
		},
	};
}

/** URL and title of the document currently shown, without asking the page to run anything. */
export async function currentEntry(session: CDPSession, signal?: AbortSignal): Promise<{ url: string; title: string }> {
	const history = await untilAborted(signal, () => session.send("Page.getNavigationHistory"));
	const entry = history.entries[history.currentIndex];
	return { url: entry?.url ?? "", title: entry?.title ?? "" };
}

/**
 * Run one expression in the session's current main-world document. A fresh
 * `Runtime.evaluate` binds to whatever document is live at call time, so it can
 * never fail against a context id we remembered from an earlier one.
 */
export async function evaluateExpression(
	session: CDPSession,
	expression: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const result = await untilAborted(signal, () =>
		session.send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
			userGesture: true,
		}),
	);
	if (result.exceptionDetails) throw new ToolError(describeException(result.exceptionDetails.text, result.exceptionDetails.exception?.description));
	return result.result.value;
}

function describeException(text: string, description: string | undefined): string {
	return description ? `Page evaluation failed: ${description}` : `Page evaluation failed: ${text}`;
}

/** `(fn)(...args)` as a self-contained expression: no bindings survive between calls. */
export function callExpression(fn: string, args: readonly unknown[]): string {
	return `(${fn})(${args.map(arg => JSON.stringify(arg ?? null)).join(", ")})`;
}

/**
 * Resolve the node into a JS object, hand it to `fn` as `this`, and release it
 * in the same call. Used only where an operation needs a live object — select,
 * file inputs, user `evaluate` — never to keep one.
 */
export async function callOnNode(
	node: CdpNode,
	fn: string,
	args: readonly unknown[],
	signal?: AbortSignal,
): Promise<unknown> {
	const resolved = await untilAborted(signal, () =>
		node.session.send("DOM.resolveNode", { backendNodeId: node.backendNodeId }),
	).catch(error => {
		rethrowIfAborted(signal, error);
		throw staleNode(node, error);
	});
	const objectId = resolved.object.objectId;
	if (!objectId) throw staleNode(node, new Error("node did not resolve to an object"));
	try {
		const result = await untilAborted(signal, () =>
			node.session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: fn,
				arguments: args.map(arg => ({ value: arg })),
				returnByValue: true,
				awaitPromise: true,
				userGesture: true,
			}),
		);
		if (result.exceptionDetails) {
			const details = result.exceptionDetails;
			throw new ToolError(
				`${node.label}: ${details.exception?.description?.split("\n")[0] ?? details.text}`,
			);
		}
		return result.result.value;
	} finally {
		await node.session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
	}
}

function staleNode(node: CdpNode, cause: unknown): ToolError {
	return new ToolError(
		`${node.label} is stale: the page no longer has that element (${cause instanceof Error ? cause.message : String(cause)}). Run tab.observe() again.`,
	);
}

/** An abort is the caller's deadline running out, never evidence about the node. */
function rethrowIfAborted(signal: AbortSignal | undefined, error: unknown): void {
	if (signal?.aborted) throw error;
}

/** Border quad of the node in its own frame's coordinates, or null when it has no box. */
async function borderQuad(node: CdpNode, signal?: AbortSignal): Promise<number[] | null> {
	const box = await untilAborted(signal, () =>
		node.session.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId }),
	).catch(error => {
		rethrowIfAborted(signal, error);
		return null;
	});
	return box ? box.model.border : null;
}

function quadRect(quad: readonly number[]): Rect {
	const xs = [quad[0], quad[2], quad[4], quad[6]];
	const ys = [quad[1], quad[3], quad[5], quad[7]];
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** A quad something can land on: at least one CSS pixel of area, however it is rotated. */
function hasArea(quad: readonly number[] | null): quad is readonly number[] {
	if (!quad) return false;
	let twiceArea = 0;
	for (let index = 0; index < 8; index += 2) {
		twiceArea += quad[index] * quad[(index + 3) % 8] - quad[(index + 2) % 8] * quad[index + 1];
	}
	return Math.abs(twiceArea) / 2 >= 1;
}

/**
 * Where this session's coordinates sit in the root viewport. Chrome reports box
 * models relative to the local root of the renderer that owns the node, so a
 * node in an out-of-process iframe measures from that iframe's content origin;
 * everything in the page's own process already measures from the root.
 */
export async function sessionOffset(page: Page, session: CDPSession, signal?: AbortSignal): Promise<Point> {
	if (session === page.mainFrame().client) return ORIGIN;
	const localRoot = page.frames().find(frame => frame.client === session && frame.parentFrame()?.client !== session);
	const parent = localRoot?.parentFrame();
	if (!localRoot || !parent) return ORIGIN;
	const parentOffset = await sessionOffset(page, parent.client, signal);
	const owner = await untilAborted(signal, () => parent.client.send("DOM.getFrameOwner", { frameId: localRoot._id }));
	const box = await untilAborted(signal, () =>
		parent.client.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }),
	);
	const content = quadRect(box.model.content);
	return { x: parentOffset.x + content.x, y: parentOffset.y + content.y };
}

/** The node's border box in root-viewport coordinates, or null when it has no box. */
export async function boundingBox(node: CdpNode, offset: Point, signal?: AbortSignal): Promise<Rect | null> {
	const quad = await borderQuad(node, signal);
	const box = quad && quadRect(quad);
	if (!box || box.width === 0 || box.height === 0) return null;
	return { x: box.x + offset.x, y: box.y + offset.y, width: box.width, height: box.height };
}

export async function scrollIntoView(node: CdpNode, signal?: AbortSignal): Promise<void> {
	await untilAborted(signal, () =>
		node.session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId }),
	).catch(error => {
		rethrowIfAborted(signal, error);
		throw staleNode(node, error);
	});
}

export async function focusNode(node: CdpNode, signal?: AbortSignal): Promise<void> {
	await untilAborted(signal, () => node.session.send("DOM.focus", { backendNodeId: node.backendNodeId })).catch(
		error => {
			rethrowIfAborted(signal, error);
			throw staleNode(node, error);
		},
	);
}

/**
 * Where a press on the node lands, in its own frame's coordinates: the centre of
 * its first fragment with area. `DOM.getContentQuads` gives each line of a
 * wrapped inline and follows transforms, but measures an inline by its text
 * alone, so an icon link drawn by padding and a background falls back to its
 * border box. Null when neither has area.
 */
async function pressPoint(node: CdpNode, signal?: AbortSignal): Promise<Point | null> {
	const quads = await untilAborted(signal, () =>
		node.session.send("DOM.getContentQuads", { backendNodeId: node.backendNodeId }),
	).then(
		result => result.quads,
		error => {
			rethrowIfAborted(signal, error);
			return [];
		},
	);
	const quad = quads.find(hasArea) ?? (await borderQuad(node, signal));
	if (!hasArea(quad)) return null;
	return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
}

/** `<tag#id.class>`: how a refusal names an element. */
const DESCRIBE_ELEMENT = `target => {
	const id = target.id ? "#" + target.id : "";
	const classes = Array.from(target.classList).slice(0, 2).map(name => "." + name).join("");
	return "<" + target.tagName.toLowerCase() + id + classes + ">";
}`;

/** Whether `descendant` is `ancestor` or inside it, across shadow roots. */
const CONTAINS = `(ancestor, descendant) => {
	for (let current = descendant, depth = 0; current && depth < 64; depth++) {
		if (current === ancestor) return true;
		current = current.parentElement || current.getRootNode().host || null;
	}
	return false;
}`;

/** A native checkbox/radio or ARIA checkbox/radio/switch, and its state now; `kind` is empty for anything else. */
const CHECKED_OF = `element => {
	const tag = element.tagName.toLowerCase();
	const type = tag === "input" ? String(element.type).toLowerCase() : "";
	const role = (element.getAttribute("role") || "").toLowerCase();
	if (tag === "input" && (type === "checkbox" || type === "radio")) {
		const state = element.indeterminate && type === "checkbox" ? "mixed" : element.checked ? "checked" : "unchecked";
		return { kind: type, checked: element.checked, state };
	}
	if (role === "switch" || role === "checkbox" || role === "radio") {
		const aria = element.getAttribute("aria-checked");
		const state = aria === "true" ? "checked" : aria === "mixed" ? "mixed" : "unchecked";
		return { kind: "aria-" + role, checked: aria === "true", state };
	}
	return { kind: "", checked: false, state: "unchecked" };
}`;
const CHECKED_STATE = `function () { return (${CHECKED_OF})(this); }`;

interface CheckedState {
	kind: string;
	checked: boolean;
	state: "checked" | "unchecked" | "mixed";
}

/**
 * Why a press on the node would not reach it, or null when it would. Asked of
 * the node where it lives, so an iframe needs no offsets, and in the order a
 * user would find out: the page dropped it (Chrome keeps answering for detached
 * nodes), `display:none` on it or an ancestor, no area, `visibility` that
 * hit-testing skips, or another element over the centre of its first fragment
 * (the fragment the press targets). An ancestor at that point is not a cover,
 * and neither is one of the control's own labels, which forwards the click.
 * A checkable control that can be pressed also reports its state, so a click
 * can tell whether it took without a read of its own before the press.
 */
const PRESS_BLOCKER = `function () {
	const element = this;
	if (!element.isConnected) return { stale: "it is detached from the document" };
	const view = element.ownerDocument.defaultView;
	const describe = ${DESCRIBE_ELEMENT};
	const contains = ${CONTAINS};
	const clear = () => {
		const state = (${CHECKED_OF})(element);
		return state.kind ? { state } : null;
	};
	const parentOf = current => current.assignedSlot || current.parentElement || current.getRootNode().host || null;
	if (!element.checkVisibility()) {
		for (let current = element; current; current = parentOf(current)) {
			const display = view.getComputedStyle(current).display;
			if (current === element && display === "contents") return { noBox: "it has display:contents, so no box of its own" };
			if (display !== "none") continue;
			return { noBox: current === element ? "it has display:none" : "it is inside " + describe(current) + ", which has display:none" };
		}
		return { noBox: "it is not rendered" };
	}
	const rect = Array.from(element.getClientRects()).find(fragment => fragment.width * fragment.height >= 1);
	if (!rect) return { noBox: "it is zero-sized" };
	const visibility = view.getComputedStyle(element).visibility;
	if (visibility !== "visible") return { blocked: "it has visibility:" + visibility + ", which clicks pass through" };
	const left = Math.max(0, Math.min(view.innerWidth, rect.left));
	const right = Math.max(0, Math.min(view.innerWidth, rect.right));
	const top = Math.max(0, Math.min(view.innerHeight, rect.top));
	const bottom = Math.max(0, Math.min(view.innerHeight, rect.bottom));
	if (right - left < 1 || bottom - top < 1) return clear();
	const x = Math.floor((left + right) / 2);
	const y = Math.floor((top + bottom) / 2);
	let hit = element.ownerDocument.elementFromPoint(x, y);
	for (let depth = 0; hit && hit.shadowRoot && depth < 16; depth++) {
		const nested = hit.shadowRoot.elementFromPoint(x, y);
		if (!nested || nested === hit) break;
		hit = nested;
	}
	if (!hit || contains(element, hit) || contains(hit, element)) return clear();
	if (Array.from(element.labels || []).some(label => contains(label, hit))) return clear();
	return { blocked: "covered by " + describe(hit) };
}`;

type PressProbe = { stale?: string; noBox?: string; blocked?: string; state?: CheckedState } | null;

function pressRefusal(node: CdpNode, label: string, probe: PressProbe): ToolError | null {
	if (probe?.stale) return staleNode(node, new Error(probe.stale));
	if (probe?.noBox) {
		return new ToolError(`${label} has no box to act on: ${probe.noBox}. Run tab.observe() to see the current page.`);
	}
	if (probe?.blocked) return new ToolError(`${label} blocked: ${probe.blocked}`);
	return null;
}

/** Scroll the node into view and find where a press lands, or refuse with the reason there is nowhere. */
async function actionPoint(node: CdpNode, label: string, signal?: AbortSignal): Promise<Point> {
	// A scroll that cannot happen is never the error worth reporting: the probe
	// below says precisely whether the node is gone or merely unrendered.
	const scrolled = await scrollIntoView(node, signal).then(
		() => true,
		error => {
			rethrowIfAborted(signal, error);
			return false;
		},
	);
	const point = scrolled ? await pressPoint(node, signal) : null;
	if (point) return point;
	throw (
		pressRefusal(node, label, (await callOnNode(node, PRESS_BLOCKER, [], signal)) as PressProbe) ??
		new ToolError(`${label} has no box to act on. Run tab.observe() to see the current page.`)
	);
}

/**
 * Mouse input goes to the session that owns the node's frame, in that session's
 * own coordinates. Chrome routes the event to the right renderer either way,
 * and this avoids composing frame offsets on the hot path.
 */
async function dispatchMouse(
	session: CDPSession,
	type: "mouseMoved" | "mousePressed" | "mouseReleased",
	point: Point,
	options: { button: "none" | "left"; buttons: number; clickCount: number },
	signal?: AbortSignal,
): Promise<void> {
	await untilAborted(signal, () =>
		session.send("Input.dispatchMouseEvent", {
			type,
			x: point.x,
			y: point.y,
			button: options.button,
			buttons: options.buttons,
			clickCount: options.clickCount,
		}),
	);
}

/**
 * Press and release where the node's first fragment is. A press that would not
 * reach it is refused instead of landing elsewhere: `${label} blocked: covered by <div#overlay>`.
 * Returns where it pressed and, for a checkable control, its state before.
 */
async function pressNode(
	node: CdpNode,
	clickCount: number,
	label: string,
	signal?: AbortSignal,
): Promise<{ point: Point; before?: CheckedState }> {
	const point = await actionPoint(node, label, signal);
	const probe = (await callOnNode(node, PRESS_BLOCKER, [], signal)) as PressProbe;
	const refusal = pressRefusal(node, label, probe);
	if (refusal) throw refusal;
	// The move both primes hover state and drives the in-page cursor overlay the
	// relay paints from Input.dispatchMouseEvent.
	await dispatchMouse(node.session, "mouseMoved", point, { button: "none", buttons: 0, clickCount: 0 }, signal);
	for (let count = 1; count <= clickCount; count++) {
		await dispatchMouse(node.session, "mousePressed", point, { button: "left", buttons: 1, clickCount: count }, signal);
		await dispatchMouse(node.session, "mouseReleased", point, { button: "left", buttons: 0, clickCount: count }, signal);
	}
	return { point, before: probe?.state };
}

/**
 * The control's state after a click, or null once it left the document. A
 * native input has settled by the time the release is acknowledged; an ARIA
 * control is the page's to update, possibly a little later, so one still
 * reading `before` gets until it changes (or leaves) or 150 ms, whichever is
 * first. Only a click that did not take pays that wait.
 */
const CHECKED_AFTER = `function (before) {
	const read = () => (this.isConnected ? (${CHECKED_OF})(this) : null);
	const now = read();
	if (!now || now.state !== before || !now.kind.startsWith("aria-")) return now;
	const { promise, resolve } = Promise.withResolvers();
	const observer = new MutationObserver(() => {
		const state = read();
		if (!state || state.state !== before) finish();
	});
	const timer = setTimeout(() => finish(), 150);
	const finish = () => {
		observer.disconnect();
		clearTimeout(timer);
		resolve(read());
	};
	observer.observe(this.ownerDocument, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-checked"] });
	return promise;
}`;

/**
 * Click the node. On a checkbox, radio or switch the click is also expected to
 * change it (toggle it, or select an unselected radio); when its state still
 * reads the same after the release, the click is reported as not taken, with
 * what the press landed on when that was not the control itself.
 */
export async function clickNode(
	node: CdpNode,
	clickCount: number,
	signal?: AbortSignal,
	label: string = node.label,
): Promise<void> {
	const { point, before } = await pressNode(node, clickCount, label, signal);
	if (!before) return;
	const radio = before.kind.endsWith("radio");
	if (radio ? before.state === "checked" : clickCount % 2 === 0) return;
	// A control the click replaced or navigated away is not evidence either way.
	const after = await callOnNode(node, CHECKED_AFTER, [before.state], signal).then(
		state => state as CheckedState | null,
		error => {
			rethrowIfAborted(signal, error);
			return null;
		},
	);
	if (!after || after.state !== before.state) return;
	const control = before.kind.replace("aria-", "");
	const setter =
		radio || before.state === "unchecked"
			? "check()"
			: before.state === "checked"
				? "uncheck()"
				: "check() or uncheck()";
	throw new ToolError(
		`${label} did not change the ${control}: it is still ${after.state}.${await landing(node, point, signal)} Use ${setter} to set it.`,
	);
}

/** What a press at `point` hit, when that is not the node or inside it: ` The press landed on <div#group>, which contains it.` */
const LANDING = `function (target) {
	const describe = ${DESCRIBE_ELEMENT};
	const contains = ${CONTAINS};
	if (contains(target, this)) return "";
	const where = " The press landed on " + describe(this);
	if (Array.from(target.labels || []).some(label => contains(label, this))) return where + " in its label.";
	return where + (contains(this, target) ? ", which contains it." : ".");
}`;

/** Only asked once a click failed, so its extra calls never cost a click that worked. Empty when unknowable. */
async function landing(node: CdpNode, point: Point, signal?: AbortSignal): Promise<string> {
	const send = node.session.send.bind(node.session);
	const objects: string[] = [];
	try {
		const hit = await untilAborted(signal, () =>
			send("DOM.getNodeForLocation", { x: Math.round(point.x), y: Math.round(point.y) }),
		);
		if (hit.backendNodeId === node.backendNodeId) return "";
		for (const backendNodeId of [hit.backendNodeId, node.backendNodeId]) {
			const { object } = await untilAborted(signal, () => send("DOM.resolveNode", { backendNodeId }));
			if (!object.objectId) return "";
			objects.push(object.objectId);
		}
		const result = await untilAborted(signal, () =>
			send("Runtime.callFunctionOn", {
				objectId: objects[0],
				functionDeclaration: LANDING,
				arguments: [{ objectId: objects[1] }],
				returnByValue: true,
			}),
		);
		return typeof result.result.value === "string" ? result.result.value : "";
	} catch (error) {
		rethrowIfAborted(signal, error);
		return "";
	} finally {
		for (const objectId of objects) await send("Runtime.releaseObject", { objectId }).catch(() => undefined);
	}
}

export async function hoverNode(node: CdpNode, signal?: AbortSignal): Promise<void> {
	const point = await actionPoint(node, node.label, signal);
	await dispatchMouse(node.session, "mouseMoved", point, { button: "none", buttons: 0, clickCount: 0 }, signal);
}

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MODIFIER_ALIASES: Record<string, string> = {
	alt: "Alt",
	option: "Alt",
	control: "Control",
	ctrl: "Control",
	meta: "Meta",
	cmd: "Meta",
	command: "Meta",
	super: "Meta",
	shift: "Shift",
};

interface KeyStroke {
	key: string;
	code: string;
	keyCode: number;
	text: string;
	location: number;
}

/** Puppeteer's US layout lookup, including its shift and modifier-suppresses-text rules. */
function keyStroke(key: string, modifiers: number): KeyStroke {
	const definition = _keyDefinitions[key as keyof typeof _keyDefinitions];
	if (!definition)
		throw new ToolError(
			`Unknown key ${JSON.stringify(key)}. Use a US-layout key name such as "Enter", "Tab", "ArrowDown", "a", or a chord like "Control+a".`,
		);
	const shift = (modifiers & MODIFIER_BITS.Shift) !== 0;
	const stroke: KeyStroke = {
		key: (shift && definition.shiftKey) || definition.key || "",
		code: definition.code ?? "",
		keyCode: (shift && definition.shiftKeyCode) || definition.keyCode || 0,
		text: "",
		location: definition.location ?? 0,
	};
	if (stroke.key.length === 1) stroke.text = stroke.key;
	if (definition.text) stroke.text = definition.text;
	if (shift && definition.shiftText) stroke.text = definition.shiftText;
	// Any modifier beyond shift turns the stroke into a shortcut, not text.
	if (modifiers & ~MODIFIER_BITS.Shift) stroke.text = "";
	return stroke;
}

/** `Control+Shift+p` → the modifier keys to hold and the key to strike. */
export function parseChord(chord: string): { modifiers: string[]; key: string } {
	const parts = chord.split("+");
	const modifiers: string[] = [];
	for (let index = 0; index < parts.length - 1; index++) {
		const part = parts[index];
		// A trailing empty part means "+" is the key itself: "Control++".
		if (part === "") return { modifiers, key: "+" };
		const modifier = MODIFIER_ALIASES[part.toLowerCase()];
		if (!modifier)
			throw new ToolError(
				`Unknown modifier ${JSON.stringify(part)} in ${JSON.stringify(chord)}. Use Control, Shift, Alt or Meta.`,
			);
		modifiers.push(modifier);
	}
	return { modifiers, key: parts[parts.length - 1] };
}

/**
 * macOS runs its editing chords as app-menu commands, which a CDP key event
 * never reaches: the page sees Meta+V and nothing is pasted. There the key-down
 * names the editor command itself, which Chrome runs as the key's default
 * action, so a page that cancels the key still cancels the edit. Keyed by
 * modifier mask and physical key.
 */
const EDITING_COMMANDS: Record<string, string> =
	process.platform === "darwin"
		? {
				[`${MODIFIER_BITS.Meta}:KeyA`]: "selectAll",
				[`${MODIFIER_BITS.Meta}:KeyC`]: "copy",
				[`${MODIFIER_BITS.Meta}:KeyV`]: "paste",
				[`${MODIFIER_BITS.Meta}:KeyX`]: "cut",
				[`${MODIFIER_BITS.Meta}:KeyZ`]: "undo",
				[`${MODIFIER_BITS.Meta | MODIFIER_BITS.Shift}:KeyZ`]: "redo",
			}
		: {};

async function dispatchKey(
	session: CDPSession,
	type: "keyDown" | "rawKeyDown" | "keyUp",
	stroke: KeyStroke,
	modifiers: number,
	signal?: AbortSignal,
): Promise<void> {
	const command = type === "keyUp" ? undefined : EDITING_COMMANDS[`${modifiers}:${stroke.code}`];
	await untilAborted(signal, () =>
		session.send("Input.dispatchKeyEvent", {
			type,
			modifiers,
			windowsVirtualKeyCode: stroke.keyCode,
			code: stroke.code,
			key: stroke.key,
			text: type === "keyUp" ? undefined : stroke.text,
			unmodifiedText: type === "keyUp" ? undefined : stroke.text,
			location: stroke.location,
			isKeypad: stroke.location === 3,
			commands: command ? [command] : undefined,
		}),
	);
}

/**
 * One key or chord: modifiers down, key down/up, modifiers up — with the bitmask Chrome expects.
 * `heldModifiers` is the mask a `holdKey()` already has down; those stay down.
 */
export async function pressChord(
	session: CDPSession,
	chord: string,
	signal?: AbortSignal,
	heldModifiers = 0,
): Promise<void> {
	const { modifiers, key } = parseChord(chord);
	let mask = heldModifiers;
	const held: KeyStroke[] = [];
	for (const modifier of modifiers) {
		const stroke = keyStroke(modifier, mask);
		mask |= MODIFIER_BITS[modifier];
		held.push(stroke);
		await dispatchKey(session, "rawKeyDown", stroke, mask, signal);
	}
	const stroke = keyStroke(key, mask);
	try {
		await dispatchKey(session, stroke.text ? "keyDown" : "rawKeyDown", stroke, mask, signal);
		await dispatchKey(session, "keyUp", stroke, mask, signal);
	} finally {
		for (let index = held.length - 1; index >= 0; index--) {
			mask &= ~MODIFIER_BITS[modifiers[index]];
			await dispatchKey(session, "keyUp", held[index], mask, signal).catch(() => undefined);
		}
	}
}

/**
 * Press a key without releasing it. A modifier joins the returned mask, which
 * later strokes carry until `releaseKey()` takes it out again.
 */
export async function holdKey(session: CDPSession, key: string, held: number, signal?: AbortSignal): Promise<number> {
	const modifier = MODIFIER_ALIASES[key.toLowerCase()];
	const mask = modifier ? held | MODIFIER_BITS[modifier] : held;
	const stroke = keyStroke(modifier ?? key, mask);
	await dispatchKey(session, stroke.text ? "keyDown" : "rawKeyDown", stroke, mask, signal);
	return mask;
}

/** Release a key `holdKey()` pressed; returns the held-modifier mask without it. */
export async function releaseKey(session: CDPSession, key: string, held: number, signal?: AbortSignal): Promise<number> {
	const modifier = MODIFIER_ALIASES[key.toLowerCase()];
	const mask = modifier ? held & ~MODIFIER_BITS[modifier] : held;
	await dispatchKey(session, "keyUp", keyStroke(modifier ?? key, mask), mask, signal);
	return mask;
}

/** Type text as a user would: a key event per layout character, IME insertion for the rest. */
export async function typeText(session: CDPSession, text: string, signal?: AbortSignal, held = 0): Promise<void> {
	for (const character of text) {
		if (character in _keyDefinitions) {
			const stroke = keyStroke(character, held);
			await dispatchKey(session, "keyDown", stroke, held, signal);
			await dispatchKey(session, "keyUp", stroke, held, signal);
		} else {
			await untilAborted(signal, () => session.send("Input.insertText", { text: character }));
		}
	}
}

/** Select every character of a text field so the next insertion replaces it. */
const SELECT_FIELD_CONTENTS = `function () {
	const node = this;
	if (node.disabled || node.readOnly) throw new Error("The field is disabled or read-only");
	if (node.tagName === "INPUT" || node.tagName === "TEXTAREA") {
		try { node.setSelectionRange(0, node.value.length); } catch { node.select(); }
		// The selection API does not apply to email and number inputs: the range
		// call throws, select() still selects the whole value, and the offsets
		// read null. Missing offsets are not a missing selection there, so the
		// read-back can only speak for the types that report one.
		if (node.selectionStart === null && node.selectionEnd === null) {
			if (node.type !== "email" && node.type !== "number")
				throw new Error("The field does not support text selection for replacement");
			return node.value.length;
		}
		if (node.selectionStart !== 0 || node.selectionEnd !== node.value.length)
			throw new Error("The field does not support text selection for replacement");
		return node.value.length;
	}
	if (!node.isContentEditable) throw new Error("fill requires an editable text field");
	const selection = node.ownerDocument.getSelection();
	if (!selection) throw new Error("The editable field has no text selection");
	const range = node.ownerDocument.createRange();
	range.selectNodeContents(node);
	selection.removeAllRanges();
	selection.addRange(range);
	return node.textContent?.length ?? 0;
}`;

/** Focus, select the existing value, then replace it through Chrome's text-input path. */
export async function fillNode(node: CdpNode, value: string, signal?: AbortSignal): Promise<void> {
	await focusNode(node, signal);
	const selected = await callOnNode(node, SELECT_FIELD_CONTENTS, [], signal);
	if (value) await untilAborted(signal, () => node.session.send("Input.insertText", { text: value }));
	else if (typeof selected === "number" && selected > 0) await pressChord(node.session, "Backspace", signal);
}

export async function typeIntoNode(node: CdpNode, text: string, signal?: AbortSignal, held = 0): Promise<void> {
	await focusNode(node, signal);
	await typeText(node.session, text, signal, held);
}

const SELECT_OPTIONS = `function (specs) { return (${SELECT_OPTIONS_SOURCE})(this, specs); }`;

export async function selectOptions(
	node: CdpNode,
	values: readonly BrowserSelectOption[],
	signal?: AbortSignal,
): Promise<string[]> {
	const selected = await callOnNode(node, SELECT_OPTIONS, [normalizeSelectOptions(values)], signal);
	return Array.isArray(selected) ? selected.map(String) : [];
}

export async function setFileInput(node: CdpNode, files: readonly string[], signal?: AbortSignal): Promise<void> {
	const described = await untilAborted(signal, () =>
		node.session.send("DOM.describeNode", { backendNodeId: node.backendNodeId }),
	).catch(error => {
		throw staleNode(node, error);
	});
	if (described.node.nodeName !== "INPUT")
		throw new ToolError(`uploadFile requires an <input type="file"> element (got <${described.node.nodeName.toLowerCase()}>)`);
	await untilAborted(signal, () =>
		node.session.send("DOM.setFileInputFiles", { files: [...files], backendNodeId: node.backendNodeId }),
	);
}

/** Force the state a click did not reach, with the events a user's change would fire. */
const SET_CHECKED = `function (desired) {
	const role = (this.getAttribute("role") || "").toLowerCase();
	const aria = role === "switch" || role === "checkbox" || role === "radio";
	const current = aria ? this.getAttribute("aria-checked") === "true" : this.checked;
	if (current === desired) return;
	if (aria) this.setAttribute("aria-checked", String(desired));
	else this.checked = desired;
	this.dispatchEvent(new Event("input", { bubbles: true }));
	this.dispatchEvent(new Event("change", { bubbles: true }));
}`;

/**
 * Set a checkable control to `checked`, idempotently: already there is a no-op,
 * otherwise a click toggles it, and a control the click did not flip is set
 * directly. A checked radio is unchecked directly, since no click unchecks one.
 */
export async function setNodeChecked(
	node: CdpNode,
	checked: boolean,
	label: string,
	signal?: AbortSignal,
): Promise<void> {
	const state = (await callOnNode(node, CHECKED_STATE, [], signal)) as CheckedState;
	if (!state.kind) throw new ToolError(`${label} requires a checkbox, radio, or ARIA switch`);
	if (state.checked === checked) return;
	if (state.kind !== "radio" || checked) await pressNode(node, 1, label, signal);
	await callOnNode(node, SET_CHECKED, [checked], signal);
}

const DRAW_HIGHLIGHT = `function (overlayId) {
	const rect = this.getBoundingClientRect();
	const overlay = this.ownerDocument.createElement("div");
	overlay.id = overlayId;
	overlay.dataset.ompHighlightOverlay = "";
	overlay.setAttribute("aria-hidden", "true");
	overlay.setAttribute("role", "presentation");
	overlay.inert = true;
	Object.assign(overlay.style, {
		position: "fixed",
		left: rect.left - 3 + "px",
		top: rect.top - 3 + "px",
		width: rect.width + 6 + "px",
		height: rect.height + 6 + "px",
		border: "3px solid #ff3366",
		borderRadius: "4px",
		boxSizing: "border-box",
		pointerEvents: "none",
		zIndex: "2147483647",
	});
	this.ownerDocument.documentElement.append(overlay);
}`;

/** Outline the node for `duration` ms (default 2000) with an inert overlay in its own document. */
export async function highlightNode(
	node: CdpNode,
	options: { duration?: number } = {},
	signal?: AbortSignal,
): Promise<void> {
	const duration = options.duration ?? 2_000;
	if (!Number.isFinite(duration) || duration < 0)
		throw new ToolError("highlight duration must be a non-negative number");
	const id = `omp-highlight-${crypto.randomUUID()}`;
	await callOnNode(node, DRAW_HIGHLIGHT, [id], signal);
	try {
		await untilAborted(signal, () => Bun.sleep(duration));
	} finally {
		// The overlay lives in the node's document, which may since have dropped
		// the node; removal goes through the document, and a navigation took it anyway.
		await callOnNode(node, "function (overlayId) { this.ownerDocument.getElementById(overlayId)?.remove(); }", [id])
			.catch(() =>
				evaluateExpression(node.session, `document.getElementById(${JSON.stringify(id)})?.remove()`),
			)
			.catch(() => undefined);
	}
}

/**
 * Wait until the document stops mutating, in one evaluate that carries its own
 * deadline. A cross-document navigation rejects the call: that is the signal to
 * re-collect against the new document, never to retry against this one.
 */
export async function waitForDomQuiet(
	session: CDPSession,
	quietMs: number,
	budgetMs: number,
	signal?: AbortSignal,
): Promise<void> {
	await untilAborted(signal, () =>
		session.send("Runtime.evaluate", {
			expression: `new Promise(resolve => {
				const quiet = ${quietMs}, max = ${budgetMs};
				let timer = setTimeout(done, quiet);
				const deadline = setTimeout(done, max);
				const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quiet); });
				observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
				function done() { observer.disconnect(); clearTimeout(timer); clearTimeout(deadline); resolve(); }
			})`,
			awaitPromise: true,
			returnByValue: true,
		}),
	);
}

/**
 * Skeleton screen: several empty placeholder blocks in the viewport, named
 * skeleton or shimmer by class, or an animated "placeholder" (a static one is
 * as often a layout spacer). A block with text, media, a control, or an image
 * background is content.
 */
const SKELETON_PROBE = `(() => {
	try {
		const content = "img,svg,video,canvas,picture,iframe,object,embed,input,textarea,select,button";
		const animated = (element, pseudo) => !!element && getComputedStyle(element, pseudo).animationName !== "none";
		let blocks = 0;
		for (const element of document.querySelectorAll('[class*="skeleton" i],[class*="shimmer" i],[class*="placeholder" i]')) {
			if (element.textContent.trim() || element.matches(content) || element.querySelector(content)) continue;
			const box = element.getBoundingClientRect();
			if (box.width < 8 || box.height < 4 || box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth) continue;
			const style = getComputedStyle(element);
			if (style.visibility === "hidden" || style.opacity === "0" || style.backgroundImage.includes("url(")) continue;
			if (!/skeleton|shimmer/i.test(element.getAttribute("class")) && !(animated(element) || animated(element, "::after") || animated(element.parentElement))) continue;
			if (++blocks >= 3) return true;
		}
		return false;
	} catch {
		return false;
	}
})()`;

/** Whether the session's document shows a skeleton screen where its content will be. */
export async function hasSkeletonScreen(session: CDPSession, signal?: AbortSignal): Promise<boolean> {
	return (await evaluateExpression(session, SKELETON_PROBE, signal)) === true;
}

/**
 * Every selector the tool accepts, resolved to backend node ids on the page
 * session, fresh on every call. Nothing is remembered between calls: a
 * selector is a question about the document that is there now.
 *
 * - CSS goes through `DOM.querySelectorAll` on the current document.
 * - `xpath/` and `text/` go through `DOM.performSearch`, whose results are
 *   discarded before returning; a text hit lands on a text node, so it is
 *   reported as the element that contains it.
 * - `pierce/` repeats the CSS query inside every shadow root of the document.
 * - `aria/` matches the accessibility tree by name (and optional role), the
 *   same payload `observe()` reads, so both agree on what a control is called.
 * - `label/`, `placeholder/`, `testid/`, `alt/`, `title/` and `role/` are the
 *   semantic query handlers the worker registers on puppeteer; their matches
 *   come back as handles, each pinned to its backend node id and released here.
 */
export async function resolveSelector(
	page: Page,
	selector: string,
	signal?: AbortSignal,
): Promise<{ session: CDPSession; backendNodeId: number }[]> {
	const session = page.mainFrame().client;
	if (selector.startsWith("aria/")) return await resolveAriaSelector(page, selector.slice("aria/".length), signal);
	if (SEMANTIC_QUERY_PREFIXES.some(prefix => selector.startsWith(prefix)))
		return await resolveSemanticQuery(page, selector, signal);
	// DOM.getDocument voids every node id handed out before it, so two selector
	// queries on one session must not interleave or each keeps voiding the other's.
	return await oneDocumentQuery(session, async () => {
		const document = await untilAborted(signal, () =>
			session.send("DOM.getDocument", { depth: selector.startsWith("pierce/") ? -1 : 0, pierce: true }),
		);
		const nodeIds = selector.startsWith("xpath/")
			? await search(session, selector.slice("xpath/".length), signal)
			: selector.startsWith("text/")
				? await search(session, selector.slice("text/".length), signal)
				: await queryAll(session, document.root, selector.replace(/^pierce\//, ""), signal);
		const nodes: { session: CDPSession; backendNodeId: number }[] = [];
		for (const nodeId of nodeIds) {
			const described = await untilAborted(signal, () => session.send("DOM.describeNode", { nodeId })).catch(
				() => null,
			);
			if (!described) continue;
			// A text search matches the text node; the model means its element.
			const backendNodeId =
				described.node.nodeType === 3
					? await elementOf(session, nodeId, signal)
					: described.node.backendNodeId;
			if (backendNodeId !== undefined && !nodes.some(node => node.backendNodeId === backendNodeId))
				nodes.push({ session, backendNodeId });
		}
		return nodes;
	});
}

const documentQueries = new WeakMap<CDPSession, Promise<unknown>>();

async function oneDocumentQuery<T>(session: CDPSession, query: () => Promise<T>): Promise<T> {
	const run = (documentQueries.get(session) ?? Promise.resolve()).then(query, query);
	documentQueries.set(session, run.catch(() => undefined));
	return await run;
}

const SEMANTIC_QUERY_PREFIXES = ["label/", "placeholder/", "testid/", "alt/", "title/", "role/"];

async function resolveSemanticQuery(
	page: Page,
	selector: string,
	signal?: AbortSignal,
): Promise<{ session: CDPSession; backendNodeId: number }[]> {
	const session = page.mainFrame().client;
	const handles = await untilAborted(signal, () => page.$$(selector));
	try {
		const nodes: { session: CDPSession; backendNodeId: number }[] = [];
		for (const handle of handles) {
			const objectId = handle.remoteObject().objectId;
			if (!objectId) continue;
			const described = await untilAborted(signal, () => session.send("DOM.describeNode", { objectId })).catch(
				() => null,
			);
			const backendNodeId = described?.node.backendNodeId;
			if (backendNodeId !== undefined && !nodes.some(node => node.backendNodeId === backendNodeId))
				nodes.push({ session, backendNodeId });
		}
		return nodes;
	} finally {
		await Promise.all(handles.map(handle => handle.dispose().catch(() => undefined)));
	}
}

/**
 * Pin whatever an expression evaluates to — an element, or null — to a backend
 * node id, releasing the object before returning. The only bridge from a
 * page-side script that hands back a node to the id-based action path.
 */
export async function nodeFromExpression(
	session: CDPSession,
	expression: string,
	label: string,
	signal?: AbortSignal,
): Promise<CdpNode | null> {
	const result = await untilAborted(signal, () => session.send("Runtime.evaluate", { expression, awaitPromise: true }));
	if (result.exceptionDetails)
		throw new ToolError(describeException(result.exceptionDetails.text, result.exceptionDetails.exception?.description));
	const objectId = result.result.objectId;
	if (!objectId) return null;
	try {
		const described = await session.send("DOM.describeNode", { objectId });
		return { session, backendNodeId: described.node.backendNodeId, label };
	} finally {
		await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
	}
}

/** The element a text-node search hit belongs to; the object lives for this call only. */
async function elementOf(session: CDPSession, nodeId: number, signal?: AbortSignal): Promise<number | undefined> {
	const text = await untilAborted(signal, () => session.send("DOM.resolveNode", { nodeId })).catch(() => null);
	const textObjectId = text?.object.objectId;
	if (!textObjectId) return undefined;
	try {
		const owner = await untilAborted(signal, () =>
			session.send("Runtime.callFunctionOn", {
				objectId: textObjectId,
				functionDeclaration: "function () { return this.parentElement; }",
			}),
		);
		const ownerObjectId = owner.result.objectId;
		if (!ownerObjectId) return undefined;
		try {
			const described = await session.send("DOM.describeNode", { objectId: ownerObjectId });
			return described.node.backendNodeId;
		} finally {
			await session.send("Runtime.releaseObject", { objectId: ownerObjectId }).catch(() => undefined);
		}
	} finally {
		await session.send("Runtime.releaseObject", { objectId: textObjectId }).catch(() => undefined);
	}
}

/** Cadence for every selector wait: one resolution per tick, nothing kept between ticks. */
const SELECTOR_POLL_MS = 100;

/**
 * Poll a selector until it names something the caller can use. `state` picks
 * what counts: `present` any match, `visible` a match with a box, `hidden` the
 * absence of either. Each tick re-resolves from scratch, so a page that
 * re-renders under the wait is simply asked again.
 */
export async function awaitSelector(
	page: Page,
	selector: string,
	options: { timeoutMs: number; state: "present" | "visible" | "hidden" },
	signal?: AbortSignal,
): Promise<CdpNode | null> {
	const deadline = Date.now() + options.timeoutMs;
	let seen = 0;
	for (;;) {
		const nodes = (await resolveSelector(page, selector, signal)).map(match => ({ ...match, label: selector }));
		seen = nodes.length;
		if (options.state === "present" && nodes.length > 0) return nodes[0];
		if (options.state !== "present") {
			let visible: CdpNode | null = null;
			for (const node of nodes) {
				// The border box bounds every fragment `pressPoint` can pick, so
				// what passes here is what a click can land on.
				if (hasArea(await borderQuad(node, signal))) {
					visible = node;
					break;
				}
			}
			if (options.state === "visible" && visible) return visible;
			if (options.state === "hidden" && !visible) return null;
		}
		if (Date.now() >= deadline) break;
		await untilAborted(signal, () => Bun.sleep(Math.min(SELECTOR_POLL_MS, Math.max(1, deadline - Date.now()))));
	}
	if (options.state === "hidden") throw new ToolError(`Selector ${JSON.stringify(selector)} is still visible`);
	if (seen === 0) throw new ToolError(`Selector ${JSON.stringify(selector)} matched no element`);
	throw new ToolError(
		`Selector ${JSON.stringify(selector)} matched ${seen} element(s) but none could be acted on: they are hidden or zero-sized.`,
	);
}

async function queryAll(
	session: CDPSession,
	root: { nodeId: number; children?: unknown[] },
	selector: string,
	signal?: AbortSignal,
): Promise<number[]> {
	const roots = [root.nodeId, ...shadowRoots(root)];
	const found: number[] = [];
	for (const nodeId of roots) {
		const result = await untilAborted(signal, () =>
			session.send("DOM.querySelectorAll", { nodeId, selector }),
		).catch(error => {
			// An invalid CSS selector is the caller's mistake and must say so.
			if (String(error).includes("not a valid selector")) throw new ToolError(`Invalid selector ${JSON.stringify(selector)}`);
			return null;
		});
		if (result) found.push(...result.nodeIds);
	}
	return found;
}

/** Shadow roots inside a pierced `DOM.getDocument` tree; each is queryable on its own. */
function shadowRoots(node: { nodeId: number; children?: unknown[]; shadowRoots?: unknown[] }): number[] {
	const ids: number[] = [];
	const visit = (current: { nodeId: number; children?: unknown[]; shadowRoots?: unknown[] }): void => {
		for (const shadow of (current.shadowRoots ?? []) as typeof current[]) {
			ids.push(shadow.nodeId);
			visit(shadow);
		}
		for (const child of (current.children ?? []) as typeof current[]) visit(child);
	};
	visit(node);
	return ids;
}

async function search(session: CDPSession, query: string, signal?: AbortSignal): Promise<number[]> {
	const started = await untilAborted(signal, () => session.send("DOM.performSearch", { query }));
	try {
		if (started.resultCount === 0) return [];
		const results = await untilAborted(signal, () =>
			session.send("DOM.getSearchResults", {
				searchId: started.searchId,
				fromIndex: 0,
				toIndex: started.resultCount,
			}),
		);
		return results.nodeIds;
	} finally {
		await session.send("DOM.discardSearchResults", { searchId: started.searchId }).catch(() => undefined);
	}
}

/** `aria/Name` or `aria/Name[role="button"]`, matched against the accessibility tree. */
async function resolveAriaSelector(
	page: Page,
	query: string,
	signal?: AbortSignal,
): Promise<{ session: CDPSession; backendNodeId: number }[]> {
	const roleMatch = /^(.*?)\[role=["']?([^\]"']+)["']?\]$/.exec(query);
	const name = (roleMatch ? roleMatch[1] : query).trim();
	const role = roleMatch?.[2]?.trim();
	const tree = await snapshotAccessibility(page, { includeAll: true }, signal);
	const matches: { session: CDPSession; backendNodeId: number }[] = [];
	const visit = (node: AxNode): void => {
		const named = (node.name ?? "").trim();
		if (node.backendNodeId !== undefined && node.frame && named === name && (!role || node.role === role))
			matches.push({ session: node.frame.session, backendNodeId: node.backendNodeId });
		for (const child of node.children ?? []) visit(child);
	};
	visit(tree);
	return matches;
}

/** Loader ids of every frame a session serves, so nodes carry the document they came from. */
async function loaderIds(session: CDPSession, signal?: AbortSignal): Promise<Map<string, string>> {
	const { frameTree } = await untilAborted(signal, () => session.send("Page.getFrameTree"));
	const loaders = new Map<string, string>();
	const walk = (tree: { frame: { id: string; loaderId: string }; childFrames?: unknown[] }): void => {
		loaders.set(tree.frame.id, tree.frame.loaderId);
		for (const child of tree.childFrames ?? []) walk(child as typeof tree);
	};
	walk(frameTree);
	return loaders;
}

/**
 * Backend ids of every node a session's documents mark as a click target: one
 * with a click/mousedown/mouseup listener of its own (Chrome's `isClickable`,
 * which also covers React's `onClick`), or a pointer cursor it does not
 * inherit from its parent. One `DOMSnapshot` read answers every frame the
 * session serves.
 */
async function clickTargets(session: CDPSession, signal?: AbortSignal): Promise<Set<number>> {
	const { documents, strings } = await untilAborted(signal, () =>
		session.send("DOMSnapshot.captureSnapshot", { computedStyles: ["cursor"] }),
	);
	const targets = new Set<number>();
	for (const { nodes, layout } of documents) {
		const backendIds = nodes.backendNodeId ?? [];
		for (const index of nodes.isClickable?.index ?? []) targets.add(backendIds[index]!);
		const cursors = new Map<number, string>();
		layout.nodeIndex.forEach((nodeIndex, i) => {
			const cursor = layout.styles[i]?.[0];
			if (cursor !== undefined) cursors.set(nodeIndex, strings[cursor]!);
		});
		const parents = nodes.parentIndex ?? [];
		for (const [nodeIndex, cursor] of cursors) {
			if (cursor !== "pointer") continue;
			// The nearest ancestor with a box: a `display: contents` parent has no style of its own.
			let parent = parents[nodeIndex] ?? -1;
			while (parent >= 0 && !cursors.has(parent)) parent = parents[parent] ?? -1;
			if (parent < 0 || cursors.get(parent) !== "pointer") targets.add(backendIds[nodeIndex]!);
		}
	}
	return targets;
}

/**
 * The page's accessibility tree, one `Accessibility.getFullAXTree` per frame,
 * with every embedded document spliced under the iframe element that owns it.
 * Frames are read on the session that serves them: an out-of-process iframe is
 * invisible to the page session, and its nodes must be actioned on its own.
 * Table and grid parts the DOM marks as click targets become actionable too.
 */
export async function snapshotAccessibility(
	page: Page,
	options: { includeAll: boolean },
	signal?: AbortSignal,
): Promise<AxNode> {
	const frames = page.frames();
	const sessions = new Set(frames.map(frame => frame.client));
	const loaders = new Map<CDPSession, Map<string, string>>();
	await Promise.all(
		[...sessions].map(async session => {
			loaders.set(session, await loaderIds(session, signal));
		}),
	);
	// Which backend node owns which child frame, per session that can see it.
	const owners = new Map<CDPSession, Map<number, Frame>>();
	await Promise.all(
		frames.map(async frame => {
			const parent = frame.parentFrame();
			if (!parent) return;
			const owner = await untilAborted(signal, () =>
				parent.client.send("DOM.getFrameOwner", { frameId: frame._id }),
			).catch(() => null);
			if (!owner) return;
			const bySession = owners.get(parent.client) ?? new Map<number, Frame>();
			bySession.set(owner.backendNodeId, frame);
			owners.set(parent.client, bySession);
		}),
	);
	// One click probe per session, and only for a frame with table parts to judge. Row refs are an
	// addition: a failed probe costs them, never the observation.
	const probes = new Map<CDPSession, Promise<Set<number> | undefined>>();
	const clickable = (session: CDPSession): Promise<Set<number> | undefined> => {
		let probe = probes.get(session);
		if (!probe) {
			probe = clickTargets(session, signal).catch(error => {
				if (signal?.aborted) throw error;
				return undefined;
			});
			probes.set(session, probe);
		}
		return probe;
	};

	const build = async (frame: Frame): Promise<AxNode | null> => {
		const { nodes } = await untilAborted(signal, () =>
			frame.client.send("Accessibility.getFullAXTree", { frameId: frame._id }),
		);
		const known = owners.get(frame.client);
		const embedded = new Map<number, AxNode>();
		if (known?.size) {
			const children = nodes
				.map(node => node.backendDOMNodeId)
				.filter((id): id is number => id !== undefined && known.get(id)?.parentFrame() === frame);
			await Promise.all(
				children.map(async id => {
					const child = known.get(id);
					if (!child) return;
					// A frame that detaches mid-collection simply has no content to
					// splice; anything else is a real failure and must surface.
					const tree = await build(child).catch(error => {
						if (child.detached || !page.frames().includes(child)) return null;
						throw error;
					});
					if (tree) embedded.set(id, tree);
				}),
			);
		}
		const axFrame: AxFrame = {
			session: frame.client,
			frameId: frame._id,
			loaderId: loaders.get(frame.client)?.get(frame._id) ?? "",
		};
		const clickableIds = !options.includeAll && hasTableParts(nodes) ? await clickable(frame.client) : undefined;
		return buildAxTree(nodes, axFrame, { includeAll: options.includeAll, embedded, clickable: clickableIds });
	};

	const tree = await build(page.mainFrame());
	if (!tree) throw new ToolError("Accessibility snapshot unavailable");
	return tree;
}
