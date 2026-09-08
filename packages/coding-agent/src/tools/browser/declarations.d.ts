/** Navigation lifecycle accepted by browser open and goto operations. */
type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

/** Browser application or attachment selection. */
interface BrowserAppOptions {
	/** Absolute or cwd-relative browser/Electron executable to spawn. */
	path?: string;
	/** HTTP Chrome DevTools Protocol discovery endpoint to attach to. */
	cdp_url?: string;
	/** Drive the user's existing Chrome tabs through the omp Browser Relay. */
	relay?: boolean;
	/** Extra command-line arguments for a spawned executable. */
	args?: string[];
	/** URL/title substring used to select an attached tab. */
	target?: string;
}

/** Requested browser page viewport. */
interface BrowserViewportOptions {
	/** Viewport width in CSS pixels. */
	width: number;
	/** Viewport height in CSS pixels. */
	height: number;
	/** Device scale factor. */
	scale?: number;
}

/** Options for opening or reusing a named browser tab. */
interface BrowserOpenOptions {
	/** Tab name; defaults to `"main"`. */
	name?: string;
	/** URL to navigate to after opening or reusing the tab. */
	url?: string;
	/** Browser process, CDP endpoint, or relay selection. */
	app?: BrowserAppOptions;
	/** Requested page viewport. */
	viewport?: BrowserViewportOptions;
	/** Navigation lifecycle to await. */
	wait_until?: BrowserWaitUntil;
	/** Automatic JavaScript-dialog policy. */
	dialogs?: "accept" | "dismiss";
	/** Keep the tab live across turn settle and idle close (default false). */
	persist?: boolean;
	/** Whole-operation timeout in seconds. */
	timeout?: number;
	/** Initial inspection options when opening a managed Chrome tab. */
	observation?: BrowserInitialObservationOptions;
}

/** Options for releasing managed browser tabs. */
interface BrowserCloseOptions {
	/** Tab name; defaults to `"main"`. */
	name?: string;
	/** Release every managed tab instead of one named tab. */
	all?: boolean;
	/** Terminate an owned spawned application after its last tab is released. */
	kill?: boolean;
	/** Whole-operation timeout in seconds. */
	timeout?: number;
}

/** Options for closing the current tab handle. */
interface BrowserTabCloseOptions {
	/** Terminate an owned spawned application after its last tab is released. */
	kill?: boolean;
	/** Whole-operation timeout in seconds. */
	timeout?: number;
}

/** Arguments and budget for code executed by `BrowserTab.run`. */
interface BrowserRunOptions<TArgs extends unknown[] = unknown[]> {
	/** Positional arguments passed after the run-scope object. */
	args?: TArgs;
	/** Execution timeout in seconds. */
	timeout?: number;
}

/** Options for a direct tab navigation. */
interface BrowserGotoOptions {
	/** Navigation lifecycle to await. */
	waitUntil?: BrowserWaitUntil;
}

/** Options for a structured accessibility observation. */
interface BrowserObserveOptions {
	/** Include non-interactive accessibility nodes. */
	includeAll?: boolean;
	/** Limit results to nodes inside the current viewport. */
	viewportOnly?: boolean;
}

/** Initial Chrome inspection includes controls, readable text, and a viewport preview. */
interface BrowserInitialObservationOptions extends BrowserObserveOptions {
	/** Capture and display a background preview; defaults to true. */
	screenshot?: boolean;
}

/** Exact Chrome discovery identity; independent of mutable title, URL, window, or task label. */
interface BrowserTargetIdentity {
	/** Discovery identity for matching popupOf, rediscovery, and explicit closeTab. */
	readonly id: string;
	/** Paired browser profile identity. */
	readonly browserId: string;
	/** Chrome tab number; unique only inside this browser profile. */
	readonly tabId: number;
}

/** Every supplied field must match; multiple matches require an explicit choice. */
interface BrowserTabSelector {
	/** Exact title (case sensitive); requires title or url. */
	title?: string;
	/** Exact URL, including path/query. */
	url?: string;
	/** Narrow to a paired profile. */
	browserId?: string;
	/** Narrow to a Chrome window in that profile. */
	windowId?: number;
}

