import { untilAborted } from "@oh-my-pi/pi-utils";
import { AGENT_COLOR_HEX, agentIdentity } from "@oh-my-pi/pi-tui/overlays/agent-identity";
import type { Page, PDFOptions, ScreenshotOptions } from "puppeteer-core";
import type { RecordingOptions } from "./recording";

/** What the agent cursor shows: its agent's colour (CSS) and name. */
export interface AgentCursorIdentity {
	color: string;
	label: string;
}

/** A pointer action omp sent, in top-viewport CSS pixels; `press` marks a button going down. */
export interface AgentCursorPlacement extends AgentCursorIdentity {
	x: number;
	y: number;
	press: boolean;
}

/** The cursor identity of registry agent `agentId`. */
export function agentCursorIdentity(agentId: string): AgentCursorIdentity {
	const identity = agentIdentity(agentId);
	return { color: AGENT_COLOR_HEX[identity.color], label: identity.label };
}

/** Recording `options` for a run that draws the agent cursor `cursor`: the frames show it, so no second overlay. */
export function withoutSecondCursor(
	options: RecordingOptions | undefined,
	cursor: AgentCursorIdentity | null | undefined,
): RecordingOptions | undefined {
	return cursor ? { ...options, cursor: false } : options;
}

interface CursorStyle {
	cssText: string;
	transform: string;
	transition: string;
	visibility: string;
	left: string;
	top: string;
}

interface CursorNode {
	readonly style: CursorStyle;
	readonly isConnected: boolean;
	id: string;
	textContent: string | null;
	setAttribute(name: string, value: string): void;
	append(...nodes: CursorNode[]): void;
	remove(): void;
	attachShadow(options: { mode: "closed" }): { append(...nodes: CursorNode[]): void };
	animate(
		keyframes: Record<string, string>[],
		options: { duration: number; easing: string },
	): { finished: Promise<unknown> };
}

interface DrawnCursor {
	host: CursorNode;
	shadow: { append(...nodes: CursorNode[]): void };
	pointer: CursorNode;
	color: string;
	label: string;
}

interface CursorWorld {
	readonly document: {
		readonly documentElement: CursorNode | null;
		createElement(tag: string): CursorNode;
		createElementNS(namespace: string, tag: string): CursorNode;
		getElementById(id: string): CursorNode | null;
		addEventListener(type: string, listener: () => void, options: { once: boolean }): void;
	};
	matchMedia(query: string): { matches: boolean };
	__ompAgentCursor?: DrawnCursor;
}

/**
 * Page function (self-contained, top document, omp's isolated world): draw the agent cursor at `at`, with a ripple
 * for a press. Re-entrant: it redraws when the page dropped the element or the identity changed, and replaces a
 * cursor another world drew (a replaced tab worker), whose closed root it cannot reach. Styles go through the CSSOM
 * and Web Animations, which a page's style CSP and Trusted Types do not block.
 */
