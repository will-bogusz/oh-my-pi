/**
 * `[x, y]` or `{ x, y }` in points: window-local for a window's own actions,
 * display coordinates for `computer.*` ones. Captures arrive on that same
 * grid, so a point read off a screenshot is a point an action takes, and an
 * element's `bounds` (also points) convert by subtracting the window's origin.
 */
type ComputerPoint = [number, number] | { x: number; y: number };
type ComputerTarget = string | ComputerPoint;
type ComputerDirection = "up" | "down" | "left" | "right";
/**
 * A chord: `"cmd+a"`, `"Return"`, or `["cmd", "shift", "p"]`. Modifiers are
 * spelled per platform — macOS `cmd`/`command`/`option`/`alt`/`ctrl`/
 * `control`/`shift`/`fn`, X11 `super`/`meta`/`win`/`alt`/`ctrl`/`shift` — and
 * `super`/`meta`/`win`/`cmd`/`option` are translated between them, as are
 * DOM arrow names (`ArrowDown` → `down`). Any other unknown name is not: the
 * macOS keystroke path drops the modifier and types the base key on its own.
 */
type ComputerChord = string | string[];
interface ComputerDeliveryOptions {
	delivery?: "background" | "foreground";
}
interface ComputerForegroundOptions {
	delivery: "foreground";
}
interface ComputerClickOptions extends ComputerDeliveryOptions {
	button?: "left" | "right" | "middle";
	count?: number;
	modifiers?: string[];
}
interface ComputerDragOptions extends Omit<ComputerClickOptions, "count"> {
	durationMs?: number;
	steps?: number;
}
interface ComputerScrollOptions extends ComputerDeliveryOptions {
	target?: ComputerTarget;
	amount?: number;
	by?: "line" | "page";
}
interface ComputerTargetOptions extends ComputerDeliveryOptions {
	target?: ComputerTarget;
}
interface ComputerObserveOptions {
	/**
	 * Capture the window's pixels alongside the tree, at the window's own
	 * point size. Default false — acquisition takes one initial screenshot,
	 * and coordinate actions need a current frame, so ask for one when you
	 * are going to click coordinates.
	 */
	screenshot?: boolean;
	silent?: boolean;
	maxDepth?: number;
	maxElements?: number;
	query?: string;
	/**
	 * Include the menu bar. Excluded by default: its rows only respond while
	 * their own menu is open, and `win.menu(path)` is the route that drives
	 * them.
	 */
	menubar?: boolean;
}
interface ComputerWindowFilter {
	id?: string | number;
	pid?: number;
	app?: string;
	title?: string;
}
/** Points, in display coordinates: window frames and element boxes alike. */
interface ComputerBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}
interface ComputerWindowInfo {
	id: string;
	pid: number;
	app: string;
	title: string;
	bounds: ComputerBounds;
	onScreen?: boolean;
	/** Stacking order where the platform reports one; higher is closer to the front. */
	zIndex?: number;
}
interface ComputerScreenshotResult {
	path: string;
	width: number;
	height: number;
	/** Which space this capture's points are in: a window's, or the display's. */
	surface: "window" | "display";
	/** Point size of what was captured: the window's bounds, or the display. */
	pointWidth: number;
	pointHeight: number;
	/**
	 * Image pixels per point. 1 — the normal case — means a coordinate read
	 * off this image is a coordinate an action takes; below 1 the surface
	 * outgrew the frame budget and image pixels divide by it.
	 */
	scale: number;
	target: string;
	label?: string;
}
interface ComputerInterruption {
	app: string;
	pid: number;
	windowId: string;
	title: string;
	kind: string;
}
interface ComputerCapabilities {
	backend: string;
	capture: boolean;
	input: boolean;
	ax: boolean;
	backgroundWindowInput: boolean;
	deliveryModes: string[];
	capturePermission: string;
	inputPermission: string;
	axPermission: string;
	displayCount: number;
	permissions: Record<string, unknown>;
}
interface ComputerAction {
	text: string;
	effect: string;
	evidence: unknown;
	data?: unknown;
	route?: string;
	delivery: unknown;
	/**
	 * A write's verdict: `committed` once the app's own editing pipeline was
	 * observed keeping the value, `not_committed` once it was observed
	 * discarding it, `unproven` when the read-back cannot tell those apart.
	 */
	committed?: "committed" | "not_committed" | "unproven";
	/** The route the driver says would land when it doubts this one did. */
	escalation?: string;
	interruptedBy?: ComputerInterruption;
}
interface ComputerElement {
	ref: string;
	role: string;
	/** The specific role behind a generic one: `AXSearchField` on an `AXTextField`. */
	subrole?: string;
	label: string;
	value?: string;
	placeholder?: string;
	help?: string;
	description?: string;
	enabled?: boolean;
	selected?: boolean;
	actions?: string[];
	bounds?: ComputerBounds;
	pid: number;
	windowId: string;
	click(options?: ComputerClickOptions): Promise<ComputerAction>;
	doubleClick(options?: Omit<ComputerClickOptions, "count">): Promise<ComputerAction>;
	setValue(value: string): Promise<ComputerAction>;
	type(text: string, options?: ComputerDeliveryOptions): Promise<ComputerAction>;
	press(chord: ComputerChord, options?: ComputerDeliveryOptions): Promise<ComputerAction>;
	scroll(direction: ComputerDirection, options?: Omit<ComputerScrollOptions, "target">): Promise<ComputerAction>;
	perform(action: string): Promise<ComputerAction>;
}
interface ComputerObservation {
	snapshotId: string;
	window: ComputerWindowInfo;
	tree: string;
	elements: ComputerElement[];
	complete: boolean;
	backgroundInput: unknown;
	relatedWindows?: { id: string; pid: number; title: string; relation: "sheet" }[];
	documentPath?: string;
	documentEdited?: boolean;
	screenshot?: ComputerScreenshotResult;
	screenshotError?: string;
	interruptedBy?: ComputerInterruption;
}
interface ComputerWindow extends ComputerWindowInfo {
	initialObservation?: ComputerObservation;
	inspectionError?: string;
	initialScreenshot?: ComputerScreenshotResult;
	screenshotError?: string;
	observe(options?: ComputerObserveOptions): Promise<ComputerObservation>;
	screenshot(options?: { silent?: boolean }): Promise<ComputerScreenshotResult>;
	/**
	 * Elements of the window's current tree. `role`, `label` and `value` match
	 * case-insensitive substrings of what the tree shows — `{ value: "555" }`
	 * finds a phone field — unless `{ exact: true }` asks for whole-string
	 * equality. `role` also matches a row's `subrole`, so `{ role:
	 * "AXSearchField" }` finds the search field macOS reports as an
	 * `AXTextField`; `{ subrole }` asks for the specific role alone. `title`
	 * is accepted as a name for `label`. Costs one AX read and mints fresh
	 * refs, exactly like `observe()`.
	 */
	find(query: {
		role?: string;
		subrole?: string;
		label?: string;
		title?: string;
		value?: string;
		exact?: boolean;
		limit?: number;
	}): Promise<ComputerElement[]>;
	/** Act on it directly (`win.ref(r).click()`) or await it for snapshot fields. */
	ref(token: string): ComputerElement & PromiseLike<ComputerElement | null>;
	click(target: ComputerTarget, options?: ComputerClickOptions): Promise<ComputerAction>;
	doubleClick(target: ComputerTarget, options?: Omit<ComputerClickOptions, "count">): Promise<ComputerAction>;
	hover(x: number, y: number, options?: ComputerDeliveryOptions): Promise<ComputerAction>;
	drag(from: ComputerTarget, to: ComputerTarget, options?: ComputerDragOptions): Promise<ComputerAction>;
	scroll(direction: ComputerDirection, options?: ComputerScrollOptions): Promise<ComputerAction>;
	type(text: string, options?: ComputerTargetOptions): Promise<ComputerAction>;
	press(chord: ComputerChord, options?: ComputerTargetOptions): Promise<ComputerAction>;
	setValue(ref: string, value: string): Promise<ComputerAction>;
	setFrame(bounds: ComputerBounds): Promise<ComputerAction>;
	menu(path: string[], options: ComputerForegroundOptions): Promise<ComputerAction>;
	verify(
		expect: Record<string, unknown>[],
		options?: { timeoutMs?: number; stableSamples?: number },
	): Promise<unknown>;
	reveal(): Promise<ComputerAction>;
	// @achieve
	/**
	 * Experimental (`computer.achieve`): a bounded sub-loop toward one
	 * verifiable goal on this window — fill, select, navigate-to. Each step a
	 * typed judge picks one row of a code-built candidate table (or re-reads,
	 * or abstains), the pick runs as `win.ref(r).<action>()` would, and a
	 * postcondition judgment over the fresh tree decides. Values written are
	 * only ones the goal quotes (`"..."`). May abstain; the trace is the
	 * driver's own replies.
	 */
	achieve(goal: string, options?: ComputerAchieveOptions): Promise<ComputerAchieveResult>;
	// @end achieve
}
interface ComputerDesktop {
	capabilities(): Promise<ComputerCapabilities>;
	apps(): Promise<unknown>;
	displays(): Promise<(ComputerBounds & { id: string; name: string; scale: number; isPrimary: boolean })[]>;
	windows(filter?: ComputerWindowFilter): Promise<ComputerWindowInfo[]>;
	window(selector: string | number | ComputerWindowFilter, options?: ComputerResolveOptions): Promise<ComputerWindow>;
	focusedWindow(): Promise<ComputerWindow | null>;
	screenshot(options?: { silent?: boolean }): Promise<ComputerScreenshotResult>;
	launch(
		options: string | { bundleId?: string; name?: string; urls?: string[]; newInstance?: boolean },
	): Promise<ComputerAction>;
	/** Act on it directly (`win.ref(r).click()`) or await it for snapshot fields. */
	ref(token: string): ComputerElement & PromiseLike<ComputerElement | null>;
	click(x: number, y: number, options: ComputerClickOptions & ComputerForegroundOptions): Promise<ComputerAction>;
	doubleClick(
		x: number,
		y: number,
		options: Omit<ComputerClickOptions, "count"> & ComputerForegroundOptions,
	): Promise<ComputerAction>;
	move(x: number, y: number, options: ComputerForegroundOptions): Promise<ComputerAction>;
	drag(points: ComputerPoint[], options: ComputerDragOptions & ComputerForegroundOptions): Promise<ComputerAction>;
	scroll(
		x: number,
		y: number,
		options: ComputerForegroundOptions & { dx?: number; dy?: number },
	): Promise<ComputerAction>;
	type(text: string, options: ComputerForegroundOptions): Promise<ComputerAction>;
	press(chord: ComputerChord, options: ComputerForegroundOptions): Promise<ComputerAction>;
	clipboard: { read(): Promise<string>; write(text: string): Promise<ComputerAction> };
}
interface ComputerRunScope {
	desktop: ComputerDesktop;
	wait: (
		msOrPredicate: number | (() => unknown),
		options?: { timeout?: number; interval?: number },
	) => Promise<unknown>;
	assert: (condition: unknown, message?: string) => void;
}
interface ComputerRunOptions {
	args?: unknown[];
	read_only?: boolean;
	timeout?: number;
}
interface ComputerResolveOptions {
	/**
	 * Several windows match: `"front"` (default) acquires the app's front
	 * document window and names the ones it passed over, `"throw"` fails with
	 * every candidate id.
	 */
	ambiguous?: "front" | "throw";
}
interface ComputerAcquireOptions extends ComputerObserveOptions, ComputerResolveOptions {
	/**
	 * Launch the app the `{ app }` selector names when no window matches it
	 * yet — the default for an `{ app }` selector, so one call covers "start
	 * it if needed, then acquire it". `false` acquires only what is already
	 * open; an exact id/pid never launches anything.
	 */
	launch?: boolean;
}
// @achieve
interface ComputerAchieveOptions {
	/** Steps before the loop stops with `max_steps`; default 8. */
	maxSteps?: number;
	/** The pick's probability must reach this (default 0.6); below it the loop re-reads once, then abstains. */
	confidence?: number;
}
interface ComputerAchieveStep {
	/** The candidate line (`role "label" -> action`), or `reobserve` / `abstain`. */
	candidate: string;
	probability: number;
	/** The row the judge leaned to when its probability fell under the gate. */
	favored?: string;
	/** The driver's typed reply for an executed pick, or `{ refusal }` with the message the call would have thrown. */
	reply?: ComputerAction | { refusal: string; interruptedBy?: ComputerInterruption };
	/** P(goal satisfied) after the pick; absent when it was not executed or reported `suspected_noop`. */
	postcondition?: number;
}
interface ComputerAchieveResult {
	done: boolean;
	steps: ComputerAchieveStep[];
	reason: "done" | "abstain" | "max_steps" | "interrupted" | "refused";
	abstained: boolean;
	/** The verbatim interruption, refusal or gate that ended the loop, when one did. */
	detail?: string;
}
// @end achieve
declare const computer: Omit<ComputerDesktop, "window"> & {
	window(selector: string | number | ComputerWindowFilter, options?: ComputerAcquireOptions): Promise<ComputerWindow>;
	run<R>(
		fn: (scope: ComputerRunScope, ...args: unknown[]) => R | Promise<R>,
		options?: ComputerRunOptions,
	): Promise<Awaited<R>>;
	run<R = unknown>(code: string, options?: ComputerRunOptions): Promise<R>;
	/** Print this declaration file — every interface and signature above. Read tier, no driver call. */
	help(): Promise<void>;
	release(): Promise<void>;
	close(): Promise<void>;
};
