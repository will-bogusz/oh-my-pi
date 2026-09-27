type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
type BrowserDragTarget = string | { x: number; y: number };
type BrowserMouseButton = "left" | "right" | "middle" | "back" | "forward";
interface BrowserWaitOptions {
	/** milliseconds */
	timeout?: number;
}
interface BrowserWaitForSelectorOptions extends BrowserWaitOptions {
	visible?: boolean;
	hidden?: boolean;
}
interface BrowserObserveOptions {
	/** every node gets a ref (default: controls only) */
	includeAll?: boolean;
	/** only controls inside the viewport get refs */
	viewportOnly?: boolean;
	/** observe only the subtree of the first match */
	selector?: string;
	/** only controls and the nodes containing them */
	compact?: boolean;
	/** false: full tree instead of the diff since the previous observation */
	diff?: boolean;
	/** false: do not print the tree (it is printed by default) */
	display?: boolean;
}
interface BrowserInitialObservationOptions extends BrowserObserveOptions {
	screenshot?: boolean;
}
interface BrowserChromeOptions {
	browserId?: string;
	timeout?: number;
	app?: { relay?: boolean };
}
interface BrowserAcquireOptions extends BrowserChromeOptions {
	label?: string;
	observation?: BrowserInitialObservationOptions;
}
interface BrowserOpenOptions {
	name?: string;
	url?: string;
	app?: { path?: string; cdp_url?: string; relay?: boolean; args?: string[]; target?: string };
	viewport?: { width: number; height: number; scale?: number };
	wait_until?: BrowserWaitUntil;
	dialogs?: "accept" | "dismiss";
	/** request hostnames allowed (exact or `*.example.com`); everything else is aborted */
	allowed_domains?: string[];
	/** document-start sources or cwd-relative file paths */
	init_scripts?: string[];
	/** cwd-relative download directory */
	downloads?: string;
	user_agent?: string;
	ignore_https_errors?: boolean;
	allow_file_access?: boolean;
	/** override browser.headless for this open */
	headed?: boolean;
	persist?: boolean;
	timeout?: number;
	observation?: BrowserInitialObservationOptions;
}
interface BrowserCloseOptions {
	name?: string;
	all?: boolean;
	kill?: boolean;
	timeout?: number;
}
interface BrowserRunOptions {
	args?: unknown[];
	/** seconds */
	timeout?: number;
}
interface BrowserObservation {
	snapshot?: string;
	url: string;
	title?: string;
	viewport: { width: number; height: number; deviceScaleFactor?: number };
	scroll: { x: number; y: number; width: number; height: number; scrollWidth: number; scrollHeight: number };
	focused?: string;
	/** text tree (or diff vs previous observation); printed automatically */
	tree: string;
	/** controls only; refs stable for the tab */
	elements: {
		ref?: string;
		id: number;
		role: string;
		name?: string;
		value?: string | number;
		description?: string;
		keyshortcuts?: string;
		states: string[];
	}[];
}
/** compact discovery row; `{ full: true }` adds the rest */
interface BrowserDiscoveredTab {
	id: string;
	title: string;
	url: string;
	active: boolean;
	ownership: "available" | "this_actor" | "other_actor";
	popupOf?: string;
	browserId?: string;
}
interface BrowserDiscoveredTabFull extends BrowserDiscoveredTab {
	browserId: string;
	browserLabel: string;
	tabId: number;
	windowId: number;
	pinned: boolean;
	groupId: number;
}
/** a tab this session opened with browser.open */
interface BrowserManagedTab {
	name: string;
	url: string;
	title: string;
	targetId: string;
	kind: "headless" | "spawned" | "connected" | "relay" | "cmux";
	persist: boolean;
}
/** the pending JavaScript dialog; in the user's Chrome answering needs its `id` */
interface BrowserDialogState {
	open: boolean;
	type?: string;
	message?: string;
	defaultValue?: string;
	/** user's Chrome: pass to handleDialog; a stale id is refused */
	id?: string;
	url?: string;
	/** user's Chrome: false while OMP was not attached to see a dialog */
	observed?: false;
}
/** one download the tab started; `path` is the saved file once completed */
interface BrowserDownload {
	path?: string;
	suggestedFilename: string;
	url: string;
	state: "inProgress" | "completed" | "canceled";
	bytes: number;
}
/** an option's text or value as a string, which must name exactly one option, or Playwright's object form */
type BrowserSelectOption = string | { label?: string; value?: string };
interface BrowserScreenshotOptions {
	selector?: string;
	fullPage?: boolean;
	silent?: boolean;
	/** outline and number the observed controls */
	annotate?: boolean;
	format?: "png" | "jpeg";
	/** jpeg only, 0-100 */
	quality?: number;
	/** return { changed: false } instead of a capture when nothing changed */
	ifChanged?: boolean;
	/** changed-pixel ratio (0-1) that still counts as unchanged */
	threshold?: number;
	/** save the model-size image even when browser.screenshotDir keeps full resolution */
	preview?: boolean;
}
interface BrowserScreenshotChangeResult {
	path?: string;
	changed: boolean;
	revision: number;
	pixelChangeRatio: number;
}
interface BrowserPdfOptions {
	path?: string;
	format?: "letter" | "legal" | "tabloid" | "ledger" | "a0" | "a1" | "a2" | "a3" | "a4" | "a5" | "a6";
	landscape?: boolean;
	scale?: number;
	printBackground?: boolean;
	margin?: { top?: string | number; bottom?: string | number; left?: string | number; right?: string | number };
	pageRanges?: string;
}
interface BrowserAriaSnapshotOptions {
	depth?: number;
	boxes?: boolean;
	/** keep interactive nodes and the path to them */
	interactive?: boolean;
	/** drop unnamed wrappers without controls */
	compact?: boolean;
	/** append link destinations */
	urls?: boolean;
	/** revisioned result against the previous snapshot of the same scope */
	diff?: boolean;
}
type BrowserAriaSnapshotDiffResult =
	| { status: "full"; revision: number; snapshot: string }
	| { status: "unchanged"; revision: number }
	| { status: "delta"; revision: number; baseRevision: number; delta: string };