export function placeAgentCursorInPage(at: AgentCursorPlacement): void {
	const world = globalThis as unknown as CursorWorld;
	const document = world.document;
	const root = document.documentElement;
	if (!root) {
		// A document that has only just committed: draw once it parses.
		document.addEventListener("DOMContentLoaded", () => placeAgentCursorInPage(at), { once: true });
		return;
	}
	const still = world.matchMedia("(prefers-reduced-motion: reduce)").matches;
	let drawn = world.__ompAgentCursor;
	if (!drawn || !drawn.host.isConnected || drawn.color !== at.color || drawn.label !== at.label) {
		drawn?.host.remove();
		document.getElementById("__omp_agent_cursor__")?.remove();
		const host = document.createElement("div");
		host.id = "__omp_agent_cursor__";
		host.setAttribute("aria-hidden", "true");
		host.setAttribute("inert", "");
		host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden";
		const shadow = host.attachShadow({ mode: "closed" });
		const pointer = document.createElement("div");
		pointer.style.cssText = "position:absolute;left:0;top:0;will-change:transform";
		const svgNs = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(svgNs, "svg");
		svg.setAttribute("width", "18");
		svg.setAttribute("height", "24");
		svg.setAttribute("viewBox", "0 0 18 24");
		svg.style.cssText = "display:block;filter:drop-shadow(0 1px 1px rgba(0,0,0,.45))";
		const arrow = document.createElementNS(svgNs, "path");
		arrow.setAttribute("d", "M1 1 L1 19 L6 14.5 L9.5 22 L12.5 20.6 L9 13.4 L15.5 13.4 Z");
		arrow.setAttribute("fill", at.color);
		arrow.setAttribute("stroke", "#fff");
		arrow.setAttribute("stroke-width", "1.6");
		arrow.setAttribute("stroke-linejoin", "round");
		svg.append(arrow);
		const badge = document.createElement("div");
		badge.style.cssText =
			"position:absolute;left:16px;top:20px;padding:1px 6px;border-radius:8px;color:#fff;white-space:nowrap;" +
			`font:600 11px/16px system-ui,sans-serif;box-shadow:0 0 0 1px rgba(255,255,255,.85);background:${at.color}`;
		badge.textContent = at.label;
		pointer.append(svg, badge);
		shadow.append(pointer);
		root.append(host);
		drawn = { host, shadow, pointer, color: at.color, label: at.label };
		world.__ompAgentCursor = drawn;
	} else if (!still) {
		drawn.pointer.style.transition = "transform .16s cubic-bezier(.45,0,.2,1)";
	}
	drawn.pointer.style.transform = `translate(${at.x}px, ${at.y}px)`;
	if (!at.press || still) return;
	const ripple = document.createElement("div");
	ripple.style.cssText = `position:absolute;border:2px solid ${at.color};border-radius:999px`;
	ripple.style.left = `${at.x}px`;
	ripple.style.top = `${at.y}px`;
	drawn.shadow.append(ripple);
	const size = (px: number): Record<string, string> => ({
		width: `${px}px`,
		height: `${px}px`,
		margin: `${-px / 2 - 2}px`,
	});
	void ripple
		.animate(
			[
				{ ...size(8), opacity: "1" },
				{ ...size(34), opacity: "0" },
			],
			{ duration: 450, easing: "ease-out" },
		)
		.finished.then(
			() => ripple.remove(),
			() => ripple.remove(),
		);
}

/** Page function (self-contained): show or hide the agent cursor, whichever world drew it. */
export function showAgentCursorInPage(visible: boolean): void {
	const world = globalThis as unknown as CursorWorld;
	const host = world.document.getElementById("__omp_agent_cursor__");
	if (host) host.style.visibility = visible ? "" : "hidden";
}

/** Page function (self-contained): remove the agent cursor, whichever world drew it. */
export function removeAgentCursorInPage(): void {
	const world = globalThis as unknown as CursorWorld;
	world.__ompAgentCursor?.host.remove();
	world.document.getElementById("__omp_agent_cursor__")?.remove();
	delete world.__ompAgentCursor;
}