/** Options for a Playwright-format ARIA snapshot. */
interface BrowserAriaSnapshotOptions {
	/** Maximum tree depth to render. */
	depth?: number;
	/** Append element bounding boxes. */
	boxes?: boolean;
}

/** Options for capturing a browser screenshot. */
interface BrowserScreenshotOptions {
	/** Capture one matching element instead of the page. */
	selector?: string;
	/** Capture the complete scrollable page. */
	fullPage?: boolean;
	/** Save without emitting an Eval image. */
	silent?: boolean;
}

/** Options for keyboard input through a direct tab helper. */
interface BrowserPressOptions {
	/** Send the key to one matching element. */
	selector?: string;
}

/** Options for bounded direct wait helpers. */
interface BrowserWaitOptions {
	/** Wait timeout in milliseconds. */
	timeout?: number;
}

/** Options for polling a predicate inside `tab.run`. */
interface BrowserPollOptions extends BrowserWaitOptions {
	/** Delay between predicate calls in milliseconds. */
	interval?: number;
}

/** Options for waiting on a selector. */
interface BrowserWaitForSelectorOptions extends BrowserWaitOptions {
	/** Require the matching element to be visible. */
	visible?: boolean;
	/** Require the matching element to be hidden. */
	hidden?: boolean;
}

/** Options for waiting on browser navigation inside `tab.run`. */
interface BrowserWaitForNavigationOptions extends BrowserWaitOptions {
	/** Navigation lifecycle to await. */
	waitUntil?: BrowserWaitUntil;
}

/** A point in page coordinates used by drag operations. */
interface BrowserPoint {
	/** Horizontal page coordinate. */
	readonly x: number;
	/** Vertical page coordinate. */
	readonly y: number;
}

/** Selector or page point accepted by drag operations. */
type BrowserDragTarget = string | BrowserPoint;

/** Element bounds in page coordinates. */
interface BrowserBoundingBox {
	/** Left edge. */
	x: number;
	/** Top edge. */
	y: number;
	/** Width. */
	width: number;
	/** Height. */
	height: number;
}

/** One element in a structured browser observation. */
interface BrowserObservationEntry {
	/** Immutable observation reference accepted by tab.ref; invalidated by observation or navigation. */
	ref?: string;
	/** Numeric id accepted by `tab.id`. */
	id: number;
	/** Accessibility role. */
	role: string;
	/** Accessible name. */
	name?: string;
	/** Current accessible value. */
	value?: string | number;
	/** Accessible description. */
	description?: string;
	/** Declared keyboard shortcut. */
	keyshortcuts?: string;
	/** Serialized accessibility states. */
	states: string[];
}

/** Structured result returned by `tab.observe`. */
interface BrowserObservation {
	/** Unique observation identity. */
	snapshot?: string;
	/** Current page URL. */
	url: string;
	/** Current page title. */
	title?: string;
	/** Current viewport. */
	viewport: {
		/** Viewport width. */
		width: number;
		/** Viewport height. */
		height: number;
		/** Device scale factor. */
		deviceScaleFactor?: number;
	};
	/** Current document scroll metrics. */
	scroll: {
		/** Horizontal scroll offset. */
		x: number;
		/** Vertical scroll offset. */
		y: number;
		/** Visible width. */
		width: number;
		/** Visible height. */
		height: number;
		/** Full scrollable width. */
		scrollWidth: number;
		/** Full scrollable height. */
		scrollHeight: number;
	};
	/** Observed accessibility elements. */
	elements: BrowserObservationEntry[];
}

/** Polling/sleep helper available to a browser run function. */
interface BrowserWait {
	/** Sleep for a number of milliseconds. */
	(milliseconds: number): Promise<void>;
	/** Poll until the predicate returns a truthy value. */
	<R>(predicate: () => R | Promise<R>, options?: BrowserPollOptions): Promise<R>;
}

