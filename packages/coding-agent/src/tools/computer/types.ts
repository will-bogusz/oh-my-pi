import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

/**
 * What the driver child can do on this host, as `computer.capabilities()`
 * returns it. The cua-driver backend's own shape: input routes are named by
 * `deliveryModes`, not by the native desktop backend's `takeover` flag.
 */
export interface ComputerCapabilities {
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
}

/** Frozen run settings captured from the host session for one computer run. */
export interface ComputerSessionSnapshot {
	cwd: string;
	sessionId: string;
	captureMaxWidth: number;
	captureMaxHeight: number;
	/**
	 * Pixel count one capture may carry before the model's own transport
	 * re-resizes it behind our back; 0 when the transport keeps what it is
	 * given and only the box above applies.
	 */
	captureMaxPixels: number;
	display: string;
	readOnly: boolean;
	/**
	 * True the first time a conversation asks about a topic, false after.
	 * Backends are rebuilt every turn; what the model was already told is the
	 * conversation's, so one-time notes key on this instead of on a backend.
	 */
	teach(topic: string): boolean;
}
/** Successful computer run output. */
export interface ComputerRunOk {
	displays: Array<TextContent | ImageContent>;
	returnValue: unknown;
	screenshots: ComputerScreenshot[];
	capabilities?: ComputerCapabilities;
	/** The last window a window step of the run resolved; absent when none did. */
	window?: ComputerWindowIdentity;
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
	surface?: "window" | "display";
	pointWidth?: number;
	pointHeight?: number;
	/** Window-local point of the image's top-left pixel; 0 unless the capture reached outside the window. */
	originX?: number;
	originY?: number;
	/** Image pixels per point of the captured surface; 1 is point-for-point. */
	scale?: number;
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
export type ComputerWindowKind = "auth" | "permission" | "lock" | "app-modal" | "desktop" | "other";
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
	axBacked?: boolean;
	main?: boolean;
	minimized?: boolean;
	kind?: ComputerWindowKind;
}
export interface ComputerElementSnapshot {
	ref: string;
	pid: number;
	windowId: string;
	role: string;
	label: string;
	/**
	 * The specific role behind a generic one (`AXSearchField` on an
	 * `AXTextField`). Present only where the provider reports one.
	 */
	subrole?: string;
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
	/**
	 * The provider says a value written to this control would be accepted
	 * (`AXUIElementIsAttributeSettable(AXValue)`). Present only where it says
	 * so: a date area, a stepper or a slider looks like a keyboard target and
	 * is not one, and the row that admits a write is the one to write to.
	 */
	settable?: true;
	/** Every action the provider advertises, under the name `perform` takes where it has one. */
	actions?: readonly string[];
	/** Observed geometry in points, in display coordinates. */
	bounds?: ComputerBounds;
}
export interface ComputerImage {
	path: string;
	width: number;
	height: number;
	sourceWidth: number;
	sourceHeight: number;
	/** What the point grid belongs to, and so which space coordinates are in. */
	surface: "window" | "display";
	/**
	 * Point size of what the pixels cover. A window's own bounds while
	 * nothing is hanging over it; the rect the window server actually drew —
	 * window plus popover plus menu — once something is.
	 */
	pointWidth: number;
	pointHeight: number;
	/**
	 * Where the image's top-left pixel sits in the window's own points. Zero
	 * on an ordinary capture; negative once the capture reaches above or to
	 * the left of the window, which is how a coordinate read off the image
	 * gets back to the window grid every action takes.
	 */
	originX: number;
	originY: number;
	/**
	 * Image pixels per point of what the pixels cover. 1 is what this capture
	 * path holds to: a coordinate read off the image is a coordinate an action
	 * takes. Anything smaller means the captured area outgrew the frame
	 * budget, and the result that carries the image says so.
	 */
	scale: number;
	target: string;
	/** Observed app/window name for presentation; target remains the routing identity. */
	label?: string;
}
export interface ComputerOperationContext {
	signal: AbortSignal;
	readOnly: boolean;
	maxWidth: number;
	maxHeight: number;
	/** Pixel-count ceiling one capture must stay under; 0 leaves only the box. */
	maxPixels: number;
	emitImage(image: ComputerImage, content: { type: "image"; data: string; mimeType: string }, silent: boolean): void;
	/**
	 * Put action text into the cell's own output. A reply that doubts its own
	 * delivery has to reach the model even when the cell discards the returned
	 * result — otherwise a silent no-op is indistinguishable from success.
	 */
	emitText(text: string): void;
	/** True once per conversation per topic (`ComputerSessionSnapshot.teach`). */
	teach(topic: string): boolean;
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
	/**
	 * The driver's own cause for an incomplete walk, where it reports one;
	 * absent when the tree is complete or the cause is unknown.
	 */
	truncation?: string;
	/** Attached sheets, each walked and rendered under this window's own tree. */
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
/**
 * The driver's verdict on a written value: `committed` once it observed the
 * app's own editing pipeline keep it, `not_committed` once it observed the app
 * discard it, `unproven` when the read-back it has cannot tell the two apart.
 * A driver that judges none reports nothing.
 */
export type ComputerCommitVerdict = "committed" | "not_committed" | "unproven";
/**
 * What a window scroll measured, read off the driver's `scroll` object.
 * `moved` and `at_end` are measured motion; `no_motion` is measured
 * stillness; `changed_in_place` saw pixels change with no rigid shift (a
 * pager, sheet or navigation); `unmeasured` had no capture to judge by.
 */
export type ComputerScrollOutcomeKind = "moved" | "at_end" | "no_motion" | "changed_in_place" | "unmeasured";
export interface ComputerScrollOutcome {
	outcome: ComputerScrollOutcomeKind;
	delivery: "foreground" | "background";
	direction: "up" | "down" | "left" | "right";
	/** Where the wheel went, in the caller's window points; absent when no frame maps it back. */
	point?: { x: number; y: number };
	/** The distance asked for, in window points; null on the background route, which sends line ticks. */
	requestedPt: number | null;
	/** Content travel along the requested direction (+ = the way asked), window points; null when unmeasured. */
	movedPt: number | null;
	/** Travel across it, window points; null when unmeasured. */
	acrossPt: number | null;
	confidence: number | null;
	/** The wheel events actually posted. */
	wheel?: { unit: "pixel" | "line"; events: number; total: number };
	chunks?: number;
	reason?: string;
}
/** Scroll distance units: notches of a line or of 0.8 × the visible height (width when scrolling sideways), or window points. */
export type ComputerScrollUnit = "line" | "page" | "points";
export interface ComputerActionResult {
	text: string;
	effect: string;
	evidence: unknown;
	route?: string;
	delivery: unknown;
	/** The driver's commit verdict for a written value; absent when it judged none. */
	committed?: ComputerCommitVerdict;
	/**
	 * The driver's escalation advice for this reply, in the vocabulary the
	 * caller types; present only when the reply named a rung this surface
	 * renders a call for.
	 */
	escalation?: string;
	/**
	 * The text has to reach the cell even where the code drops the returned
	 * value: the reply left its delivery or its written value unproven, or
	 * the session composed a line about it (a renderer's note, a window the
	 * app gained, system UI that appeared). Absent means the driver's own
	 * sentence is all there is and the action proved itself.
	 */
	mustShow?: boolean;
	/**
	 * System UI that appeared while this action ran. The action itself was
	 * dispatched, so its evidence still describes the target; the environment
	 * changed under it and the next action will be refused.
	 */
	interruptedBy?: ComputerInterruption;
	/** A window scroll's measured outcome; absent from a driver that measures none. */
	scroll?: ComputerScrollOutcome;
	data?: unknown;
}
export interface ObserveOptions {
	screenshot?: boolean;
	silent?: boolean;
	maxDepth?: number;
	maxElements?: number;
	/** One case-insensitive substring, taken literally; an array matches any of several. */
	query?: string | readonly string[];
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
	 * `front` acquires the app's front document window — on screen, titled and
	 * not one of its own attached sheets — and names the others it passed
	 * over; `throw` refuses and lists every candidate. Acquisition defaults to
	 * `front`: that window is the one the user is working in, and a model that
	 * has never seen the ids cannot pick between them.
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
	/** `desktop` names a display's desktop surface (the icons on the Desktop), which no title can. */
	kind?: "desktop";
}
export interface ActionOptions {
	delivery?: "background" | "foreground";
	button?: "left" | "right" | "middle";
	count?: number;
	modifiers?: string[];
}
export interface ScrollOptions extends ActionOptions {
	/** Line and page notches: 1–50. Points: 1–5000. */
	amount?: number;
	by?: ComputerScrollUnit;
}
/** Where `type` puts the caret in a control's current value before it types. */
export type ComputerCaret = "start" | "end" | { after: string } | { before: string };
export interface TypeOptions extends ActionOptions {
	caret?: ComputerCaret;
}
export type ComputerPoint = [number, number] | { x: number; y: number };
export type ComputerTarget = string | ComputerPoint;
