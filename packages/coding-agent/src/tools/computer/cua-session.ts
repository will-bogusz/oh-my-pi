import * as os from "node:os";
import * as path from "node:path";
import type { DesktopCapabilities, DesktopDisplay } from "@oh-my-pi/pi-natives";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { resizeImage } from "../../utils/image-resize";
import { ToolError, throwIfAborted } from "../tool-errors";
import type { ComputerBackend, ComputerBackendFactory } from "./backend";
import { type CuaDriver, type CuaDriverFactory, type CuaToolResult, spawnVendoredCuaDriver } from "./driver";
import {
	classifyWindow,
	describeInterruption,
	rosterInterruption,
	sampleWindowRoster,
	type WindowRosterSample,
} from "./interruption";
import { observedSemanticActions } from "./semantic-actions";
import type {
	ActionOptions,
	ComputerActionResult,
	ComputerBounds,
	ComputerElementSnapshot,
	ComputerImage,
	ComputerInterruption,
	ComputerLaunchOptions,
	ComputerObservation,
	ComputerRelatedWindow,
	ComputerOperationContext,
	ComputerTarget,
	ComputerWindowIdentity,
	ObserveOptions,
	WindowSelector,
} from "./types";

type Context = ComputerOperationContext;
type Wire = Record<string, unknown>;
interface Reply {
	result: CuaToolResult;
	data: Wire;
}
interface Binding {
	window: ComputerWindowIdentity;
	token: string;
	snapshotId: string;
	element: ComputerElementSnapshot;
	doubleClickAtCenter: boolean;
}
interface Frame {
	window: ComputerWindowIdentity;
	image: ComputerImage;
	sdkWidth: number;
	sdkHeight: number;
}
interface PrimaryDisplay {
	uuid: string;
	nativeId: number;
	bounds: ComputerBounds;
	scale: number;
}
interface DesktopFrame {
	display: PrimaryDisplay;
	image: ComputerImage;
}
type VerificationStatus = "satisfied" | "unsatisfied" | "unknown";
interface VerificationResult {
	status: VerificationStatus;
	stable: boolean;
	elapsed_ms: number;
	samples: number;
	predicates: {
		index: number;
		status: VerificationStatus;
		unknown_reason: string | null;
		observed_json: string | null;
	}[];
}
export interface CuaSessionOptions {
	display?: string;
	/** Spawns the driver child; a dead child is replaced through this on the next call. */
	spawn?: CuaDriverFactory;
	/** WindowServer roster used for interruption checks; tests inject a quiet desktop. */
	sampleRoster?: () => WindowRosterSample;
	/**
	 * Host the driver child runs on. The driver is a local child, so this is
	 * `process.platform`; tests pin it to exercise the other backend.
	 */
	platform?: NodeJS.Platform;
}
function object(value: unknown, name: string): Wire {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolError(`Malformed Cua ${name}`);
	return value as Wire;
}
function number(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolError(`Malformed Cua ${name}`);
	return value;
}
function string(value: unknown, name: string): string {
	if (typeof value !== "string") throw new ToolError(`Malformed Cua ${name}`);
	return value;
}
/** Signal 0 probes existence without delivering anything; EPERM still means alive. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
/** CGWindow owner that hosts macOS CrashReporter alerts ("<app> quit unexpectedly"). */
const CRASH_ALERT_HOST = "usernotificationcenter";
/** The pid a failed `launch_app` reports in its error details, if any. */
function launchedPid(error: unknown): number | undefined {
	const pid = error instanceof ToolError ? error.context?.pid : undefined;
	return typeof pid === "number" ? pid : undefined;
}
function crashAlertGuidance(pid: number, alert: ComputerInterruption): string {
	return `Launched app (pid ${pid}) exited and ${describeInterruption(alert)} — a crash report. Do not relaunch; acquire {id:"${alert.windowId}",pid:${alert.pid}}, observe it, press its "Ignore" button, then tell the user.`;
}
function relatedWindows(value: unknown): readonly ComputerRelatedWindow[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new ToolError("Malformed Cua related windows");
	return Object.freeze(
		value.map(value => {
			const row = object(value, "related window");
			const pid = number(row.pid, "related window PID");
			const id = number(row.window_id, "related window ID");
			if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(id) || id <= 0 || row.relation !== "sheet")
				throw new ToolError("Malformed Cua related window identity");
			return Object.freeze({
				id: String(id),
				pid,
				title: string(row.title, "related window title"),
				relation: "sheet" as const,
			});
		}),
	);
}
function bounds(value: unknown): ComputerBounds {
	const row = object(value, "bounds");
	return Object.freeze({
		x: number(row.x, "bounds.x"),
		y: number(row.y, "bounds.y"),
		width: number(row.width ?? row.w, "bounds.width"),
		height: number(row.height ?? row.h, "bounds.height"),
	});
}
function sameBounds(a: ComputerBounds, b: ComputerBounds): boolean {
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
function primaryDisplay(data: Wire, capture = false): PrimaryDisplay | undefined {
	// Stock 0.23.2 has dimensions only. They cannot identify a display.
	if (data.display_identity === undefined || data.screen_origin === undefined) return undefined;
	const identity = object(data.display_identity, "display_identity");
	const origin = object(data.screen_origin, "screen_origin");
	const uuid = string(identity.uuid, "display UUID");
	const nativeId = number(identity.native_id, "display native_id");
	const width = number(capture ? data.screen_width : data.width, "screen width");
	const height = number(capture ? data.screen_height : data.height, "screen height");
	const scale = number(data.scale_factor, "screen scale_factor");
	if (!uuid || !Number.isSafeInteger(nativeId) || nativeId < 1 || width <= 0 || height <= 0 || scale <= 0)
		throw new ToolError("Malformed Cua primary display identity/geometry");
	return Object.freeze({
		uuid,
		nativeId,
		scale,
		bounds: Object.freeze({
			x: number(origin.x, "screen origin x"),
			y: number(origin.y, "screen origin y"),
			width,
			height,
		}),
	});
}
function sameDisplay(a: PrimaryDisplay, b: PrimaryDisplay): boolean {
	return a.uuid === b.uuid && a.nativeId === b.nativeId && a.scale === b.scale && sameBounds(a.bounds, b.bounds);
}
function windowArgs(window: Pick<ComputerWindowIdentity, "id" | "pid">): Wire {
	const id = Number(window.id);
	if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(window.pid) || window.pid < 1)
		throw new ToolError("Invalid exact Cua window identity");
	return { pid: window.pid, window_id: id };
}
/**
 * Names each backend does not know, mapped to the one it does. The macOS
 * driver's modifier set is `cmd|command|shift|option|alt|ctrl|control|fn`
 * (`tools/hotkey.rs`) and the X11 driver's is `shift|ctrl|control|alt|super|
 * meta|win` (`input/mod.rs: key_name_to_keysym`), so the same chord has two
 * spellings. An unknown name is not a refusal on the macOS keystroke path: the
 * modifier is dropped and the base key types on its own, which is how `super+a`
 * typed "a" into a name field during the bench.
 */