type CursorLog = (level: "debug" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;

/** Calls the page function `source` (its text) with `arg` in the tab's top document, in omp's isolated world. */
export type CursorEvaluate = (source: string, arg: unknown) => Promise<unknown>;

/**
 * The agent cursor of one tab, drawn in its top document through the backend's `evaluate`. omp places it after each
 * pointer action it sends and never awaits that, so input goes out as it would without the cursor; the page's own
 * events never move it, so neither iframes nor the user's real pointer do.
 */
export class AgentCursor {
	readonly #evaluate: CursorEvaluate;
	readonly #log: CursorLog;
	#identity: AgentCursorIdentity | null = null;
	/** An identity was ever set, so the page may hold a cursor to remove. */
	#used = false;
	#at: { x: number; y: number } | undefined;

	constructor(evaluate: CursorEvaluate, log: CursorLog) {
		this.#evaluate = evaluate;
		this.#log = log;
	}

	/** Draw as `identity` from now on; `null` removes the cursor. */
	use(identity: AgentCursorIdentity | null): void {
		const previous = this.#identity;
		this.#identity = identity;
		if (!identity) {
			if (previous) void this.remove();
			return;
		}
		this.#used = true;
		if (previous?.color !== identity.color || previous.label !== identity.label) this.#draw(false);
	}

	/** Draw at (`x`, `y`), top-viewport CSS pixels, where a pointer action just went. */
	moveTo(x: number, y: number): void {
		this.#at = { x, y };
		this.#draw(false);
	}

	/** Mark a button press where the cursor is. */
	press(): void {
		this.#draw(true);
	}

	/** Draw again where the last action left it: the main frame's new document has no cursor yet. */
	redraw(): void {
		this.#draw(false);
	}

	/** Run `capture` with the cursor hidden, so what the agent captures leaves it out. */
	async hiddenDuring<T>(signal: AbortSignal | undefined, capture: () => Promise<T>): Promise<T> {
		if (!this.#identity) return await capture();
		try {
			await untilAborted(signal, () => this.#call(showAgentCursorInPage, false));
		} catch (error) {
			signal?.throwIfAborted();
			this.#log("warn", "Browser agent cursor could not be hidden for a capture", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		try {
			return await capture();
		} finally {
			void this.#call(showAgentCursorInPage, true).catch(() => undefined);
		}
	}

	/** Remove the cursor from the current document if one may have been drawn; never throws. */
	async remove(): Promise<void> {
		if (!this.#used) return;
		await this.#call(removeAgentCursorInPage, undefined).catch(() => undefined);
	}

	#draw(press: boolean): void {
		const identity = this.#identity;
		const at = this.#at;
		if (!identity || !at) return;
		void this.#call(placeAgentCursorInPage, { ...identity, ...at, press }).catch(() => undefined);
	}

	#call<Arg>(fn: (arg: Arg) => void, arg: Arg): Promise<unknown> {
		return this.#evaluate(fn.toString(), arg);
	}
}

/**
 * The agent cursor of a Puppeteer page. Every pointer action omp sends goes through `page.mouse` (element clicks and
 * hovers, drags, coordinate input, an eval cell's own `page.mouse` calls), so the cursor follows its moves and
 * presses there; every capture and print goes through `page.screenshot` (element screenshots too) or `page.pdf`, so
 * it is hidden for those. It is drawn again in each new main-frame document once that has parsed: at
 * `framenavigated` the isolated world still holds the old document's context, so a draw then lands in the page being
 * left.
 */
export function pageAgentCursor(page: Page, log: CursorLog): AgentCursor {
	const cursor = new AgentCursor(
		(source, arg) =>
			page
				.mainFrame()
				.isolatedRealm()
				.evaluate(`(${source})(${JSON.stringify(arg)})`),
		log,
	);
	const mouse = page.mouse;
	const move = mouse.move.bind(mouse);
	const down = mouse.down.bind(mouse);
	mouse.move = async (x, y, options) => {
		await move(x, y, options);
		cursor.moveTo(x, y);
	};
	mouse.down = async options => {
		await down(options);
		cursor.press();
	};
	const screenshot = page.screenshot.bind(page);
	const pdf = page.pdf.bind(page);
	// `Object.assign` because `screenshot` is overloaded on its encoding; the wrapper passes options through.
	Object.assign(page, {
		screenshot: (options?: ScreenshotOptions) => cursor.hiddenDuring(undefined, () => screenshot(options)),
		pdf: (options?: PDFOptions) => cursor.hiddenDuring(undefined, () => pdf(options)),
	});
	page.on("domcontentloaded", () => cursor.redraw());
	return cursor;
}