interface BrowserA11yViolation {
	id: string;
	impact: string | null;
	help: string;
	helpUrl: string;
	tags: string[];
	nodeCount: number;
	nodes: { target: string[] | string[][]; html: string; failureSummary: string }[];
}
interface BrowserA11yResult {
	url: string;
	engine: { name: "axe-core"; version: string };
	counts: { violations: number; incomplete: number; passes: number };
	violations: BrowserA11yViolation[];
	incomplete: BrowserA11yViolation[];
}
interface BrowserEmulateOptions {
	viewport?: { width: number; height: number; scale?: number };
	/** a name from tab.devices() */
	device?: string;
	geolocation?: { latitude: number; longitude: number; accuracy?: number } | null;
	offline?: boolean;
	colorScheme?: "dark" | "light" | "no-preference";
	reducedMotion?: boolean;
	headers?: Record<string, string> | null;
	credentials?: { username: string; password: string } | null;
	userAgent?: string | null;
	timezone?: string | null;
	locale?: string | null;
	cpuThrottling?: number | null;
	network?: "slow3g" | "fast3g" | { download: number; upload: number; latency: number } | null;
}
interface BrowserCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	sameSite: "Strict" | "Lax" | "None";
}
interface BrowserCookieInput {
	name: string;
	value: string;
	domain?: string;
	path?: string;
	url?: string;
	expires?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "Strict" | "Lax" | "None";
}
type BrowserStorageKind = "local" | "session";
type BrowserConsoleLevel = "log" | "info" | "warn" | "error" | "debug";
interface BrowserCaptureResult<TEntry> {
	entries: TEntry[];
	nextSeq: number;
	dropped: number;
}
interface BrowserConsoleEntry {
	seq: number;
	ts: number;
	type: "console";
	level: BrowserConsoleLevel;
	text: string;
	location?: string;
	args: unknown[];
}
interface BrowserErrorEntry {
	seq: number;
	ts: number;
	type: "pageerror" | "requestfailed";
	level: "error";
	text: string;
	location?: string;
	stack?: string;
}
interface BrowserRouteOptions {
	abort?: boolean;
	resourceType?: string | string[];
	status?: number;
	headers?: Record<string, string>;
	contentType?: string;
	body?: string | object;
	delay?: number;
}
interface BrowserRequestRecord {
	id: string;
	seq: number;
	ts: number;
	method: string;
	url: string;
	resourceType: string;
	status?: number;
	ok?: boolean;
	failureText?: string;
	durationMs?: number;
	requestHeaders: Record<string, string>;
	responseHeaders?: Record<string, string>;
	sizes: { requestBody: number; responseBody?: number };
}
interface BrowserRequestDetail extends BrowserRequestRecord {
	body?: string | { base64: string };
	contentType?: string;
	bodyTruncated?: boolean;
}
interface BrowserRequestsOptions {
	filter?: string | RegExp;
	type?: string | string[];
	method?: string | string[];
	status?: number | string;
	since?: number;
	clear?: boolean;
	limit?: number;
}
/** page-provided and untrusted: discovery never authorizes invoking a tool */
interface BrowserWebMcpTool {
	name: string;
	description: string;
	frameId: string;
	origin: string;
	inputSchema?: unknown;
	annotations?: unknown;
	untrusted: true;
}
type BrowserWebMcpInvokeResult =
	| { ok: true; result: unknown; truncated?: boolean; originalBytes?: number; untrusted: true }
	| { ok: false; error: string; untrusted: true };