/** Assertion helper available to a browser run function. */
interface BrowserAssert {
	/** Throw with `message` when `condition` is falsy. */
	(condition: unknown, message?: string): asserts condition;
}

/** A download event observed on this page since acquisition. */
interface BrowserDownload {
	id: string;
	url: string;
	frameId: string;
	suggestedFilename: string;
	startedAt: number;
	state: "started" | "inProgress" | "completed" | "canceled";
	receivedBytes?: number;
	totalBytes?: number;
}

interface BrowserDownloadFileCandidate {
	id: number;
	path: string;
	url: string;
	finalUrl: string;
	referrer: string;
	startedAt: number;
	state: "in_progress" | "complete" | "interrupted";
	bytesReceived: number;
	totalBytes: number;
	exists: boolean;
}

interface BrowserDownloads {
	since: number;
	omitted: number;
	entries: BrowserDownload[];
	files?:
		| { available: false; reason: string }
		| {
				available: true;
				correlation: "url-and-time-candidates";
				matches: Array<{ id: string; truncated: boolean; candidates: BrowserDownloadFileCandidate[] }>;
		  };
}

/** Browser-tab helpers whose behavior is shared by direct and run-realm handles. */
interface BrowserTabHelpers {
	/** Return the current page title. */
	title(): Promise<string>;
	/** Navigate the page. */
	goto(url: string, options?: BrowserGotoOptions): Promise<void>;
	/** Capture a structured accessibility observation. */
	observe(options?: BrowserObserveOptions): Promise<BrowserObservation>;
	/** Capture a Playwright-format ARIA snapshot. */
	ariaSnapshot(selector?: string, options?: BrowserAriaSnapshotOptions): Promise<string>;
	/** Capture the page or one matching element and return the saved path. */
	screenshot(options?: BrowserScreenshotOptions): Promise<string>;
	/** Extract readable page content. */
	extract(format?: "text" | "markdown"): Promise<string>;
	/** Click the element matching `selector`. */
	click(selector: string): Promise<void>;
	/** Type individual key events into the element matching `selector`. */
	type(selector: string, text: string): Promise<void>;
	/** Replace editable text. Managed Chrome uses browser text insertion, not individual key events. */
	fill(selector: string, value: string): Promise<void>;
	/** Press a keyboard key, optionally on a matching element. */
	press(key: string, options?: BrowserPressOptions): Promise<void>;
	/** Scroll by page-relative deltas. */
	scroll(deltaX: number, deltaY: number): Promise<void>;
	/** Drag from one selector or point to another. */
	drag(from: BrowserDragTarget, to: BrowserDragTarget): Promise<void>;
	/** Evaluate a function or source string in the page. */
	evaluate<R, TArgs extends unknown[]>(fn: string | ((...args: TArgs) => R | Promise<R>), ...args: TArgs): Promise<R>;
	/** Scroll the matching element into view. */
	scrollIntoView(selector: string): Promise<void>;
	/** Select values in the matching `<select>` element. */
	select(selector: string, ...values: string[]): Promise<string[]>;
	/** Upload files through the matching file input. */
	uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
	/** Inspect this acquisition's download events, optionally with candidate saved paths. */
	downloads(options?: { paths?: boolean }): Promise<BrowserDownloads>;
	/** Wait for the current URL to match a string or regular expression. */
	waitForUrl(pattern: string | RegExp, options?: BrowserWaitOptions): Promise<string>;
}

