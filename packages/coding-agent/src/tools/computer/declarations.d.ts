type ComputerDelivery = "background" | "foreground";
type ComputerPoint = [number, number];
type ComputerTarget = string | ComputerPoint;
type ComputerDirection = "up" | "down" | "left" | "right";

interface ComputerDeliveryOptions {
	delivery?: ComputerDelivery;
}

/** Desktop-global input always requires explicit foreground delivery. */
interface ComputerForegroundOptions {
	delivery: "foreground";
}

interface ComputerClickOptions extends ComputerDeliveryOptions {
	button?: "left" | "right" | "middle";
	count?: number;
	modifiers?: string[];
}

interface ComputerDragOptions extends ComputerDeliveryOptions {
	modifiers?: string[];
	button?: "left" | "right" | "middle";
	/** Cua window drag: integer 0–10000 milliseconds. Other backends may refuse timing. */
	durationMs?: number;
	/** Cua: integer 1–200. Other backends may have different limits. */
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

interface ComputerScreenshotOptions {
	silent?: boolean;
}

interface ComputerObserveOptions extends ComputerScreenshotOptions {
	screenshot?: boolean;
	maxDepth?: number;
	/** Bounds visited accessibility nodes, including containers; returned controls may be fewer. */
	maxElements?: number;
	query?: string;
}

interface ComputerElementQuery {
	role?: string;
	label?: string;
	value?: string;
	limit?: number;
}

interface ComputerWindowFilter {
	id?: string | number;
	pid?: number;
	app?: string;
	title?: string;
}

interface ComputerBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

interface ComputerWindowInfo {
	readonly id: string;
	readonly pid: number;
	readonly app: string;
	readonly title: string;
	readonly bounds: ComputerBounds;
	readonly onScreen?: boolean;
}

interface ComputerDisplay extends ComputerBounds {
	id: string;
	name: string;
	scale: number;
	pixelX: number;
	pixelY: number;
	pixelWidth: number;
	pixelHeight: number;
	isPrimary: boolean;
}

interface ComputerScreenshotResult {
	path: string;
	width: number;
	height: number;
	sourceWidth: number;
	sourceHeight: number;
	target: string;
	/** Observed app/window name for presentation; target remains the routing identity. */
	label?: string;
}

interface ComputerCapabilities {
	backend: string;
	displayServer?: string;
	capture: boolean;
	input: boolean;
	ax: boolean;
	backgroundWindowInput: boolean;
	deliveryModes: string[];
	capturePermission: string;
	inputPermission: string;
	axPermission: string;
	displayCount: number;
	driver: unknown;
	permissions: Record<string, unknown>;
}

/**
 * Immutable observation data, not live getters. Observation and element verification
 * invalidate prior refs for that window. Any AX traversal can also evict refs from
 * the session-wide 5,000-entry native registry, including another window's refs.
 * Resolving a snapshot does not prove native liveness; on StaleRef, observe again.
 */
interface ComputerElementSnapshot {
	readonly ref: string;
	readonly role: string;
	readonly label: string;
	readonly value?: string;
	/** Provider-reported hint; never substituted for the field value. */
	readonly placeholder?: string;
	/** Undefined when the platform could not read the enabled state. */
	readonly enabled?: boolean;
	readonly selected?: boolean;
	/** Observed perform(action) names. Availability does not guarantee effect or background behavior. */
	readonly actions?: readonly string[];
	readonly bounds?: ComputerBounds;
	readonly pid: number;
	readonly windowId: string;
}

/** Native evidence is returned unchanged; dispatch does not imply a verified application effect. */
interface ComputerActionResult {
	text: string;
	effect: string;
	evidence: unknown;
	data?: unknown;
	route?: string;
	delivery: unknown;
}

interface ComputerObservation {
	snapshotId: string;
	window: ComputerWindowInfo;
	tree: string;
	elements: ComputerElementSnapshot[];
	/** True only when AX traversal has neither truncated nor skipped nodes. */
	/** Whole-tree coverage only. Partial trees retain valid returned refs; missing nodes remain unknown. */
	complete: boolean;
	backgroundInput: unknown;
	/** Acquire each attached sheet by its id and pid; its controls are outside this snapshot. */
	relatedWindows?: readonly { id: string; pid: number; title: string; relation: "sheet" }[];
	screenshot?: ComputerScreenshotResult;
	screenshotError?: string;
}

interface ComputerElement extends ComputerElementSnapshot {
	click(options?: ComputerClickOptions): Promise<ComputerActionResult>;
	doubleClick(options?: Omit<ComputerClickOptions, "count">): Promise<ComputerActionResult>;
	setValue(value: string): Promise<ComputerActionResult>;
	type(text: string, options?: ComputerDeliveryOptions): Promise<ComputerActionResult>;
	press(chord: string | string[], options?: ComputerDeliveryOptions): Promise<ComputerActionResult>;
	scroll(direction: ComputerDirection, options?: Omit<ComputerScrollOptions, "target">): Promise<ComputerActionResult>;
	perform(action: string): Promise<ComputerActionResult>;
}

/** Window actions default to background delivery, without automatic foreground fallback. */
interface ComputerWindow extends ComputerWindowInfo {
	/** Displays current tree and coverage with optional image; also returns the structured observation. */
	observe(options?: ComputerObserveOptions): Promise<ComputerObservation>;
	screenshot(options?: ComputerScreenshotOptions): Promise<ComputerScreenshotResult>;
	find(query: ComputerElementQuery): Promise<ComputerElement[]>;
	ref(token: string): Promise<ComputerElement>;
	/** Pixels belong to the latest shadow-free screenshot of this exact window. */
	click(target: ComputerTarget, options?: ComputerClickOptions): Promise<ComputerActionResult>;
	doubleClick(target: ComputerTarget, options?: Omit<ComputerClickOptions, "count">): Promise<ComputerActionResult>;
	/** Moves the real native pointer. */
	hover(x: number, y: number, options?: ComputerDeliveryOptions): Promise<ComputerActionResult>;
	/** Check capabilities: the current macOS Cua route requires foreground delivery for drag. */
	drag(from: ComputerPoint, to: ComputerPoint, options?: ComputerDragOptions): Promise<ComputerActionResult>;
	scroll(direction: ComputerDirection, options?: ComputerScrollOptions): Promise<ComputerActionResult>;
	/** Explicitly click the intended editor first; AXFocused alone is insufficient in Electron. */
	type(text: string, options?: ComputerTargetOptions): Promise<ComputerActionResult>;
	press(chord: string | string[], options?: ComputerTargetOptions): Promise<ComputerActionResult>;
	setValue(ref: string, value: string): Promise<ComputerActionResult>;
	setFrame(bounds: ComputerBounds): Promise<ComputerActionResult>;
	menu(path: string[], options: ComputerForegroundOptions): Promise<ComputerActionResult>;
	/** Element predicates invalidate refs; re-observe before subsequent token actions. */
	verify(
		expect: Record<string, unknown>[],
		options?: { timeoutMs?: number; stableSamples?: number },
	): Promise<unknown>;
	/** Reveal the actual window to the user. Never required for inspection or preview. */
	reveal(): Promise<ComputerActionResult>;
}

interface ComputerAcquiredWindow extends ComputerWindow {
	/** Historical initial snapshot; later observations/actions can invalidate its refs. */
	readonly initialObservation?: ComputerObservation;
	readonly inspectionError?: string;
	/** Independent capture when initial accessibility inspection failed. */
	readonly initialScreenshot?: ComputerScreenshotResult;
	readonly screenshotError?: string;
}

interface ComputerLaunchOptions {
	bundleId?: string;
	name?: string;
	urls?: string[];
	newInstance?: boolean;
}

/** Desktop helpers shared by direct computer calls and the desktop object inside run. */
interface ComputerDesktop {
	capabilities(): Promise<ComputerCapabilities>;
	apps(): Promise<unknown>;
	displays(): Promise<ComputerDisplay[]>;
	windows(filter?: ComputerWindowFilter): Promise<ComputerWindowInfo[]>;
	window(selector: string | number | ComputerWindowFilter): Promise<ComputerWindow>;
	focusedWindow(): Promise<ComputerWindow | null>;
	screenshot(options?: ComputerScreenshotOptions): Promise<ComputerScreenshotResult>;
	/** Background launch by name, absolute app path, or explicit options. */
	launch(options: string | ComputerLaunchOptions): Promise<ComputerActionResult>;
	ref(token: string): Promise<ComputerElement>;
	click(
		x: number,
		y: number,
		options: ComputerClickOptions & ComputerForegroundOptions,
	): Promise<ComputerActionResult>;
	doubleClick(
		x: number,
		y: number,
		options: Omit<ComputerClickOptions, "count"> & ComputerForegroundOptions,
	): Promise<ComputerActionResult>;
	move(x: number, y: number, options: ComputerForegroundOptions): Promise<ComputerActionResult>;
	drag(
		points: ComputerPoint[],
		options: ComputerDragOptions & ComputerForegroundOptions,
	): Promise<ComputerActionResult>;
	scroll(
		x: number,
		y: number,
		options: ComputerForegroundOptions & { dx?: number; dy?: number },
	): Promise<ComputerActionResult>;
	type(text: string, options: ComputerForegroundOptions): Promise<ComputerActionResult>;
	press(chord: string | string[], options: ComputerForegroundOptions): Promise<ComputerActionResult>;
	readonly clipboard: {
		read(): Promise<string>;
		write(text: string): Promise<ComputerActionResult>;
	};
}

interface ComputerRunScope {
	readonly desktop: ComputerDesktop;
	readonly wait: (
		msOrPredicate: number | (() => unknown),
		options?: { timeout?: number; interval?: number },
	) => Promise<unknown>;
	readonly assert: (condition: unknown, message?: string) => void;
}

interface ComputerRunOptions {
	args?: unknown[];
	read_only?: boolean;
	timeout?: number;
}

/** Direct helpers use the same approved call pipeline as computer.run. */
declare const computer: Omit<ComputerDesktop, "window"> & {
	/** Acquire an exact window and display initial background inspection; never activates it. */
	window(
		selector: string | number | ComputerWindowFilter,
		options?: ComputerObserveOptions,
	): Promise<ComputerAcquiredWindow>;
	run<R>(
		fn: (scope: ComputerRunScope, ...args: unknown[]) => R | Promise<R>,
		options?: ComputerRunOptions,
	): Promise<Awaited<R>>;
	run<R = unknown>(code: string, options?: ComputerRunOptions): Promise<R>;
	/** Drain and release capture/control resources; later calls start a fresh worker. */
	release(): Promise<void>;
	/** Permanently end computer use in this OMP session. */
	close(): Promise<void>;
};
