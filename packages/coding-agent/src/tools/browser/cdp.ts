import { untilAborted } from "@oh-my-pi/pi-utils";
import type { CDPSession, Frame, Page } from "puppeteer-core";
import { _keyDefinitions } from "puppeteer-core/internal/common/USKeyboardLayout.js";
import { ToolError } from "../tool-errors";
import { type AxFrame, type AxNode, buildAxTree } from "./observation";
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

/** Border box of the node in its own frame's coordinates, or null when it has no box. */
async function nodeBox(node: CdpNode, signal?: AbortSignal): Promise<{ border: Rect; content: Rect } | null> {
	const box = await untilAborted(signal, () =>
		node.session.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId }),
	).catch(error => {
		rethrowIfAborted(signal, error);
		return null;
	});
	if (!box) return null;
	return { border: quadRect(box.model.border), content: quadRect(box.model.content) };
}

function quadRect(quad: readonly number[]): Rect {
	const xs = [quad[0], quad[2], quad[4], quad[6]];
	const ys = [quad[1], quad[3], quad[5], quad[7]];
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
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
	const box = await nodeBox(node, signal);
	if (!box || box.border.width === 0 || box.border.height === 0) return null;
	return { x: box.border.x + offset.x, y: box.border.y + offset.y, width: box.border.width, height: box.border.height };
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
 * Why the node has no box: the page dropped it — Chrome keeps answering for
 * detached nodes, so only the node itself can say — or it is still in the
 * document but not rendered. Costs a resolve, and only on the failure path.
 */
async function noBoxError(node: CdpNode, signal?: AbortSignal): Promise<ToolError> {
	const connected = await callOnNode(node, "function () { return this.isConnected === true; }", [], signal).then(
		value => value === true,
		() => false,
	);
	if (!connected) return staleNode(node, new Error("it is detached from the document"));
	return new ToolError(
		`${node.label} has no box to act on: it is hidden or zero-sized. Run tab.observe() to see the current page.`,
	);
}

/** Centre of the node's content box in its own frame's coordinates — where a click lands. */
async function actionPoint(node: CdpNode, signal?: AbortSignal): Promise<Point> {
	// A scroll that cannot happen is never the error worth reporting: the box
	// check below says precisely whether the node is gone or merely unrendered.
	const scrolled = await scrollIntoView(node, signal).then(
		() => true,
		error => {
			rethrowIfAborted(signal, error);
			return false;
		},
	);
	const box = scrolled ? await nodeBox(node, signal) : null;
	if (!box || box.content.width === 0 || box.content.height === 0) throw await noBoxError(node, signal);
	return { x: box.content.x + box.content.width / 2, y: box.content.y + box.content.height / 2 };
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

export async function clickNode(node: CdpNode, clickCount: number, signal?: AbortSignal): Promise<void> {
	const point = await actionPoint(node, signal);
	// The move both primes hover state and drives the in-page cursor overlay the
	// relay paints from Input.dispatchMouseEvent.
	await dispatchMouse(node.session, "mouseMoved", point, { button: "none", buttons: 0, clickCount: 0 }, signal);
	for (let count = 1; count <= clickCount; count++) {
		await dispatchMouse(node.session, "mousePressed", point, { button: "left", buttons: 1, clickCount: count }, signal);
		await dispatchMouse(node.session, "mouseReleased", point, { button: "left", buttons: 0, clickCount: count }, signal);
	}
}

export async function hoverNode(node: CdpNode, signal?: AbortSignal): Promise<void> {
	const point = await actionPoint(node, signal);
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

async function dispatchKey(
	session: CDPSession,
	type: "keyDown" | "rawKeyDown" | "keyUp",
	stroke: KeyStroke,
	modifiers: number,
	signal?: AbortSignal,
): Promise<void> {
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
		}),
	);
}

/** One key or chord: modifiers down, key down/up, modifiers up — with the bitmask Chrome expects. */
export async function pressChord(session: CDPSession, chord: string, signal?: AbortSignal): Promise<void> {
	const { modifiers, key } = parseChord(chord);
	let mask = 0;
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

/** Type text as a user would: a key event per layout character, IME insertion for the rest. */
export async function typeText(session: CDPSession, text: string, signal?: AbortSignal): Promise<void> {
	for (const character of text) {
		if (character in _keyDefinitions) {
			const stroke = keyStroke(character, 0);
			await dispatchKey(session, "keyDown", stroke, 0, signal);
			await dispatchKey(session, "keyUp", stroke, 0, signal);
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

export async function typeIntoNode(node: CdpNode, text: string, signal?: AbortSignal): Promise<void> {
	await focusNode(node, signal);
	await typeText(node.session, text, signal);
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
 */
export async function resolveSelector(
	page: Page,
	selector: string,
	signal?: AbortSignal,
): Promise<{ session: CDPSession; backendNodeId: number }[]> {
	const session = page.mainFrame().client;
	if (selector.startsWith("aria/")) return await resolveAriaSelector(page, selector.slice("aria/".length), signal);
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

async function hasBox(node: CdpNode, signal?: AbortSignal): Promise<boolean> {
	const box = await nodeBox(node, signal);
	return box !== null && box.border.width > 0 && box.border.height > 0;
}

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
				if (await hasBox(node, signal)) {
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
 * The page's accessibility tree, one `Accessibility.getFullAXTree` per frame,
 * with every embedded document spliced under the iframe element that owns it.
 * Frames are read on the session that serves them: an out-of-process iframe is
 * invisible to the page session, and its nodes must be actioned on its own.
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
		return buildAxTree(nodes, axFrame, { includeAll: options.includeAll, embedded });
	};

	const tree = await build(page.mainFrame());
	if (!tree) throw new ToolError("Accessibility snapshot unavailable");
	return tree;
}
