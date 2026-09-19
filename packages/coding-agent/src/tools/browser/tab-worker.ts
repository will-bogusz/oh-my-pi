import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { postmortem, Snowflake, toError, untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import type { HTMLElement } from "@oh-my-pi/pi-utils/dom";
import type { Browser, CDPSession, Dialog, HTTPResponse, Page, Target } from "puppeteer-core";
import { JsRuntime, type RuntimeHooks } from "../../eval/js/shared/runtime";
import { formatScreenshot, resizeImage } from "../../utils/image-resize";
import { resolveToCwd } from "../path-utils";
import {
	bindRunFacade,
	CELL_BUDGET_SLACK_MS,
	installBrowserWorkerRejectionGuard,
	isBrowserRunOwnedRejection,
	markBrowserRunRejection,
	markHandled,
	observeBrowserRunPromise,
	resolvePredicateTimeout,
	type WaitPredicateOptions,
	waitForRun,
	withBrowserPromiseCombinatorTracking,
} from "../run-scope";
import { ToolAbortError, throwIfAborted } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	type AriaSnapshotOptions,
	assertSelectorString,
	buildAriaRefScript,
	buildAriaSnapshotFunction,
	buildAriaSnapshotScript,
	parseAriaRefSelector,
} from "./aria/aria-snapshot";
import {
	awaitSelector,
	boundingBox,
	callExpression,
	callOnNode,
	type CdpNode,
	clickNode,
	currentEntry,
	evaluateExpression,
	fillNode,
	focusNode,
	hoverNode,
	isDocumentGoneError,
	nodeFromExpression,
	type PageLayout,
	pageLayout,
	type Point,
	pressChord,
	type Rect,
	scrollIntoView,
	selectOptions,
	resolveSelector,
	sessionOffset,
	setFileInput,
	snapshotAccessibility,
	typeIntoNode,
	waitForDomQuiet,
} from "./cdp";
import { applyStealthPatches, applyViewport, BROWSER_PROTOCOL_TIMEOUT_MS, loadPuppeteerInWorker } from "./launch";
import { TabDownloadMonitor, type TabDownloads } from "./downloads";
import { navigateMainFrame, watchMainFrameNavigation } from "./navigation";
import {
	type AxNode,
	axNodeKey,
	buildTreeLines,
	flattenSnapshot,
	hasBusyIndicator,
	matchRefs,
	type ObservedNode,
	type RefRecord,
	renderTree,
	renderTreeDiff,
	roleNamePositions,
	sameDocument,
	type TreeHeader,
	type TreeLine,
} from "./observation";
import { extractReadableFromHtml, type ReadableFormat } from "./readable";

import { cloneSafe, RunOutput } from "./run-output";
import type { BrowserSelectOption } from "./select-options";
import type {
	Observation,
	ReadyInfo,
	RefStyle,
	RunErrorPayload,
	ScreenshotResult,
	SessionSnapshot,
	ToolReply,
	Transport,
	WorkerInbound,
	WorkerInitPayload,
} from "./tab-protocol";

declare module "puppeteer-core" {
	interface JSHandle<T> {
		/** Remote object id (`@internal` upstream, present at runtime); `T` is puppeteer's own parameter. */
		readonly id: string | undefined;
	}
	interface Realm {
		/** Re-home a DOM handle into this realm (`@internal` upstream, stripped from published types). */
		adoptHandle<T extends JSHandle>(handle: T): Promise<T>;
	}
	interface JSHandle {
		/** Realm that created this handle (`@internal` upstream, stripped from published types). */
		readonly realm: Realm;
	}
}

declare global {
	interface Element extends HTMLElement {}
	function getComputedStyle(element: Element): Record<string, unknown>;
	var innerWidth: number;
	var innerHeight: number;
	var document: {
		elementFromPoint(x: number, y: number): Element | null;
		readonly visibilityState: "visible" | "hidden";
	};
}

const LEGACY_SELECTOR_PREFIXES = ["p-aria/", "p-text/", "p-xpath/", "p-pierce/"] as const;

const SELECTOR_HANDLER_PREFIXES = [
	"aria/",
	"text/",
	"xpath/",
	"pierce/",
	"aria-ref=",
	"aria-ref/",
	"ariaref/",
	"p-",
] as const;

/**
 * Playwright-only selector engines/pseudos puppeteer cannot parse. Without this guard a
 * `tab.click(":has-text(...)")` would wait the full action timeout and fail opaquely;
 * fail fast instead with a pointer to the puppeteer-native alternative. Skipped for
 * explicit query-handler prefixes (`text/`, `aria/`, …) whose payload is literal text.
 */
