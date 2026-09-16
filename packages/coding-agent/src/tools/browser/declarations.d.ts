type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
type BrowserDragTarget = string | { x: number; y: number };
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
	/** false: full tree instead of the diff since the previous observation */
	diff?: boolean;
	/** false: do not print the tree (it is printed by default) */
	display?: boolean;
}
interface BrowserInitialObservationOptions extends BrowserObserveOptions {
	screenshot?: boolean;
}
interface BrowserAcquireOptions {
	browserId?: string;
	label?: string;
	timeout?: number;
	observation?: BrowserInitialObservationOptions;
}
interface BrowserOpenOptions {
	name?: string;
	url?: string;
	app?: { path?: string; cdp_url?: string; relay?: boolean; args?: string[]; target?: string };
	viewport?: { width: number; height: number; scale?: number };
	wait_until?: BrowserWaitUntil;
	dialogs?: "accept" | "dismiss";
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
interface BrowserDownloads {
	since: number;
	omitted: number;
	entries: {
		id: string;
		url: string;
		suggestedFilename: string;
		state: "started" | "inProgress" | "completed" | "canceled";
		receivedBytes?: number;
		totalBytes?: number;
	}[];
}
/** an option's text or value as a string, or Playwright's object form */
type BrowserSelectOption = string | { label?: string; value?: string };
interface BrowserTabHelpers {
	title(): Promise<string>;
	goto(url: string, options?: { waitUntil?: BrowserWaitUntil }): Promise<void>;
	/** settles, prints the tree (diff by default), returns it */
	observe(options?: BrowserObserveOptions): Promise<BrowserObservation>;
	ariaSnapshot(selector?: string, options?: { depth?: number; boxes?: boolean }): Promise<string>;
	/** returns the saved path */
	screenshot(options?: { selector?: string; fullPage?: boolean; silent?: boolean }): Promise<string>;
	/** readable article text; positional string, default "text" */
	extract(format?: "text" | "markdown"): Promise<string>;
	click(selector: string): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	press(key: string, options?: { selector?: string }): Promise<void>;
	scroll(
		deltaXOrDirection: number | "up" | "down" | "left" | "right",
		deltaYOrOptions?: number | { by?: number | "page" },
	): Promise<void>;
	drag(from: BrowserDragTarget, to: BrowserDragTarget): Promise<void>;
	evaluate<R, A extends unknown[]>(fn: string | ((...args: A) => R | Promise<R>), ...args: A): Promise<R>;
	scrollIntoView(selector: string): Promise<void>;
	select(selector: string, ...values: BrowserSelectOption[]): Promise<string[]>;
	uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
	downloads(): Promise<BrowserDownloads>;
	waitForUrl(pattern: string | RegExp, options?: BrowserWaitOptions): Promise<string>;
}
interface BrowserElement {
	click(options?: { count?: number }): Promise<void>;
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
	evaluate<R, A extends unknown[]>(
		fn: string | ((element: unknown, ...args: A) => R | Promise<R>),
		...args: A
	): Promise<R>;
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
	waitFor(selector: string, options?: BrowserWaitOptions): Promise<boolean>;
	waitForSelector(selector: string, options?: BrowserWaitForSelectorOptions): Promise<boolean>;
	run<R>(fn: (scope: BrowserRunScope, ...args: unknown[]) => R | Promise<R>, options?: BrowserRunOptions): Promise<R>;
	run<R = unknown>(code: string, options?: BrowserRunOptions): Promise<R>;
	dialog(
		options?: { action?: "inspect" } | { action: "accept" | "dismiss"; id: string; promptText?: string },
	): Promise<BrowserDialogState>;
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
	discover(options?: { browserId?: string; full?: false }): Promise<BrowserDiscoveredTab[]>;
	discover(options: { browserId?: string; full: true }): Promise<BrowserDiscoveredTabFull[]>;
	claim(id: string, options?: BrowserAcquireOptions): Promise<BrowserTab>;
	create(options?: BrowserAcquireOptions & { url?: string }): Promise<BrowserTab>;
	closeTab(id: string, options?: { browserId?: string; timeout?: number }): Promise<void>;
	instances(): Promise<{ id: string; label: string; connected: boolean }[]>;
	open(options?: BrowserOpenOptions): Promise<BrowserTab>;
	tab(name?: string): BrowserTab;
	/** Print this declaration file — every interface and signature above. Read tier, no tab needed. */
	help(): Promise<void>;
	close(options?: BrowserCloseOptions): Promise<void>;
};
