type ComputerPoint = [number, number];
type ComputerTarget = string | ComputerPoint;
type ComputerDirection = "up" | "down" | "left" | "right";
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
	screenshot?: boolean;
	silent?: boolean;
	maxDepth?: number;
	maxElements?: number;
	query?: string;
}
interface ComputerWindowFilter {
	id?: string | number;
	pid?: number;
	app?: string;
	title?: string;
}
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
}
interface ComputerScreenshotResult {
	path: string;
	width: number;
	height: number;
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
	interruptedBy?: ComputerInterruption;
}
interface ComputerElement {
	ref: string;
	role: string;
	label: string;
	value?: string;
	placeholder?: string;
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
	press(chord: string | string[], options?: ComputerDeliveryOptions): Promise<ComputerAction>;
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
	find(query: { role?: string; label?: string; value?: string; limit?: number }): Promise<ComputerElement[]>;
	/** Act on it directly (`win.ref(r).click()`) or await it for snapshot fields. */
	ref(token: string): ComputerElement & PromiseLike<ComputerElement | null>;
	click(target: ComputerTarget, options?: ComputerClickOptions): Promise<ComputerAction>;
	doubleClick(target: ComputerTarget, options?: Omit<ComputerClickOptions, "count">): Promise<ComputerAction>;
	hover(x: number, y: number, options?: ComputerDeliveryOptions): Promise<ComputerAction>;
	drag(from: ComputerPoint, to: ComputerPoint, options?: ComputerDragOptions): Promise<ComputerAction>;
	scroll(direction: ComputerDirection, options?: ComputerScrollOptions): Promise<ComputerAction>;
	type(text: string, options?: ComputerTargetOptions): Promise<ComputerAction>;
	press(chord: string | string[], options?: ComputerTargetOptions): Promise<ComputerAction>;
	setValue(ref: string, value: string): Promise<ComputerAction>;
	setFrame(bounds: ComputerBounds): Promise<ComputerAction>;
	menu(path: string[], options: ComputerForegroundOptions): Promise<ComputerAction>;
	verify(
		expect: Record<string, unknown>[],
		options?: { timeoutMs?: number; stableSamples?: number },
	): Promise<unknown>;
	reveal(): Promise<ComputerAction>;
}
interface ComputerDesktop {
	capabilities(): Promise<ComputerCapabilities>;
	apps(): Promise<unknown>;
	displays(): Promise<(ComputerBounds & { id: string; name: string; scale: number; isPrimary: boolean })[]>;
	windows(filter?: ComputerWindowFilter): Promise<ComputerWindowInfo[]>;
	window(selector: string | number | ComputerWindowFilter): Promise<ComputerWindow>;
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
	press(chord: string | string[], options: ComputerForegroundOptions): Promise<ComputerAction>;
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
interface ComputerAcquireOptions extends ComputerObserveOptions {
	/** launch the app the `{ app }` selector names when no window matches it yet */
	launch?: boolean;
}
declare const computer: Omit<ComputerDesktop, "window"> & {
	window(selector: string | number | ComputerWindowFilter, options?: ComputerAcquireOptions): Promise<ComputerWindow>;
	run<R>(
		fn: (scope: ComputerRunScope, ...args: unknown[]) => R | Promise<R>,
		options?: ComputerRunOptions,
	): Promise<Awaited<R>>;
	run<R = unknown>(code: string, options?: ComputerRunOptions): Promise<R>;
	release(): Promise<void>;
	close(): Promise<void>;
};
