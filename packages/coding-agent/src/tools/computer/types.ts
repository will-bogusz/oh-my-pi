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
export interface ComputerWindowIdentity {
	id: string;
	pid: number;
	app: string;
	title: string;
	bounds: ComputerBounds;
	onScreen?: boolean;
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
	screenshot?: ComputerImage;
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
	data?: unknown;
}
export interface ObserveOptions {
	screenshot?: boolean;
	silent?: boolean;
	maxDepth?: number;
	maxElements?: number;
	query?: string;
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