const PLAYWRIGHT_ONLY_SELECTOR_RE =
	/:has-text\(|:text\(|:text-is\(|:text-matches\(|:visible\b|:hidden\b|:nth-match\(|:near\(|:above\(|:below\(|:right-of\(|:left-of\(/;

type DialogPolicy = "accept" | "dismiss";
type DragTarget = string | { readonly x: number; readonly y: number };
/** Last JS dialog seen on the page; kept for timeout attribution until handled or navigation. */
interface OpenDialogInfo {
	type: string;
	message: string;
}

/**
 * Per-op fail-fast ceilings for `tab.*` helpers. All are kept strictly under the cell
 * budget (`timeoutMs - OP_DEADLINE_SLACK_MS`) so a stalled helper rejects with a named,
 * attributable error that leaves recovery budget — never the opaque whole-cell
 * "Browser code execution timed out" path that consumed the entire run.
 *
 * - `QUICK_OP_TIMEOUT_MS`: page-coupled reads that should resolve fast (`observe`,
 *   `screenshot`, `extract`, `ariaSnapshot`).
 * - `ACTION_OP_TIMEOUT_MS`: interactive point actions (`click`, `fill`, `type`, …) and
 *   the default for wait helpers when no explicit `{ timeout }` is given. Selector ops
 *   additionally fail fast after `ZERO_MATCH_FAIL_FAST_MS` of confirmed zero matches
 *   (see `#zeroMatchWatchdog`), so the full ceiling is only spent on elements that
 *   exist but are not yet actionable.
 *
 * `goto` and `evaluate` stay uncapped (`Number.POSITIVE_INFINITY`): navigation and user
 * code legitimately use the full cell budget.
 */
const QUICK_OP_TIMEOUT_MS = 20_000;
const ACTION_OP_TIMEOUT_MS = 8_000;
/** Maximum wait for a renderer acknowledgement after a wheel event is queued. */
const SCROLL_ACK_TIMEOUT_MS = 2_000;
/** Headroom subtracted from the cell budget so a per-op deadline fires before it. */
const OP_DEADLINE_SLACK_MS = CELL_BUDGET_SLACK_MS;
/**
 * A selector op whose selector has matched nothing for this long fails fast with the
 * zero-match hint instead of burning the rest of its deadline: a wrong selector or a
 * wrong page (consent wall, pre-navigation document) is the common agent failure and
 * should cost ~2s, not the full action ceiling. Explicit `{ timeout }` waits opt out.
 */
const ZERO_MATCH_FAIL_FAST_MS = 2_000;
/** Poll cadence for `tab.waitForUrl()`; the frame url updates on navigation events, not on a timer. */
const URL_POLL_MS = 100;
/** Poll cadence for the zero-match watchdog. */
const ZERO_MATCH_POLL_MS = 250;
/** Cleanup must settle inside the supervisor's 750ms post-run grace window. */
const REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS = 500;

export interface OpTimeouts {
	/** Largest per-op deadline allowed — strictly below the cell budget. */
	budgetBound: number;
	/** Ceiling for quick page reads. */
	quickOpMs: number;
	/** Ceiling for interactive actions + default for waits. */
	actionOpMs: number;
}

/** Resolve the per-op fail-fast ceilings for a given cell budget. */
export function resolveOpTimeouts(cellTimeoutMs: number): OpTimeouts {
	const budgetBound = Math.max(1, cellTimeoutMs - OP_DEADLINE_SLACK_MS);
	return {
		budgetBound,
		quickOpMs: Math.min(budgetBound, QUICK_OP_TIMEOUT_MS),
		actionOpMs: Math.min(budgetBound, ACTION_OP_TIMEOUT_MS),
	};
}

/** Queue a wheel event without treating a delayed renderer acknowledgement as dispatch failure. */
export async function dispatchScroll(
	dispatch: () => Promise<void>,
	ackTimeoutMs = SCROLL_ACK_TIMEOUT_MS,
): Promise<void> {
	const deadline = Promise.withResolvers<void>();
	const timer = setTimeout(() => deadline.resolve(), ackTimeoutMs);
	timer.unref();
	try {
		await Promise.race([dispatch(), deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Effective timeout for a wait helper (`waitFor*`). A positive explicit `{ timeout }` is
 * honored but clamped to the cell budget so it still fails fast + named; raising the tool
 * `timeout` raises that cap, so a longer budget stays meaningful. No `{ timeout }` → the
 * action ceiling. Puppeteer's `{ timeout: 0 }` / `Infinity` ("disable") maps to the largest
 * bounded wait (`budgetBound`) — the harness never permits an unbounded wait. Garbage input
 * (negative, `NaN`) falls back to the action ceiling rather than the longest wait.
 */
export function resolveWaitTimeout(cellTimeoutMs: number, explicit?: number): number {
	const { budgetBound, actionOpMs } = resolveOpTimeouts(cellTimeoutMs);
	if (explicit === undefined) return actionOpMs;
	// Puppeteer "disable" sentinels — still bounded by the budget here.
	if (explicit === 0 || explicit === Number.POSITIVE_INFINITY) return budgetBound;
	// Positive finite → honored + clamped. Negative/NaN garbage → default, not the longest wait.
	if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, budgetBound);
	return actionOpMs;
}

interface ScreenshotOptions {
	selector?: string;
	fullPage?: boolean;
	silent?: boolean;
}

interface TabApi {
	readonly name: string;
	readonly page: Page;
	readonly signal?: AbortSignal;
	url(): string;
	title(): Promise<string>;
	goto(
		url: string,
		opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2" },
	): Promise<void>;
	observe(opts?: ObserveOptions): Promise<Observation>;
	ariaSnapshot(selector?: string, opts?: AriaSnapshotOptions): Promise<string>;
	screenshot(opts?: ScreenshotOptions): Promise<string>;
	extract(format?: ReadableFormat): Promise<string>;
	click(selector: string): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	press(key: string, opts?: { selector?: string }): Promise<void>;
	scroll(
		deltaXOrDirection: number | ScrollDirection,
		deltaYOrOptions?: number | { by?: number | "page" },
	): Promise<void>;
	drag(from: DragTarget, to: DragTarget): Promise<void>;
	waitFor(selector: string, opts?: { timeout?: number }): Promise<TabElement>;
	evaluate<R, TArgs extends unknown[]>(fn: string | ((...args: TArgs) => R | Promise<R>), ...args: TArgs): Promise<R>;
	scrollIntoView(selector: string): Promise<void>;
	select(selector: string, ...values: BrowserSelectOption[]): Promise<string[]>;
	uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
	downloads(): Promise<TabDownloads>;
	waitForUrl(pattern: string | RegExp, opts?: { timeout?: number }): Promise<string>;
	waitForResponse(
		pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
		opts?: { timeout?: number },
	): Promise<HTTPResponse>;
	waitForSelector(
		selector: string,
		opts?: { timeout?: number; visible?: boolean; hidden?: boolean },
	): Promise<TabElement | null>;
	waitForNavigation(opts?: {
		waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
		timeout?: number;
	}): Promise<HTTPResponse | null>;
	id(n: number): Promise<TabElement>;
	ref(id: string): Promise<TabElement>;
}

/**
 * What `tab.ref()`, `tab.id()` and the selector waits hand model code. Mirrors
 * `BrowserElement` in the code-mode declarations: same names, same positional
 * arguments, nothing puppeteer-shaped leaking through.
 */
export interface TabElement {
	click(options?: { count?: number }): Promise<void>;
	type(text: string): Promise<void>;
	fill(value: string): Promise<void>;
	press(key: string): Promise<void>;
	hover(): Promise<void>;
	focus(): Promise<void>;
	select(...values: BrowserSelectOption[]): Promise<string[]>;
	uploadFile(...filePaths: string[]): Promise<void>;
	scrollIntoView(): Promise<void>;
	boundingBox(): Promise<Rect | null>;
	isVisible(): Promise<boolean>;
	isHidden(): Promise<boolean>;
	evaluate<R, TArgs extends unknown[]>(
		fn: string | ((element: unknown, ...args: TArgs) => R | Promise<R>),
		...args: TArgs
	): Promise<R>;
}

/** Per-op fail-fast wrapper an element's methods run inside. */
type ElementOp = <T>(label: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>;

export function normalizeSelector(selector: string): string {
	assertSelectorString(selector);
	if (!selector) return selector;
	if (
		!SELECTOR_HANDLER_PREFIXES.some(prefix => selector.startsWith(prefix)) &&
		PLAYWRIGHT_ONLY_SELECTOR_RE.test(selector)
	) {
		throw new ToolError(
			`Playwright-only selector ${JSON.stringify(selector)} is not supported by the browser tool. ` +
				`Use a puppeteer text selector ("text/Allow all"), an aria selector ("aria/Name"), CSS, or "xpath/...".`,
		);
	}
	if (selector.startsWith("p-") && !LEGACY_SELECTOR_PREFIXES.some(prefix => selector.startsWith(prefix))) {
		throw new ToolError(
			`Unsupported selector prefix. Use CSS or puppeteer query handlers (aria/, text/, xpath/, pierce/). Got: ${selector}`,
		);
	}
	if (selector.startsWith("p-text/")) return `text/${selector.slice("p-text/".length)}`;
	if (selector.startsWith("p-xpath/")) return `xpath/${selector.slice("p-xpath/".length)}`;
	if (selector.startsWith("p-pierce/")) return `pierce/${selector.slice("p-pierce/".length)}`;
	if (selector.startsWith("p-aria/")) {
		const rest = selector.slice("p-aria/".length);
		const nameMatch = rest.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
		const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
		if (name) return `aria/${name.trim()}`;
		return `aria/${rest}`;
	}
	return selector;
}

interface ObserveOptions {
	includeAll?: boolean;
	viewportOnly?: boolean;
	/** Render only what changed since the previous observation of this document (default when one exists). */
	diff?: boolean;
	/** Print the tree into the run output (default true). */
	display?: boolean;
}

/**
 * What one ref needs to act on its element again: the DOM node's backend id and
 * the CDP session that owns its frame — nothing live, so a navigation can only
 * make the node unknown, never leave a dead object behind. `nodeKey` identifies
 * the exact DOM node and role/name/position an equivalent one, so the next
 * observation re-attaches the same number to the same element (that re-match is
 * the healing: a ref is repaired by observing, never behind the model's back).
 * Entries outlive the observation that minted them so a ref keeps naming the
 * same element for the tab lifetime.
 */
interface RefEntry extends RefRecord {
	session: CDPSession;
	backendNodeId: number;
}

/**
 * Numeric element id behind a ref token, or null when the token belongs to a
 * different observation (uuid style) or is not a ref at all (e.g. an ARIA
 * snapshot ref, which the caller resolves through the page instead).
 */
export function parseRefToken(token: string, observationId: string): number | null {
	const trimmed = token.trim();
	const separator = trimmed.lastIndexOf(":");
	if (separator >= 0) {
		if (trimmed.slice(0, separator) !== observationId) return null;
		const id = Number(trimmed.slice(separator + 1));
		return Number.isSafeInteger(id) && id > 0 ? id : null;
	}
	const compact = /^e(\d+)$/.exec(trimmed);
	if (!compact) return null;
	const id = Number(compact[1]);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const backgroundInputQueues = new WeakMap<Page, Promise<void>>();
const backgroundInputFailures = new WeakMap<Page, Error>();
const backgroundPageScopes = new WeakMap<Page, BackgroundPageScope>();
/**
 * A cross-document navigation started by the click we just dispatched leaves this
 * CDP call unanswered for as long as Chrome takes to swap documents (and often
 * processes), so the window has to outlast a commit, not a round trip.
 */
const INPUT_RESTORE_TIMEOUT_MS = 3000;

interface BackgroundPageScope {
	ready: Promise<void>;
	accepting: boolean;
	close(): Promise<void>;
}

async function restoreBackgroundPage(page: Page, pending: Promise<unknown>): Promise<void> {
	const navigation = watchMainFrameNavigation(page);
	await withTimeout(
		pending
			.catch(() => undefined)
			.then(async () => {
				if (!page.isClosed()) await page.emulateFocusedPage(false);
			}),
		INPUT_RESTORE_TIMEOUT_MS,
		"Timed out restoring Chrome page focus state",
	)
		.catch(async error => {
			if (page.isClosed()) return;
			const excuse = await navigation.excuse(error);
			if (excuse) {
				// The page navigated: focus emulation is a per-renderer setting the new
				// document did not inherit, and the handle is fine. Retry once for the
				// same-process case, then let the caller carry on either way.
				await withTimeout(
					page.emulateFocusedPage(false),
					INPUT_RESTORE_TIMEOUT_MS,
					"Timed out restoring Chrome page focus state",
				).catch(() => undefined);
				return;
			}
			const failure = new ToolError(
				`Chrome page focus state could not be restored: ${String(error)}. ` +
					"The page navigated or is busy; observe again before acting.",
			);
			backgroundInputFailures.set(page, failure);
			throw failure;
		})
		.finally(() => navigation.stop());
}

/** Prepare a complete managed run, including accessibility queries, without selecting its tab. */
export function prepareBackgroundPage(page: Page, signal?: AbortSignal): BackgroundPageScope {
	throwIfAborted(signal);
	const failure = backgroundInputFailures.get(page);
	if (failure) throw failure;
	if (backgroundPageScopes.has(page) || backgroundInputQueues.has(page))
		throw new ToolError("Chrome page still has an active operation");
	const entering = Promise.resolve().then(() => {
		throwIfAborted(signal);
		return page.emulateFocusedPage(true);
	});
	let closing: Promise<void> | undefined;
	const scope: BackgroundPageScope = {
		ready: untilAborted(signal, () => entering),
		accepting: true,
		close: () => {
			if (closing) return closing;
			scope.accepting = false;
			// Run cancellation stops new admission before this drain. Already-started
			// input keeps its serialization slot until it settles, even after abort.
			const drained = backgroundInputQueues.get(page) ?? Promise.resolve();
			closing = restoreBackgroundPage(page, Promise.allSettled([entering, drained])).finally(() => {
				if (backgroundPageScopes.get(page) === scope) backgroundPageScopes.delete(page);
			});
			return closing;
		},
	};
	backgroundPageScopes.set(page, scope);
	return scope;
}

/** Serialize page input and restore browser focus emulation even after cancellation. */
export async function withBackgroundInput<T>(
	page: Page,
	signal: AbortSignal | undefined,
	action: () => Promise<T>,
): Promise<T> {
	const previous = backgroundInputQueues.get(page) ?? Promise.resolve();
	const finished = Promise.withResolvers<void>();
	const queued = previous.then(() => finished.promise);
	backgroundInputQueues.set(page, queued);
	let entering: Promise<void> | undefined;
	try {
		await untilAborted(signal, () => previous);
		throwIfAborted(signal);
		const failure = backgroundInputFailures.get(page);
		if (failure) throw failure;
		const scope = backgroundPageScopes.get(page);
		if (scope) {
			if (!scope.accepting) throw new ToolAbortError("Chrome page operation ended");
			await untilAborted(signal, () => scope.ready);
			throwIfAborted(signal);
			if (!scope.accepting) throw new ToolAbortError("Chrome page operation ended");
			return await action();
		}
		entering = page.emulateFocusedPage(true);
		await untilAborted(signal, () => entering!);
		throwIfAborted(signal);
		return await action();
	} finally {
		try {
			if (entering) {
				// Wait for a late enable before restoring, so it cannot re-enable focus
				// after cleanup. A failed restore poisons this worker's input path.
				await restoreBackgroundPage(page, entering);
			}
		} finally {
			finished.resolve();
			void queued.then(() => {
				if (backgroundInputQueues.get(page) === queued) backgroundInputQueues.delete(page);
			});
		}
	}
}

export type ScrollDirection = "up" | "down" | "left" | "right";

const SCROLL_DIRECTIONS: Readonly<Record<ScrollDirection, { x: number; y: number }>> = {
	up: { x: 0, y: -1 },
	down: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
};

/**
 * Accept both scroll forms. `scroll(0, 600)` is pixel deltas; `scroll("down")`
 * and `scroll("down", { by: "page" })` are one viewport step, which is what
 * models reach for and used to reach CDP as `deltaX: "down"` — a protocol
 * error rather than a scroll. A page step is 90% of the viewport so the
 * boundary content stays visible.
 */
async function resolveScrollDeltas(
	page: Page,
	deltaXOrDirection: number | ScrollDirection,
	deltaYOrOptions: number | { by?: number | "page" } | undefined,
	signal: AbortSignal | undefined,
): Promise<{ deltaX: number; deltaY: number }> {
	if (typeof deltaXOrDirection === "number") {
		const deltaY = deltaYOrOptions ?? 0;
		if (typeof deltaY !== "number" || !Number.isFinite(deltaXOrDirection) || !Number.isFinite(deltaY))
			throw new ToolError(
				'tab.scroll() takes pixel deltas (tab.scroll(0, 600)) or a direction (tab.scroll("down", { by: "page" }))',
			);
		return { deltaX: deltaXOrDirection, deltaY };
	}
	const unit = SCROLL_DIRECTIONS[deltaXOrDirection as ScrollDirection];
	if (!unit)
		throw new ToolError(
			`tab.scroll() direction must be one of up, down, left, right (got ${JSON.stringify(deltaXOrDirection)})`,
		);
	const by = typeof deltaYOrOptions === "number" ? deltaYOrOptions : (deltaYOrOptions?.by ?? "page");
	if (typeof by === "number") {
		if (!Number.isFinite(by) || by < 0) throw new ToolError("tab.scroll() `by` must be a non-negative pixel count");
		return { deltaX: unit.x * by, deltaY: unit.y * by };
	}
	if (by !== "page") throw new ToolError('tab.scroll() `by` must be a pixel count or "page"');
	const { viewport } = await readPageMetrics(page, signal);
	const step = Math.max(1, Math.round((unit.x === 0 ? viewport.height : viewport.width) * 0.9));
	return { deltaX: unit.x * step, deltaY: unit.y * step };
}

/** Viewport and document geometry as an observation reports them. */
function metricsFromLayout(page: Page, layout: PageLayout): Pick<Observation, "viewport" | "scroll"> {
	return {
		viewport: {
			width: layout.viewport.width,
			height: layout.viewport.height,
			// Attached pages have no emulated viewport, so Chrome has no scale to report.
			deviceScaleFactor: page.viewport()?.deviceScaleFactor,
		},
		scroll: {
			x: layout.scroll.x,
			y: layout.scroll.y,
			width: layout.viewport.width,
			height: layout.viewport.height,
			scrollWidth: layout.scroll.scrollWidth,
			scrollHeight: layout.scroll.scrollHeight,
		},
	};
}

/** Measured page geometry, straight from the compositor — the page runs nothing for it. */
export async function readPageMetrics(
	page: Page,
	signal?: AbortSignal,
): Promise<Pick<Observation, "viewport" | "scroll">> {
	return metricsFromLayout(page, await pageLayout(page.mainFrame().client, signal));
}

function redactUrlCredentials(url: string): string {
	if (!url || (!url.includes("@") && !url.includes("//"))) return url;
	try {
		const parsed = new URL(url);
		if (!parsed.username && !parsed.password) return url;
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return url;
	}
}

class RequestInterceptionCleanupError extends ToolError {}

interface RunPageScope {
	page: Page;
	cleanup(resume?: Promise<void>): Promise<void>;
}

/** Run-owned event handlers cannot survive a failed cell or remove controller observers. */
export function createRunPageScope(page: Page): RunPageScope {
	const handlers: { type: unknown; original: unknown; registered: unknown }[] = [];
	const on = page.on;
	const off = page.off;
	const setRequestInterception = page.setRequestInterception;
	// Only a run that turned interception on needs it turned off. Puppeteer's
	// `NetworkManager` starts with no recorded protocol state, so a bare
	// `setRequestInterception(false)` is not a no-op: it fans out
	// `Network.setCacheDisabled` + `Fetch.disable` and can outlive the cleanup
	// budget on a page that never intercepted anything.
	let intercepting = false;
	const descriptors = Object.fromEntries(
		["on", "off", "once", "removeAllListeners", "setRequestInterception"].map(name => [
			name,
			Object.getOwnPropertyDescriptor(page, name),
		]),
	);
	const remove = (index: number): void => {
		const [entry] = handlers.splice(index, 1);
		if (entry) Reflect.apply(off, page, [entry.type, entry.registered]);
	};
	const removeAll = (type?: unknown): Page => {
		for (let index = handlers.length - 1; index >= 0; index--) {
			if (type === undefined || handlers[index]!.type === type) remove(index);
		}
		return page;
	};
	Object.defineProperties(page, {
		on: {
			configurable: true,
			value: (type: unknown, handler: unknown): Page => {
				Reflect.apply(on, page, [type, handler]);
				handlers.push({ type, original: handler, registered: handler });
				return page;
			},
		},
		once: {
			configurable: true,
			value: (type: unknown, handler: unknown): Page => {
				if (typeof handler !== "function") throw new TypeError("Event handler must be a function");
				const wrapper = (...args: unknown[]): unknown => {
					const index = handlers.findIndex(entry => entry.registered === wrapper);
					if (index >= 0) remove(index);
					return Reflect.apply(handler, page, args);
				};
				handlers.push({ type, original: handler, registered: wrapper });
				Reflect.apply(on, page, [type, wrapper]);
				return page;
			},
		},
		off: {
			configurable: true,
			value: (type: unknown, handler?: unknown): Page => {
				if (handler === undefined) return removeAll(type);
				const index = handlers.findLastIndex(
					entry => entry.type === type && (entry.original === handler || entry.registered === handler),
				);
				if (index >= 0) remove(index);
				return page;
			},
		},
		removeAllListeners: { configurable: true, value: removeAll },
		setRequestInterception: {
			configurable: true,
			value: async (value: unknown): Promise<void> => {
				await Reflect.apply(setRequestInterception, page, [value]);
				intercepting = value === true;
			},
		},
	});

	return {
		page,
		async cleanup(resume) {
			removeAll();
			for (const [name, descriptor] of Object.entries(descriptors)) {
				if (descriptor) Object.defineProperty(page, name, descriptor);
				else Reflect.deleteProperty(page, name);
			}
			await resume;
			if (!intercepting) return;
			try {
				await withTimeout(
					page.setRequestInterception(false),
					REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS,
					"Timed out clearing browser request interception",
				);
			} catch (error) {
				throw new RequestInterceptionCleanupError(
					"Failed to clear browser request interception after browser.run",
					{ error: error instanceof Error ? error.message : String(error) },
				);
			}
		},
	};
}

function errorPayload(error: unknown): RunErrorPayload {
	const recoverTab = error instanceof RequestInterceptionCleanupError || undefined;
	if (error instanceof ToolAbortError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: true };
	}
	if (error instanceof ToolError) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isToolError: true,
			isAbort: false,
			recoverTab,
		};
	}
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: false };
	}
	return { name: "Error", message: String(error), isToolError: false, isAbort: false };
}

function replyError(payload: RunErrorPayload): Error {
	if (payload.isAbort) {
		const err = new ToolAbortError(payload.message || "Tool call aborted");
		if (payload.stack) err.stack = payload.stack;
		return err;
	}
	const Ctor = payload.isToolError ? ToolError : Error;
	const err = new Ctor(payload.message);
	if (payload.name) err.name = payload.name;
	if (payload.stack) err.stack = payload.stack;
	return err;
}

function privateTargetId(target: Target): string | undefined {
	const raw = target as unknown as { _targetId?: unknown };
	return typeof raw._targetId === "string" ? raw._targetId : undefined;
}

async function targetIdForTarget(target: Target): Promise<string> {
	const fastTargetId = privateTargetId(target);
	if (fastTargetId) return fastTargetId;
	const session = await target.createCDPSession();
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		if (info.targetInfo?.targetId) return info.targetInfo.targetId;
		throw new ToolError("Target id unavailable from CDP target info");
	} finally {
		await session.detach().catch(() => undefined);
	}
}

async function targetIdForPage(page: Page): Promise<string> {
	return await targetIdForTarget(page.target());
}

async function createTrackedHeadlessPage(browser: Browser, reportTarget: (targetId: string) => void): Promise<Page> {
	const session = await browser.target().createCDPSession();
	let targetId: string;
	try {
		({ targetId } = await session.send("Target.createTarget", { url: "about:blank" }));
		reportTarget(targetId);
	} finally {
		await session.detach().catch(() => undefined);
	}
	const existing = browser.targets().find(target => privateTargetId(target) === targetId);
	const target =
		existing ??
		(await browser.waitForTarget(candidate => privateTargetId(candidate) === targetId, {
			timeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		}));
	const page = await target.page();
	if (!page) throw new ToolError(`Created headless target ${targetId} did not expose a page`);
	return page;
}

/** Upper bound on the wait for a page to settle before an observation snapshots it. */
const SETTLE_BUDGET_MS = 3_000;
/** DOM-mutation quiet window that counts as settled. */
const SETTLE_DOM_QUIET_MS = 300;
/** Network idle window that counts as settled. */
const SETTLE_NETWORK_IDLE_MS = 1_000;
/** Re-check cadence while the tree still shows a loading indicator. */
const SETTLE_BUSY_POLL_MS = 250;
/** How many box models one viewport filter asks for at a time. */
const VIEWPORT_PROBE_BATCH = 32;

/**
 * Wait for the page to go quiet — no DOM mutations for 300 ms or no network
 * traffic for 1 s, whichever comes first — so an observation taken right after
 * an action sees the result instead of the spinner. Bounded by the budget it is
 * given. The DOM wait is one evaluate against the session's current document:
 * if that document is replaced under it the call rejects, which is the caller's
 * signal that a navigation happened, not an error to swallow.
 */
async function settlePage(page: Page, signal: AbortSignal | undefined, budgetMs: number): Promise<void> {
	// The network wait also carries the caller's abort: aborting it ends the race.
	const network = new AbortController();
	const onAbort = () => network.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const domQuiet = waitForDomQuiet(page.mainFrame().client, SETTLE_DOM_QUIET_MS, budgetMs, signal);
	const networkQuiet = page
		.waitForNetworkIdle({ idleTime: SETTLE_NETWORK_IDLE_MS, timeout: budgetMs, signal: network.signal })
		.catch(() => undefined);
	try {
		await Promise.race([domQuiet, networkQuiet]);
	} finally {
		network.abort();
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Hint appended to a selector op's fail-fast timeout, given the selector's current
 * match count: a missing element (consent wall, wrong page) reads differently from
 * a present-but-unactionable one.
 */
export function formatSelectorMatchHint(count: number): string {
	return count === 0
		? "; selector currently matches no elements — run tab.observe() or tab.ariaSnapshot() to inspect the page"
		: `; selector currently matches ${count} element(s) but the action never became possible — the element may be hidden or covered (try tab.scrollIntoView() or a more specific selector)`;
}

export interface InflightOp {
	label: string;
	startedAt: number;
}

interface ActiveRun {
	id: string;
	ac: AbortController;
	signal: AbortSignal;
	output: RunOutput;
	screenshots: ScreenshotResult[];
	pendingTools: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
	rejectionOwner: object;
	floatingRejections: unknown[];
	floatingFailure: { promise: Promise<never>; reject(reason?: unknown): void };
	/** Helper invocations currently awaiting the page/network, keyed by op id. */
	inflight: Map<number, InflightOp>;
	opCounter: number;
	/**
	 * Most recent observation this run printed (or was told not to print with
	 * `display:false`). When the cell returns it, the eval echo is suppressed.
	 */
	presented?: object;
}

/** Human-readable label for a screenshot op, used in op tracking + timeout errors. */
export function describeScreenshot(opts?: ScreenshotOptions): string {
	if (opts?.selector) return `tab.screenshot({ selector: ${JSON.stringify(opts.selector)} })`;
	if (opts?.fullPage) return "tab.screenshot({ fullPage: true })";
	return "tab.screenshot()";
}
export async function preparePageForScreenshot(
	page: Pick<Page, "bringToFront" | "evaluate">,
	signal: AbortSignal | undefined,
	activate: boolean,
): Promise<void> {
	if (activate) {
		await untilAborted(signal, () => page.bringToFront()).catch(() => undefined);
		return;
	}
	// CDP captures the selected page without a visibility or foreground precondition.
	// Failure remains a capture failure; it never authorizes an implicit activation.
}

/** Summarize still-running helpers (oldest first) so a cell timeout names what stalled. */
export function describeInflight(inflight: Map<number, InflightOp>): string {
	const now = Date.now();
	return [...inflight.values()]
		.sort((a, b) => a.startedAt - b.startedAt)
		.map(op => `${op.label} (${((now - op.startedAt) / 1000).toFixed(1)}s)`)
		.join(", ");
}

export class WorkerCore {
	#transport: Transport;
	#browser?: Browser;
	#page?: Page;
	#targetId?: string;
	/** Every ref minted on this tab; numbers are never reused, entries outlive their observation. */
	#refs = new Map<number, RefEntry>();
	#refCounter = 0;
	#observationId: string = crypto.randomUUID();
	/** Previous tree of this tab, the baseline a diff observation renders against. */
	#lastTree?: { url: string; filter: { includeAll: boolean; viewportOnly: boolean }; lines: TreeLine[] };
	#managedChrome = false;
	#active: ActiveRun | null = null;
	#runtime: JsRuntime | null = null;
	#unsub: () => void;
	#isolated: boolean;
	#uninstallRejectionGuard: () => void;
	#mode?: WorkerInitPayload["mode"];
	#activateForScreenshot = true;
	#dialogPolicy?: DialogPolicy;
	#dialogHandler?: (dialog: Dialog) => void;
	#openDialog?: OpenDialogInfo;
	#pendingPageCleanup?: Promise<void>;
	#dialogClosed = Promise.withResolvers<void>();
	#downloads?: TabDownloadMonitor;
	#downloadObservationError?: string;

	constructor(transport: Transport, isolated: boolean) {
		this.#transport = transport;
		this.#isolated = isolated;
		this.#unsub = this.#transport.onMessage(msg => {
			void this.#handleMessage(msg as WorkerInbound);
		});
		this.#uninstallRejectionGuard = this.#installRejectionGuard();
	}

	#installRejectionGuard(): () => void {
		if (!this.#isolated) {
			return postmortem.interceptUnhandledRejections(reason => this.#consumeUnhandledRejection(reason));
		}
		return installBrowserWorkerRejectionGuard(reason => this.#consumeUnhandledRejection(reason));
	}

	#consumeUnhandledRejection(reason: unknown): boolean {
		const active = this.#active;
		if (!active) return false;
		if (!isBrowserRunOwnedRejection(reason, active.rejectionOwner, `browser-run-${active.id}.js`)) return false;
		this.#recordFloatingRejection(active, reason);
		return true;
	}

	#recordFloatingRejection(active: ActiveRun, reason: unknown): void {
		if (postmortem.isExpectedCleanupError(reason)) return;
		if (this.#active !== active) {
			this.#log("warn", "Unhandled rejection after browser run ended", {
				runId: active.id,
				error: reason instanceof Error ? reason.message : String(reason),
			});
			return;
		}
		const isFirst = active.floatingRejections.length === 0;
		active.floatingRejections.push(reason);
		if (isFirst) active.floatingFailure.reject(this.#floatingRejectionError(reason));
	}

	#floatingRejectionError(reason: unknown): Error {
		const message = reason instanceof Error ? reason.message : String(reason);
		const error = new Error(`Unhandled rejection (missing await?): ${message}`, { cause: reason });
		if (reason instanceof Error) error.name = reason.name;
		return error;
	}

	#foldFloatingRejections(active: ActiveRun, failure: { error: unknown } | undefined): { error: unknown } | undefined {
		const rejections = active.floatingRejections;
		if (rejections.length === 0) return failure;
		let reported = rejections;
		if (!failure) {
			failure = { error: this.#floatingRejectionError(rejections[0]) };
			reported = rejections.slice(1);
		} else if (failure.error instanceof Error && failure.error.cause === rejections[0]) {
			reported = rejections.slice(1);
		}
		for (const reason of reported) {
			this.#log("warn", "Additional unhandled browser-run rejection", {
				error: reason instanceof Error ? reason.message : String(reason),
			});
		}
		return failure;
	}

	async #handleMessage(msg: WorkerInbound): Promise<void> {
		switch (msg.type) {
			case "init":
				await this.#init(msg.payload);
				return;
			case "run":
				await this.#run(msg);
				return;
			case "abort":
				if (this.#active?.id === msg.id) {
					const reason = msg.expectedCleanup
						? postmortem.markExpectedCleanupError(new ToolAbortError())
						: new ToolAbortError();
					this.#active.ac.abort(reason);
				}
				return;
			case "tool-reply":
				this.#deliverToolReply(msg.id, msg.reply);
				return;
			case "close":
				await this.#close();
				return;
		}
	}

	async #init(payload: WorkerInitPayload): Promise<void> {
		try {
			this.#mode = payload.mode;
			this.#managedChrome = new URL(payload.browserWSEndpoint).searchParams.has("lease");
			this.#activateForScreenshot = payload.mode === "headless" || payload.activateForScreenshot !== false;
			const puppeteer = await loadPuppeteerInWorker(payload.safeDir);
			this.#browser = await puppeteer
				.connect({
					browserWSEndpoint: payload.browserWSEndpoint,
					defaultViewport: null,
					protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
				})
				.catch(error => {
					throw toError(error);
				});

			// Realm setup is done: puppeteer loaded and browser connected. Sent before
			// page acquisition so the supervisor's cold-start budget bounds only the
			// realm setup; page creation and the first navigation run under the ready
			// wait.
			this.#transport.send({ type: "setup" });
			if (payload.mode === "headless") {
				// Create the target directly so its id is reportable before
				// Puppeteer waits for target/page initialization. If that wait
				// wedges, the supervisor can still close the created target.
				this.#page = await createTrackedHeadlessPage(this.#browser, targetId => {
					this.#transport.send({ type: "page-created", targetId });
				});
				this.#observeDialogs();
				await applyStealthPatches(this.#browser, this.#page, { browserSession: null, override: null });
				if (payload.emulateViewport !== false) await applyViewport(this.#page, payload.viewport);
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
			} else {
				const target = await this.#findAttachedTarget(payload.targetId);
				// Post-timeout recycle: unblock the target BEFORE adopting the page — an open
				// modal dialog or hung navigation can stall `target.page()` / ready info, and a
				// stalled init used to time out and force-kill the tab.
				if (payload.recover) await this.#recoverAttachedTarget(target);
				const page = await target.page();
				if (!page) throw new ToolError(`Target ${payload.targetId} is no longer available on the attached browser`);
				this.#page = page;
				this.#observeDialogs();
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
			}
			try {
				this.#downloads = await TabDownloadMonitor.connect(this.#page);
				this.#downloads.session.on("Page.javascriptDialogClosed", () => {
					this.#openDialog = undefined;
					this.#dialogClosed.resolve();
				});
			} catch (error) {
				this.#downloadObservationError = toError(error).message;
			}
			if ((payload.mode === "headless" || payload.emulateFocus) && !this.#managedChrome) {
				// Background Chromium tabs stop producing frames, stalling rAF,
				// IntersectionObserver, and input acknowledgements. Keep owned tabs
				// interactive without raising a window; explicit settle-freeze still
				// applies. A leased tab in the user's Chrome is different: it only
				// emulates focus for the span of an action (`withBackgroundInput`), so
				// the user's own focus is never displaced between actions.
				await this.#page.emulateFocusedPage(true);
			}
			if (payload.url) {
				// Default to "load" because dev servers with HMR/WS never reach networkidle.
				await navigateMainFrame(this.#page, payload.url, {
					label: `navigate to ${JSON.stringify(payload.url)}`,
					timeoutMs: payload.timeoutMs,
					waitUntil: payload.waitUntil,
					stopLoading: () => this.#stopLoading(),
				});
			}
			this.#targetId = await targetIdForPage(this.#page);
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			// A failed headless init leaves the worker's page orphaned in the shared
			// browser (the supervisor retries with a fresh worker), so close it before
			// reporting. Attach mode adopts an existing target — never close it.
			const page = this.#page;
			if (payload.mode === "headless" && page && !page.isClosed()) {
				await page.close().catch(() => undefined);
			}
			this.#transport.send({ type: "init-failed", error: errorPayload(error) });
		}
	}

	async #findAttachedTarget(targetId: string): Promise<Target> {
		if (!this.#browser) throw new ToolError("Browser is not connected");
		for (const target of this.#browser.targets()) {
			if ((await targetIdForTarget(target).catch(() => "")) !== targetId) continue;
			return target;
		}
		throw new ToolError(`Target ${targetId} is no longer available on the attached browser`);
	}

	/**
	 * Clear abandoned request interception on the exact target. A dialog decision
	 * or navigation cancellation must never be an implicit side effect of recycling.
	 */
	async #recoverAttachedTarget(target: Target): Promise<void> {
		let session: CDPSession | undefined;
		try {
			session = await target.createCDPSession();
			// Recovery never answers a user dialog or cancels page navigation.
			await session.send("Fetch.disable").catch(() => undefined);
		} catch (error) {
			this.#log("debug", "Recovery CDP session failed; proceeding with attach", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			await session?.detach().catch(() => undefined);
		}
	}

	/**
	 * Record JS dialogs for timeout attribution without handling them (semantics of an
	 * unset `dialogs` policy are unchanged — the page stays blocked until user code or
	 * the policy handler acts). Cleared when the policy handler settles the dialog or a
	 * main-frame navigation proves the modal is gone.
	 */
	#observeDialogs(): void {
		const page = this.#requirePage();
		page.on("dialog", dialog => {
			const opened = { type: dialog.type(), message: dialog.message() };
			this.#openDialog = opened;
			this.#dialogClosed = Promise.withResolvers<void>();
			if (this.#managedChrome) {
				const timer = setTimeout(() => {
					if (this.#openDialog === opened) this.#active?.floatingFailure.reject(this.#dialogPendingError());
				}, 250);
				timer.unref();
			}
		});
		page.on("framenavigated", frame => {
			if (frame === page.mainFrame()) {
				this.#openDialog = undefined;
				this.#invalidateRefs();
			}
		});
	}

	#dialogPendingError(): ToolError {
		const dialog = this.#openDialog;
		return new ToolError(
			`A JavaScript ${dialog?.type ?? "dialog"} awaits a decision: ${JSON.stringify((dialog?.message ?? "").slice(0, 2000))}. The triggering action may have taken effect and its page handler can continue after the dialog is answered. Use await tab.dialog() to inspect the exact current dialog, then tab.dialog({action:"accept"|"dismiss",id,...}) to answer it. Inspect page state before repeating the triggering action. Input cleanup may remain pending until the dialog is resolved.`,
		);
	}

	async #currentReadyInfo(): Promise<ReadyInfo> {
		const page = this.#requirePage();
		const targetId = this.#targetId ?? (await targetIdForPage(page));
		this.#targetId = targetId;
		return {
			url: redactUrlCredentials(page.url()),
			title: await page.title().catch(() => undefined),
			viewport: (await readPageMetrics(page)).viewport,
			targetId,
		};
	}

	#applyDialogPolicy(policy: DialogPolicy): void {
		const page = this.#requirePage();
		if (this.#dialogPolicy === policy && this.#dialogHandler) return;
		if (this.#dialogHandler) page.off("dialog", this.#dialogHandler);
		const handler = (dialog: Dialog): void => {
			const action = policy === "accept" ? dialog.accept() : dialog.dismiss();
			void action.then(
				() => {
					this.#openDialog = undefined;
				},
				err =>
					this.#log("debug", "Dialog auto-handler failed", {
						policy,
						error: err instanceof Error ? err.message : String(err),
					}),
			);
		};
		page.on("dialog", handler);
		this.#dialogPolicy = policy;
		this.#dialogHandler = handler;
	}

	async #postReadyInfo(): Promise<void> {
		try {
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			this.#log("debug", "Failed to refresh tab info", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #run(msg: Extract<WorkerInbound, { type: "run" }>): Promise<void> {
		if (this.#active) {
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: false,
				error: errorPayload(new ToolError("Tab worker is busy")),
			});
			return;
		}
		const timeoutSignal = AbortSignal.timeout(msg.timeoutMs);
		const ac = new AbortController();
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, ac.signal, runAc.signal]);
		const output = new RunOutput();
		const screenshots: ScreenshotResult[] = [];
		/** A completed run whose tab state could not be restored; the result still stands. */
		let recoverTab: unknown;
		const floatingFailure = Promise.withResolvers<never>();
		const active: ActiveRun = {
			id: msg.id,
			ac,
			signal,
			output,
			screenshots,
			pendingTools: new Map(),
			rejectionOwner: {},
			floatingRejections: [],
			floatingFailure,
			inflight: new Map(),
			opCounter: 0,
		};
		this.#active = active;
		let completed = false;
		let returnValue: unknown;
		let failure: { error: unknown } | undefined;
		let runPage: RunPageScope | undefined;
		let backgroundPage: BackgroundPageScope | undefined;
		try {
			throwIfAborted(signal);
			if (this.#managedChrome && this.#openDialog) throw this.#dialogPendingError();
			if (this.#pendingPageCleanup) {
				await untilAborted(signal, () => this.#pendingPageCleanup!);
				this.#pendingPageCleanup = undefined;
			}
			if (this.#managedChrome) {
				backgroundPage = prepareBackgroundPage(this.#requirePage(), signal);
				await backgroundPage.ready;
			}
			runPage = createRunPageScope(this.#requirePage());
			const browser = this.#requireBrowser();
			const tabApi = this.#createTabApi(msg.name, msg.timeoutMs, signal, msg.session, output, screenshots, active);
			const runtime = this.#ensureRuntime(msg.session);
			runtime.setCwd(msg.session.cwd);
			const onFloatingRejection = (reason: unknown): void => this.#recordFloatingRejection(active, reason);
			runtime.setRunScope({
				page: bindRunFacade(runPage.page, signal, active.rejectionOwner, onFloatingRejection),
				browser: bindRunFacade(browser, signal, active.rejectionOwner, onFloatingRejection),
				tab: bindRunFacade(tabApi, signal, active.rejectionOwner, onFloatingRejection),
				assert: (cond: unknown, text?: string): void => {
					if (!cond) throw new ToolError(text ?? "Assertion failed");
				},
				// Both wait forms register in the in-flight map so a cell that dies while
				// sleeping/polling names the culprit instead of a bare whole-cell timeout.
				wait: (msOrPredicate: number | (() => unknown), opts?: WaitPredicateOptions): Promise<unknown> => {
					const label = typeof msOrPredicate === "number" ? `wait(${msOrPredicate}ms)` : "wait(predicate)";
					const resolved =
						typeof msOrPredicate === "number"
							? undefined
							: { timeout: resolvePredicateTimeout(msg.timeoutMs, opts?.timeout), interval: opts?.interval };
					return observeBrowserRunPromise(
						this.#runOp(active, label, signal, Number.POSITIVE_INFINITY, sig =>
							waitForRun(msOrPredicate, sig, resolved),
						),
						active.rejectionOwner,
						onFloatingRejection,
					);
				},
			});
			const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers<never>();
			const onCancel = (): void => {
				const abortError =
					signal.reason instanceof ToolAbortError
						? signal.reason
						: new ToolAbortError(undefined, { cause: signal.reason });
				if (timeoutSignal.aborted) {
					const stalled = describeInflight(active.inflight);
					const dialog = this.#openDialog;
					const dialogNote = dialog
						? `; a ${dialog.type}(${JSON.stringify(dialog.message.slice(0, 80))}) dialog opened during this run and may still block the page — reopen the tab with dialogs:"accept"|"dismiss" or handle page.on('dialog')`
						: "";
					rejectCancel(
						new ToolError(
							`Browser code execution timed out after ${msg.timeoutMs}ms${stalled ? ` (stalled on ${stalled})` : ""}${dialogNote}`,
						),
					);
				} else {
					rejectCancel(abortError);
				}
				// Cancel in-flight tool calls so user code's awaited proxies reject promptly.
				const toolAbort = timeoutSignal.aborted
					? postmortem.markExpectedCleanupError(new ToolAbortError(undefined, { cause: timeoutSignal.reason }))
					: abortError;
				for (const pending of active.pendingTools.values()) {
					pending.reject(toolAbort);
				}
				active.pendingTools.clear();
			};
			if (signal.aborted) onCancel();
			else signal.addEventListener("abort", onCancel, { once: true });
			try {
				const hooks = this.#hooksForActiveRun();
				if (!hooks) throw new ToolError("Browser runtime started without an active run");
				returnValue = await withBrowserPromiseCombinatorTracking(
					active.rejectionOwner,
					onFloatingRejection,
					async () =>
						await Promise.race([
							runtime.run(msg.code, `browser-run-${msg.id}.js`, hooks, {
								runId: msg.id,
								cwd: msg.session.cwd,
							}),
							cancelRejection,
							floatingFailure.promise,
						]),
				);
				completed = true;
			} finally {
				signal.removeEventListener("abort", onCancel);
			}
		} catch (error) {
			failure = { error };
		} finally {
			runAc.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Browser run ended")));
			await Bun.sleep(0);
			const blockedByDialog = this.#managedChrome && !!this.#openDialog;
			if (blockedByDialog && !failure) failure = { error: this.#dialogPendingError() };
			const cleanup = async (): Promise<void> => {
				if (!runPage && !backgroundPage) return;
				// Remove call-owned listeners immediately. Input retains its slot until
				// the browser acknowledges it; a modal may defer that until a decision.
				const resume = (async () => {
					while (this.#managedChrome && this.#openDialog) await this.#dialogClosed.promise;
				})();
				await Promise.all([runPage?.cleanup(resume), resume.then(() => backgroundPage?.close())]);
			};
			if (blockedByDialog && (runPage || backgroundPage)) {
				this.#pendingPageCleanup = cleanup();
				void this.#pendingPageCleanup.catch(() => undefined);
			} else {
				try {
					await cleanup();
				} catch (error) {
					// Work the cell already finished is never retracted over tab
					// bookkeeping: the result stands and the supervisor recycles the
					// tab whose browser state could not be restored.
					if (completed) recoverTab = error;
					else failure = { error };
				}
			}
			failure = this.#foldFloatingRejections(active, failure);
			if (this.#active?.id === msg.id) this.#active = null;
		}
		if (failure) {
			this.#transport.send({ type: "result", id: msg.id, ok: false, error: errorPayload(failure.error) });
			return;
		}
		if (completed) {
			if (recoverTab)
				this.#log("warn", "Browser tab state could not be restored after a completed run; recycling the tab", {
					error: recoverTab instanceof Error ? recoverTab.message : String(recoverTab),
				});
			await this.#postReadyInfo();
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: true,
				payload: {
					displays: output.finish(),
					returnValue: cloneSafe(returnValue),
					screenshots,
					...(returnValue !== undefined && returnValue === active.presented ? { rendered: true } : {}),
					...(recoverTab ? { recoverTab: true } : {}),
				},
			});
		}
	}

	#ensureRuntime(session: SessionSnapshot): JsRuntime {
		if (this.#runtime) return this.#runtime;
		this.#runtime = new JsRuntime({
			initialCwd: session.cwd,
			sessionId: `browser-tab-${this.#targetId ?? "unknown"}`,
		});
		return this.#runtime;
	}

	#hooksForActiveRun(): RuntimeHooks | null {
		const active = this.#active;
		if (!active) return null;
		return {
			onText: chunk => {
				throwIfAborted(active.signal);
				active.output.pushText(chunk);
				this.#log("debug", chunk.replace(/\n$/, ""));
			},
			onDisplay: output => {
				throwIfAborted(active.signal);
				active.output.pushDisplay(output);
			},
			callTool: (name, args) => {
				throwIfAborted(active.signal);
				return this.#callTool(active, name, args);
			},
		};
	}

	async #callTool(active: ActiveRun, name: string, args: unknown): Promise<unknown> {
		const id = `tab-tc-${active.id}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { resolve, reject });
		this.#transport.send({ type: "tool-call", id, runId: active.id, name, args });
		return await promise;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		const active = this.#active;
		if (!active) return;
		const pending = active.pendingTools.get(id);
		if (!pending) return;
		active.pendingTools.delete(id);
		if (reply.ok) pending.resolve(reply.value);
		else pending.reject(replyError(reply.error));
	}

	/**
	 * Wrap a tab helper so it (a) registers in the active run's in-flight map for
	 * timeout diagnostics and (b) honors an optional per-op deadline that fails fast
	 * with a named error instead of silently consuming the whole cell budget. Pass
	 * `Number.POSITIVE_INFINITY` for `perOpTimeoutMs` to bound the op only by the cell
	 * budget (used for `evaluate` running user code and for locator helpers that already
	 * carry puppeteer's own `.setTimeout(timeoutMs)`). When the op targets a `selector`,
	 * the fail-fast timeout carries a best-effort match-count hint, and — when
	 * `zeroMatchAfterMs` is set — a watchdog aborts the op early once the selector has
	 * matched nothing for that long.
	 */
	async #runOp<T>(
		active: ActiveRun,
		label: string,
		cellSignal: AbortSignal,
		perOpTimeoutMs: number,
		fn: (signal: AbortSignal) => Promise<T>,
		opts?: { selector?: string; zeroMatchAfterMs?: number },
	): Promise<T> {
		const opId = active.opCounter++;
		active.inflight.set(opId, { label, startedAt: Date.now() });
		const capped = Number.isFinite(perOpTimeoutMs) && perOpTimeoutMs > 0;
		const opTimeout = capped ? AbortSignal.timeout(perOpTimeoutMs) : undefined;
		const opSignal = opTimeout ? AbortSignal.any([cellSignal, opTimeout]) : cellSignal;
		const selector = opts?.selector;
		const watchdog =
			selector !== undefined && opts?.zeroMatchAfterMs !== undefined && parseAriaRefSelector(selector) === null
				? { selector, afterMs: opts.zeroMatchAfterMs }
				: undefined;
		// Fired when the watchdog wins the race (tears down the in-flight action) and in
		// the finally (stops the watchdog's polling once the op settles either way).
		const earlyAc = new AbortController();
		try {
			if (!watchdog) return await fn(opSignal);
			const racedSignal = AbortSignal.any([opSignal, earlyAc.signal]);
			return await Promise.race([
				fn(racedSignal),
				this.#zeroMatchWatchdog(watchdog.selector, label, watchdog.afterMs, racedSignal),
			]);
		} catch (err) {
			// Fail fast with a named, attributable error instead of the opaque whole-cell timeout:
			// our per-op deadline fired, or puppeteer's own (equal) timeout fired first — having
			// already torn down the CDP action via the op signal, so no work is left dangling.
			// Cell-budget aborts and uncapped helpers (goto/evaluate) keep their native errors.
			if (
				capped &&
				!cellSignal.aborted &&
				(opTimeout?.aborted || (err instanceof Error && err.name === "TimeoutError"))
			) {
				const hint = selector ? await this.#selectorTimeoutHint(selector) : "";
				throw markBrowserRunRejection(
					new ToolError(`${label} timed out after ${perOpTimeoutMs}ms${hint}`),
					active.rejectionOwner,
				);
			}
			throw markBrowserRunRejection(err, active.rejectionOwner);
		} finally {
			earlyAc.abort();
			active.inflight.delete(opId);
		}
	}

	/**
	 * Fail-fast arm raced against a selector op: rejects once the selector has matched
	 * nothing for the whole `afterMs` window, so a wrong selector or wrong page (consent
	 * wall, pre-navigation document) costs ~2s instead of the full action deadline.
	 * Disarms — hangs until the settled race drops it — the moment at least one element
	 * matches; an inconclusive probe (mid-navigation, detached frame) never counts
	 * toward the zero-match window.
	 */
	async #zeroMatchWatchdog(selector: string, label: string, afterMs: number, signal: AbortSignal): Promise<never> {
		const page = this.#requirePage();
		const resolved = normalizeSelector(selector);
		const deadline = Date.now() + afterMs;
		while (!signal.aborted) {
			let count: number | null = null;
			try {
				count = (await resolveSelector(page, resolved, signal)).length;
			} catch {
				// Inconclusive probe — keep polling without advancing toward failure.
			}
			if (count !== null && count > 0) break;
			if (count === 0 && Date.now() >= deadline) {
				throw new ToolError(`${label} failed fast after ${afterMs}ms${formatSelectorMatchHint(0)}`);
			}
			try {
				await untilAborted(signal, () => Bun.sleep(ZERO_MATCH_POLL_MS));
			} catch {
				break;
			}
		}
		return await new Promise<never>(() => {});
	}

	/**
	 * Best-effort match-count probe for a timed-out selector op. Never throws;
	 * empty string when the probe fails, stalls, or the selector is an aria-ref.
	 */
	async #selectorTimeoutHint(selector: string): Promise<string> {
		if (parseAriaRefSelector(selector) !== null) return "";
		try {
			const matches = await Promise.race([
				resolveSelector(this.#requirePage(), normalizeSelector(selector)),
				Bun.sleep(1_000).then(() => null),
			]);
			return matches ? formatSelectorMatchHint(matches.length) : "";
		} catch {
			return "";
		}
	}

	#createTabApi(
		name: string,
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
		output: RunOutput,
		screenshots: ScreenshotResult[],
		active: ActiveRun,
	): TabApi {
		const page = this.#requirePage();
		const { budgetBound, quickOpMs, actionOpMs } = resolveOpTimeouts(timeoutMs);
		const waitMs = (explicit?: number): number => resolveWaitTimeout(timeoutMs, explicit);
		const INF = Number.POSITIVE_INFINITY;
		const op = <T>(
			label: string,
			perOpMs: number,
			fn: (sig: AbortSignal) => Promise<T>,
			selectorOpts?: { selector?: string; zeroMatchAfterMs?: number },
		): Promise<T> => markHandled(this.#runOp(active, label, signal, perOpMs, fn, selectorOpts));
		// Element methods run through the same fail-fast per-op wrapper as the
		// selector helpers, so `(await tab.ref("e12")).click()` can't outrun the
		// cell budget (issue #9535).
		const element = (node: CdpNode): TabElement =>
			this.#createElement(node, session.cwd, (label, fn) => op(label, actionOpMs, fn));
		// Managed Chrome drives a tab the user is not looking at: pointer and
		// keyboard input need page focus emulation held around the dispatch.
		const input = <T>(sig: AbortSignal, action: () => Promise<T>): Promise<T> =>
			this.#managedChrome ? withBackgroundInput(page, sig, action) : action();
		return {
			name,
			page,
			signal,
			url: () => page.url(),
			title: () => op("tab.title()", INF, async sig => (await currentEntry(page.mainFrame().client, sig)).title),
			goto: (url, opts) =>
				op(`tab.goto(${JSON.stringify(url)})`, INF, async sig => {
					this.#invalidateRefs();
					// Default to "load" because dev servers with HMR/WS never reach networkidle.
					// budgetBound (not the full cell) so a hung navigation fails named and
					// catchable inside the run instead of dying with the whole cell. A timeout
					// abandons the pending load NOW: it would stall every later op on this page.
					await navigateMainFrame(page, url, {
						label: `tab.goto(${JSON.stringify(url)})`,
						timeoutMs: budgetBound,
						waitUntil: opts?.waitUntil,
						signal: sig,
						stopLoading: () => this.#stopLoading(),
					});
				}),
			observe: opts =>
				op("tab.observe()", quickOpMs, async sig => {
					const observation = await this.#collectObservation({ ...opts, refs: session.refs, signal: sig });
					if (opts?.display !== false) output.push({ type: "text", text: observation.tree });
					active.presented = observation;
					return observation;
				}),
			ariaSnapshot: (selector, opts) =>
				op(
					selector ? `tab.ariaSnapshot(${JSON.stringify(selector)})` : "tab.ariaSnapshot()",
					quickOpMs,
					async sig => {
						const snapshot = selector
							? await callOnNode(
									await this.#selectorNode(selector, quickOpMs, "present", sig),
									buildAriaSnapshotFunction(opts),
									[],
									sig,
								)
							: await evaluateExpression(page.mainFrame().client, buildAriaSnapshotScript(undefined, opts), sig);
						const text = String(snapshot);
						return this.#managedChrome ? text.replace(/ \[ref=e\d+\]/g, "") : text;
					},
				),
			screenshot: opts =>
				op(describeScreenshot(opts), quickOpMs, sig =>
					this.#captureScreenshot(session, output, screenshots, sig, opts),
				),
			extract: (format = "text") =>
				op(`tab.extract(${JSON.stringify(format)})`, quickOpMs, async sig => {
					if (format !== "text" && format !== "markdown")
						throw new ToolError(
							`tab.extract(format) takes "text" or "markdown" (positional string, default "text"); received ${JSON.stringify(format)}`,
						);
					const html = (await untilAborted(sig, () => page.content())) as string;
					const result = await extractReadableFromHtml(html, page.url(), format);
					if (!result) {
						throw new ToolError(
							`tab.extract(${JSON.stringify(format)}) found no readable content on ${page.url()}`,
						);
					}
					const content = format === "markdown" ? result.markdown : result.text;
					if (!content) {
						throw new ToolError(
							`tab.extract(${JSON.stringify(format)}) produced empty ${format} content for ${page.url()}`,
						);
					}
					return content;
				}),
			click: selector =>
				op(
					`tab.click(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const node = await this.#selectorNode(selector, actionOpMs, "visible", sig);
						await input(sig, () => clickNode(node, 1, sig));
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			type: (selector, text) =>
				op(
					`tab.type(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const node = await this.#selectorNode(selector, actionOpMs, "present", sig);
						await input(sig, () => typeIntoNode(node, text, sig));
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			fill: (selector, value) =>
				op(
					`tab.fill(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const node = await this.#selectorNode(selector, actionOpMs, "present", sig);
						await input(sig, () => fillNode(node, value, sig));
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			press: (key, opts) =>
				op(`tab.press(${JSON.stringify(key)})`, actionOpMs, async sig => {
					const selector = opts?.selector;
					const node = selector ? await this.#selectorNode(selector, actionOpMs, "present", sig) : undefined;
					await input(sig, async () => {
						if (node) await focusNode(node, sig);
						throwIfAborted(sig);
						await pressChord(page.mainFrame().client, key, sig);
					});
				}),
			scroll: (deltaXOrDirection, deltaYOrOptions) =>
				op("tab.scroll()", actionOpMs, async sig => {
					const deltas = await resolveScrollDeltas(page, deltaXOrDirection, deltaYOrOptions, sig);
					await untilAborted(sig, () => dispatchScroll(() => page.mouse.wheel(deltas)));
				}),
			drag: (from, to) => op("tab.drag()", actionOpMs, sig => this.#drag(from, to, sig)),
			waitFor: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.waitFor(${JSON.stringify(selector)})`,
					w,
					async sig => element(await this.#selectorNode(selector, w, "present", sig)),
					{ selector, zeroMatchAfterMs: opts?.timeout === undefined ? ZERO_MATCH_FAIL_FAST_MS : undefined },
				);
			},
			waitForSelector: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.waitForSelector(${JSON.stringify(selector)})`,
					w,
					async sig => {
						if (parseAriaRefSelector(selector) !== null) return element(await this.#ariaRefNode(selector, sig));
						const state = opts?.hidden ? "hidden" : opts?.visible ? "visible" : "present";
						const node = await awaitSelector(page, normalizeSelector(selector), { timeoutMs: w, state }, sig);
						return node ? element(node) : null;
					},
					{
						selector,
						// `hidden: true` waits for zero matches — that is success, never a fast-fail.
						zeroMatchAfterMs: opts?.timeout === undefined && !opts?.hidden ? ZERO_MATCH_FAIL_FAST_MS : undefined,
					},
				);
			},
			waitForNavigation: opts => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForNavigation()", w, sig =>
					untilAborted(sig, () =>
						page.waitForNavigation({ waitUntil: opts?.waitUntil ?? "load", timeout: w, signal: sig }),
					),
				);
			},
			evaluate: (fn, ...args) =>
				op("tab.evaluate()", INF, sig =>
					evaluateExpression(
						page.mainFrame().client,
						typeof fn === "string" ? fn : callExpression(String(fn), args),
						sig,
					),
				) as never,
			scrollIntoView: selector =>
				op(
					`tab.scrollIntoView(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => await scrollIntoView(await this.#selectorNode(selector, actionOpMs, "present", sig), sig),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			select: (selector, ...values) =>
				op(
					`tab.select(${JSON.stringify(selector)})`,
					actionOpMs,
					sig => this.#select(selector, values, actionOpMs, sig),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			uploadFile: (selector, ...filePaths) =>
				op(
					`tab.uploadFile(${JSON.stringify(selector)})`,
					actionOpMs,
					sig => this.#uploadFile(selector, filePaths, actionOpMs, sig, session),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			waitForUrl: (pattern, opts) => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForUrl()", w, sig => this.#waitForUrl(pattern, w, sig));
			},
			downloads: () =>
				op("tab.downloads()", quickOpMs, () => {
					if (!this.#downloads)
						throw new ToolError(
							`Download observation unavailable: ${this.#downloadObservationError ?? "not initialized"}`,
						);
					return Promise.resolve(this.#downloads.snapshot());
				}),
			waitForResponse: (pattern, opts) => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForResponse()", w, sig => this.#waitForResponse(pattern, w, sig));
			},
			id: async id => {
				if (this.#managedChrome)
					throw new ToolError(
						"Use tab.ref(observation.elements[i].ref) so the action retains its observation identity",
					);
				return element(this.#refNode(id));
			},
			ref: async id => {
				const elementId = parseRefToken(id, this.#observationId);
				if (elementId !== null) return element(this.#refNode(elementId));
				if (id.includes(":"))
					throw new ToolError("The element reference belongs to an old observation. Observe the tab again.");
				return element(await this.#ariaRefNode(id));
			},
		};
	}

	/**
	 * Settle the page, then snapshot it — restarting whenever the main frame
	 * navigates mid-collection. `observe()` promises the settled tree of the
	 * document the caller ends up on, and "click, then observe" in one cell is
	 * the ordinary way to use it, so a navigation is a reason to look again, not
	 * a failure. Every attempt shares the one settle budget; only exhausting it
	 * fails, and it never grows.
	 */
	async #settledSnapshot(
		page: Page,
		includeAll: boolean,
		deadline: number,
		signal?: AbortSignal,
	): Promise<{ snapshot: AxNode; layout: PageLayout; url: string; title: string }> {
		for (;;) {
			const observationId = this.#observationId;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new ToolError("The page changed while observing it. Observe again.");
			const attempt = await this.#snapshotOnce(page, includeAll, remaining, deadline, signal).catch(error => {
				// The document answering our calls went away: the only cause is a
				// navigation, which the next attempt collects instead.
				if (isDocumentGoneError(error) || observationId !== this.#observationId) return null;
				throw error;
			});
			if (attempt && observationId === this.#observationId) return attempt;
		}
	}

	async #snapshotOnce(
		page: Page,
		includeAll: boolean,
		budgetMs: number,
		deadline: number,
		signal?: AbortSignal,
	): Promise<{ snapshot: AxNode; layout: PageLayout; url: string; title: string }> {
		const session = page.mainFrame().client;
		await settlePage(page, signal, budgetMs);
		let snapshot = await snapshotAccessibility(page, { includeAll }, signal);
		while (hasBusyIndicator(snapshot)) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await untilAborted(signal, () => Bun.sleep(Math.min(SETTLE_BUSY_POLL_MS, remaining)));
			snapshot = await snapshotAccessibility(page, { includeAll }, signal);
		}
		const [layout, entry] = await Promise.all([pageLayout(session, signal), currentEntry(session, signal)]);
		return { snapshot, layout, url: entry.url, title: entry.title };
	}

	/**
	 * Drop every node whose box does not reach the viewport. One box model per
	 * candidate, in bounded batches so a long page cannot flood the connection.
	 */
	async #filterToViewport(
		page: Page,
		nodes: readonly ObservedNode[],
		layout: PageLayout,
		signal?: AbortSignal,
	): Promise<ObservedNode[]> {
		const offsets = new Map<CDPSession, Point>();
		const kept: ObservedNode[] = [];
		const candidates = nodes.filter(node => node.actionable && node.ax?.frame);
		for (let start = 0; start < candidates.length; start += VIEWPORT_PROBE_BATCH) {
			const batch = candidates.slice(start, start + VIEWPORT_PROBE_BATCH);
			const boxes = await Promise.all(
				batch.map(async node => {
					const frame = node.ax!.frame!;
					let offset = offsets.get(frame.session);
					if (!offset) {
						offset = await sessionOffset(page, frame.session, signal);
						offsets.set(frame.session, offset);
					}
					return await boundingBox(
						{ session: frame.session, backendNodeId: node.ax!.backendNodeId!, label: node.role },
						offset,
						signal,
					);
				}),
			);
			batch.forEach((node, index) => {
				const box = boxes[index];
				if (!box) return;
				const visible =
					box.x + box.width > 0 &&
					box.y + box.height > 0 &&
					box.x < layout.viewport.width &&
					box.y < layout.viewport.height;
				if (visible) kept.push(node);
			});
		}
		const inViewport = new Set(kept);
		return nodes.filter(node => !candidates.includes(node) || inViewport.has(node));
	}

	async #collectObservation(
		options: ObserveOptions & { refs?: RefStyle; signal?: AbortSignal },
	): Promise<Observation> {
		const page = this.#requirePage();
		const { signal } = options;
		const refStyle = options.refs ?? "uuid";
		const includeAll = options.includeAll ?? false;
		const viewportOnly = options.viewportOnly ?? false;
		this.#invalidateRefs();
		const deadline = Date.now() + SETTLE_BUDGET_MS;
		const { snapshot, layout, url, title } = await this.#settledSnapshot(page, includeAll, deadline, signal);
		const observationId = this.#observationId;

		let nodes = flattenSnapshot(snapshot, { includeAll });
		if (viewportOnly) nodes = await this.#filterToViewport(page, nodes, layout, signal);

		const actionable = nodes.filter(node => node.actionable && node.ax?.frame);
		const refs = matchRefs(
			actionable.map(node => ({ role: node.role, name: node.name, nodeKey: axNodeKey(node.ax!) })),
			this.#refs,
			() => ++this.#refCounter,
		);
		const positions = roleNamePositions(actionable);
		const refByNode = new Map<ObservedNode, number>();
		actionable.forEach((node, index) => {
			const ref = refs[index];
			const ax = node.ax!;
			refByNode.set(node, ref);
			this.#refs.set(ref, {
				role: node.role,
				name: node.name,
				position: positions[index],
				nodeKey: axNodeKey(ax),
				session: ax.frame!.session,
				backendNodeId: ax.backendNodeId!,
			});
		});
		const lines = buildTreeLines(
			nodes,
			nodes.map(node => refByNode.get(node)),
		);

		const viewport = { ...layout.viewport, deviceScaleFactor: page.viewport()?.deviceScaleFactor };
		const scroll = {
			x: layout.scroll.x,
			y: layout.scroll.y,
			width: layout.viewport.width,
			height: layout.viewport.height,
			scrollWidth: layout.scroll.scrollWidth,
			scrollHeight: layout.scroll.scrollHeight,
		};
		const focusedNode = actionable.find(node => node.ax!.focused === true);
		const focused = focusedNode ? `e${refByNode.get(focusedNode)}` : undefined;
		const header: TreeHeader = { url, title, scroll: { y: scroll.y, scrollHeight: scroll.scrollHeight }, focused };
		const previous = this.#lastTree;
		const filter = { includeAll, viewportOnly };
		// Diff only against the same document observed with the same filter;
		// anything else needs the full tree to be readable.
		const baseline =
			options.diff !== false &&
			previous &&
			sameDocument(previous.url, url) &&
			previous.filter.includeAll === includeAll &&
			previous.filter.viewportOnly === viewportOnly
				? previous
				: undefined;
		const tree = baseline ? renderTreeDiff(header, baseline.lines, lines) : renderTree(header, lines);
		// A diff is only readable against a tree the reader has seen. An
		// observation taken with `display:false` was never printed, so it cannot
		// become the baseline the next printed diff is measured from.
		if (options.display !== false) this.#lastTree = { url, filter, lines };
		return {
			snapshot: observationId,
			url,
			title,
			viewport,
			scroll,
			focused,
			tree,
			elements: actionable.map((node, index) => ({
				id: refs[index],
				ref: refStyle === "compact" ? `e${refs[index]}` : `${observationId}:${refs[index]}`,
				role: node.role,
				name: node.name || undefined,
				value: node.value,
				description: node.description,
				keyshortcuts: node.keyshortcuts,
				states: node.states,
			})),
		};
	}

	async #captureScreenshot(
		session: SessionSnapshot,
		output: RunOutput,
		screenshots: ScreenshotResult[],
		signal: AbortSignal | undefined,
		opts: ScreenshotOptions = {},
	): Promise<string> {
		const page = this.#requirePage();
		// Managed Chrome clears activation even for an explicitly selected inactive tab.
		await preparePageForScreenshot(page, signal, this.#activateForScreenshot);
		const fullPage = opts.selector ? false : (opts.fullPage ?? false);
		const captureType = "png";
		const captureMime = "image/png" as const;
		let buffer: Buffer;
		if (opts.selector) {
			const node = await this.#selectorNode(opts.selector, QUICK_OP_TIMEOUT_MS, "present", signal);
			// Best-effort: a clipped capture of an off-screen element still renders.
			await scrollIntoView(node, signal).catch(() => undefined);
			const box = await boundingBox(node, await sessionOffset(page, node.session, signal), signal);
			if (!box) throw new ToolError(`Screenshot selector ${JSON.stringify(opts.selector)} has no visible box`);
			const shot = await untilAborted(signal, () =>
				page.mainFrame().client.send("Page.captureScreenshot", {
					format: captureType,
					clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
					captureBeyondViewport: true,
				}),
			);
			buffer = Buffer.from(shot.data, "base64");
		} else {
			buffer = (await untilAborted(signal, () => page.screenshot({ type: captureType, fullPage }))) as Buffer;
		}
		const resized = await resizeImage(
			{ type: "image", data: buffer.toBase64(), mimeType: captureMime },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70, excludeWebP: session.excludeWebP },
		);
		const saveFullRes = !!session.browserScreenshotDir;
		const savedBuffer = saveFullRes ? buffer : resized.buffer;
		const savedMimeType = saveFullRes ? captureMime : resized.mimeType;
		const ext = savedMimeType === "image/webp" ? "webp" : savedMimeType === "image/jpeg" ? "jpg" : "png";
		const dest = session.browserScreenshotDir
			? path.join(
					session.browserScreenshotDir,
					`screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`,
				)
			: path.join(os.tmpdir(), `omp-sshots-${Snowflake.next()}.${ext}`);
		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		await Bun.write(dest, savedBuffer);
		const info: ScreenshotResult = {
			dest,
			mimeType: savedMimeType,
			bytes: savedBuffer.length,
			width: resized.width,
			height: resized.height,
		};
		screenshots.push(info);
		if (!opts.silent) {
			const lines = formatScreenshot({
				saveFullRes,
				savedMimeType,
				savedByteLength: savedBuffer.length,
				dest,
				resized,
			});
			output.push({ type: "text", text: lines.join("\n") });
			info.imageIndex = output.imageCount;
			output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		}
		return dest;
	}

	async #drag(from: DragTarget, to: DragTarget, signal: AbortSignal): Promise<void> {
		const page = this.#requirePage();
		const resolveDragPoint = async (target: DragTarget, role: "from" | "to"): Promise<Point> => {
			if (typeof target === "string") {
				const node = await this.#selectorNode(target, ACTION_OP_TIMEOUT_MS, "present", signal);
				const box = await boundingBox(node, await sessionOffset(page, node.session, signal), signal);
				if (!box) throw new ToolError(`Drag ${role} element has no bounding box (likely not visible): ${target}`);
				return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
			}
			if (
				target !== null &&
				typeof target === "object" &&
				typeof target.x === "number" &&
				typeof target.y === "number"
			) {
				return { x: target.x, y: target.y };
			}
			throw new ToolError(
				`Drag ${role} must be a selector string or { x: number, y: number } point. Got: ${typeof target}`,
			);
		};
		const start = await resolveDragPoint(from, "from");
		const end = await resolveDragPoint(to, "to");
		await untilAborted(signal, () => page.mouse.move(start.x, start.y));
		await untilAborted(signal, () => page.mouse.down());
		await untilAborted(signal, () => page.mouse.move(end.x, end.y, { steps: 12 }));
		await untilAborted(signal, () => page.mouse.up());
	}

	async #select(
		selector: string,
		values: readonly BrowserSelectOption[],
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<string[]> {
		const node = await this.#selectorNode(selector, timeoutMs, "present", signal);
		return await selectOptions(node, values, signal);
	}

	async #uploadFile(
		selector: string,
		filePaths: string[],
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
	): Promise<void> {
		if (!filePaths.length) throw new ToolError("tab.uploadFile() requires at least one file path");
		const node = await this.#selectorNode(selector, timeoutMs, "present", signal);
		await setFileInput(
			node,
			filePaths.map(filePath => resolveToCwd(filePath, session.cwd)),
			signal,
		);
	}

	/**
	 * Wait for the address bar, not for the page: the frame url puppeteer keeps
	 * is event-driven, so this survives the navigations it exists to watch. A
	 * page-side wait task would not — an isolated-world one never re-runs after
	 * a document swap, and this helper is used across exactly that.
	 */
	async #waitForUrl(pattern: string | RegExp, timeout: number, signal: AbortSignal): Promise<string> {
		const page = this.#requirePage();
		const matches = (url: string) => (pattern instanceof RegExp ? pattern.test(url) : url.includes(pattern));
		const deadline = Date.now() + timeout;
		for (;;) {
			const url = page.url();
			if (matches(url)) return url;
			if (Date.now() >= deadline)
				throw new ToolError(
					`tab.waitForUrl(${JSON.stringify(String(pattern))}) timed out after ${timeout}ms; the page is at ${page.url()}`,
				);
			await untilAborted(signal, () => Bun.sleep(Math.min(URL_POLL_MS, Math.max(1, deadline - Date.now()))));
		}
	}

	async #waitForResponse(
		pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
		timeout: number,
		signal: AbortSignal,
	): Promise<HTTPResponse> {
		const page = this.#requirePage();
		const predicate: (response: HTTPResponse) => boolean | Promise<boolean> =
			typeof pattern === "function"
				? pattern
				: pattern instanceof RegExp
					? response => pattern.test(response.url())
					: response => response.url().includes(pattern);
		return (await untilAborted(signal, () => page.waitForResponse(predicate, { timeout, signal }))) as HTTPResponse;
	}

	/**
	 * The DOM node a ref points at: the backend node id and the session that owns
	 * its frame, both recorded by the observation that minted the ref. Nothing is
	 * resolved here — the node is addressed at action time, so a navigation in
	 * between cannot leave a dead handle behind, only a node id the page no
	 * longer knows, which every action reports as stale.
	 */
	#refNode(id: number): CdpNode {
		const entry = this.#refs.get(id);
		if (!entry)
			throw new ToolError(`Unknown element ref e${id}: no observation of this tab minted it. Run tab.observe().`);
		return {
			session: entry.session,
			backendNodeId: entry.backendNodeId,
			label: `e${id}`,
		};
	}

	/**
	 * A selector answered by the page as it is now: a backend node id plus the
	 * session that owns it, resolved fresh on every call and never kept.
	 * `present` returns the first match, `visible` waits for one with a box.
	 */
	async #selectorNode(
		selector: string,
		timeoutMs: number,
		state: "present" | "visible",
		signal?: AbortSignal,
	): Promise<CdpNode> {
		if (parseAriaRefSelector(selector) !== null) return await this.#ariaRefNode(selector, signal);
		const node = await awaitSelector(this.#requirePage(), normalizeSelector(selector), { timeoutMs, state }, signal);
		if (!node) throw new ToolError(`Selector ${JSON.stringify(selector)} matched no element`);
		return node;
	}

	/**
	 * `aria-ref=eN` names a slot in the last ARIA snapshot, and only that
	 * snapshot's own script can map it. Resolve it once, pin the result to a
	 * backend node id, and release the object in the same call.
	 */
	async #ariaRefNode(selector: string, signal?: AbortSignal): Promise<CdpNode> {
		if (this.#managedChrome)
			throw new ToolError(
				"ARIA snapshots are read-only for managed Chrome. Use an immutable ref from tab.observe() to act.",
			);
		const ref = parseAriaRefSelector(selector) ?? selector.trim();
		const node = await nodeFromExpression(
			this.#requirePage().mainFrame().client,
			buildAriaRefScript(ref),
			`aria-ref=${ref}`,
			signal,
		);
		if (!node)
			throw new ToolError(
				`Unknown ARIA ref ${JSON.stringify(ref)}. Run tab.ariaSnapshot() to refresh refs (they renumber each snapshot).`,
			);
		return node;
	}

	/**
	 * The element surface model code drives. Every method addresses the node by
	 * backend id on the session that owns its frame, at call time, so no
	 * navigation between two statements can leave it holding a dead object.
	 */
	#createElement(node: CdpNode, cwd: string, op: ElementOp): TabElement {
		const page = this.#requirePage();
		// Managed Chrome drives a tab the user is not looking at: pointer and
		// keyboard input need page focus emulation held around the dispatch.
		const input = <T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> =>
			this.#managedChrome ? withBackgroundInput(page, signal, action) : action();
		return {
			click: options =>
				op(`${node.label}.click()`, sig => input(sig, () => clickNode(node, options?.count ?? 1, sig))),
			hover: () => op(`${node.label}.hover()`, sig => input(sig, () => hoverNode(node, sig))),
			type: text => op(`${node.label}.type()`, sig => input(sig, () => typeIntoNode(node, text, sig))),
			fill: value => op(`${node.label}.fill()`, sig => input(sig, () => fillNode(node, value, sig))),
			press: key =>
				op(`${node.label}.press()`, sig =>
					input(sig, async () => {
						await focusNode(node, sig);
						await pressChord(node.session, key, sig);
					}),
				),
			focus: () => op(`${node.label}.focus()`, sig => focusNode(node, sig)),
			scrollIntoView: () => op(`${node.label}.scrollIntoView()`, sig => scrollIntoView(node, sig)),
			select: (...values) => op(`${node.label}.select()`, sig => selectOptions(node, values, sig)),
			uploadFile: (...filePaths) =>
				op(`${node.label}.uploadFile()`, sig => {
					if (!filePaths.length) throw new ToolError("uploadFile() requires at least one file path");
					return setFileInput(
						node,
						filePaths.map(filePath => resolveToCwd(filePath, cwd)),
						sig,
					);
				}),
			boundingBox: () =>
				op(`${node.label}.boundingBox()`, async sig =>
					boundingBox(node, await sessionOffset(page, node.session, sig), sig),
				),
			isVisible: () =>
				op(`${node.label}.isVisible()`, async sig =>
					Boolean(await boundingBox(node, await sessionOffset(page, node.session, sig), sig)),
				),
			isHidden: () =>
				op(
					`${node.label}.isHidden()`,
					async sig => !(await boundingBox(node, await sessionOffset(page, node.session, sig), sig)),
				),
			evaluate: (fn, ...args) =>
				op(`${node.label}.evaluate()`, sig =>
					callOnNode(
						node,
						`function (...args) { return (${String(fn)}).apply(null, [this, ...args]); }`,
						args,
						sig,
					),
				) as never,
		};
	}

	/**
	 * Void every ref: the observation id rotates, so a `uuid` ref minted before
	 * this point is rejected by contract. The records stay so the next
	 * observation hands the same numbers to the same elements.
	 */
	#invalidateRefs(): void {
		this.#observationId = crypto.randomUUID();
	}

	/** Best-effort `Page.stopLoading` so an abandoned navigation cannot stall later ops. */
	async #stopLoading(): Promise<void> {
		try {
			const session = await this.#requirePage().createCDPSession();
			try {
				await session.send("Page.stopLoading");
			} finally {
				await session.detach().catch(() => undefined);
			}
		} catch (error) {
			this.#log("debug", "Page.stopLoading failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #close(): Promise<void> {
		this.#unsub();
		this.#uninstallRejectionGuard();
		const page = this.#page;
		await this.#downloads?.dispose().catch(() => undefined);
		if (this.#dialogHandler && page && !page.isClosed()) page.off("dialog", this.#dialogHandler);
		if (this.#mode === "headless" && page && !page.isClosed()) await page.close().catch(() => undefined);
		if (this.#browser?.connected) this.#browser.disconnect();
		this.#transport.send({ type: "closed" });
		this.#transport.close();
	}

	#requirePage(): Page {
		if (!this.#page) throw new ToolError("Tab worker is not initialized");
		return this.#page;
	}

	#requireBrowser(): Browser {
		if (!this.#browser) throw new ToolError("Tab worker is not initialized");
		return this.#browser;
	}

	#log(level: "debug" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
		this.#transport.send({ type: "log", level, msg, meta });
	}
}