const MACOS_KEY_ALIASES: Readonly<Record<string, string>> = {
	super: "cmd",
	meta: "cmd",
	win: "cmd",
	windows: "cmd",
};
const X11_KEY_ALIASES: Readonly<Record<string, string>> = {
	cmd: "super",
	command: "super",
	windows: "super",
	option: "alt",
};
/** DOM key names; both drivers spell the arrows bare. */
const ARROW_KEY = /^arrow(up|down|left|right)$/;
function chordKeys(chord: string | string[], platform: NodeJS.Platform): string[] {
	const keys = Array.isArray(chord) ? [...chord] : chord.split("+").map(key => key.trim());
	if (!keys.length || keys.some(key => !key)) throw new ToolError("Invalid key chord");
	const aliases = platform === "darwin" ? MACOS_KEY_ALIASES : X11_KEY_ALIASES;
	return keys.map(key => {
		const lower = key.toLowerCase();
		return ARROW_KEY.exec(lower)?.[1] ?? aliases[lower] ?? key;
	});
}
function delivery(options: ActionOptions): Wire {
	return { delivery_mode: options.delivery ?? "background" };
}
function foreground(options: { delivery?: "background" | "foreground" }): void {
	if (options.delivery !== "foreground") throw new ToolError("This desktop operation requires delivery: 'foreground'");
}
/**
 * The driver advertises its own wire vocabulary in refusal text and escalation
 * advice (`delivery_mode: "foreground"`); the prelude takes
 * `{ delivery: "foreground" }`. Rewriting at the error boundary keeps a typed
 * refusal's own suggestion executable as written. Structured details stay
 * verbatim on the error's context.
 */
const DELIVERY_MODE_VOCABULARY = /delivery_mode\s*:\s*"(background|foreground)"/g;
function preludeVocabulary<T>(value: T): T {
	if (typeof value === "string") return value.replace(DELIVERY_MODE_VOCABULARY, '{ delivery: "$1" }') as T;
	if (Array.isArray(value)) return value.map(entry => preludeVocabulary(entry)) as T;
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, preludeVocabulary(entry)])) as T;
	return value;
}
function unsupported(operation: string): never {
	throw new ToolError(`Unsupported Cua operation: ${operation}`);
}

/**
 * Maps computer operations onto `cua-driver` tools over one supervised child.
 * All desktop work, including capture, happens in the driver process.
 *
 * Operations are serialized per session. Aborting an operation's signal
 * cancels the driver call cooperatively and the session stays usable; a
 * child that exits (crash, or killed after ignoring a cancel) is respawned by
 * the next operation, with element refs and pixel frames invalidated.
 *
 * Driver window hover is only cursor decoration and focused-window identity is
 * unavailable. Display enumeration/capture/input cover the primary display only.
 * Desktop pixels require the driver's display identity/origin extension; stock
 * observations remain usable as images but never authorize coordinate dispatch.
 * Desktop drags are straight two-point gestures. Desktop scroll accepts only
 * one-axis multiples of 120 pixels (the driver's line notch), up to 50 notches.
 */
export class CuaComputerSession implements ComputerBackend {
	readonly #spawn: CuaDriverFactory;
	readonly #sampleRoster: () => WindowRosterSample;
	readonly #platform: NodeJS.Platform;
	readonly #elements = new Map<string, Binding>();
	readonly #frames = new Map<string, Frame>();
	readonly capabilities: DesktopCapabilities & Record<string, unknown>;
	#driver: CuaDriver;
	/**
	 * Monotonic source of public element refs (`n1`, `n2`, …). Never reset: a
	 * respawn clears `#elements`, and a counter that restarted would hand a
	 * dead ref from the previous child a live binding in the new one.
	 */
	#refSeq = 0;
	#tail: Promise<unknown> = Promise.resolve();
	/** Signal of the operation currently holding the serialized tail. */
	#signal?: AbortSignal;
	#closed = false;
	#closing?: Promise<void>;
	#desktopFrame?: DesktopFrame;

	private constructor(
		driver: CuaDriver,
		spawn: CuaDriverFactory,
		sampleRoster: () => WindowRosterSample,
		permissions: Wire,
		platform: NodeJS.Platform,
	) {
		this.#driver = driver;
		this.#spawn = spawn;
		this.#sampleRoster = sampleRoster;
		this.#platform = platform;
		// The two backends answer `check_permissions` with disjoint keys:
		// macOS reports TCC grants (`accessibility`, `screen_recording`),
		// Linux reports reachability (`x11`, `wayland`, `atspi`, `xsend_event`).
		// Nothing is synthesized: an unreported key stays false.
		const linux = platform === "linux";
		const x11 = permissions.x11 === true;
		const atspi = permissions.atspi === true;
		const accessibility = permissions.accessibility === true;
		const capture = linux ? x11 : permissions.screen_recording === true;
		const input = linux ? x11 : accessibility;
		const ax = linux ? atspi : accessibility;
		// X11 has no permission model; reachability is the booleans above.
		const state = (granted: boolean): string => (linux ? "not-applicable" : granted ? "granted" : "not-granted");
		this.capabilities = Object.freeze({
			backend: "cua-driver",
			displayServer: linux ? (permissions.wayland === true ? "wayland" : "x11") : "macos",
			capture,
			input,
			ax,
			backgroundWindowInput: linux ? atspi || x11 : accessibility,
			deliveryModes: ["background", "foreground"],
			capturePermission: state(capture),
			inputPermission: state(input),
			axPermission: state(ax),
			displayCount: 0,
			permissions: Object.freeze({ ...permissions }),
			driver: Object.freeze({ version: driver.version, transport: "mcp --direct" }),
			displayCountKnown: false,
			displayEnumeration: "primary only; other display count is unknown",
			captureScope: "exact window or primary display",
			desktopCoordinates: linux
				? "unavailable; the Linux driver reports no display identity, so desktop-root input is refused"
				: "primary display only; requires current UUID, native id, origin, size and scale metadata",
			desktopDrag: "exactly two points; the driver interpolates one straight drag",
			windowDrag:
				"foreground only; durationMs integer 0–10000 (default 500), steps integer 1–200 (default 20); background drag is unavailable",
			desktopScroll: "one axis per action; pixel deltas must be multiples of 120, up to 6000",
			backgroundInput: linux
				? 'toolkit-dependent; a typed background_unavailable refusal means nothing was dispatched — retry with { delivery: "foreground" }'
				: "best effort; use observation backgroundInput and fresh evidence, never assume delivery",
			elementRefLifetime:
				"Exact driver snapshot, PID and window; re-observe after StaleRef. AX traversals can evict driver snapshots.",
			unsupported: linux
				? ["window hover", "focusedWindow", "displays", "desktop-root input", "interruption detection"]
				: ["window hover", "focusedWindow", "secondary display enumeration/capture/input"],
		});
	}

	static async create(options: CuaSessionOptions = {}): Promise<CuaComputerSession> {
		if (options.display && !["all", "primary"].includes(options.display))
			unsupported(`display selector '${options.display}'`);
		const platform = options.platform ?? process.platform;
		const spawn = options.spawn ?? spawnVendoredCuaDriver;
		const driver = await spawn();
		try {
			const permissions = await driver.callTool("check_permissions", { prompt: false });
			if (permissions.isError) throw new ToolError(permissions.text);
			const reported = object(JSON.parse(permissions.structuredJson ?? "{}"), "permissions");
			// Without an X11 connection the Linux driver answers every window
			// call with an opaque X error; its own report says what is missing.
			if (platform === "linux" && reported.x11 !== true) throw new ToolError(permissions.text);
			return new CuaComputerSession(driver, spawn, options.sampleRoster ?? sampleWindowRoster, reported, platform);
		} catch (error) {
			await driver.kill({ force: true });
			throw error;
		}
	}

