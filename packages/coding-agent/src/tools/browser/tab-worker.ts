import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { postmortem, Snowflake, toError, untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import type { HTMLElement } from "@oh-my-pi/pi-utils/dom";
import type { Browser, CDPSession, Dialog, HTTPResponse, KeyInput, Page, Target } from "puppeteer-core";
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
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { type BrowserA11yOptions, type BrowserA11yResult, formatA11ySummary, runA11yAudit } from "./a11y/audit";
import {
	type AriaSnapshotOptions,
	type AriaSnapshotPayload,
	assertSelectorString,
	buildAriaRefScript,
	buildAriaSnapshotFunction,
	buildAriaSnapshotPayloadScript,
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
	highlightNode,
	holdKey,
	hoverNode,
	isDocumentGoneError,
	nodeFromExpression,
	type PageLayout,
	pageLayout,
	type Point,
	pressChord,
	type Rect,
	releaseKey,
	resolveSelector,
	scrollIntoView,
	selectOptions,
	sessionOffset,
	setFileInput,
	setNodeChecked,
	snapshotAccessibility,
	typeIntoNode,
	waitForDomQuiet,
} from "./cdp";
import {
	type BrowserCaptureResult,
	type BrowserConsoleEntry,
	type BrowserConsoleOptions,
	type BrowserErrorEntry,
	type BrowserErrorOptions,
	PageConsoleCapture,
} from "./console-capture";
import { type DialogPolicy, type DialogState, RuntimeDialogController } from "./dialogs";
import { type BrowserDownload, DownloadManager, TabDownloadMonitor, type TabDownloadSource } from "./downloads";
import {
	applyUserAgentOverride,
	BrowserEmulationController,
	type BrowserEmulateOptions,
	type ClipboardActionResult,
	type ClipboardReadResult,
} from "./emulation";
import {
	type BrowserFrameApi,
	type BrowserFrameInfo,
	captureFrameScreenshot,
	createFrameApi,
	listFrames,
	resolveFrame,
} from "./frames";
import { type InitScriptInfo, InitScriptManager } from "./init-scripts";
import {
	type ClickAtOptions,
	clickAt,
	type HighlightOptions,
	type MouseButtonOptions,
	type MouseMoveOptions,
	mouseDown,
	mouseMove,
	mouseUp,
	type ScrollOptions,
	wheel,
} from "./interactions";
import {
	applyStealthPatches,
	applyViewport,
	BROWSER_PROTOCOL_TIMEOUT_MS,
	DEFAULT_VIEWPORT,
	loadedKnownDevices,
	loadedNetworkConditions,
	loadPuppeteerInWorker,
} from "./launch";
import {
	navigateMainFrame,
	type NavigationWaitUntil,
	pushState,
	reloadPage,
	traverseHistory,
	watchMainFrameNavigation,
} from "./navigation";
import {
	BrowserNetworkManager,
	type HarContentPolicy,
	type NetworkPattern,
	type NetworkRequestDetail,
	type NetworkRequestRecord,
	type NetworkRequestsOptions,
	type NetworkRouteDescription,
	type NetworkRouteOptions,
} from "./network";
import {
	type AxNode,
	axNodeKey,
	buildTreeLines,
	compactNodes,
	flattenSnapshot,
	hasBusyIndicator,
	matchRefs,
	type ObservedNode,
	type RefRecord,
	renderTree,
	renderTreeDiff,
	roleNamePositions,
	sameDocument,
	scopeNodes,
	type TreeHeader,
	type TreeLine,
} from "./observation";
import { applyIgnoreHttpsErrors } from "./open-options";
import {
	DEFAULT_STYLE_PROPERTIES,
	ELEMENT_READS,
	type ElementQueryHelpers,
	queryAttribute,
	type QueryBox,
	queryBox,
	queryChecked,
	queryCount,
	queryEnabled,
	queryHtml,
	queryStyles,
	queryText,
	queryValue,
	queryVisible,
	waitForPageText,
} from "./queries";
import { registerSemanticQueryHandlers } from "./query-handlers";
import { enableReact, type ReactEnableResult } from "./react/devtools-hook";
import { collectReactRenders, type ReactRendersAction, type ReactRendersResult } from "./react/renders";
import { type ReactSuspenseBoundary, type ReactSuspenseOptions, readReactSuspense } from "./react/suspense";
import {
	inspectReactFiber,
	type ReactInspectResult,
	type ReactTreeNode,
	type ReactTreeOptions,
	readReactTree,
} from "./react/tree";
import { collectVitals, installVitalsObservers, type VitalsOptions, type VitalsResult } from "./react/vitals";
import { extractReadableFromHtml, type ReadableExtractOptions, type ReadableFormat } from "./readable";
import {
	RecordingController,
	type RecordingOptions,
	type RecordingStartResult,
	type RecordingStatus,
	type RecordingStopResult,
} from "./recording";
import {
	captureScreenshotBuffer,
	createPngDiff,
	type DiffScreenshotOptions,
	type DiffScreenshotResult,
	formatScreenshotLegend,
	installScreenshotAnnotations,
	type PdfOptions,
	pngPixelChangeRatio,
	type ScreenshotAnnotationTarget,
	type ScreenshotChangeResult,
	type ScreenshotHistory,
	type ScreenshotOptions,
	screenshotQuality,
	screenshotScope,
	screenshotThreshold,
} from "./screenshot";
import {
	type AriaSnapshotBaseline,
	type AriaSnapshotDiffResult,
	ariaSnapshotBaselineKey,
	diffAriaSnapshot,
	postProcessAriaSnapshot,
} from "./snapshot-plus";
import {
	type BrowserCookie,
	type ClearCookiesOptions,
	clearPageCookies,
	clearPageStorage,
	type CookieQueryOptions,
	type LoadStateResult,
	loadStorageState,
	readCookies,
	readStorage,
	saveStorageState,
	setPageCookies,
	setPageStorage,
	type StorageKind,
} from "./storage-state";
import { withDeclaredArguments } from "./declared-arguments";
import { assertTabPressArgs } from "./tab-arguments";
import {
	type BrowserMetrics,
	type BrowserProfileStopOptions,
	type BrowserTraceStartOptions,
	type BrowserTraceStopOptions,
	BrowserTracingController,
} from "./tracing";
import {
	installWebMcp,
	type WebMcpController,
	type WebMcpEventsOptions,
	type WebMcpEventsResult,
	type WebMcpInvokeOptions,
	type WebMcpInvokeResult,
	type WebMcpListOptions,
	type WebMcpListResult,
} from "./webmcp";

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
	"label/",
	"placeholder/",
	"testid/",
	"alt/",
	"title/",
	"role/",
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

interface TabApi {
	readonly name: string;
	readonly page: Page;
	readonly signal?: AbortSignal;
	url(): string;
	title(): Promise<string>;
	goto(url: string, opts?: { waitUntil?: NavigationWaitUntil }): Promise<void>;
	back(opts?: { waitUntil?: NavigationWaitUntil }): Promise<string>;
	forward(opts?: { waitUntil?: NavigationWaitUntil }): Promise<string>;
	reload(opts?: { waitUntil?: NavigationWaitUntil }): Promise<string>;
	pushState(url: string): Promise<string>;
	frames(): Promise<BrowserFrameInfo[]>;
	frame(selectorOrNameOrUrl: string): Promise<BrowserFrameApi>;
	dialog(): Promise<DialogState>;
	handleDialog(opts: { accept: boolean; text?: string }): Promise<void>;
	setDialogs(policy: DialogPolicy | null): Promise<void>;
	observe(opts?: ObserveOptions): Promise<Observation>;
	ariaSnapshot(selector?: string, opts?: AriaSnapshotOptions): Promise<string | AriaSnapshotDiffResult>;
	a11y(opts?: BrowserA11yOptions): Promise<BrowserA11yResult>;
	webmcpList(opts?: WebMcpListOptions): Promise<WebMcpListResult>;
	webmcpInvoke(name: string, params: Record<string, unknown>, opts?: WebMcpInvokeOptions): Promise<WebMcpInvokeResult>;
	webmcpEvents(opts?: WebMcpEventsOptions): Promise<WebMcpEventsResult>;
	screenshot(opts?: ScreenshotOptions): Promise<string | ScreenshotChangeResult>;
	diffScreenshot(baselinePath: string, opts?: DiffScreenshotOptions): Promise<DiffScreenshotResult>;
	pdf(opts?: PdfOptions): Promise<string>;
	extract(format?: ReadableFormat, opts?: ReadableExtractOptions): Promise<string>;
	click(selector: string): Promise<void>;
	dblclick(selector: string): Promise<void>;
	hover(selector: string): Promise<void>;
	focus(selector: string): Promise<void>;
	check(selector: string): Promise<void>;
	uncheck(selector: string): Promise<void>;
	keyDown(key: KeyInput): Promise<void>;
	keyUp(key: KeyInput): Promise<void>;
	mouseMove(x: number, y: number, opts?: MouseMoveOptions): Promise<void>;
	mouseDown(opts?: MouseButtonOptions): Promise<void>;
	mouseUp(opts?: MouseButtonOptions): Promise<void>;
	clickAt(x: number, y: number, opts?: ClickAtOptions): Promise<void>;
	wheel(deltaX: number, deltaY: number): Promise<void>;
	highlight(selector: string, opts?: HighlightOptions): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	press(key: string, opts?: { selector?: string }): Promise<void>;
	scroll(
		deltaXOrDirection: number | ScrollDirection,
		deltaYOrOptions?: number | TabScrollOptions,
		opts?: ScrollOptions,
	): Promise<void>;
	drag(from: DragTarget, to: DragTarget): Promise<void>;
	waitFor(selector: string, opts?: { timeout?: number }): Promise<TabElement>;
	evaluate<R, TArgs extends unknown[]>(fn: string | ((...args: TArgs) => R | Promise<R>), ...args: TArgs): Promise<R>;
	scrollIntoView(selector: string): Promise<void>;
	select(selector: string, ...values: BrowserSelectOption[]): Promise<string[]>;
	uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
	waitForUrl(pattern: string | RegExp, opts?: { timeout?: number }): Promise<string>;
	text(selector: string): Promise<string | null>;
	html(selector: string): Promise<string | null>;
	value(selector: string): Promise<string | null>;
	attr(selector: string, name: string): Promise<string | null>;
	count(selector: string): Promise<number>;
	box(selector: string): Promise<QueryBox | null>;
	styles(selector: string, props?: string[]): Promise<Record<string, string> | null>;
	isVisible(selector: string): Promise<boolean>;
	isEnabled(selector: string): Promise<boolean>;
	isChecked(selector: string): Promise<boolean>;
	waitForText(text: string, opts?: { timeout?: number; selector?: string; exact?: boolean }): Promise<void>;
	waitForResponse(
		pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
		opts?: { timeout?: number },
	): Promise<HTTPResponse>;
	waitForSelector(
		selector: string,
		opts?: { timeout?: number; visible?: boolean; hidden?: boolean },
	): Promise<TabElement | null>;
	waitForNavigation(opts?: { waitUntil?: NavigationWaitUntil; timeout?: number }): Promise<HTTPResponse | null>;
	id(n: number): Promise<TabElement>;
	ref(id: string): Promise<TabElement>;
	emulate(opts?: BrowserEmulateOptions): Promise<BrowserEmulateOptions>;
	devices(): Promise<string[]>;
	clipboardRead(): Promise<ClipboardReadResult>;
	clipboardWrite(text: string): Promise<ClipboardActionResult>;
	clipboardCopy(): Promise<ClipboardActionResult>;
	clipboardPaste(): Promise<ClipboardActionResult>;
	cookies(opts?: CookieQueryOptions): Promise<BrowserCookie[]>;
	setCookies(...cookies: unknown[]): Promise<void>;
	clearCookies(opts?: ClearCookiesOptions): Promise<void>;
	storage(kind: StorageKind, opts?: { key?: string }): Promise<Record<string, string> | string | null>;
	setStorage(kind: StorageKind, keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void>;
	clearStorage(kind: StorageKind): Promise<void>;
	saveState(filePath?: string): Promise<string>;
	loadState(filePath: string): Promise<LoadStateResult>;
	addInitScript(source: string): Promise<{ id: string }>;
	removeInitScript(id: string): Promise<void>;
	initScripts(): Promise<InitScriptInfo[]>;
	waitForDownload(opts?: { timeout?: number }): Promise<BrowserDownload>;
	downloads(): Promise<BrowserDownload[]>;
	console(opts?: BrowserConsoleOptions): Promise<BrowserCaptureResult<BrowserConsoleEntry>>;
	errors(opts?: BrowserErrorOptions): Promise<BrowserCaptureResult<BrowserErrorEntry>>;
	clearConsole(): Promise<void>;
	traceStart(opts?: BrowserTraceStartOptions): Promise<void>;
	traceStop(opts?: BrowserTraceStopOptions): Promise<string>;
	profileStart(): Promise<void>;
	profileStop(opts?: BrowserProfileStopOptions): Promise<string>;
	metrics(): Promise<BrowserMetrics>;
	route(pattern: NetworkPattern, opts?: NetworkRouteOptions): Promise<void>;
	unroute(pattern?: NetworkPattern): Promise<void>;
	routes(): Promise<NetworkRouteDescription[]>;
	requests(opts?: NetworkRequestsOptions): Promise<NetworkRequestRecord[]>;
	request(id: string | number): Promise<NetworkRequestDetail>;
	clearRequests(): Promise<void>;
	harStart(opts?: { content?: HarContentPolicy }): Promise<void>;
	harStop(opts?: { path?: string }): Promise<string>;
	allowedDomains(): Promise<string[]>;
	vitals(opts?: VitalsOptions): Promise<VitalsResult>;
	reactEnable(): Promise<ReactEnableResult>;
	reactTree(opts?: ReactTreeOptions): Promise<ReactTreeNode[]>;
	reactInspect(id: number): Promise<ReactInspectResult>;
	reactRenders(opts: { action: ReactRendersAction }): Promise<ReactRendersResult>;
	reactSuspense(opts?: ReactSuspenseOptions): Promise<ReactSuspenseBoundary[]>;
	recordStart(path: string, opts?: RecordingOptions): Promise<RecordingStartResult>;
	recordStop(): Promise<RecordingStopResult>;
	recordRestart(path: string, opts?: RecordingOptions): Promise<RecordingStartResult>;
	recording(): Promise<RecordingStatus>;
}

/**
 * What `tab.ref()`, `tab.id()` and the selector waits hand model code. Mirrors
 * `BrowserElement` in the code-mode declarations: same names, same positional
 * arguments, nothing puppeteer-shaped leaking through.
 */
export interface TabElement extends ElementQueryHelpers {
	click(options?: { count?: number }): Promise<void>;
	dblclick(): Promise<void>;
	check(): Promise<void>;
	uncheck(): Promise<void>;
	highlight(options?: HighlightOptions): Promise<void>;
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
	/** Observe only the subtree of the first element this selector matches. */
	selector?: string;
	/** Keep only controls and the nodes that contain them. */
	compact?: boolean;
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

/** A ref must be a token string; `tab.ref(undefined)` usually means an `elements.find()` that matched nothing. */
export function requireRefToken(id: unknown): asserts id is string {
	if (typeof id === "string" && id.trim()) return;
	const got =
		typeof id === "string" ? '""' : typeof id === "object" && id !== null ? "an object (pass its .ref)" : String(id);
	throw new ToolError(`tab.ref() needs a ref string such as "e12" from an observation, got ${got}.`);
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

/** `scroll()`'s option bag: how far a direction steps, and an element to scroll instead of the page. */
interface TabScrollOptions extends ScrollOptions {
	by?: number | "page";
}

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
 * error rather than a scroll. A page step is 90% of the scrolled area (the
 * viewport, or the element named by `selector`) so the boundary content stays
 * visible.
 */
async function resolveScrollDeltas(
	deltaXOrDirection: number | ScrollDirection,
	deltaYOrOptions: number | TabScrollOptions | undefined,
	area: () => Promise<{ width: number; height: number }>,
): Promise<{ deltaX: number; deltaY: number }> {
	if (typeof deltaXOrDirection === "number") {
		const deltaY = deltaYOrOptions ?? 0;
		if (typeof deltaY !== "number" || !Number.isFinite(deltaXOrDirection) || !Number.isFinite(deltaY))
			throw new ToolError(
				'tab.scroll() takes pixel deltas (tab.scroll(0, 600, { selector? })) or a direction (tab.scroll("down", { by: "page", selector? }))',
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
	const size = await area();
	const step = Math.max(1, Math.round((unit.x === 0 ? size.height : size.width) * 0.9));
	return { deltaX: unit.x * step, deltaY: unit.y * step };
}

/** `fn(element, ...args)` as a `Runtime.callFunctionOn` declaration whose `this` is the element. */
function onElement(fn: string | ((...args: never[]) => unknown)): string {
	return `function (...args) { return (${String(fn)}).apply(null, [this, ...args]); }`;
}

/** Scroll one element by pixel deltas; its client size is the "page" a direction steps by. */
const SCROLL_ELEMENT = "function (dx, dy) { this.scrollBy({ left: dx, top: dy, behavior: 'instant' }); }";
const ELEMENT_CLIENT_SIZE = "function () { return { width: this.clientWidth, height: this.clientHeight }; }";
const IS_FILE_INPUT = "function () { return this.tagName === 'INPUT' && String(this.type).toLowerCase() === 'file'; }";
/** A drop of `payloads` (name, type, base64 data) on the element, as a drop zone expects it. */
const DROP_FILES = `function (payloads) {
	const transfer = new DataTransfer();
	for (const payload of payloads) {
		const bytes = Uint8Array.from(atob(payload.data), character => character.charCodeAt(0));
		transfer.items.add(new File([bytes], payload.name, { type: payload.type }));
	}
	for (const type of ["dragenter", "dragover", "drop"])
		this.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
}`;

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

/**
 * Run-owned event handlers cannot survive a failed cell or remove controller
 * observers (tab-level routes, request logging, dialogs, console capture keep
 * theirs). A run that switched raw request interception hands the final state
 * it left to `restoreInterception`, which puts back the tab's persistent
 * route/allowlist state; the default turns interception off again.
 */
export function createRunPageScope(
	page: Page,
	restoreInterception: (leftEnabled: boolean) => Promise<void> = async leftEnabled => {
		if (leftEnabled) await page.setRequestInterception(false);
	},
): RunPageScope {
	const handlers: { type: unknown; original: unknown; registered: unknown }[] = [];
	const on = page.on;
	const off = page.off;
	const setRequestInterception = page.setRequestInterception;
	// Only a run that touched interception needs it restored. Puppeteer's
	// `NetworkManager` starts with no recorded protocol state, so a bare
	// `setRequestInterception(false)` is not a no-op: it fans out
	// `Network.setCacheDisabled` + `Fetch.disable` and can outlive the cleanup
	// budget on a page that never intercepted anything.
	let intercepting: boolean | undefined;
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
			if (intercepting === undefined) return;
			try {
				await withTimeout(
					restoreInterception(intercepting),
					REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS,
					"Timed out restoring browser request interception",
				);
			} catch (error) {
				throw new RequestInterceptionCleanupError(
					"Failed to restore browser request interception after browser.run",
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

/** The document the main frame shows: the session serving it and the loader that committed it. */
interface MainDocument {
	session: CDPSession;
	loaderId: string;
}

/**
 * Asked of Chrome, not inferred from events: puppeteer reports a
 * same-document navigation (pushState, a fragment) as `framenavigated` too,
 * but only a new document gets a new loader.
 */
async function mainDocument(page: Page, signal?: AbortSignal): Promise<MainDocument> {
	const session = page.mainFrame().client;
	const { frameTree } = await untilAborted(signal, () => session.send("Page.getFrameTree"));
	return { session, loaderId: frameTree.frame.loaderId };
}

/**
 * Whether the main frame moved on from `before`: a new document, or a new
 * session serving it. Read through the session serving it now, so a tab that
 * no longer answers rejects instead of reading as a navigation.
 */
async function leftDocument(page: Page, before: MainDocument, signal?: AbortSignal): Promise<boolean> {
	const now = await mainDocument(page, signal);
	return now.session !== before.session || now.loaderId !== before.loaderId;
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
/**
 * A tree too big for the cell to print whole. The eval sink caps a cell's
 * inline output at {@link DEFAULT_MAX_BYTES} and cuts the middle out of
 * anything larger, which on a long page is exactly the table or list the read
 * was for — measured: an 83 KB Wikipedia tree printed as 30.7 KB of head plus
 * 12.8 KB of tail, with the wanted row inside the 39.8 KB that went. The whole
 * tree is still in the cell, as the `.tree` of the value this call returns, and
 * code can search it for no tokens at all; nothing said so, so the model
 * re-derived the page from the DOM instead. The cut keeps the tail, so a line
 * at the end is one the model still reads.
 */
export function printableTree(tree: string): string {
	if (Buffer.byteLength(tree, "utf-8") <= DEFAULT_MAX_BYTES) return tree;
	return `${tree}\n[This tree is larger than the cell's ${Math.round(DEFAULT_MAX_BYTES / 1024)} KB inline output budget, so the printed copy above has its middle cut out. The whole tree is in this cell: the \`.tree\` of the value this call returned — \`tab.initialObservation.tree\` for a tab's first observation — so search it in code (\`tree.split("\\n").filter(line => line.includes("…"))\`) instead of printing it again.]`;
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
	#lastTree?: { url: string; filter: string; lines: TreeLine[] };
	#managedChrome = false;
	#active: ActiveRun | null = null;
	#runtime: JsRuntime | null = null;
	#unsub: () => void;
	#isolated: boolean;
	#uninstallRejectionGuard: () => void;
	#mode?: WorkerInitPayload["mode"];
	#activateForScreenshot = true;
	/**
	 * Dialogs on a worker-owned tab: upstream's runtime controller (policy,
	 * `tab.dialog()`/`handleDialog()`). Never installed on managed Chrome, whose
	 * dialogs belong to the relay journal and are never auto-answered.
	 */
	#dialogs?: RuntimeDialogController;
	/** Managed Chrome only: the modal the relay journal will answer, kept for attribution. */
	#openDialog?: OpenDialogInfo;
	#pendingPageCleanup?: Promise<void>;
	#dialogClosed = Promise.withResolvers<void>();
	#downloads?: TabDownloadSource;
	#downloadObservationError?: string;
	/** Last measured viewport, reported while a dialog blocks the renderer. */
	#viewport?: ReadyInfo["viewport"];
	/** Modifier keys held by `tab.keyDown()`, as Chrome's bitmask; key strokes carry them. */
	#heldModifiers = 0;
	#network?: BrowserNetworkManager;
	#initScripts?: InitScriptManager;
	readonly #consoleCapture = new PageConsoleCapture();
	#tracing?: BrowserTracingController;
	#ariaSnapshotBaselines = new Map<string, AriaSnapshotBaseline>();
	#emulation?: BrowserEmulationController;
	#screenshotHistory = new Map<string, ScreenshotHistory>();
	#webmcp?: WebMcpController;
	readonly #recording = new RecordingController();

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
			registerSemanticQueryHandlers(puppeteer);
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
			if ((payload.mode === "headless" || payload.emulateFocus) && !this.#managedChrome) {
				// Background Chromium tabs stop producing frames, stalling rAF,
				// IntersectionObserver, and input acknowledgements. Keep owned tabs
				// interactive without raising a window; explicit settle-freeze still
				// applies. A leased tab in the user's Chrome is different: it only
				// emulates focus for the span of an action (`withBackgroundInput`), so
				// the user's own focus is never displaced between actions.
				await this.#page.emulateFocusedPage(true);
			}
			// Page hooks install at document start on tabs OMP owns. The user's own
			// Chrome gets none until the model asks for the capability behind them.
			if (!this.#managedChrome) {
				this.#webmcp = await installWebMcp(this.#page);
				await installVitalsObservers(this.#page);
			}
			if (payload.userAgent !== undefined) await applyUserAgentOverride(this.#page, payload.userAgent);
			if (payload.ignoreHttpsErrors) await applyIgnoreHttpsErrors(this.#page);
			this.#targetId = await targetIdForPage(this.#page);
			this.#initScripts = new InitScriptManager(this.#page);
			for (const source of payload.initScripts ?? []) await this.#initScripts.add(source);
			if (this.#managedChrome) {
				// Passive and page-scoped: the user's Chrome keeps its own download
				// settings, so a download there lands where the user's Chrome puts it.
				try {
					const monitor = await TabDownloadMonitor.connect(this.#page);
					this.#downloads = monitor;
					monitor.session.on("Page.javascriptDialogClosed", () => {
						this.#openDialog = undefined;
						this.#dialogClosed.resolve();
					});
				} catch (error) {
					this.#downloadObservationError = toError(error).message;
				}
			} else {
				const downloads = new DownloadManager(this.#browser, this.#page, this.#targetId);
				this.#downloads = downloads;
				if (payload.downloadsPath) await downloads.enable(payload.downloadsPath);
			}
			await this.#consoleCapture.install(this.#page);
			this.#tracing = new BrowserTracingController(this.#page);
			this.#network = new BrowserNetworkManager(this.#page, payload.allowedDomains);
			await this.#network.start();
			if (payload.url) {
				// Default to "load" because dev servers with HMR/WS never reach networkidle.
				await navigateMainFrame(this.#page, payload.url, {
					label: `navigate to ${JSON.stringify(payload.url)}`,
					timeoutMs: payload.timeoutMs,
					waitUntil: payload.waitUntil,
					stopLoading: () => this.#stopLoading(),
				});
			}
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			// A failed headless init leaves the worker's page orphaned in the shared
			// browser (the supervisor retries with a fresh worker), so close it before
			// reporting. Attach mode adopts an existing target — never close it.
			const page = this.#page;
			await this.#webmcp?.dispose().catch(() => undefined);
			this.#webmcp = undefined;
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
	 * A main-frame navigation voids every ref and proves a modal gone. On a
	 * worker-owned tab the runtime controller observes, auto-answers per policy
	 * and exposes `tab.dialog()`/`handleDialog()`. In managed Chrome the modal is
	 * only recorded for attribution: the relay journal answers it, never this
	 * worker, and an auto-accepted beforeunload would discard the user's work.
	 */
	#observeDialogs(): void {
		const page = this.#requirePage();
		page.on("framenavigated", frame => {
			if (frame !== page.mainFrame()) return;
			this.#openDialog = undefined;
			this.#invalidateRefs();
		});
		if (!this.#managedChrome) {
			this.#dialogs?.dispose();
			this.#dialogs = new RuntimeDialogController(page, (message, details) => this.#log("debug", message, details));
			this.#dialogs.observe();
			return;
		}
		page.on("dialog", dialog => {
			const opened = { type: dialog.type(), message: dialog.message() };
			this.#openDialog = opened;
			this.#dialogClosed = Promise.withResolvers<void>();
			const timer = setTimeout(() => {
				if (this.#openDialog === opened) this.#active?.floatingFailure.reject(this.#dialogPendingError());
			}, 250);
			timer.unref();
		});
	}

	#dialogPendingError(): ToolError {
		const dialog = this.#openDialog;
		return new ToolError(
			`A JavaScript ${dialog?.type ?? "dialog"} awaits a decision: ${JSON.stringify((dialog?.message ?? "").slice(0, 2000))}. The triggering action may have taken effect and its page handler can continue after the dialog is answered. Use await tab.dialog() to read the exact current dialog and its id, then await tab.handleDialog({ accept, id, text? }) to answer it. Inspect page state before repeating the triggering action. Input cleanup may remain pending until the dialog is resolved.`,
		);
	}

	async #currentReadyInfo(): Promise<ReadyInfo> {
		const page = this.#requirePage();
		const targetId = this.#targetId ?? (await targetIdForPage(page));
		this.#targetId = targetId;
		// A page blocked by a modal answers nothing that needs its renderer — the
		// title read or the layout metrics — so a dialog reports what was last seen.
		const blocked = this.#dialogOpen();
		if (!blocked) this.#viewport = (await readPageMetrics(page)).viewport;
		return {
			url: redactUrlCredentials(page.url()),
			title: blocked ? undefined : await page.title().catch(() => undefined),
			viewport: this.#viewport ?? page.viewport() ?? DEFAULT_VIEWPORT,
			targetId,
		};
	}

	/** Whether a JavaScript dialog is blocking the page right now. */
	#dialogOpen(): boolean {
		return this.#managedChrome ? this.#openDialog !== undefined : (this.#dialogs?.state().open ?? false);
	}

	/** Apply an automatic dialog policy selected while opening the tab. */
	#applyDialogPolicy(policy: DialogPolicy): void {
		void this.#requireDialogs()
			.setPolicy(policy)
			.catch(error =>
				this.#log("debug", "Dialog auto-handler failed", {
					policy,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
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
		const runErrorStartSeq = this.#consoleCapture.nextSequence;
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
			await untilAborted(signal, () => this.#emulation?.reapply() ?? Promise.resolve());
			const network = this.#requireNetwork();
			runPage = createRunPageScope(this.#requirePage(), async leftEnabled => {
				if (leftEnabled !== network.hasPersistentInterception()) await network.restoreInterception();
			});
			const browser = this.#requireBrowser();
			const tabApi = this.#createTabApi(msg.name, msg.timeoutMs, signal, msg.session, output, screenshots, active);
			const runtime = this.#ensureRuntime(msg.session);
			runtime.setCwd(msg.session.cwd);
			const onFloatingRejection = (reason: unknown): void => this.#recordFloatingRejection(active, reason);
			runtime.setRunScope({
				page: bindRunFacade(runPage.page, signal, active.rejectionOwner, onFloatingRejection),
				browser: bindRunFacade(browser, signal, active.rejectionOwner, onFloatingRejection),
				// Unknown option keys refuse instead of being ignored: the tab is its declared type.
				tab: bindRunFacade(
					withDeclaredArguments("BrowserTabRealm", tabApi),
					signal,
					active.rejectionOwner,
					onFloatingRejection,
				),
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
					const dialog = this.#managedChrome ? this.#openDialog : this.#dialogs?.state();
					const dialogNote = dialog?.type
						? `; a ${dialog.type}(${JSON.stringify((dialog.message ?? "").slice(0, 80))}) dialog opened during this run and may still block the page — ${this.#managedChrome ? "read it with tab.dialog() and answer it with tab.handleDialog({ accept, id })" : 'use tab.handleDialog() or tab.setDialogs("accept"|"dismiss")'}`
						: "";
					const pageErrorCount = this.#consoleCapture.errorCountSince(runErrorStartSeq);
					const pageErrorNote =
						pageErrorCount > 0 ? `; ${pageErrorCount} page error(s) since run start — see tab.errors()` : "";
					rejectCancel(
						new ToolError(
							`Browser code execution timed out after ${msg.timeoutMs}ms${stalled ? ` (stalled on ${stalled})` : ""}${dialogNote}${pageErrorNote}`,
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
		// Managed Chrome drives a tab the user is not looking at: pointer and
		// keyboard input need page focus emulation held around the dispatch.
		const input = <T>(sig: AbortSignal, action: () => Promise<T>): Promise<T> =>
			this.#managedChrome ? withBackgroundInput(page, sig, action) : action();
		// Element methods run through the same fail-fast per-op wrapper as the
		// selector helpers, so `(await tab.ref("e12")).click()` can't outrun the
		// cell budget (issue #9535).
		const element = (node: CdpNode): TabElement =>
			this.#createElement(node, session.cwd, (label, fn) => op(label, actionOpMs, fn), input);
		/** A selector action on the node the selector names now: one op, zero-match fail-fast. */
		const onSelector = (
			verb: string,
			selector: string,
			state: "present" | "visible",
			act: (node: CdpNode, sig: AbortSignal, label: string) => Promise<void>,
		): Promise<void> => {
			const label = `tab.${verb}(${JSON.stringify(selector)})`;
			return op(
				label,
				actionOpMs,
				async sig => act(await this.#selectorNode(selector, actionOpMs, state, sig), sig, label),
				{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
			);
		};
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
			back: opts =>
				op("tab.back()", INF, async sig => {
					this.#invalidateRefs();
					return await traverseHistory(page, "back", opts?.waitUntil ?? "load", budgetBound, sig);
				}),
			forward: opts =>
				op("tab.forward()", INF, async sig => {
					this.#invalidateRefs();
					return await traverseHistory(page, "forward", opts?.waitUntil ?? "load", budgetBound, sig);
				}),
			reload: opts =>
				op("tab.reload()", INF, async sig => {
					this.#invalidateRefs();
					return await reloadPage(page, opts?.waitUntil ?? "load", budgetBound, sig);
				}),
			pushState: url =>
				op(`tab.pushState(${JSON.stringify(url)})`, actionOpMs, async sig => {
					this.#invalidateRefs();
					return await pushState(page, url, sig);
				}),
			frames: () => op("tab.frames()", quickOpMs, sig => listFrames(page, sig)),
			frame: selectorOrNameOrUrl =>
				op(`tab.frame(${JSON.stringify(selectorOrNameOrUrl)})`, quickOpMs, async sig => {
					const frame = await resolveFrame(page, selectorOrNameOrUrl, normalizeSelector, sig);
					return createFrameApi(frame, {
						quickOpMs,
						actionOpMs,
						zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS,
						normalizeSelector,
						waitMs,
						op: (label, perOpMs, fn, selectorOpts) =>
							op(label, perOpMs, frameSignal => input(frameSignal, () => fn(frameSignal)), selectorOpts),
						captureScreenshot: (target, selector, screenshotSignal) =>
							captureFrameScreenshot(
								target,
								selector,
								screenshotSignal,
								normalizeSelector,
								session,
								output,
								screenshots,
							),
					});
				}),
			dialog: () =>
				op("tab.dialog()", quickOpMs, async sig => {
					throwIfAborted(sig);
					return this.#requireDialogs().state();
				}),
			handleDialog: opts =>
				op("tab.handleDialog()", actionOpMs, sig => untilAborted(sig, () => this.#requireDialogs().handle(opts))),
			setDialogs: policy =>
				op("tab.setDialogs()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireDialogs().setPolicy(policy)),
				),
			observe: opts =>
				op("tab.observe()", quickOpMs, async sig => {
					const observation = await this.#collectObservation({ ...opts, refs: session.refs, signal: sig });
					// `String(observation)` is the tree; non-enumerable, so it never crosses the run boundary.
					Object.defineProperty(observation, "toString", { value: () => observation.tree });
					if (opts?.display !== false) output.push({ type: "text", text: printableTree(observation.tree) });
					active.presented = observation;
					return observation;
				}),
			ariaSnapshot: (selector, opts) =>
				op(
					selector ? `tab.ariaSnapshot(${JSON.stringify(selector)})` : "tab.ariaSnapshot()",
					quickOpMs,
					async sig => {
						const payload = (
							selector
								? await callOnNode(
										await this.#selectorNode(selector, quickOpMs, "present", sig),
										buildAriaSnapshotFunction(opts),
										[],
										sig,
									)
								: await evaluateExpression(
										page.mainFrame().client,
										buildAriaSnapshotPayloadScript(undefined, opts),
										sig,
									)
						) as AriaSnapshotPayload;
						const processed = postProcessAriaSnapshot(payload.snapshot, opts, payload.hrefs);
						// Refs act through the page's own snapshot markers, which managed Chrome
						// never lets an action resolve: act through tab.observe() refs there.
						const snapshot = this.#managedChrome ? processed.replace(/ \[ref=e\d+\]/g, "") : processed;
						if (!opts?.diff) return snapshot;
						const key = ariaSnapshotBaselineKey(selector, opts);
						return diffAriaSnapshot(this.#ariaSnapshotBaselines, key, page.url(), snapshot);
					},
				),
			a11y: opts =>
				op("tab.a11y()", budgetBound, async sig => {
					const result = await untilAborted(sig, () => runA11yAudit(page, opts));
					output.push({ type: "text", text: formatA11ySummary(result) });
					return result;
				}),
			webmcpList: opts =>
				op("tab.webmcpList()", quickOpMs, async sig => {
					const webmcp = await untilAborted(sig, () => this.#requireWebMcp());
					return await untilAborted(sig, () => webmcp.list(opts));
				}),
			webmcpInvoke: (toolName, params, opts) => {
				const w = waitMs(opts?.timeout);
				return op(`tab.webmcpInvoke(${JSON.stringify(toolName)})`, w, async sig => {
					const webmcp = await untilAborted(sig, () => this.#requireWebMcp());
					return await untilAborted(sig, () => webmcp.invoke(toolName, params, opts));
				});
			},
			webmcpEvents: opts =>
				op("tab.webmcpEvents()", quickOpMs, async sig => {
					const webmcp = await untilAborted(sig, () => this.#requireWebMcp());
					return await untilAborted(sig, () => webmcp.events(opts));
				}),
			screenshot: opts =>
				op(describeScreenshot(opts), quickOpMs, sig =>
					this.#captureScreenshot(session, output, screenshots, sig, opts),
				),
			diffScreenshot: (baselinePath, opts) =>
				op("tab.diffScreenshot()", quickOpMs, sig =>
					this.#diffScreenshot(session, output, screenshots, sig, baselinePath, opts),
				),
			pdf: opts => op("tab.pdf()", quickOpMs, sig => this.#pdf(session, sig, opts)),
			extract: (format = "text", opts) =>
				op(`tab.extract(${JSON.stringify(format)})`, quickOpMs, async sig => {
					if (format !== "text" && format !== "markdown")
						throw new ToolError(
							`tab.extract(format, options?) takes "text" or "markdown" (positional string, default "text"); received ${JSON.stringify(format)}`,
						);
					const html = (await untilAborted(sig, () => page.content())) as string;
					const result = await extractReadableFromHtml(html, page.url(), format, opts);
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
				onSelector("click", selector, "visible", (node, sig, label) =>
					input(sig, () => clickNode(node, 1, sig, label)),
				),
			dblclick: selector =>
				onSelector("dblclick", selector, "visible", (node, sig, label) =>
					input(sig, () => clickNode(node, 2, sig, label)),
				),
			hover: selector => onSelector("hover", selector, "visible", (node, sig) => input(sig, () => hoverNode(node, sig))),
			focus: selector => onSelector("focus", selector, "present", (node, sig) => focusNode(node, sig)),
			check: selector =>
				onSelector("check", selector, "present", (node, sig, label) =>
					input(sig, () => setNodeChecked(node, true, label, sig)),
				),
			uncheck: selector =>
				onSelector("uncheck", selector, "present", (node, sig, label) =>
					input(sig, () => setNodeChecked(node, false, label, sig)),
				),
			highlight: (selector, opts) =>
				onSelector("highlight", selector, "present", (node, sig) => highlightNode(node, opts, sig)),
			keyDown: key =>
				op(`tab.keyDown(${JSON.stringify(key)})`, actionOpMs, sig =>
					input(sig, async () => {
						this.#heldModifiers = await holdKey(page.mainFrame().client, key, this.#heldModifiers, sig);
					}),
				),
			keyUp: key =>
				op(`tab.keyUp(${JSON.stringify(key)})`, actionOpMs, sig =>
					input(sig, async () => {
						this.#heldModifiers = await releaseKey(page.mainFrame().client, key, this.#heldModifiers, sig);
					}),
				),
			mouseMove: (x, y, opts) =>
				op("tab.mouseMove()", actionOpMs, sig => input(sig, () => mouseMove(page, x, y, opts, sig))),
			mouseDown: opts => op("tab.mouseDown()", actionOpMs, sig => input(sig, () => mouseDown(page, opts, sig))),
			mouseUp: opts => op("tab.mouseUp()", actionOpMs, sig => input(sig, () => mouseUp(page, opts, sig))),
			clickAt: (x, y, opts) =>
				op("tab.clickAt()", actionOpMs, sig => input(sig, () => clickAt(page, x, y, opts, sig))),
			wheel: (deltaX, deltaY) =>
				op("tab.wheel()", actionOpMs, sig => input(sig, () => wheel(page, deltaX, deltaY, sig))),
			type: (selector, text) =>
				onSelector("type", selector, "present", (node, sig) =>
					input(sig, () => typeIntoNode(node, text, sig, this.#heldModifiers)),
				),
			fill: (selector, value) =>
				onSelector("fill", selector, "present", (node, sig) => input(sig, () => fillNode(node, value, sig))),
			press: (key, opts) => {
				assertTabPressArgs(key, opts);
				return op(`tab.press(${JSON.stringify(key)})`, actionOpMs, async sig => {
					const selector = opts?.selector;
					const node = selector ? await this.#selectorNode(selector, actionOpMs, "present", sig) : undefined;
					await input(sig, async () => {
						if (node) await focusNode(node, sig);
						throwIfAborted(sig);
						await pressChord(page.mainFrame().client, key, sig, this.#heldModifiers);
					});
				});
			},
			scroll: (deltaXOrDirection, deltaYOrOptions, opts) =>
				op("tab.scroll()", actionOpMs, async sig => {
					const selector = (typeof deltaYOrOptions === "object" ? deltaYOrOptions : opts)?.selector;
					if (selector === undefined) {
						const deltas = await resolveScrollDeltas(deltaXOrDirection, deltaYOrOptions, async () =>
							(await readPageMetrics(page, sig)).viewport,
						);
						await untilAborted(sig, () => dispatchScroll(() => page.mouse.wheel(deltas)));
						return;
					}
					const node = await this.#selectorNode(selector, actionOpMs, "present", sig);
					const deltas = await resolveScrollDeltas(
						deltaXOrDirection,
						deltaYOrOptions,
						async () => (await callOnNode(node, ELEMENT_CLIENT_SIZE, [], sig)) as { width: number; height: number },
					);
					await callOnNode(node, SCROLL_ELEMENT, [deltas.deltaX, deltas.deltaY], sig);
				}),
			drag: (from, to) => op("tab.drag()", actionOpMs, sig => input(sig, () => this.#drag(from, to, sig))),
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
				onSelector("scrollIntoView", selector, "present", (node, sig) => scrollIntoView(node, sig)),
			select: (selector, ...values) =>
				op(
					`tab.select(${JSON.stringify(selector)})`,
					actionOpMs,
					sig => this.#select(selector, values, actionOpMs, sig),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			uploadFile: (selector, ...filePaths) =>
				onSelector("uploadFile", selector, "present", (node, sig, label) =>
					input(sig, () => this.#uploadFile(node, filePaths, label, sig, session.cwd)),
				),
			waitForUrl: (pattern, opts) => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForUrl()", w, sig => this.#waitForUrl(pattern, w, sig));
			},
			text: selector =>
				op(`tab.text(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryText(page, normalizeSelector(selector), sig),
				),
			html: selector =>
				op(`tab.html(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryHtml(page, normalizeSelector(selector), sig),
				),
			value: selector =>
				op(`tab.value(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryValue(page, normalizeSelector(selector), sig),
				),
			attr: (selector, attribute) =>
				op(`tab.attr(${JSON.stringify(selector)}, ${JSON.stringify(attribute)})`, quickOpMs, sig =>
					queryAttribute(page, normalizeSelector(selector), attribute, sig),
				),
			count: selector =>
				op(`tab.count(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryCount(page, normalizeSelector(selector), sig),
				),
			box: selector =>
				op(`tab.box(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryBox(page, normalizeSelector(selector), sig),
				),
			styles: (selector, props) =>
				op(`tab.styles(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryStyles(page, normalizeSelector(selector), props, sig),
				),
			isVisible: selector =>
				op(`tab.isVisible(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryVisible(page, normalizeSelector(selector), sig),
				),
			isEnabled: selector =>
				op(`tab.isEnabled(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryEnabled(page, normalizeSelector(selector), sig),
				),
			isChecked: selector =>
				op(`tab.isChecked(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryChecked(page, normalizeSelector(selector), sig),
				),
			waitForText: (text, opts) => {
				const w = waitMs(opts?.timeout);
				return op(`tab.waitForText(${JSON.stringify(text)})`, w, sig =>
					waitForPageText(page, text, {
						timeout: w,
						selector: opts?.selector ? normalizeSelector(opts.selector) : undefined,
						exact: opts?.exact,
						signal: sig,
					}),
				);
			},
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
				requireRefToken(id);
				const elementId = parseRefToken(id, this.#observationId);
				if (elementId !== null) return element(this.#refNode(elementId));
				if (id.includes(":"))
					throw new ToolError("The element reference belongs to an old observation. Observe the tab again.");
				return element(await this.#ariaRefNode(id));
			},
			emulate: opts =>
				op("tab.emulate()", actionOpMs, sig => untilAborted(sig, async () => (await this.#requireEmulation()).emulate(opts))),
			devices: () =>
				op("tab.devices()", quickOpMs, async sig => (await untilAborted(sig, () => this.#requireEmulation())).devices()),
			clipboardRead: () =>
				op("tab.clipboardRead()", actionOpMs, sig =>
					untilAborted(sig, async () => (await this.#requireEmulation()).clipboardRead()),
				),
			clipboardWrite: text =>
				op("tab.clipboardWrite()", actionOpMs, sig =>
					untilAborted(sig, async () => (await this.#requireEmulation()).clipboardWrite(text)),
				),
			clipboardCopy: () =>
				op("tab.clipboardCopy()", actionOpMs, sig =>
					untilAborted(sig, async () => (await this.#requireEmulation()).clipboardCopy()),
				),
			clipboardPaste: () =>
				op("tab.clipboardPaste()", actionOpMs, sig =>
					untilAborted(sig, async () => (await this.#requireEmulation()).clipboardPaste()),
				),
			cookies: opts => op("tab.cookies()", quickOpMs, sig => readCookies(page, opts, sig)),
			setCookies: (...cookies) => op("tab.setCookies()", actionOpMs, sig => setPageCookies(page, cookies, sig)),
			clearCookies: opts => op("tab.clearCookies()", actionOpMs, sig => clearPageCookies(page, opts, sig)),
			storage: (kind, opts) => op("tab.storage()", quickOpMs, sig => readStorage(page, kind, opts, sig)),
			setStorage: (kind, keyOrEntries, value) =>
				op("tab.setStorage()", actionOpMs, sig => setPageStorage(page, kind, keyOrEntries, value, sig)),
			clearStorage: kind => op("tab.clearStorage()", actionOpMs, sig => clearPageStorage(page, kind, sig)),
			saveState: filePath =>
				op("tab.saveState()", actionOpMs, sig => saveStorageState(page, name, filePath, session.cwd, sig)),
			loadState: filePath =>
				op("tab.loadState()", actionOpMs, sig =>
					loadStorageState(page, filePath, session.cwd, {
						allowOtherOrigins: this.#mode === "headless",
						navigationTimeoutMs: actionOpMs,
						signal: sig,
					}),
				),
			addInitScript: source =>
				op("tab.addInitScript()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireInitScripts().add(source)),
				),
			removeInitScript: id =>
				op("tab.removeInitScript()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireInitScripts().remove(id)),
				),
			initScripts: () =>
				op("tab.initScripts()", quickOpMs, async sig => {
					throwIfAborted(sig);
					return this.#requireInitScripts().list();
				}),
			waitForDownload: opts => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForDownload()", w, sig => this.#requireDownloads().wait(sig));
			},
			downloads: () =>
				op("tab.downloads()", quickOpMs, async sig => {
					throwIfAborted(sig);
					return this.#requireDownloads().list();
				}),
			console: opts =>
				op("tab.console()", quickOpMs, sig => untilAborted(sig, () => this.#consoleCapture.console(opts))),
			errors: opts =>
				op("tab.errors()", quickOpMs, sig => untilAborted(sig, () => this.#consoleCapture.errors(opts))),
			clearConsole: () =>
				op("tab.clearConsole()", quickOpMs, async sig => {
					throwIfAborted(sig);
					this.#consoleCapture.clear();
				}),
			traceStart: opts =>
				op("tab.traceStart()", actionOpMs, sig => untilAborted(sig, () => this.#requireTracing().traceStart(opts))),
			traceStop: opts =>
				op("tab.traceStop()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireTracing().traceStop(session.cwd, opts)),
				),
			profileStart: () =>
				op("tab.profileStart()", actionOpMs, sig => untilAborted(sig, () => this.#requireTracing().profileStart())),
			profileStop: opts =>
				op("tab.profileStop()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireTracing().profileStop(session.cwd, opts)),
				),
			metrics: () =>
				op("tab.metrics()", quickOpMs, sig => untilAborted(sig, () => this.#requireTracing().metrics())),
			route: (pattern, opts) =>
				op("tab.route()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireNetwork().route(pattern, opts, sig)),
				),
			unroute: pattern =>
				op("tab.unroute()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireNetwork().unroute(pattern, sig)),
				),
			routes: () =>
				op("tab.routes()", quickOpMs, async sig => {
					throwIfAborted(sig);
					return this.#requireNetwork().routes();
				}),
			requests: opts =>
				op("tab.requests()", quickOpMs, async sig => {
					throwIfAborted(sig);
					return this.#requireNetwork().requests(opts);
				}),
			request: id =>
				op("tab.request()", quickOpMs, sig => untilAborted(sig, () => this.#requireNetwork().request(id, sig))),
			clearRequests: () =>
				op("tab.clearRequests()", quickOpMs, async sig => {
					throwIfAborted(sig);
					this.#requireNetwork().clearRequests();
				}),
			harStart: opts =>
				op("tab.harStart()", quickOpMs, async sig => {
					throwIfAborted(sig);
					this.#requireNetwork().harStart(opts?.content);
				}),
			harStop: opts =>
				op("tab.harStop()", INF, sig => {
					const destination = opts?.path
						? resolveToCwd(opts.path, session.cwd)
						: path.join(session.cwd, `browser-${name.replace(/[^a-z0-9_-]+/gi, "-")}-${Snowflake.next()}.har`);
					return untilAborted(sig, () => this.#requireNetwork().harStop(destination, sig));
				}),
			allowedDomains: () =>
				op("tab.allowedDomains()", quickOpMs, async sig => {
					throwIfAborted(sig);
					return this.#requireNetwork().allowedDomains();
				}),
			vitals: opts => op("tab.vitals()", INF, sig => collectVitals(page, opts, sig)),
			reactEnable: () => op("tab.reactEnable()", INF, sig => enableReact(page, sig)),
			reactTree: opts => op("tab.reactTree()", quickOpMs, sig => readReactTree(page, opts, sig)),
			reactInspect: id => op(`tab.reactInspect(${id})`, quickOpMs, sig => inspectReactFiber(page, id, sig)),
			reactRenders: opts => op("tab.reactRenders()", quickOpMs, sig => collectReactRenders(page, opts, sig)),
			reactSuspense: opts => op("tab.reactSuspense()", quickOpMs, sig => readReactSuspense(page, opts, sig)),
			recordStart: (destination, opts) =>
				op(`tab.recordStart(${JSON.stringify(destination)})`, quickOpMs, sig =>
					this.#recording.start(page, destination, session.cwd, opts, sig),
				),
			recordStop: () =>
				op("tab.recordStop()", budgetBound, sig =>
					this.#recording.stop({ signal: sig, output, excludeWebP: session.excludeWebP }),
				),
			recordRestart: (destination, opts) =>
				op(`tab.recordRestart(${JSON.stringify(destination)})`, budgetBound, sig =>
					this.#recording.restart(page, destination, session.cwd, opts, {
						signal: sig,
						output,
						excludeWebP: session.excludeWebP,
					}),
				),
			recording: () => op("tab.recording()", quickOpMs, () => Promise.resolve(this.#recording.status())),
		};
	}

	/**
	 * Settle the page, then snapshot it — collecting again whenever the main
	 * frame moves to a new document mid-collection. `observe()` promises the
	 * settled tree of the document the caller ends up on, and "click, then
	 * observe" in one cell is the ordinary way to use it, so a navigation is a
	 * reason to look again, not a failure. A same-document navigation (pushState,
	 * a fragment) is not one: the tree read across it is still the page's. Every
	 * attempt shares the one settle budget, which never grows. When it runs out
	 * on a page that keeps replacing its document, the last complete read comes
	 * back marked as still navigating; only a page that never held a document
	 * through one read fails.
	 */
	async #settledSnapshot(
		page: Page,
		includeAll: boolean,
		deadline: number,
		signal?: AbortSignal,
	): Promise<{ snapshot: AxNode; layout: PageLayout; url: string; title: string; navigating: boolean }> {
		let latest: { snapshot: AxNode; layout: PageLayout; url: string; title: string } | undefined;
		let navigated = false;
		while (Date.now() < deadline) {
			const before = await mainDocument(page, signal);
			const read = await this.#snapshotOnce(page, includeAll, deadline - Date.now(), deadline, signal).catch(
				async error => {
					// A call the old document could no longer answer, or any failure
					// while the main frame moved on, is the navigation itself: the
					// next attempt reads the new document. A tab that no longer
					// answers is lost, and its own error says why.
					const moved = await leftDocument(page, before, signal).catch(() => undefined);
					if (moved !== undefined && (moved || isDocumentGoneError(error))) return null;
					throw error;
				},
			);
			// A read of the document the page still shows. It is provisional only
			// when the budget ran out before this document had its settle.
			if (read && !(await leftDocument(page, before, signal)))
				return { ...read, navigating: navigated && Date.now() >= deadline };
			navigated = true;
			latest = read ?? latest;
		}
		if (latest) return { ...latest, navigating: true };
		throw new ToolError("The page changed while observing it. Observe again.");
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

	/** Every DOM node under `node`, shadow roots and same-process frames included, on its own session. */
	async #descendantsOf(
		node: CdpNode,
		signal?: AbortSignal,
	): Promise<{ session: CDPSession; backendNodeIds: Set<number> }> {
		const described = await untilAborted(signal, () =>
			node.session.send("DOM.describeNode", { backendNodeId: node.backendNodeId, depth: -1, pierce: true }),
		);
		const backendNodeIds = new Set<number>();
		const visit = (current: {
			backendNodeId: number;
			children?: unknown[];
			shadowRoots?: unknown[];
			contentDocument?: unknown;
		}): void => {
			backendNodeIds.add(current.backendNodeId);
			for (const child of [...(current.children ?? []), ...(current.shadowRoots ?? [])]) visit(child as typeof current);
			if (current.contentDocument) visit(current.contentDocument as typeof current);
		};
		visit(described.node);
		return { session: node.session, backendNodeIds };
	}

	async #collectObservation(
		options: ObserveOptions & { refs?: RefStyle; signal?: AbortSignal },
	): Promise<Observation> {
		const page = this.#requirePage();
		const { signal } = options;
		const refStyle = options.refs ?? "uuid";
		const includeAll = options.includeAll ?? false;
		const viewportOnly = options.viewportOnly ?? false;
		const compact = options.compact ?? false;
		const selector = options.selector;
		// Resolved before settling: a selector that names nothing is the caller's
		// mistake, and it must not cost the settle budget to say so.
		const scope = selector
			? await this.#descendantsOf(await this.#selectorNode(selector, QUICK_OP_TIMEOUT_MS, "present", signal), signal)
			: undefined;
		this.#invalidateRefs();
		const deadline = Date.now() + SETTLE_BUDGET_MS;
		const { snapshot, layout, url, title, navigating } = await this.#settledSnapshot(
			page,
			includeAll,
			deadline,
			signal,
		);
		const observationId = this.#observationId;

		let nodes = flattenSnapshot(snapshot, { includeAll });
		if (scope) {
			nodes = scopeNodes(
				nodes,
				node =>
					node.ax?.frame?.session === scope.session &&
					node.ax.backendNodeId !== undefined &&
					scope.backendNodeIds.has(node.ax.backendNodeId),
			);
		}
		if (compact) nodes = compactNodes(nodes);
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
		const header: TreeHeader = {
			url,
			title,
			scroll: { y: scroll.y, scrollHeight: scroll.scrollHeight },
			focused,
			navigating,
		};
		const previous = this.#lastTree;
		const filter = JSON.stringify({ includeAll, viewportOnly, compact, selector: selector ?? null });
		// Diff only against the same document observed with the same filter;
		// anything else needs the full tree to be readable.
		const baseline =
			options.diff !== false && previous && sameDocument(previous.url, url) && previous.filter === filter
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
	): Promise<string | ScreenshotChangeResult> {
		const page = this.#requirePage();
		// Managed Chrome clears activation even for an explicitly selected inactive tab.
		await preparePageForScreenshot(page, signal, this.#activateForScreenshot);
		screenshotQuality(opts);
		const threshold = screenshotThreshold(opts.threshold);
		const changeDetection = opts.ifChanged === true || opts.threshold !== undefined;
		const captureFormat = opts.format ?? "png";
		const captureMime = captureFormat === "jpeg" ? ("image/jpeg" as const) : ("image/png" as const);
		let clip: Rect | undefined;
		if (opts.selector) {
			const node = await this.#selectorNode(opts.selector, QUICK_OP_TIMEOUT_MS, "present", signal);
			// Best-effort: a clipped capture of an off-screen element still renders.
			await scrollIntoView(node, signal).catch(() => undefined);
			const box = await boundingBox(node, await sessionOffset(page, node.session, signal), signal);
			if (!box) throw new ToolError(`Screenshot selector ${JSON.stringify(opts.selector)} has no visible box`);
			clip = box;
		}
		const annotationTargets = opts.annotate ? await this.#annotationTargets(signal) : [];
		const cleanupAnnotations = opts.annotate
			? await installScreenshotAnnotations(page, annotationTargets, signal)
			: async (): Promise<void> => {};
		// A background tab in the user's Chrome produces no frames to wait for.
		const waitForFrame = !this.#managedChrome;
		let comparisonBuffer: Uint8Array;
		let buffer: Uint8Array;
		try {
			comparisonBuffer = await captureScreenshotBuffer(page, opts, signal, clip, "png", waitForFrame);
			buffer =
				captureFormat === "png"
					? comparisonBuffer
					: await captureScreenshotBuffer(page, opts, signal, clip, captureFormat, waitForFrame);
		} finally {
			await cleanupAnnotations();
		}
		let changeResult: ScreenshotChangeResult | undefined;
		if (changeDetection) {
			const scope = screenshotScope(opts);
			const previous = this.#screenshotHistory.get(scope);
			const pixelChangeRatio = previous ? pngPixelChangeRatio(previous.png, comparisonBuffer) : 1;
			const changed = !previous || pixelChangeRatio > threshold;
			const revision = previous ? previous.revision + (changed ? 1 : 0) : 1;
			this.#screenshotHistory.set(scope, { png: comparisonBuffer, revision });
			changeResult = { changed, revision, pixelChangeRatio };
			if (!changed) return changeResult;
		}
		const resized = await resizeImage(
			{ type: "image", data: buffer.toBase64(), mimeType: captureMime },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70, excludeWebP: session.excludeWebP },
		);
		const preserveFormat = opts.format !== undefined;
		const saveFullRes = !!session.browserScreenshotDir || preserveFormat;
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
			if (opts.annotate) lines.push(formatScreenshotLegend(annotationTargets));
			output.push({ type: "text", text: lines.join("\n") });
			info.imageIndex = output.imageCount;
			output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		}
		if (changeResult) return { ...changeResult, path: dest };
		return dest;
	}

	/** Boxes of the controls one observation numbers, labelled by their stable ref ids. */
	async #annotationTargets(signal: AbortSignal | undefined): Promise<ScreenshotAnnotationTarget[]> {
		const page = this.#requirePage();
		const observation = await this.#collectObservation({ display: false, signal });
		const targets: ScreenshotAnnotationTarget[] = [];
		for (const entry of observation.elements) {
			const node = this.#refNode(entry.id);
			const box = await boundingBox(node, await sessionOffset(page, node.session, signal), signal).catch(() => null);
			if (!box || box.width <= 0 || box.height <= 0) continue;
			targets.push({ id: entry.id, role: entry.role, name: entry.name, ...box });
		}
		return targets;
	}

	async #diffScreenshot(
		session: SessionSnapshot,
		output: RunOutput,
		screenshots: ScreenshotResult[],
		signal: AbortSignal | undefined,
		baselinePath: string,
		opts: DiffScreenshotOptions = {},
	): Promise<DiffScreenshotResult> {
		const page = this.#requirePage();
		await preparePageForScreenshot(page, signal, this.#activateForScreenshot);
		const absoluteBaseline = resolveToCwd(baselinePath, session.cwd);
		const baseline = await untilAborted(signal, () => fs.promises.readFile(absoluteBaseline));
		const current = await captureScreenshotBuffer(page, {}, signal, undefined, "png", !this.#managedChrome);
		const diff = createPngDiff(baseline, current);
		const threshold = screenshotThreshold(opts.threshold);
		const changed = diff.pixelChangeRatio > threshold;
		const diffPath = opts.output
			? resolveToCwd(opts.output, session.cwd)
			: path.join(os.tmpdir(), `omp-screenshot-diff-${Snowflake.next()}.png`);
		await fs.promises.mkdir(path.dirname(diffPath), { recursive: true });
		await Bun.write(diffPath, diff.png);
		const resized = await resizeImage(
			{ type: "image", data: diff.png.toBase64(), mimeType: "image/png" },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70, excludeWebP: session.excludeWebP },
		);
		const info: ScreenshotResult = {
			dest: diffPath,
			mimeType: "image/png",
			bytes: diff.png.length,
			width: resized.width,
			height: resized.height,
		};
		screenshots.push(info);
		output.push({
			type: "text",
			text: `Screenshot diff: ${diff.pixelChangeRatio.toFixed(6)} changed-pixel ratio (${changed ? "changed" : "unchanged"}); saved to ${diffPath}`,
		});
		info.imageIndex = output.imageCount;
		output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		return { pixelChangeRatio: diff.pixelChangeRatio, changed, diffPath };
	}

	async #pdf(session: SessionSnapshot, signal: AbortSignal | undefined, opts: PdfOptions = {}): Promise<string> {
		const dest = opts.path
			? resolveToCwd(opts.path, session.cwd)
			: path.join(os.tmpdir(), `omp-browser-${Snowflake.next()}.pdf`);
		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		await untilAborted(signal, () =>
			this.#requirePage().pdf({
				path: dest,
				format: opts.format,
				landscape: opts.landscape,
				scale: opts.scale,
				printBackground: opts.printBackground,
				margin: opts.margin,
				pageRanges: opts.pageRanges,
			}),
		);
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

	/**
	 * Hand files to whatever the node is: a file input takes them directly;
	 * anything else is clicked in case it opens a file chooser, and a drop zone
	 * that opens none receives them as a synthetic drop.
	 */
	async #uploadFile(
		node: CdpNode,
		filePaths: string[],
		label: string,
		signal: AbortSignal,
		cwd: string,
	): Promise<void> {
		if (!filePaths.length) throw new ToolError(`${label} requires at least one file path`);
		const absolute = filePaths.map(filePath => resolveToCwd(filePath, cwd));
		if ((await callOnNode(node, IS_FILE_INPUT, [], signal)) === true) {
			await setFileInput(node, absolute, signal);
			return;
		}
		const page = this.#requirePage();
		const chooserPromise = page.waitForFileChooser({ timeout: 400 }).catch(() => null);
		await clickNode(node, 1, signal, label);
		const chooser = await untilAborted(signal, () => chooserPromise);
		if (chooser) {
			await untilAborted(signal, () => chooser.accept(absolute));
			return;
		}
		const files: { name: string; type: string; data: string }[] = [];
		for (const filePath of absolute) {
			throwIfAborted(signal);
			const file = Bun.file(filePath);
			files.push({
				name: path.basename(filePath),
				type: file.type || "application/octet-stream",
				data: Buffer.from(await file.arrayBuffer()).toString("base64"),
			});
		}
		await callOnNode(node, DROP_FILES, [files], signal);
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
	 * `input` holds page focus emulation around pointer and keyboard dispatch in
	 * managed Chrome, whose tab the user is not looking at.
	 */
	#createElement(
		node: CdpNode,
		cwd: string,
		op: ElementOp,
		input: <T>(signal: AbortSignal, action: () => Promise<T>) => Promise<T>,
	): TabElement {
		const page = this.#requirePage();
		const label = (method: string): string => `${node.label}.${method}()`;
		const read = <R>(method: keyof typeof ELEMENT_READS, ...args: unknown[]): Promise<R> =>
			op(label(method), sig => callOnNode(node, onElement(ELEMENT_READS[method]), args, sig)) as Promise<R>;
		return {
			click: options =>
				op(label("click"), sig => input(sig, () => clickNode(node, options?.count ?? 1, sig, label("click")))),
			dblclick: () => op(label("dblclick"), sig => input(sig, () => clickNode(node, 2, sig, label("dblclick")))),
			check: () => op(label("check"), sig => input(sig, () => setNodeChecked(node, true, label("check"), sig))),
			uncheck: () =>
				op(label("uncheck"), sig => input(sig, () => setNodeChecked(node, false, label("uncheck"), sig))),
			highlight: options => op(label("highlight"), sig => highlightNode(node, options, sig)),
			hover: () => op(label("hover"), sig => input(sig, () => hoverNode(node, sig))),
			type: text =>
				op(label("type"), sig => input(sig, () => typeIntoNode(node, text, sig, this.#heldModifiers))),
			fill: value => op(label("fill"), sig => input(sig, () => fillNode(node, value, sig))),
			press: key =>
				op(label("press"), sig =>
					input(sig, async () => {
						await focusNode(node, sig);
						await pressChord(node.session, key, sig, this.#heldModifiers);
					}),
				),
			focus: () => op(label("focus"), sig => focusNode(node, sig)),
			scrollIntoView: () => op(label("scrollIntoView"), sig => scrollIntoView(node, sig)),
			select: (...values) => op(label("select"), sig => selectOptions(node, values, sig)),
			uploadFile: (...filePaths) =>
				op(label("uploadFile"), sig => input(sig, () => this.#uploadFile(node, filePaths, label("uploadFile"), sig, cwd))),
			boundingBox: () =>
				op(label("boundingBox"), async sig => boundingBox(node, await sessionOffset(page, node.session, sig), sig)),
			isVisible: () =>
				op(label("isVisible"), async sig =>
					Boolean(await boundingBox(node, await sessionOffset(page, node.session, sig), sig)),
				),
			isHidden: () =>
				op(label("isHidden"), async sig => !(await boundingBox(node, await sessionOffset(page, node.session, sig), sig))),
			text: () => read("text"),
			html: () => read("html"),
			value: () => read("value"),
			attr: name => read("attr", name),
			styles: props => read("styles", props ?? [...DEFAULT_STYLE_PROPERTIES]),
			isEnabled: () => read("isEnabled"),
			isChecked: () => read("isChecked"),
			evaluate: (fn, ...args) =>
				op(label("evaluate"), sig => callOnNode(node, onElement(fn), args, sig)) as never,
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
		await this.#recording.close().catch(error => {
			this.#log("warn", "Failed to finalize active browser recording during tab close", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		await this.#webmcp?.dispose().catch(() => undefined);
		this.#webmcp = undefined;
		this.#dialogs?.dispose();
		await this.#network?.close();
		await this.#downloads?.close().catch(() => undefined);
		await this.#tracing?.dispose();
		await this.#consoleCapture.detach();
		this.#emulation?.dispose();
		if (this.#mode === "headless" && page && !page.isClosed()) await page.close().catch(() => undefined);
		if (this.#browser?.connected) this.#browser.disconnect();
		this.#transport.send({ type: "closed" });
		this.#transport.close();
	}

	#requirePage(): Page {
		if (!this.#page) throw new ToolError("Tab worker is not initialized");
		return this.#page;
	}

	#requireDialogs(): RuntimeDialogController {
		if (this.#managedChrome)
			throw new ToolError(
				"In the user's Chrome a dialog is answered from Eval, outside tab.run: await tab.dialog() returns it with its id, then await tab.handleDialog({ accept, id, text? }). Dialogs there are never answered automatically, so setDialogs() does not apply.",
			);
		if (!this.#dialogs) throw new ToolError("Tab worker dialog handling is not initialized");
		return this.#dialogs;
	}

	#requireNetwork(): BrowserNetworkManager {
		if (!this.#network) throw new ToolError("Tab worker network manager is not initialized");
		return this.#network;
	}

	#requireTracing(): BrowserTracingController {
		if (!this.#tracing) throw new ToolError("Tab worker tracing is not initialized");
		return this.#tracing;
	}

	#requireInitScripts(): InitScriptManager {
		if (!this.#initScripts) throw new ToolError("Tab worker init scripts are not initialized");
		return this.#initScripts;
	}

	#requireDownloads(): TabDownloadSource {
		if (!this.#downloads)
			throw new ToolError(`Download observation unavailable: ${this.#downloadObservationError ?? "not initialized"}`);
		return this.#downloads;
	}

	/** Emulation starts from the page's own user agent, read the first time an override is asked for. */
	async #requireEmulation(): Promise<BrowserEmulationController> {
		if (this.#emulation) return this.#emulation;
		const page = this.#requirePage();
		const baseUserAgent = (await page.evaluate(() => navigator.userAgent)) as string;
		this.#emulation ??= new BrowserEmulationController(
			page,
			loadedKnownDevices(),
			loadedNetworkConditions(),
			baseUserAgent,
		);
		return this.#emulation;
	}

	/** Worker-owned tabs install the WebMCP hook at start; the user's Chrome gets it on first use. */
	async #requireWebMcp(): Promise<WebMcpController> {
		this.#webmcp ??= await installWebMcp(this.#requirePage());
		return this.#webmcp;
	}

	#requireBrowser(): Browser {
		if (!this.#browser) throw new ToolError("Tab worker is not initialized");
		return this.#browser;
	}

	#log(level: "debug" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
		this.#transport.send({ type: "log", level, msg, meta });
	}
}
