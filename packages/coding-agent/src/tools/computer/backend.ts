import type { DesktopCapabilities, DesktopDisplay } from "@oh-my-pi/pi-natives";
import type {
	ActionOptions,
	TypeOptions,
	ComputerActionResult,
	ComputerBounds,
	ComputerElementSnapshot,
	ComputerImage,
	ComputerLaunchOptions,
	ComputerObservation,
	ComputerOperationContext,
	ComputerTarget,
	ComputerWindowIdentity,
	ObserveOptions,
	WindowResolveOptions,
	WindowSelector,
} from "./types";

/** Observed verification evidence; unavailable state must remain unknown. */
export interface ComputerVerificationResult {
	status: "satisfied" | "unsatisfied" | "unknown";
	stable: boolean;
	elapsed_ms: number;
	samples: number;
	predicates: Array<{
		index: number;
		status: "satisfied" | "unsatisfied" | "unknown";
		unknown_reason: string | null;
		observed_json: string | null;
	}>;
}

/**
 * Computer operations exposed to the interpreter, independent of the driver.
 * Implementations own exact window/ref/frame validation and operation admission;
 * unsupported capabilities reject without an alternate target or input replay.
 */
export interface ComputerBackend {
	readonly capabilities: DesktopCapabilities & Record<string, unknown>;

	apps(context: ComputerOperationContext): Promise<unknown>;
	displays(context: ComputerOperationContext): Promise<DesktopDisplay[]>;
	windows(context: ComputerOperationContext, selector?: WindowSelector): Promise<ComputerWindowIdentity[]>;
	window(
		context: ComputerOperationContext,
		selector: string | WindowSelector,
		options?: WindowResolveOptions,
	): Promise<ComputerWindowIdentity>;
	acquire(
		context: ComputerOperationContext,
		selector: string | WindowSelector,
		options?: WindowResolveOptions,
	): Promise<ComputerWindowIdentity>;
	focusedWindow(context: ComputerOperationContext): Promise<ComputerWindowIdentity | null>;
	element(ref: string, window?: ComputerWindowIdentity): ComputerElementSnapshot;
	elementWindow(ref: string): ComputerWindowIdentity;
	observe(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		options?: ObserveOptions,
	): Promise<ComputerObservation>;
	captureWindow(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		options?: { silent?: boolean },
	): Promise<ComputerImage>;
	screenshot(context: ComputerOperationContext, options?: { silent?: boolean }): Promise<ComputerImage>;
	verify(
		context: ComputerOperationContext,
		window: Pick<ComputerWindowIdentity, "id" | "pid">,
		expect: Record<string, unknown>[],
		options?: { timeoutMs?: number; stableSamples?: number },
	): Promise<ComputerVerificationResult>;

	click(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		target: ComputerTarget,
		options?: ActionOptions,
	): Promise<ComputerActionResult>;
	type(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		text: string,
		target?: ComputerTarget,
		options?: TypeOptions,
	): Promise<ComputerActionResult>;
	press(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		chord: string | string[],
		target?: ComputerTarget,
		options?: ActionOptions,
	): Promise<ComputerActionResult>;
	setValue(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		ref: string,
		value: string,
	): Promise<ComputerActionResult>;
	perform(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		ref: string,
		action: string,
	): Promise<ComputerActionResult>;
	hover(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		x: number,
		y: number,
		options?: ActionOptions,
	): Promise<ComputerActionResult>;
	drag(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		from: ComputerTarget,
		to: ComputerTarget,
		options?: ActionOptions & { durationMs?: number; steps?: number },
	): Promise<ComputerActionResult>;
	scroll(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		direction: "up" | "down" | "left" | "right",
		target?: ComputerTarget,
		options?: ActionOptions & { amount?: number; by?: "line" | "page" },
	): Promise<ComputerActionResult>;
	setFrame(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		frame: ComputerBounds,
	): Promise<ComputerActionResult>;
	menu(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		menuPath: string[],
		options?: ActionOptions,
	): Promise<ComputerActionResult>;
	raise(context: ComputerOperationContext, window: ComputerWindowIdentity): Promise<ComputerActionResult>;

	desktopClick(
		context: ComputerOperationContext,
		x: number,
		y: number,
		options?: ActionOptions,
	): Promise<ComputerActionResult>;
	desktopMove(
		context: ComputerOperationContext,
		x: number,
		y: number,
		options?: ActionOptions,
	): Promise<ComputerActionResult>;
	desktopDrag(
		context: ComputerOperationContext,
		points: ComputerPoint[],
		options?: ActionOptions,
	): Promise<ComputerActionResult>;
	desktopScroll(
		context: ComputerOperationContext,
		x: number,
		y: number,
		options?: { dx?: number; dy?: number; delivery?: "background" | "foreground" },
	): Promise<ComputerActionResult>;
	desktopType(context: ComputerOperationContext, text: string, options?: ActionOptions): Promise<ComputerActionResult>;
	desktopPress(
		context: ComputerOperationContext,
		chord: string | string[],
		options?: ActionOptions,
	): Promise<ComputerActionResult>;
	clipboardRead(context: ComputerOperationContext): Promise<string>;
	clipboardWrite(context: ComputerOperationContext, text: string): Promise<ComputerActionResult>;
	launch(context: ComputerOperationContext, options: ComputerLaunchOptions): Promise<ComputerActionResult>;

	/** Wait for all admitted driver operations, including work whose caller aborted. */
	drain(): Promise<void>;
	/** Stop admission, drain operations, and release driver resources once. */
	close(): Promise<void>;
}

export type ComputerBackendFactory = (options: { display: string }) => Promise<ComputerBackend>;
