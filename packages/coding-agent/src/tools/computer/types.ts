import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";

/** Frozen run settings captured from the host session for one computer run. */
export interface ComputerSessionSnapshot {
	cwd: string;
	sessionId: string;
	captureMaxWidth: number;
	captureMaxHeight: number;
	display: string;
	readOnly: boolean;
}
/** Successful computer run output. */
export interface ComputerRunOk {
	displays: Array<TextContent | ImageContent>;
	returnValue: unknown;
	screenshots: ComputerScreenshot[];
	capabilities?: DesktopCapabilities;
}
/** Full-resolution screenshot emitted during one computer run. */
export interface ComputerScreenshot {
	/** Zero-based image ordinal in run displays; absent when captured silently. */
	imageIndex?: number;
	path: string;
	width: number;
	height: number;
	sourceWidth?: number;
	sourceHeight?: number;
	target: string;
	/** Observed app/window name for presentation; target remains the routing identity. */
	label?: string;
}
export interface ComputerBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface ComputerLaunchOptions {
	bundleId?: string;
	/** App display name or absolute .app bundle path on macOS. */
	name?: string;
	urls?: string[];
	newInstance?: boolean;
}
/**
 * What a window is, by owner process. `auth` is a system authentication panel
 * (keychain, admin rights, Touch ID), `permission` a TCC consent dialog,
 * `lock` the login window or screen saver, `app-modal` a panel one process
 * hosts for another (open/save/share). Everything else is `other`.
 */
export type ComputerWindowKind = "auth" | "permission" | "lock" | "app-modal" | "other";
/** System UI that took the screen; carried by refusals, actions and observations. */
export interface ComputerInterruption {
	app: string;
	pid: number;
	windowId: string;
	title: string;
	kind: ComputerWindowKind;
}
export interface ComputerWindowIdentity {
	id: string;
	pid: number;
	app: string;
	title: string;
	bounds: ComputerBounds;
	onScreen?: boolean;
	/** CGWindow layer: 0 for ordinary windows, 1000 for system auth panels. */
	layer?: number;
	/**
	 * Stacking order as the platform reports it: higher is closer to the
	 * front. Absent when it reports none, and then nothing may be inferred
	 * from roster order.
	 */
	zIndex?: number;
	kind?: ComputerWindowKind;
}
export interface ComputerElementSnapshot {
	ref: string;
	pid: number;
	windowId: string;
	role: string;
	label: string;
	value?: string;
	/** A field hint reported by the provider, separate from its raw value. */
	placeholder?: string;
	/**
	 * Provider-authored guidance for the control (macOS `AXHelp`, AT-SPI
	 * description): what it does, which its role and label often do not say.
	 * Absent when the provider offers none — most rows have neither.
	 */
	help?: string;
	/** Accessible description, when it says something the label does not. */
	description?: string;
	/** Unavailable platform state stays undefined; never infer enabled or disabled. */
	enabled?: boolean;
	selected?: boolean;
	/** Observed semantic actions accepted by perform; absence means unavailable. */
	actions?: readonly string[];
	bounds?: ComputerBounds;
}
export interface ComputerImage {
	path: string;
	width: number;
	height: number;
	sourceWidth: number;
	sourceHeight: number;
	target: string;
	/** Observed app/window name for presentation; target remains the routing identity. */
	label?: string;
}
export interface ComputerOperationContext {
	signal: AbortSignal;
	readOnly: boolean;
	maxWidth: number;
	maxHeight: number;
	emitImage(image: ComputerImage, content: { type: "image"; data: string; mimeType: string }, silent: boolean): void;
	/**
	 * Put action text into the cell's own output. A reply that doubts its own
	 * delivery has to reach the model even when the cell discards the returned
	 * result — otherwise a silent no-op is indistinguishable from success.
	 */
	emitText(text: string): void;
}
export interface ComputerRelatedWindow {
	id: string;
	pid: number;
	title: string;
	relation: "sheet";
}
export interface ComputerObservation {
	snapshotId: string;
	window: ComputerWindowIdentity;
	tree: string;
	elements: ComputerElementSnapshot[];
	complete: boolean;
	backgroundInput: unknown;
	/** Attached surfaces have separate identities and must be acquired before input. */
	relatedWindows?: readonly ComputerRelatedWindow[];
	/** Document window's file (`file://` URL); absent when the app reports none. */
	documentPath?: string;
	/** The app's own unsaved-changes flag; absent when the app reports none. */
	documentEdited?: boolean;
	screenshot?: ComputerImage;
	/** System UI covering the screen when this observation was taken. */
	interruptedBy?: ComputerInterruption;
	screenshotError?: string;
}
export interface ComputerWindowAcquisition extends ComputerWindowIdentity {
	initialObservation?: ComputerObservation;
	inspectionError?: string;
	initialScreenshot?: ComputerImage;
	screenshotError?: string;
}
export interface ComputerActionResult {
	text: string;
	effect: string;
	evidence: unknown;
	route?: string;
	delivery: unknown;
	/**
	 * Whether the app's own editing pipeline kept a written value. Reported by
	 * `setValue` when the driver could judge the end-of-edit gesture; absent
	 * when it has none to drive or does not report the flag at all.
	 */
	committed?: boolean;
	/**
	 * System UI that appeared while this action ran. The action itself was
	 * dispatched, so its evidence still describes the target; the environment
	 * changed under it and the next action will be refused.
	 */
	interruptedBy?: ComputerInterruption;
	data?: unknown;
}
export interface ObserveOptions {
	screenshot?: boolean;
	silent?: boolean;
	maxDepth?: number;
	maxElements?: number;
	query?: string;
	/**
	 * Include the window's `AXMenuBar` subtrees. They are excluded by default:
	 * a menu bar row only responds while its own menu is open, so `menu(path)`
	 * is the route, and the rows are a fifth of a macOS tree.
	 */
	menubar?: boolean;
}
/** How a selector several windows match is settled. */
export interface WindowResolveOptions {
	/**
	 * `front` acquires the frontmost match and names the others it passed
	 * over; `throw` refuses and lists every candidate. Acquisition defaults to
	 * `front` — the frontmost window is the one the user is looking at, and a
	 * model that has never seen the ids cannot pick between them.
	 */
	ambiguous?: "front" | "throw";
}
export interface AcquireOptions extends ObserveOptions, WindowResolveOptions {
	/**
	 * Launch the app the `{ app }` selector names when no window matches it
	 * yet. Defaults to true for an `{ app }` selector; an exact id/pid
	 * addresses a window that already exists and never launches anything.
	 */
	launch?: boolean;
}
export interface WindowSelector {
	id?: string;
	pid?: number;
	app?: string;
	title?: string;
}
export interface ActionOptions {
	delivery?: "background" | "foreground";
	button?: "left" | "right" | "middle";
	count?: number;
	modifiers?: string[];
}
export type ComputerTarget = string | [number, number];