/** An element handle returned by `BrowserTab.id` or `BrowserTab.ref`. */
interface BrowserElement {
	/** Click this element. */
	click(): Promise<void>;
	/** Type individual key events into this element. */
	type(text: string): Promise<void>;
	/** Replace editable text. Managed Chrome uses browser text insertion, including empty replacement. */
	fill(value: string): Promise<void>;
	/** Press a keyboard key on this element. */
	press(key: string): Promise<void>;
	/** Hover this element. */
	hover(): Promise<void>;
	/** Focus this element. */
	focus(): Promise<void>;
	/** Select values when this element is a `<select>`. */
	select(...values: string[]): Promise<string[]>;
	/** Upload files when this element is a file input. */
	uploadFile(...filePaths: string[]): Promise<void>;
	/** Scroll this element into view. */
	scrollIntoView(): Promise<void>;
	/** Return this element's page-coordinate bounds. */
	boundingBox(): Promise<BrowserBoundingBox | null>;
	/** Report whether this element is visible. */
	isVisible(): Promise<boolean>;
	/** Report whether this element is hidden. */
	isHidden(): Promise<boolean>;
	/** Evaluate a function or source string with this element as the first argument. */
	evaluate<R, TArgs extends unknown[]>(
		fn: string | ((element: unknown, ...args: TArgs) => R | Promise<R>),
		...args: TArgs
	): Promise<R>;
}

/** Full tab helper available inside the isolated `tab.run` realm. */
interface BrowserTabRealm extends BrowserTabHelpers {
	/** Managed-tab name. */
	readonly name: string;
	/** Raw Puppeteer page object. */
	readonly page: unknown;
	/** Abort signal for the active run. */
	readonly signal?: AbortSignal;
	/** Return the current page URL synchronously. */
	url(): string;
	/** Wait for and return an actionable element handle. */
	waitFor(selector: string, options?: BrowserWaitOptions): Promise<BrowserElement>;
	/** Wait for and return an element handle, or `null` when it remains absent. */
	waitForSelector(selector: string, options?: BrowserWaitForSelectorOptions): Promise<BrowserElement | null>;
	/** Wait for a matching network response and return the raw response object. */
	waitForResponse(
		pattern: string | RegExp | ((response: unknown) => boolean | Promise<boolean>),
		options?: BrowserWaitOptions,
	): Promise<unknown>;
	/** Wait for the next navigation and return its raw response when available. */
	waitForNavigation(options?: BrowserWaitForNavigationOptions): Promise<unknown | null>;
	/** Resolve a numeric observation id to an element handle. */
	id(id: number): Promise<BrowserElement>;
	/** Resolve an ARIA snapshot reference to an element handle. */
	ref(id: string): Promise<BrowserElement>;
}

/** Scope object passed as the first argument to a browser run function. */
interface BrowserRunScope {
	/** Full tab helper for the current run realm. */
	readonly tab: BrowserTabRealm;
	/** Raw Puppeteer page object. */
	readonly page: unknown;
	/** Raw Puppeteer browser object. */
	readonly browser: unknown;
	/** Polling and sleep helper. */
	readonly wait: BrowserWait;
	/** Assertion helper. */
	readonly assert: BrowserAssert;
}