interface BrowserWebMcpCatalogEvent {
	sequence: number;
	type: "registered" | "updated" | "unregistered";
	name: string;
	frameId: string;
	origin: string;
	timestamp: number;
	untrusted: true;
}
type BrowserBoundedJson =
	| null
	| string
	| number
	| boolean
	| BrowserBoundedJson[]
	| { [key: string]: BrowserBoundedJson };
interface BrowserVitalsResult {
	url: string;
	lcp: number;
	cls: number;
	fcp: number;
	ttfb: number;
	inp: number;
	domContentLoaded: number;
	load: number;
	hydration?: { framework: string; hydratedAt?: number };
	longTasks: number;
}
interface BrowserReactTreeNode {
	id: number;
	name: string;
	type: string;
	key?: string;
	props: Record<string, BrowserBoundedJson>;
	children: BrowserReactTreeNode[];
}
interface BrowserReactInspectResult {
	name: string;
	props: BrowserBoundedJson;
	state?: { index: number; kind: string; value: BrowserBoundedJson }[] | BrowserBoundedJson;
	source?: { fileName?: string; lineNumber?: number; columnNumber?: number; owner?: string };
	domSelector?: string;
}
interface BrowserReactSuspenseBoundary {
	id: number;
	name?: string;
	state: "pending" | "resolved";
	fallback?: BrowserBoundedJson;
	classification: "static" | "dynamic";
}
interface BrowserRecordingOptions {
	fps?: number;
	/** overlay the pointer */
	cursor?: boolean;
	/** save a sheet of changed frames */
	contactSheet?: boolean;
	contactSheetThreshold?: number;
	quality?: number;
}
interface BrowserTabHelpers {
	title(): Promise<string>;
	goto(url: string, options?: { waitUntil?: BrowserWaitUntil }): Promise<void>;
	/** Step one entry back through this tab's own session history; returns the URL. */
	back(): Promise<string>;
	/** Step one entry forward; only meaningful after a `back()`. */
	forward(): Promise<string>;
	/** returns the URL */
	reload(options?: { waitUntil?: BrowserWaitUntil }): Promise<string>;
	/** client-side navigation (Next.js router or History API) */
	pushState(url: string): Promise<string>;
	frames(): Promise<{ id: string; name: string; url: string; parentId: string | null; selector?: string }[]>;
	dialog(): Promise<BrowserDialogState>;
	/** `id` from dialog() is required in the user's Chrome */
	handleDialog(options: { accept: boolean; text?: string; id?: string }): Promise<void>;
	/** auto-answer later dialogs; never in the user's Chrome */
	setDialogs(policy: "accept" | "dismiss" | null): Promise<void>;
	/** settles, prints the tree (diff by default), returns it */
	observe(options?: BrowserObserveOptions): Promise<BrowserObservation>;
	ariaSnapshot(
		selector?: string,
		options?: BrowserAriaSnapshotOptions,
	): Promise<string | BrowserAriaSnapshotDiffResult>;
	/** axe-core audit; prints a summary */
	a11y(options?: { tags?: string[]; rules?: string[]; selector?: string; includeIncomplete?: boolean }): Promise<BrowserA11yResult>;
	webmcpList(options?: { name?: string; frame?: string }): Promise<{
		status: "ready" | "unavailable";
		tools: BrowserWebMcpTool[];
		truncated: boolean;
		reason?: string;
		untrusted: true;
	}>;
	webmcpInvoke(
		name: string,
		params: Record<string, unknown>,
		options?: { frame?: string; timeout?: number },
	): Promise<BrowserWebMcpInvokeResult>;
	webmcpEvents(options?: { since?: number; clear?: boolean }): Promise<{
		events: BrowserWebMcpCatalogEvent[];
		cursor: number;
		truncated: boolean;
		untrusted: true;
	}>;
	/** returns the saved path, or change metadata with ifChanged/threshold */
	screenshot(options?: BrowserScreenshotOptions): Promise<string | BrowserScreenshotChangeResult>;
	diffScreenshot(
		baselinePath: string,
		options?: { threshold?: number; output?: string },
	): Promise<{ pixelChangeRatio: number; changed: boolean; diffPath: string }>;
	/** returns the saved path */
	pdf(options?: BrowserPdfOptions): Promise<string>;
	/** readable article text; positional format, default "text" */
	extract(
		format?: "text" | "markdown",
		options?: { selector?: string; outline?: boolean; filter?: string },
	): Promise<string>;
	click(selector: string): Promise<void>;
	dblclick(selector: string): Promise<void>;
	hover(selector: string): Promise<void>;
	focus(selector: string): Promise<void>;
	check(selector: string): Promise<void>;
	uncheck(selector: string): Promise<void>;
	/** outline an element for `duration` ms (default 2000) */
	highlight(selector: string, options?: { duration?: number }): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	press(key: string, options?: { selector?: string }): Promise<void>;
	/** a held modifier applies to later press/type */
	keyDown(key: string): Promise<void>;
	keyUp(key: string): Promise<void>;
	mouseMove(x: number, y: number, options?: { steps?: number }): Promise<void>;
	mouseDown(options?: { button?: BrowserMouseButton }): Promise<void>;
	mouseUp(options?: { button?: BrowserMouseButton }): Promise<void>;
	clickAt(x: number, y: number, options?: { button?: BrowserMouseButton; clickCount?: number }): Promise<void>;
	wheel(deltaX: number, deltaY: number): Promise<void>;
	/** pixel deltas, or a direction stepping a page (90% of the viewport or `selector` element) */
	scroll(
		deltaXOrDirection: number | "up" | "down" | "left" | "right",
		deltaYOrOptions?: number | { by?: number | "page"; selector?: string },
		options?: { selector?: string },
	): Promise<void>;
	drag(from: BrowserDragTarget, to: BrowserDragTarget): Promise<void>;
	evaluate<R, A extends unknown[]>(fn: string | ((...args: A) => R | Promise<R>), ...args: A): Promise<R>;
	scrollIntoView(selector: string): Promise<void>;
	select(selector: string, ...values: BrowserSelectOption[]): Promise<string[]>;
	/** file input, file-chooser trigger, or drop zone */
	uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
	waitForUrl(pattern: string | RegExp, options?: BrowserWaitOptions): Promise<string>;
	/** first match; null when none */
	text(selector: string): Promise<string | null>;
	html(selector: string): Promise<string | null>;
	value(selector: string): Promise<string | null>;
	attr(selector: string, name: string): Promise<string | null>;
	count(selector: string): Promise<number>;
	box(selector: string): Promise<{ x: number; y: number; width: number; height: number } | null>;
	styles(selector: string, props?: string[]): Promise<Record<string, string> | null>;
	isVisible(selector: string): Promise<boolean>;
	isEnabled(selector: string): Promise<boolean>;
	isChecked(selector: string): Promise<boolean>;
	waitForText(text: string, options?: BrowserWaitOptions & { selector?: string; exact?: boolean }): Promise<void>;
	/** merges overrides; no argument returns the current state */
	emulate(options?: BrowserEmulateOptions): Promise<BrowserEmulateOptions>;
	devices(): Promise<string[]>;
	clipboardRead(): Promise<{ text: string; source: "page" | "shim" }>;
	clipboardWrite(text: string): Promise<{ source: "page" | "shim" }>;
	clipboardCopy(): Promise<{ source: "page" | "shim" }>;
	clipboardPaste(): Promise<{ source: "page" | "shim" }>;
	cookies(options?: { urls?: string[] }): Promise<BrowserCookie[]>;
	/** objects, a raw Cookie header, a DevTools cURL dump, or a JSON array; a trailing { domain?, url? } scopes raw pairs */
	setCookies(...cookies: (BrowserCookieInput | string | { domain?: string; url?: string })[]): Promise<void>;
	clearCookies(options?: { names?: string[] }): Promise<void>;
	storage(kind: BrowserStorageKind, options?: { key?: string }): Promise<Record<string, string> | string | null>;
	setStorage(kind: BrowserStorageKind, key: string, value: unknown): Promise<void>;
	setStorage(kind: BrowserStorageKind, entries: Record<string, unknown>): Promise<void>;
	clearStorage(kind: BrowserStorageKind): Promise<void>;
	/** Playwright-compatible cookies + current-origin storage; returns the path */
	saveState(path?: string): Promise<string>;
	loadState(path: string): Promise<{ loadedOrigins: string[]; skippedOrigins: string[] }>;
	addInitScript(source: string): Promise<{ id: string }>;
	removeInitScript(id: string): Promise<void>;
	initScripts(): Promise<{ id: string; source: string }[]>;
	waitForDownload(options?: BrowserWaitOptions): Promise<BrowserDownload>;
	downloads(): Promise<BrowserDownload[]>;
	console(options?: {
		level?: BrowserConsoleLevel;
		since?: number;
		clear?: boolean;
		limit?: number;
	}): Promise<BrowserCaptureResult<BrowserConsoleEntry>>;
	errors(options?: { since?: number; clear?: boolean; limit?: number }): Promise<BrowserCaptureResult<BrowserErrorEntry>>;
	clearConsole(): Promise<void>;
	traceStart(options?: { screenshots?: boolean; categories?: string[] }): Promise<void>;
	/** returns the saved path */
	traceStop(options?: { path?: string }): Promise<string>;
	profileStart(): Promise<void>;
	profileStop(options?: { path?: string }): Promise<string>;
	metrics(): Promise<{ [name: string]: number; domContentLoaded: number; load: number }>;
	/** persistent until unroute or tab close; glob or RegExp */
	route(pattern: string | RegExp, options?: BrowserRouteOptions): Promise<void>;
	unroute(pattern?: string | RegExp): Promise<void>;
	routes(): Promise<{ pattern: string | { source: string; flags: string }; options: BrowserRouteOptions }[]>;
	requests(options?: BrowserRequestsOptions): Promise<BrowserRequestRecord[]>;
	request(id: string | number): Promise<BrowserRequestDetail>;
	clearRequests(): Promise<void>;
	harStart(options?: { content?: "text" | "all" | "none" }): Promise<void>;
	harStop(options?: { path?: string }): Promise<string>;
	allowedDomains(): Promise<string[]>;
	vitals(options?: { reload?: boolean }): Promise<BrowserVitalsResult>;
	/** installs the DevTools hook and reloads; call before the other react* helpers */
	reactEnable(): Promise<{ installed: boolean; reactVersion?: string }>;
	reactTree(options?: { maxDepth?: number; includeHost?: boolean }): Promise<BrowserReactTreeNode[]>;
	reactInspect(id: number): Promise<BrowserReactInspectResult>;
	reactRenders(options: { action: "start" | "stop" | "status" }): Promise<{
		active?: boolean;
		commits: number;
		components: { name: string; renders: number; totalMs: number }[];
	}>;
	reactSuspense(options?: { onlyDynamic?: boolean }): Promise<BrowserReactSuspenseBoundary[]>;
	/** .mp4 (H.264) or .webm */
	recordStart(path: string, options?: BrowserRecordingOptions): Promise<{ path: string; fps: number }>;
	recordStop(): Promise<{ path: string; durationMs: number; frames: number; bytes: number; contactSheet?: string }>;
	recordRestart(path: string, options?: BrowserRecordingOptions): Promise<{ path: string; fps: number }>;
	recording(): Promise<{ active: boolean; path?: string; fps?: number; durationMs?: number; frames?: number }>;
}
interface BrowserElement {
	click(options?: { count?: number; button?: BrowserMouseButton }): Promise<void>;
	dblclick(): Promise<void>;
	check(): Promise<void>;
	uncheck(): Promise<void>;
	highlight(options?: { duration?: number }): Promise<void>;
	type(text: string): Promise<void>;
	fill(value: string): Promise<void>;
	press(key: string): Promise<void>;
	hover(): Promise<void>;
	focus(): Promise<void>;
	select(...values: BrowserSelectOption[]): Promise<string[]>;
	uploadFile(...filePaths: string[]): Promise<void>;
	scrollIntoView(): Promise<void>;
	boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
	isVisible(): Promise<boolean>;
	isHidden(): Promise<boolean>;
	text(): Promise<string>;
	html(): Promise<string>;
	value(): Promise<string | null>;
	attr(name: string): Promise<string | null>;
	styles(props?: string[]): Promise<Record<string, string>>;
	isEnabled(): Promise<boolean>;
	isChecked(): Promise<boolean>;
	evaluate<R, A extends unknown[]>(
		fn: string | ((element: unknown, ...args: A) => R | Promise<R>),
		...args: A
	): Promise<R>;
}
/** one child frame, from tab.frame(selector | name | url) */
interface BrowserFrame {
	click(selector: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	press(key: string, options?: { selector?: string }): Promise<void>;
	text(selector: string): Promise<string>;
	html(selector: string): Promise<string>;
	value(selector: string): Promise<string>;
	attr(selector: string, name: string): Promise<string | null>;
	count(selector: string): Promise<number>;
	isVisible(selector: string): Promise<boolean>;
	ariaSnapshot(selector?: string, options?: BrowserAriaSnapshotOptions): Promise<string>;
	evaluate<R, A extends unknown[]>(fn: string | ((...args: A) => R | Promise<R>), ...args: A): Promise<R>;
	waitFor(selector: string, options?: BrowserWaitForSelectorOptions): Promise<boolean>;
	waitForSelector(selector: string, options?: BrowserWaitForSelectorOptions): Promise<boolean>;
	/** returns the saved path */
	screenshot(selector: string): Promise<string>;
}
interface BrowserTabRealm extends BrowserTabHelpers {
	name: string;
	/** Puppeteer, not Playwright (no locator()) */
	page: unknown;
	signal?: AbortSignal;
	url(): string;
	waitFor(selector: string, options?: BrowserWaitOptions): Promise<BrowserElement>;
	waitForSelector(selector: string, options?: BrowserWaitForSelectorOptions): Promise<BrowserElement | null>;
	waitForResponse(
		pattern: string | RegExp | ((response: unknown) => boolean | Promise<boolean>),
		options?: BrowserWaitOptions,
	): Promise<unknown>;
	waitForNavigation(options?: BrowserWaitOptions & { waitUntil?: BrowserWaitUntil }): Promise<unknown | null>;
	id(id: number): Promise<BrowserElement>;
	ref(id: string): Promise<BrowserElement>;
	frame(selectorOrNameOrUrl: string): Promise<BrowserFrame>;
}
interface BrowserRunScope {
	tab: BrowserTabRealm;
	/** Puppeteer */
	page: unknown;
	browser: unknown;
	wait: {
		(milliseconds: number): Promise<void>;
		<R>(predicate: () => R | Promise<R>, options?: BrowserWaitOptions & { interval?: number }): Promise<R>;
	};
	assert: (condition: unknown, message?: string) => void;
}
interface BrowserTab extends BrowserTabHelpers {
	name: string;
	handle?: string;
	/** stable identity: `target.id` is what discover lists and claim takes */
	target?: { id: string; browserId: string; tabId: number };
	initialObservation?: BrowserObservation;
	/** saved path */
	initialScreenshot?: string;
	inspectionError?: string;
	screenshotError?: string;
	initialDialog?: BrowserDialogState;
	url(): Promise<string>;
	id(id: number): BrowserElement;
	ref(id: string): BrowserElement;
	frame(selectorOrNameOrUrl: string): BrowserFrame;
	waitFor(selector: string, options?: BrowserWaitOptions): Promise<boolean>;
	waitForSelector(selector: string, options?: BrowserWaitForSelectorOptions): Promise<boolean>;
	run<R>(fn: (scope: BrowserRunScope, ...args: unknown[]) => R | Promise<R>, options?: BrowserRunOptions): Promise<R>;
	run<R = unknown>(code: string, options?: BrowserRunOptions): Promise<R>;
	popups(): Promise<BrowserDiscoveredTabFull[]>;
	reveal(): Promise<void>;
	release(): Promise<void>;
	close(options?: { kill?: boolean; timeout?: number }): Promise<void>;
}
declare const browser: {
	getTab(
		selector: string | { title?: string; url?: string; browserId?: string; windowId?: number },
		options?: Omit<BrowserAcquireOptions, "browserId">,
	): Promise<BrowserTab>;
	/** title/url filter by substring, as getTab matches */
	discover(options?: BrowserChromeOptions & { title?: string; url?: string; full?: false }): Promise<BrowserDiscoveredTab[]>;
	discover(options: BrowserChromeOptions & { title?: string; url?: string; full: true }): Promise<BrowserDiscoveredTabFull[]>;
	claim(id: string, options?: BrowserAcquireOptions): Promise<BrowserTab>;
	create(options?: BrowserAcquireOptions & { url?: string }): Promise<BrowserTab>;
	closeTab(id: string, options?: BrowserChromeOptions): Promise<void>;
	instances(): Promise<{ id: string; label: string; connected: boolean }[]>;
	open(options?: BrowserOpenOptions): Promise<BrowserTab>;
	tab(name?: string): BrowserTab;
	/** tabs this session opened with browser.open */
	tabs(): Promise<BrowserManagedTab[]>;
	/** Print this declaration file — every interface and signature above. Read tier, no tab needed. */
	help(): Promise<void>;
	close(options?: BrowserCloseOptions): Promise<void>;
};