	/** The live child, replacing one that exited. Cached refs and frames die with the old child. */
	async #liveDriver(): Promise<CuaDriver> {
		if (this.#driver.alive) return this.#driver;
		logger.warn("cua-driver child is gone; respawning", { previousPid: this.#driver.pid });
		this.#driver = await this.#spawn();
		this.#elements.clear();
		this.#frames.clear();
		this.#desktopFrame = undefined;
		return this.#driver;
	}

	#guard(context: Context): void {
		throwIfAborted(context.signal);
		if (this.#closed) throw new ToolError("Computer session is closed");
	}
	/**
	 * The only place interruption detection is decided. Every caller — the
	 * pre-dispatch gate, observations, action replies and `launch`'s crash
	 * watch — goes through here, and off macOS it is always "no sample".
	 *
	 * The WindowServer roster is a macOS concept: `pi-natives` has no other
	 * implementation, and X11 has no equivalent of a layer-1000 SecurityAgent
	 * window. Leaving the gate to an empty roster would state the same
	 * behaviour by accident; this states it.
	 */
	#roster(): WindowRosterSample | undefined {
		return this.#platform === "darwin" ? this.#sampleRoster() : undefined;
	}
	#interruption(): ComputerInterruption | undefined {
		const sample = this.#roster();
		return sample && rosterInterruption(sample);
	}
	/**
	 * Pre-dispatch gate for every mutation. While a system prompt owns the
	 * screen an action either lands invisibly behind it (background routes are
	 * pid-addressed and AX writes bypass the WindowServer) or lands *in* it
	 * (foreground delivery posts to the HID tap, which is the password field).
	 * Both are wrong, so nothing is dispatched.
	 *
	 * One exemption: an AX action aimed at a crash alert this session caused
	 * (`#crashAlerts`, recorded by `launch`) — that is how the agent presses
	 * "Ignore" on the report for its own crashed app instead of leaving it
	 * on the user's screen.
	 */
	#refuseWhenInterrupted(name: string, crashAlertTarget?: string): void {
		const interruption = this.#interruption();
		if (!interruption) return;
		if (
			crashAlertTarget !== undefined &&
			interruption.windowId === crashAlertTarget &&
			interruption.app.trim().toLowerCase() === CRASH_ALERT_HOST &&
			this.#crashAlerts.has(crashAlertTarget)
		)
			return;
		throw new ToolError(
			`Interrupted: ${describeInterruption(interruption)}. '${name}' was not dispatched; tell the user what is asking and wait for them. Never type, click or send keys at it. Reading is still allowed: acquire {id:"${interruption.windowId}",pid:${interruption.pid}} and observe it to see what it says — the system alert host also carries crash reports and other alerts, and the user needs to know which one it is.`,
			{ interruptedBy: interruption },
		);
	}
	/** Window ids of CrashReporter alerts raised by apps this session launched; see `launch`. */
	readonly #crashAlerts = new Set<string>();
	/**
	 * `crashAlertTarget`: only the AX semantic route (`perform`) passes its
	 * window id, so the crash-alert exemption can never reach a keystroke,
	 * pointer or value write — those routes have no business on any alert.
	 */
	async #schedule<T>(
		context: Context,
		name: string,
		mutation: boolean,
		dispatch: () => Promise<T>,
		crashAlertTarget?: string,
	): Promise<T> {
		if (mutation && context.readOnly) throw new ToolError(`read-only run: '${name}' requires read_only: false`);
		this.#guard(context);
		const run = async (): Promise<T> => {
			this.#guard(context);
			if (mutation) this.#refuseWhenInterrupted(name, crashAlertTarget);
			this.#signal = context.signal;
			try {
				const value = await dispatch();
				throwIfAborted(context.signal);
				return value;
			} finally {
				this.#signal = undefined;
			}
		};
		const pending = this.#tail.then(run, run);
		this.#tail = pending.catch(() => undefined);
		return pending;
	}
	async #call(name: string, args: Wire): Promise<Reply> {
		const result = await (await this.#liveDriver()).callTool(name, args, this.#signal);
		if (result.isError) {
			let details: Wire | undefined;
			try {
				details = result.structuredJson ? object(JSON.parse(result.structuredJson), `${name} error`) : undefined;
			} catch {
				// Malformed optional details must not replace the original SDK failure.
			}
			const code = result.errorCode ?? (typeof details?.error === "string" ? details.error : "CuaError");
			// A typed refusal (`background_unavailable`, `foreground_unavailable`)
			// carries the driver's own reason and the one escalation that works.
			// Both survive verbatim; only the route is restated in the vocabulary
			// the caller can actually type. Nothing is retried here.
			throw new ToolError(
				`${code}: ${preludeVocabulary(result.text)}${details ? `\nDetails: ${JSON.stringify(preludeVocabulary(details))}` : ""}`,
				details,
			);
		}
		return { result, data: object(JSON.parse(result.structuredJson ?? "{}"), `${name} result`) };
	}
	/**
	 * Cua enumerates CGWindow layer 0 only, which is exactly where the system
	 * panels are not: a keychain prompt is a layer-1000 SecurityAgent window.
	 * The WindowServer sample supplies `kind` for the rows Cua does report and
	 * contributes the classified rows it cannot see, with their real geometry —
	 * Cua reports a placeholder rectangle and `onScreen: false` for the
	 * off-screen ghost windows those owners also keep.
	 */
	#windowRoster(data: Wire, selector: WindowSelector, sample?: WindowRosterSample): ComputerWindowIdentity[] {
		if (!Array.isArray(data.windows)) throw new ToolError("Malformed Cua window roster");
		const onScreen = new Map((sample?.windows ?? []).map(window => [window.id, window]));
		const windows: ComputerWindowIdentity[] = [];
		for (const value of data.windows) {
			const row = object(value, "window");
			// X11 reports a titled window whose owner set no `_NET_WM_PID` with
			// `pid: null` (contract-legal). Every driver call is pid-addressed,
			// so such a row names nothing this session can observe or act on.
			if (row.pid === null) continue;
			const window = {
				id: String(number(row.window_id, "window_id")),
				pid: number(row.pid, "pid"),
				app: string(row.app_name, "app_name"),
				title: string(row.title, "title"),
				bounds: bounds(row.bounds),
				onScreen: typeof row.is_on_screen === "boolean" ? row.is_on_screen : undefined,
				// Contract-optional and absent on Linux; only macOS stacks system
				// panels on a layer. Unknown stays unknown.
				...(typeof row.layer === "number" ? { layer: row.layer } : {}),
				// An owner's off-screen placeholder window is not the panel itself.
				kind: onScreen.has(String(row.window_id))
					? classifyWindow({ app: string(row.app_name, "app_name") })
					: ("other" as const),
			};
			windowArgs(window);
			windows.push(Object.freeze(window));
		}
		if (sample) {
			const known = new Set(windows.map(window => window.id));
			for (const row of sample.windows) {
				const kind = classifyWindow(row);
				// Menus, tooltips, the Dock and the rest of the accessory layers
				// stay out for the reason Cua filters them: they swamp the roster.
				if (kind === "other" || known.has(row.id)) continue;
				windows.push(
					Object.freeze({
						id: row.id,
						pid: row.pid,
						app: row.app,
						title: row.title,
						bounds: Object.freeze({ x: row.x, y: row.y, width: row.width, height: row.height }),
						onScreen: true,
						layer: row.layer,
						kind,
					}),
				);
			}
		}
		return windows.filter(
			window =>
				(selector.id === undefined || window.id === selector.id) &&
				(selector.pid === undefined || window.pid === selector.pid) &&
				(selector.app === undefined || window.app.toLowerCase().includes(selector.app.toLowerCase())) &&
				(selector.title === undefined || window.title.toLowerCase().includes(selector.title.toLowerCase())),
		);
	}
	async #windows(selector: WindowSelector = {}): Promise<ComputerWindowIdentity[]> {
		const { data } = await this.#call("list_windows", {});
		return this.#windowRoster(data, selector, this.#roster());
	}
	async #window(selector: string | WindowSelector): Promise<ComputerWindowIdentity> {
		const filter = typeof selector === "string" ? { id: selector } : selector;
		let matches = await this.#windows(filter);
		const pid = matches[0]?.pid;
		if (filter.id === undefined && matches.length > 1 && matches.every(window => window.pid === pid)) {
			// WindowServer can include invisible app helpers. Only a complete,
			// exact AXWindows mapping may narrow a broad selector; visibility,
			// title, size and stacking order are not evidence of window ownership.
			const { data } = await this.#call("list_windows", { pid, include_accessibility_metadata: true });
			const sample = this.#roster();
			const roster = this.#windowRoster(data, { pid }, sample);
			matches = this.#windowRoster(data, filter, sample).filter(window => window.pid === pid);
			const metadata = data.accessibility_windows;
			if (metadata !== undefined) {
				const ax = object(metadata, "accessibility window metadata");
				if (ax.pid !== pid) throw new ToolError("Mismatched Cua accessibility window process");
				if (ax.complete === true) {
					if (!Array.isArray(ax.windows)) throw new ToolError("Malformed Cua accessibility window roster");
					const ids = new Set(
						ax.windows.map(value => {
							const row = object(value, "accessibility window");
							const id = number(row.window_id, "accessibility window_id");
							if (!Number.isInteger(id) || id <= 0 || id > 0xffff_ffff || row.role !== "AXWindow")
								throw new ToolError("Malformed Cua accessibility window identity");
							return String(id);
						}),
					);
					// AX and CG are sequential snapshots. Missing CG identities mean
					// the mapping cannot safely disambiguate this acquisition.
					if (ids.size && [...ids].every(id => roster.some(window => window.id === id))) {
						const applicationWindows = matches.filter(window => ids.has(window.id));
						if (applicationWindows.length) matches = applicationWindows;
					}
				}
			}
		}
		if (matches.length !== 1)
			throw new ToolError(
				`${matches.length ? "Ambiguous" : "Missing"} computer window ${JSON.stringify(selector)}: ${JSON.stringify(matches)}`,
			);
		return matches[0]!;
	}
	#current(window: Pick<ComputerWindowIdentity, "id" | "pid">): Promise<ComputerWindowIdentity> {
		return this.#window({ id: window.id, pid: window.pid });
	}
	windows(context: Context, selector: WindowSelector = {}): Promise<ComputerWindowIdentity[]> {
		return this.#schedule(context, "windows", false, () => this.#windows(selector));
	}
	window(context: Context, selector: string | WindowSelector): Promise<ComputerWindowIdentity> {
		return this.#schedule(context, "window", false, () => this.#window(selector));
	}
	apps(context: Context): Promise<unknown> {
		return this.#schedule(context, "apps", false, async () => (await this.#call("list_apps", {})).data);
	}
	displays(context: Context): Promise<DesktopDisplay[]> {
		return this.#schedule(context, "displays", false, async () => {
			const display = await this.#primaryDisplay();
			if (!display) unsupported("display identity is unavailable in this SDK");
			return [
				{
					id: display.uuid,
					name: "Primary display",
					...display.bounds,
					scale: display.scale,
					pixelX: 0,
					pixelY: 0,
					pixelWidth: Math.round(display.bounds.width * display.scale),
					pixelHeight: Math.round(display.bounds.height * display.scale),
					isPrimary: true,
				},
			];
		});
	}
	focusedWindow(context: Context): Promise<ComputerWindowIdentity | null> {
		return this.#schedule(context, "focusedWindow", false, async () =>
			unsupported("focusedWindow; stacking order does not prove keyboard focus"),
		);
	}
	#invalidate(window: Pick<ComputerWindowIdentity, "id" | "pid">): void {
		for (const [ref, binding] of this.#elements)
			if (binding.window.id === window.id && binding.window.pid === window.pid) this.#elements.delete(ref);
	}
	#binding(ref: string, window?: ComputerWindowIdentity): Binding {
		const binding = this.#elements.get(ref);
		if (this.#closed || !binding) throw new ToolError("StaleRef: observe the window again");
		if (window && (binding.window.id !== window.id || binding.window.pid !== window.pid))
			throw new ToolError("WrongWindow: element belongs to a different PID/window");
		return binding;
	}
	element(ref: string, window?: ComputerWindowIdentity): ComputerElementSnapshot {
		return this.#binding(ref, window).element;
	}
	elementWindow(ref: string): ComputerWindowIdentity {
		return this.#binding(ref).window;
	}

	observe(
		context: Context,
		window: ComputerWindowIdentity,
		options: ObserveOptions = {},
	): Promise<ComputerObservation> {
		return this.#schedule(context, "observe", false, async () => {
			const { reply, current } = await this.#state(context, window, {
				include_accessibility_tree: true,
				include_screenshot: options.screenshot === true,
				max_depth: options.maxDepth,
				max_elements: options.maxElements,
				query: options.query,
			});
			if (!Array.isArray(reply.data.elements)) throw new ToolError("Malformed Cua elements");
			// A real window can have no matching AXWindow at all (canvas/custom UI).
			// Preserve visual access without fabricating an actionable SDK snapshot.
			const snapshotId = typeof reply.data.snapshot_id === "string" ? reply.data.snapshot_id : "unavailable";
			if (snapshotId === "unavailable" && reply.data.elements.length)
				throw new ToolError("Cua elements have no snapshot identity");
			const rows: { depth: number; element: ComputerElementSnapshot }[] = [];
			for (const value of reply.data.elements) {
				const row = object(value, "element");
				const token = string(row.element_token, "element_token");
				// `#elements` is the only binding: it carries the exact window, driver
				// snapshot and element token, and rejects a ref it does not hold. The
				// ref itself only has to be unique for this session's lifetime.
				const ref = `n${++this.#refSeq}`;
				if (row.background_actions != null && !Array.isArray(row.background_actions))
					throw new ToolError("Malformed Cua background actions");
				const actions = row.background_actions ?? row.actions;
				const element = Object.freeze({
					ref,
					pid: current.pid,
					windowId: current.id,
					role: string(row.role, "role"),
					label: typeof row.label === "string" ? row.label : "",
					...(typeof row.value === "string" ? { value: row.value } : {}),
					...(typeof row.placeholder === "string" ? { placeholder: row.placeholder } : {}),
					// Semantics the provider authored but role/label do not carry. An
					// empty string is the driver's way of saying "none", and a
					// description that merely repeats the label is pure noise.
					...(typeof row.help === "string" && row.help ? { help: row.help } : {}),
					...(typeof row.description === "string" &&
					row.description &&
					row.description !== row.label &&
					row.description !== row.value
						? { description: row.description }
						: {}),
					...(typeof row.enabled === "boolean" ? { enabled: row.enabled } : {}),
					...(typeof row.selected === "boolean" ? { selected: row.selected } : {}),
					...(Array.isArray(actions) ? { actions: observedSemanticActions(actions) } : {}),
					...(row.frame ? { bounds: bounds(row.frame) } : {}),
				});
				this.#elements.set(ref, {
					window: current,
					token,
					snapshotId,
					element,
					doubleClickAtCenter: reply.data.element_double_click === "left_center_v1",
				});
				rows.push({
					depth: typeof row.depth === "number" ? Math.max(0, Math.min(50, Math.floor(row.depth))) : 0,
					element,
				});
			}
			// Only the walker knows whether it clipped the tree. `truncated` is its
			// explicit verdict and `elements_complete` its older positive proof.
			// Equal returned/total counts prove nothing: both count what the walk
			// reached, so every budget-capped walk called itself complete. Without
			// a verdict a requested `maxElements` is a budget the walk may have
			// hit, and no count can argue that away.
			const walkFinished = reply.data.ax_walk_timed_out !== true && reply.data.ax_walk_stop_reason == null;
			const countedWhole =
				typeof reply.data.returned_element_count === "number" &&
				reply.data.returned_element_count === reply.data.total_element_count;
			const complete =
				walkFinished &&
				(typeof reply.data.truncated === "boolean"
					? !reply.data.truncated
					: reply.data.elements_complete === true || (options.maxElements === undefined && countedWhole));
			const observation: ComputerObservation = {
				snapshotId,
				window: current,
				elements: rows.map(row => row.element),
				complete,
				backgroundInput: reply.data.background_input ?? null,
				relatedWindows: relatedWindows(reply.data.related_windows),
				tree: rows
					.map(
						({ depth, element }) =>
							`${"  ".repeat(depth)}- [${element.ref}] ${element.role} ${JSON.stringify(element.label)}${element.value !== undefined ? ` value=${JSON.stringify(element.value)}` : ""}${element.placeholder !== undefined ? ` placeholder=${JSON.stringify(element.placeholder)}` : ""}${element.description !== undefined ? ` description=${JSON.stringify(element.description)}` : ""}${element.help !== undefined ? ` help=${JSON.stringify(element.help)}` : ""}${element.enabled !== undefined ? ` enabled=${element.enabled}` : ""}${element.selected !== undefined ? ` selected=${element.selected}` : ""}${element.actions?.length ? ` actions=${JSON.stringify(element.actions)}` : ""}`,
					)
					.join("\n"),
			};
			if (!rows.length)
				observation.tree =
					typeof reply.data.degraded_reason === "string"
						? reply.data.degraded_reason
						: "No accessibility elements returned; completeness is unknown.";
			if (observation.relatedWindows?.length)
				observation.tree += `\nAttached sheets: ${JSON.stringify(observation.relatedWindows)}`;
			if (reply.data.ax_walk_timed_out === true)
				observation.tree +=
					"\nAccessibility observation reached its time limit. The walk has finished; omitted controls and values remain unknown.";
			else if (reply.data.ax_walk_stop_reason != null)
				observation.tree +=
					"\nAccessibility observation stopped because a native request could not complete. The walk has finished; omitted controls and values remain unknown.";
			// Document apps: the app's own dirty bit and file path (absent = the app
			// reports neither). AX value writes never reach disk, so this is how the
			// model tells "text changed" from "saved".
			if (typeof reply.data.document_path === "string") observation.documentPath = reply.data.document_path;
			if (typeof reply.data.document_edited === "boolean") observation.documentEdited = reply.data.document_edited;
			if (observation.documentPath !== undefined || observation.documentEdited !== undefined)
				observation.tree += `\nDocument: ${observation.documentPath ?? "(path unknown)"}${observation.documentEdited === undefined ? "" : observation.documentEdited ? " — unsaved changes" : " — no unsaved changes flagged (setValue writes are not flagged; check the disk)"}`;
			// An observation is the model's picture of the environment; a system
			// prompt over it is part of that picture even though the AX tree of
			// the target window looks entirely normal underneath.
			observation.interruptedBy = this.#interruption();
			if (observation.interruptedBy)
				observation.tree += `\n⚠️ Interrupted: ${describeInterruption(observation.interruptedBy)}. Actions on any window are refused until it is answered; tell the user what is asking.`;
			if (options.screenshot) {
				try {
					observation.screenshot = await this.#windowImage(context, current, reply, options.silent === true);
				} catch (error) {
					throwIfAborted(context.signal);
					observation.screenshotError = error instanceof Error ? error.message : String(error);
				}
			}
			return observation;
		});
	}
	async #state(
		context: Context,
		window: ComputerWindowIdentity,
		args: Wire,
	): Promise<{ reply: Reply; current: ComputerWindowIdentity }> {
		// Cua keeps one rendering lease per session. A screenshot request may stop
		// the previous window's stream even when the new capture fails.
		if (args.include_screenshot === true) this.#frames.clear();
		else this.#frames.delete(window.id);
		if (args.include_accessibility_tree !== false) this.#invalidate(window);
		const current = await this.#current(window);
		throwIfAborted(context.signal);
		const reply = await this.#call("get_window_state", { ...windowArgs(current), ...args });
		if (reply.data.pid !== current.pid || String(reply.data.window_id) !== current.id)
			throw new ToolError("WrongWindow: Cua observation identity mismatch");
		const after = await this.#current(current);
		if (!sameBounds(current.bounds, after.bounds))
			throw new ToolError("StaleFrame: window geometry changed during observation");
		return { reply, current: after };
	}
	async #saveImage(
		context: Context,
		reply: Reply,
		target: string,
		silent: boolean,
		label?: string,
	): Promise<ComputerImage> {
		if (reply.result.images.length !== 1) throw new ToolError("Screenshot unavailable or ambiguous");
		const source = reply.result.images[0]!;
		const width = number(reply.data.screenshot_width, "screenshot_width");
		const height = number(reply.data.screenshot_height, "screenshot_height");
		const resized = await resizeImage(
			{ type: "image", data: source.dataBase64, mimeType: source.mimeType },
			{ maxWidth: context.maxWidth, maxHeight: context.maxHeight, minDimension: 1, excludeWebP: true },
		);
		if (resized.decodeFailed || resized.originalWidth !== width || resized.originalHeight !== height)
			throw new ToolError("Screenshot dimensions do not match its SDK coordinate frame");
		const destination = path.join(
			os.tmpdir(),
			`omp-computer-${crypto.randomUUID()}.${resized.mimeType === "image/png" ? "png" : "jpg"}`,
		);
		await Bun.write(destination, resized.buffer);
		throwIfAborted(context.signal);
		const image = Object.freeze({
			path: destination,
			width: resized.width,
			height: resized.height,
			sourceWidth: width,
			sourceHeight: height,
			target,
			...(label ? { label } : {}),
		});
		context.emitImage(image, { type: "image", data: resized.data, mimeType: resized.mimeType }, silent);
		return image;
	}
	async #windowImage(
		context: Context,
		window: ComputerWindowIdentity,
		reply: Reply,
		silent: boolean,
	): Promise<ComputerImage> {
		// `screenshot_frame_valid` is a contract-optional tri-state: macOS sets
		// it true on success, Linux only ever sets it false on a capture error.
		// A valid frame is therefore "not denied, one image part, and geometry
		// to bind it to" — absence is not failure and never fabricates pixels.
		if (
			reply.data.screenshot_frame_valid === false ||
			reply.result.images.length !== 1 ||
			reply.data.window_bounds === undefined
		) {
			const failure = reply.data.screenshot_error;
			if (failure && typeof failure === "object" && !Array.isArray(failure)) {
				const details = failure as Wire;
				// The driver bounds its capture-start wait; the accessibility tree in
				// the same reply is still good, only the pixels are missing.
				if (details.code === "capture_timeout")
					throw new ToolError(
						`capture_timeout: the window did not deliver a frame within ${String(details.waited_ms ?? "?")} ms; accessibility state is still current — retry the screenshot or continue with refs`,
						details,
					);
				if (typeof details.code === "string" && typeof details.reason === "string")
					throw new ToolError(`${details.code}: ${details.reason}`);
			}
			throw new ToolError("Screenshot unavailable: the driver did not provide a valid image");
		}
		if (!sameBounds(bounds(reply.data.window_bounds), window.bounds))
			throw new ToolError("StaleFrame: Cua did not provide a valid matching screenshot frame");
		const image = await this.#saveImage(
			context,
			reply,
			window.id,
			silent,
			`${window.app}: ${window.title || "Untitled window"}`,
		);
		this.#frames.set(window.id, {
			window,
			image,
			sdkWidth: number(reply.data.screenshot_width, "screenshot_width"),
			sdkHeight: number(reply.data.screenshot_height, "screenshot_height"),
		});
		return image;
	}
	captureWindow(
		context: Context,
		window: ComputerWindowIdentity,
		options: { silent?: boolean } = {},
	): Promise<ComputerImage> {
		return this.#schedule(context, "captureWindow", false, async () => {
			const { current, reply } = await this.#state(context, window, {
				include_accessibility_tree: false,
				include_screenshot: true,
			});
			return this.#windowImage(context, current, reply, options.silent === true);
		});
	}
	#target(window: ComputerWindowIdentity, target?: ComputerTarget): Wire {
		if (typeof target === "string") {
			const ref = this.#binding(target, window);
			return { ...windowArgs(window), element_token: ref.token, snapshot_id: ref.snapshotId };
		}
		if (!target) return windowArgs(window);
		const frame = this.#frames.get(window.id);
		if (!frame || frame.window.pid !== window.pid || !sameBounds(frame.window.bounds, window.bounds)) {
			this.#frames.delete(window.id);
			throw new ToolError("StaleFrame: capture the exact window again before a pixel action");
		}
		const [x, y] = target;
		if (
			!Number.isFinite(x) ||
			!Number.isFinite(y) ||
			x < 0 ||
			y < 0 ||
			x >= frame.image.width ||
			y >= frame.image.height
		)
			throw new ToolError("InvalidCoordinates: point is outside the observed window image");
		return {
			...windowArgs(window),
			x: (x * frame.sdkWidth) / frame.image.width,
			y: (y * frame.sdkHeight) / frame.image.height,
		};
	}
	/**
	 * Modifiers and click counts are a pixel-route capability here: the element
	 * route posts a bare AX press that carries neither. The ref's own observed
	 * bounds name the point — its centre, converted out of global desktop
	 * coordinates into the cached frame's pixels, so the pixel action is checked
	 * against the same live frame a model-supplied point would be. Without
	 * bounds or without a frame there is no honest point, and only then is the
	 * click refused.
	 */
	#elementPixel(window: ComputerWindowIdentity, element: ComputerElementSnapshot): ComputerTarget | undefined {
		const frame = this.#frames.get(window.id);
		const box = element.bounds;
		if (!frame || !box) return undefined;
		const area = frame.window.bounds;
		return [
			((box.x + box.width / 2 - area.x) * frame.image.width) / area.width,
			((box.y + box.height / 2 - area.y) * frame.image.height) / area.height,
		];
	}
	/**
	 * The pre-dispatch gate cleared the screen a moment ago, so any blocking
	 * window found now appeared while this action ran — a prompt the action
	 * itself provoked, or the user's own. The action is not retracted; the
	 * result says the environment changed under it, and the next mutation is
	 * refused until the panel goes away.
	 */
	async #action(name: string, args: Wire): Promise<ComputerActionResult> {
		const { result, data } = await this.#call(name, args);
		const interruptedBy = this.#interruption();
		return {
			text: interruptedBy
				? `${result.text}\n⚠️ Interrupted while acting: ${describeInterruption(interruptedBy)}. Stop and tell the user; further actions are refused until it is answered.`
				: result.text,
			effect: typeof data.effect === "string" ? data.effect : "unverifiable",
			evidence: data.evidence ?? null,
			route: typeof data.route === "string" ? data.route : typeof data.path === "string" ? data.path : "cua-sdk",
			delivery: data.delivery ?? args.delivery_mode ?? "background",
			interruptedBy,
			data,
		};
	}
	#targetAction(
		context: Context,
		name: string,
		window: ComputerWindowIdentity,
		target: ComputerTarget | undefined,
		args: Wire,
		crashAlertTarget?: string,
	): Promise<ComputerActionResult> {
		return this.#schedule(
			context,
			name,
			true,
			async () => {
				const current = await this.#current(window);
				throwIfAborted(context.signal);
				return this.#action(name, { ...this.#target(current, target), ...args });
			},
			crashAlertTarget,
		);
	}
	click(
		context: Context,
		window: ComputerWindowIdentity,
		target: ComputerTarget,
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(
			context,
			"click",
			true,
			async () => {
				const current = await this.#current(window);
				throwIfAborted(context.signal);
				let point = target;
				if (typeof target === "string") {
					const binding = this.#binding(target, current);
					const supportedDouble =
						binding.doubleClickAtCenter && options.count === 2 && (options.button ?? "left") === "left";
					if (options.modifiers?.length || ((options.count ?? 1) !== 1 && !supportedDouble)) {
						const pixel = this.#elementPixel(current, binding.element);
						if (!pixel)
							unsupported(
								"counted or modified click on an element with no observed bounds or no current window screenshot; capture the window again and use a pixel target",
							);
						point = pixel;
					}
				}
				return this.#action("click", {
					...this.#target(current, point),
					...delivery(options),
					button: options.button,
					count: options.count,
					modifier: options.modifiers,
				});
			},
			// A background click on an element ref is the AX press route, so it
			// may address a crash alert this session caused (see the gate). A
			// counted or modified click leaves that route for pixels, which have
			// no business on an alert.
			typeof target === "string" &&
				!options.modifiers?.length &&
				(options.count ?? 1) === 1 &&
				options.delivery !== "foreground"
				? window.id
				: undefined,
		);
	}
	type(
		context: Context,
		window: ComputerWindowIdentity,
		text: string,
		target?: ComputerTarget,
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#targetAction(context, "type_text", window, target, { text, ...delivery(options) });
	}
	setValue(
		context: Context,
		window: ComputerWindowIdentity,
		ref: string,
		value: string,
	): Promise<ComputerActionResult> {
		return this.#targetAction(context, "set_value", window, ref, { value });
	}
	press(
		context: Context,
		window: ComputerWindowIdentity,
		chord: string | string[],
		target?: ComputerTarget,
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		const keys = chordKeys(chord, this.#platform);
		return this.#targetAction(context, keys.length === 1 ? "press_key" : "hotkey", window, target, {
			...(keys.length === 1 ? { key: keys[0] } : { keys }),
			...delivery(options),
		});
	}
	perform(
		context: Context,
		window: ComputerWindowIdentity,
		ref: string,
		action: string,
	): Promise<ComputerActionResult> {
		if (!["press", "show_menu", "pick", "confirm", "cancel", "open"].includes(action))
			unsupported(`AX action '${action}'`);
		return this.#targetAction(context, "click", window, ref, { action, delivery_mode: "background" }, window.id);
	}
	hover(
		context: Context,
		_window: ComputerWindowIdentity,
		_x: number,
		_y: number,
		_options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(context, "hover", true, async () =>
			unsupported("window hover; move_cursor only moves an overlay in window scope"),
		);
	}
	drag(
		context: Context,
		window: ComputerWindowIdentity,
		from: [number, number],
		to: [number, number],
		options: ActionOptions & { durationMs?: number; steps?: number } = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(context, "drag", true, async () => {
			if (options.delivery !== "foreground") unsupported("background drag on macOS Cua; no input was sent");
			if (
				options.durationMs !== undefined &&
				(!Number.isInteger(options.durationMs) || options.durationMs < 0 || options.durationMs > 10000)
			)
				throw new ToolError("Drag durationMs must be an integer from 0 to 10000");
			if (
				options.steps !== undefined &&
				(!Number.isInteger(options.steps) || options.steps < 1 || options.steps > 200)
			)
				throw new ToolError("Drag steps must be an integer from 1 to 200");
			const current = await this.#current(window);
			const start = this.#target(current, from);
			const end = this.#target(current, to);
			throwIfAborted(context.signal);
			return this.#action("drag", {
				...windowArgs(current),
				from_x: start.x,
				from_y: start.y,
				to_x: end.x,
				to_y: end.y,
				duration_ms: options.durationMs,
				steps: options.steps,
				modifier: options.modifiers,
				button: options.button,
				...delivery(options),
			});
		});
	}
	scroll(
		context: Context,
		window: ComputerWindowIdentity,
		direction: "up" | "down" | "left" | "right",
		target?: ComputerTarget,
		options: ActionOptions & { amount?: number; by?: "line" | "page" } = {},
	): Promise<ComputerActionResult> {
		return this.#targetAction(context, "scroll", window, target, {
			direction,
			amount: options.amount,
			by: options.by,
			...delivery(options),
		});
	}
	setFrame(context: Context, window: ComputerWindowIdentity, frame: ComputerBounds): Promise<ComputerActionResult> {
		return this.#schedule(context, "setFrame", true, async () => {
			const current = await this.#current(window);
			this.#frames.delete(window.id);
			this.#invalidate(window);
			throwIfAborted(context.signal);
			return this.#action("set_window_frame", {
				...windowArgs(current),
				x: frame.x,
				y: frame.y,
				width: frame.width,
				height: frame.height,
			});
		});
	}
	menu(
		context: Context,
		window: ComputerWindowIdentity,
		menuPath: string[],
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(context, "menu", true, async () => {
			foreground(options);
			const current = await this.#current(window);
			throwIfAborted(context.signal);
			return this.#action("invoke_menu", { ...windowArgs(current), path: menuPath });
		});
	}
	verify(
		context: Context,
		window: Pick<ComputerWindowIdentity, "id" | "pid">,
		expect: Record<string, unknown>[],
		options: { timeoutMs?: number; stableSamples?: number } = {},
	): Promise<VerificationResult> {
		return this.#schedule(context, "verify", false, async () => {
			windowArgs(window);
			this.#invalidate(window);
			this.#frames.delete(window.id);
			const { data } = await this.#call("verify_state", {
				...windowArgs(window),
				expect,
				timeout_ms: options.timeoutMs,
				stable_samples: options.stableSamples,
				include_screenshot: false,
			});
			const status = (value: unknown): VerificationStatus => {
				if (value !== "satisfied" && value !== "unsatisfied" && value !== "unknown")
					throw new ToolError("Malformed Cua verification status");
				return value;
			};
			if (typeof data.stable !== "boolean" || !Array.isArray(data.predicates))
				throw new ToolError("Malformed Cua verification");
			return {
				status: status(data.status),
				stable: data.stable,
				elapsed_ms: number(data.elapsed_ms, "elapsed_ms"),
				samples: number(data.samples, "samples"),
				predicates: data.predicates.map(value => {
					const row = object(value, "predicate outcome");
					return {
						index: number(row.index, "predicate index"),
						status: status(row.status),
						unknown_reason: row.unknown_reason === null ? null : string(row.unknown_reason, "unknown_reason"),
						observed_json: row.observed_json === null ? null : string(row.observed_json, "observed_json"),
					};
				}),
			};
		});
	}
	raise(context: Context, window: ComputerWindowIdentity): Promise<ComputerActionResult> {
		return this.#schedule(context, "raise", true, async () => {
			const current = await this.#current(window);
			throwIfAborted(context.signal);
			return this.#action("bring_to_front", windowArgs(current));
		});
	}
	screenshot(context: Context, options: { silent?: boolean } = {}): Promise<ComputerImage> {
		return this.#schedule(context, "screenshot", false, async () => {
			this.#desktopFrame = undefined;
			const before = await this.#primaryDisplay();
			throwIfAborted(context.signal);
			const reply = await this.#call("get_desktop_state", {});
			const captured = primaryDisplay(reply.data, true);
			const after = await this.#primaryDisplay();
			if (before || captured || after) {
				if (!before || !captured || !after || !sameDisplay(before, captured) || !sameDisplay(captured, after))
					throw new ToolError("StaleFrame: primary display identity/geometry changed during capture");
				if (
					reply.data.screenshot_width !== Math.round(captured.bounds.width * captured.scale) ||
					reply.data.screenshot_height !== Math.round(captured.bounds.height * captured.scale)
				)
					throw new ToolError("StaleFrame: primary screenshot dimensions do not match the display geometry");
			}
			const image = await this.#saveImage(context, reply, "primary", options.silent === true);
			if (captured) this.#desktopFrame = { display: captured, image };
			return image;
		});
	}
	async #primaryDisplay(): Promise<PrimaryDisplay | undefined> {
		return primaryDisplay((await this.#call("get_screen_size", {})).data);
	}
	async #desktopPoints(context: Context, points: [number, number][]): Promise<{ x: number; y: number }[]> {
		const frame = this.#desktopFrame;
		if (!frame)
			throw new ToolError(
				"MissingFrame: capture the primary desktop with an SDK that reports display identity before coordinate input",
			);
		try {
			const current = await this.#primaryDisplay();
			if (!current || !sameDisplay(frame.display, current))
				throw new ToolError("StaleFrame: primary display identity/geometry changed; capture it again");
		} catch (error) {
			this.#desktopFrame = undefined;
			throw error;
		}
		throwIfAborted(context.signal);
		return points.map(([x, y]) => {
			if (
				!Number.isFinite(x) ||
				!Number.isFinite(y) ||
				x < 0 ||
				y < 0 ||
				x >= frame.image.width ||
				y >= frame.image.height
			)
				throw new ToolError("InvalidCoordinates: point is outside the observed primary desktop image");
			return {
				x: (x * frame.image.sourceWidth) / frame.image.width,
				y: (y * frame.image.sourceHeight) / frame.image.height,
			};
		});
	}
	desktopClick(context: Context, x: number, y: number, options: ActionOptions = {}): Promise<ComputerActionResult> {
		return this.#schedule(context, "desktopClick", true, async () => {
			foreground(options);
			if (options.count !== undefined && (!Number.isSafeInteger(options.count) || options.count < 1))
				throw new ToolError("Click count must be a positive integer");
			const [point] = await this.#desktopPoints(context, [[x, y]]);
			return this.#action("click", {
				scope: "desktop",
				...point,
				button: options.button,
				count: options.count,
				modifier: options.modifiers,
				delivery_mode: "foreground",
			});
		});
	}
	desktopMove(context: Context, x: number, y: number, options: ActionOptions = {}): Promise<ComputerActionResult> {
		return this.#schedule(context, "desktopMove", true, async () => {
			foreground(options);
			const [point] = await this.#desktopPoints(context, [[x, y]]);
			const result = await this.#action("move_cursor", { scope: "desktop", ...point });
			return { ...result, delivery: "foreground" };
		});
	}
	desktopDrag(
		context: Context,
		points: [number, number][],
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(context, "desktopDrag", true, async () => {
			foreground(options);
			if (points.length !== 2)
				unsupported("desktop drag with anything other than two points; the SDK cannot preserve a multi-point path");
			const [start, end] = await this.#desktopPoints(context, points);
			return this.#action("drag", {
				scope: "desktop",
				from_x: start!.x,
				from_y: start!.y,
				to_x: end!.x,
				to_y: end!.y,
				modifier: options.modifiers,
				button: options.button,
				delivery_mode: "foreground",
			});
		});
	}
	desktopScroll(
		context: Context,
		x: number,
		y: number,
		options: { dx?: number; dy?: number; delivery?: "background" | "foreground" } = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(context, "desktopScroll", true, async () => {
			foreground(options);
			const dx = options.dx ?? 0;
			const dy = options.dy ?? 0;
			if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx !== 0 && dy !== 0))
				unsupported("desktop scroll must use one finite axis per action");
			const delta = dx || dy;
			if (delta === 0)
				return {
					text: "Zero scroll delta; no input dispatched.",
					effect: "unchanged",
					evidence: null,
					route: "no-op",
					delivery: "foreground",
				};
			if (delta % 120 !== 0 || Math.abs(delta) > 6000)
				unsupported("desktop scroll deltas must be multiples of 120 pixels, up to 6000, matching SDK line notches");
			const [point] = await this.#desktopPoints(context, [[x, y]]);
			return this.#action("scroll", {
				scope: "desktop",
				...point,
				direction: dx ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up",
				amount: Math.abs(delta) / 120,
				by: "line",
				delivery_mode: "foreground",
			});
		});
	}
	desktopType(context: Context, text: string, options: ActionOptions = {}): Promise<ComputerActionResult> {
		return this.#schedule(context, "desktopType", true, async () => {
			foreground(options);
			return this.#action("type_text", { scope: "desktop", text, delivery_mode: "foreground" });
		});
	}
	desktopPress(
		context: Context,
		chord: string | string[],
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(context, "desktopPress", true, async () => {
			foreground(options);
			const keys = chordKeys(chord, this.#platform);
			return this.#action(keys.length === 1 ? "press_key" : "hotkey", {
				scope: "desktop",
				...(keys.length === 1 ? { key: keys[0] } : { keys }),
				delivery_mode: "foreground",
			});
		});
	}
	clipboardRead(context: Context): Promise<string> {
		return this.#schedule(context, "clipboardRead", false, async () => {
			const { data } = await this.#call("clipboard_read", { include_text: true });
			return string(data.text, "clipboard text (clipboard may contain no plain text)");
		});
	}
	clipboardWrite(context: Context, text: string): Promise<ComputerActionResult> {
		return this.#schedule(context, "clipboardWrite", true, () => this.#action("clipboard_write", { text }));
	}
	launch(context: Context, options: ComputerLaunchOptions): Promise<ComputerActionResult> {
		return this.#schedule(context, "launch", true, async () => {
			let result: ComputerActionResult;
			try {
				result = await this.#action("launch_app", {
					bundle_id: options.bundleId,
					name: options.name,
					urls: options.urls,
					creates_new_application_instance: options.newInstance,
				});
			} catch (error) {
				// The driver reports an app that died during launch as a failed launch
				// (LAUNCH_TARGET_CHANGED, process_running:false). Its crash alert still
				// lands on the user's screen a moment later, so watch for it here too.
				const pid = launchedPid(error);
				if (pid === undefined) throw error;
				const alert = await this.#watchCrashAlert(context, pid);
				if (!alert) throw error;
				throw new ToolError(
					`${error instanceof Error ? error.message : String(error)}\n${crashAlertGuidance(pid, alert)}`,
					{ interruptedBy: alert },
				);
			}
			const data = result.data as { pid?: unknown } | undefined;
			const pid = typeof data?.pid === "number" ? data.pid : undefined;
			// An app that traps at startup queues a CrashReporter alert (UserNotificationCenter)
			// a moment after launch_app returns. Watch briefly so the crash surfaces as an
			// interruption naming the alert instead of a "launched" result that invites a retry.
			// macOS-only: no other platform draws that alert, and polling an
			// always-empty roster would only cost the launch two seconds.
			for (let waited = 0; this.#platform === "darwin" && !result.interruptedBy && waited < 2_000; waited += 250) {
				await Bun.sleep(250);
				throwIfAborted(context.signal);
				result.interruptedBy = this.#interruption();
			}
			if (result.interruptedBy) {
				result.text +=
					pid !== undefined && this.#recordCrashAlert(pid, result.interruptedBy)
						? `\n⚠️ ${crashAlertGuidance(pid, result.interruptedBy)}`
						: `\n⚠️ Interrupted after launch: ${describeInterruption(result.interruptedBy)}. Tell the user what is asking and wait; actions are refused until it is answered.`;
			}
			return result;
		});
	}
	/** Poll up to 2 s for the crash alert of a launched app that already died; macOS-only. */
	async #watchCrashAlert(context: Context, pid: number): Promise<ComputerInterruption | undefined> {
		if (this.#platform !== "darwin") return undefined;
		for (let waited = 0; waited < 2_000; waited += 250) {
			await Bun.sleep(250);
			throwIfAborted(context.signal);
			const interruption = this.#interruption();
			if (interruption && this.#recordCrashAlert(pid, interruption)) return interruption;
		}
		return undefined;
	}
	/**
	 * The alert is this session's to dismiss only when the app it launched is
	 * already gone and the alert host is CrashReporter's: a live app that raised
	 * a permission prompt is the user's call.
	 */
	#recordCrashAlert(pid: number, interruption: ComputerInterruption): boolean {
		if (processAlive(pid) || interruption.app.trim().toLowerCase() !== CRASH_ALERT_HOST) return false;
		this.#crashAlerts.add(interruption.windowId);
		return true;
	}
	async drain(): Promise<void> {
		await this.#tail;
	}
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		this.#closing = (async () => {
			await this.#tail;
			try {
				await this.#driver.kill();
			} finally {
				this.#elements.clear();
				this.#frames.clear();
				this.#desktopFrame = undefined;
			}
		})();
		return this.#closing;
	}
}

/** Default backend factory: one vendored driver child per session. */
export const createCuaBackend: ComputerBackendFactory = options =>
	CuaComputerSession.create({ display: options.display });