/** A named browser tab handle returned by `browser.open` or `browser.tab`. */
interface BrowserDialogState {
	status: "unobserved" | "closed" | "open";
	dialog: {
		id: string;
		type: "alert" | "confirm" | "prompt" | "beforeunload";
		message: string;
		url: string;
		defaultPrompt: string;
	} | null;
}
interface BrowserTab extends BrowserTabHelpers {
	readonly initialDialog?: BrowserDialogState;
	/** Managed Chrome only. Uses the existing exact debugger attachment, independently of a blocked renderer. */
	dialog(
		options?: { action?: "inspect" } | { action: "accept" | "dismiss"; id: string; promptText?: string },
	): Promise<BrowserDialogState>;
	/** Exact Chrome identity. tab.id(...) is an element helper, not this identity. */
	readonly target?: BrowserTargetIdentity;
	/** First controls and snapshot refs; later observe() calls supersede these refs. */
	readonly initialObservation?: BrowserObservation;
	/** Readable page tree captured during acquisition, independently of control inspection. */
	readonly initialTree?: string;
	/** Local preview path captured during acquisition. */
	readonly initialScreenshot?: string;
	/** Partial control-inspection failure; missing state is unknown. */
	readonly inspectionError?: string;
	/** Partial readable-tree failure. */
	readonly treeError?: string;
	/** Partial preview failure. */
	readonly screenshotError?: string;
	/** Immutable actor-owned Chrome handle; display names do not confer ownership. */
	readonly handle?: string;
	/** Explicitly reveal this Chrome tab and focus its window. */
	reveal(): Promise<void>;
	/** Keep a task-created Chrome tab after release. */
	retain(): Promise<void>;
	/** Release ownership; preserve adopted/retained tabs and close other created tabs. */
	release(): Promise<void>;
	/** Immutable managed-tab name. */
	readonly name: string;
	/** Return the current page URL. */
	url(): Promise<string>;
	/** Wait for an actionable selector and report whether it appeared. */
	waitFor(selector: string, options?: BrowserWaitOptions): Promise<boolean>;
	/** Wait for a selector and report whether it appeared. */
	waitForSelector(selector: string, options?: BrowserWaitForSelectorOptions): Promise<boolean>;
	/** Return a numeric observation-id element proxy. */
	id(id: number): BrowserElement;
	/** Return an ARIA-reference element proxy. */
	ref(id: string): BrowserElement;
	/** Run a serialized function in the tab runtime. */
	run<R, TArgs extends unknown[]>(
		fn: (scope: BrowserRunScope, ...args: TArgs) => R | Promise<R>,
		options?: BrowserRunOptions<TArgs>,
	): Promise<R>;
	/** Run a JavaScript function body in the tab runtime. */
	run<R = unknown>(code: string, options?: BrowserRunOptions): Promise<R>;
	/** Close this Chrome tab, including adopted or retained pages. Other CDP handles only disconnect. */
	close(options?: BrowserTabCloseOptions): Promise<void>;
}

/** Session-scoped browser facade available in JavaScript Eval. */
declare const browser: {
	/** Acquire a unique existing tab by exact title/URL or discovery id, including initial state. Never creates a tab. */
	getTab(
		selector: string | BrowserTabSelector,
		options?: {
			label?: string;
			timeout?: number;
			observation?: BrowserInitialObservationOptions;
		},
	): Promise<BrowserTab>;
	/** Paired browser profiles, including offline ones. Labels are chosen during setup. */
	instances(): Promise<
		Array<{
			id: string;
			label: string;
			connected: boolean;
			generation?: string;
			extension?: {
				loadedBuildId?: string;
				expectedBuildId: string;
				status: "matching" | "different" | "unknown";
			};
		}>
	>;
	/** Discover exact existing Chrome tabs without attaching or activating them. */
	discover(options?: { browserId?: string }): Promise<
		Array<{
			id: string;
			browserId: string;
			browserLabel: string;
			tabId: number;
			windowId: number;
			title: string;
			url: string;
			active: boolean;
			pinned: boolean;
			groupId: number;
			ownership: "available" | "this_actor" | "other_actor";
			/** Discovery id of the task-owned parent that opened this popup. */
			popupOf?: string;
		}>
	>;
	/** Create a new inactive Chrome tab under a task label. */
	create(options?: {
		browserId?: string;
		url?: string;
		label?: string;
		timeout?: number;
		observation?: BrowserInitialObservationOptions;
	}): Promise<BrowserTab>;
	/** Exclusively claim an exact discovered Chrome tab; never navigate or regroup it. */
	claim(
		id: string,
		options?: {
			browserId?: string;
			label?: string;
			timeout?: number;
			observation?: BrowserInitialObservationOptions;
		},
	): Promise<BrowserTab>;
	/** Close an exact discovered Chrome tab without attaching or activating it. Refuses other actors' tabs. */
	closeTab(id: string, options?: { browserId?: string; timeout?: number }): Promise<void>;
	/** Open or reuse a tab and return its handle. */
	open(options?: BrowserOpenOptions): Promise<BrowserTab>;
	/** Return a handle for an existing named tab without opening it. */
	tab(name?: string): BrowserTab;
	/** Release one or all managed tabs. */
	close(options?: BrowserCloseOptions): Promise<void>;
};
