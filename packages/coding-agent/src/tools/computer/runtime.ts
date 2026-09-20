import { AsyncLocalStorage } from "node:async_hooks";
import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { JsRuntime, type RuntimeHooks } from "../../eval/js/shared/runtime";
import { cloneSafe, RunOutput } from "../browser/run-output";
import {
	bindRunFacade,
	markHandled,
	resolvePredicateTimeout,
	type WaitPredicateOptions,
	waitForRun,
} from "../run-scope";
import { ToolAbortError, throwIfAborted } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ComputerBackend } from "./backend";
import { openWindows } from "./roster";
import { normalizeLaunchOptions, normalizeWindowSelector } from "./selectors";
import type {
	ActionOptions,
	TypeOptions,
	ComputerActionResult,
	ComputerBounds,
	ComputerElementSnapshot,
	ComputerOperationContext,
	ComputerRunOk,
	ComputerScreenshot,
	ComputerSessionSnapshot,
	ComputerTarget,
	ComputerWindowAcquisition,
	ComputerWindowIdentity,
	ComputerWindowKind,
	AcquireOptions,
	ObserveOptions,
	WindowResolveOptions,
	WindowSelector,
} from "./types";

type GestureOptions = ActionOptions & { durationMs?: number; steps?: number };
type TextOptions = ActionOptions & { target?: ComputerTarget };
type TypeTextOptions = TypeOptions & { target?: ComputerTarget };
type ScrollOptions = TextOptions & { amount?: number; by?: "line" | "page" };
type Direction = "up" | "down" | "left" | "right";
type ElementQuery = {
	role?: string;
	/**
	 * Matched against `role` as well: a control's specific role is where its
	 * generic one is `AXTextField`, and the query names whichever the tree
	 * showed. `subrole` asks for the specific one alone.
	 */
	subrole?: string;
	label?: string;
	/** Accepted for `label`: an element's own name is its label, not a title. */
	title?: string;
	value?: string;
	exact?: boolean;
	limit?: number;
};

/**
 * One `find` field. Absent asks nothing; a value is a case-insensitive
 * substring unless `{ exact: true }`, because the model queries what it read
 * in the tree — `value: "555"` against a phone field, a lowercased label —
 * and exact matching answered those with an empty list. A field the row does
 * not carry at all never matches.
 */
function matched(observed: string | undefined, wanted: string | undefined, exact: boolean | undefined): boolean {
	if (wanted === undefined) return true;
	if (observed === undefined) return false;
	return exact === true ? observed === wanted : observed.toLowerCase().includes(wanted.toLowerCase());
}

interface ComputerRunContext {
	signal: AbortSignal;
	readOnly: boolean;
	snapshot: ComputerSessionSnapshot;
	output: RunOutput;
	screenshots: ComputerScreenshot[];
}

type RunContextAccessor = () => ComputerRunContext;

function operationContext(getContext: RunContextAccessor): ComputerOperationContext {
	const context = getContext();
	throwIfAborted(context.signal);
	return {
		signal: context.signal,
		readOnly: context.readOnly,
		maxWidth: context.snapshot.captureMaxWidth,
		maxHeight: context.snapshot.captureMaxHeight,
		maxPixels: context.snapshot.captureMaxPixels,
		emitImage: (image, content, silent) => {
			throwIfAborted(context.signal);
			const screenshot: ComputerScreenshot = { ...image };
			context.screenshots.push(screenshot);
			if (!silent) {
				// A capture is normally its surface's own point grid, so the
				// coordinates the model reads off it are the coordinates actions
				// take. When the surface outgrew the frame budget the image is
				// smaller than that grid, and the only place that can be said is
				// beside the pixels it is true of.
				const grid =
					image.width === Math.round(image.pointWidth) && image.height === Math.round(image.pointHeight)
						? `1 px = 1 ${image.surface} point`
						: `${image.surface} ${Math.round(image.pointWidth)}×${Math.round(image.pointHeight)} points at ${image.scale.toFixed(2)}× — divide image pixels by ${image.scale.toFixed(2)} for the ${image.surface} points every action takes`;
				context.output.push({
					type: "text",
					text: `screenshot ${image.target} ${image.width}×${image.height} (${grid}) → ${image.path}`,
				});
				screenshot.imageIndex = context.output.imageCount;
				context.output.push(content);
			}
		},
		emitText: text => {
			throwIfAborted(context.signal);
			context.output.push({ type: "text", text });
		},
	};
}

/**
 * Effects that mean the driver dispatched without proving the target reacted:
 * `no_observed_change` (nothing about the target changed after delivery),
 * `suspected_noop` (the element never advertised the action) and
 * `unverifiable` (it dispatched an app action and cannot say what it did).
 * None of the three is a result the caller can read off the state, so their
 * text is pushed into the cell output instead of living only in a return
 * value the cell is free to drop.
 */
const UNDELIVERED_EFFECTS: Record<string, true> = {
	no_observed_change: true,
	suspected_noop: true,
	unverifiable: true,
};

async function reported(
	context: ComputerOperationContext,
	action: Promise<ComputerActionResult>,
): Promise<ComputerActionResult> {
	const result = await action;
	// A write verdict short of `committed` is the same shape by another route:
	// the driver decided something about the written value that the caller
	// cannot see from a return value the cell is free to drop. So is a reply
	// carrying the driver's own escalation. Keyed on the verdict, not on a
	// `committed === false` the contract stopped sending, which dropped every
	// write sentence there was.
	if (
		(UNDELIVERED_EFFECTS[result.effect] ||
			(result.committed !== undefined && result.committed !== "committed") ||
			result.escalation !== undefined) &&
		result.text
	)
		context.emitText(result.text);
	return result;
}

function mutationContext(getContext: RunContextAccessor): ComputerOperationContext {
	const context = operationContext(getContext);
	if (context.readOnly) throw new ToolError("read-only run: computer mutation requires read_only: false");
	return context;
}

class El {
	readonly ref: string;
	readonly pid: number;
	readonly windowId: string;
	readonly role: string;
	readonly subrole?: string;
	readonly label: string;
	readonly value?: string;
	readonly placeholder?: string;
	readonly help?: string;
	readonly description?: string;
	readonly enabled?: boolean;
	readonly selected?: boolean;
	readonly actions?: readonly string[];
	readonly bounds?: ComputerBounds;
	readonly #session: ComputerBackend;
	readonly #getContext: RunContextAccessor;
	readonly #window: ComputerWindowIdentity;

	constructor(
		session: ComputerBackend,
		getContext: RunContextAccessor,
		window: ComputerWindowIdentity,
		snapshot: ComputerElementSnapshot,
	) {
		this.#session = session;
		this.#getContext = getContext;
		this.#window = Object.freeze({ ...window, bounds: Object.freeze({ ...window.bounds }) });
		this.ref = snapshot.ref;
		this.pid = snapshot.pid;
		this.windowId = snapshot.windowId;
		this.role = snapshot.role;
		this.subrole = snapshot.subrole;
		this.label = snapshot.label;
		this.value = snapshot.value;
		this.placeholder = snapshot.placeholder;
		this.help = snapshot.help;
		this.description = snapshot.description;
		this.enabled = snapshot.enabled;
		this.selected = snapshot.selected;
		this.actions = snapshot.actions ? Object.freeze([...snapshot.actions]) : undefined;
		this.bounds = snapshot.bounds ? Object.freeze({ ...snapshot.bounds }) : undefined;
		Object.freeze(this);
	}

	click(options?: ActionOptions) {
		const context = mutationContext(this.#getContext);
		return reported(context, this.#session.click(context, this.#window, this.ref, options));
	}
	doubleClick(options?: ActionOptions) {
		return this.click({ ...options, count: 2 });
	}
	setValue(value: string) {
		const context = mutationContext(this.#getContext);
		return reported(context, this.#session.setValue(context, this.#window, this.ref, value));
	}
	type(text: string, options?: TypeOptions) {
		const context = mutationContext(this.#getContext);
		return reported(context, this.#session.type(context, this.#window, text, this.ref, options));
	}
	press(chord: string | string[], options?: ActionOptions) {
		const context = mutationContext(this.#getContext);
		return reported(context, this.#session.press(context, this.#window, chord, this.ref, options));
	}
	scroll(direction: Direction, options?: ScrollOptions) {
		const context = mutationContext(this.#getContext);
		return reported(context, this.#session.scroll(context, this.#window, direction, this.ref, options));
	}
	perform(action: string) {
		const context = mutationContext(this.#getContext);
		return reported(context, this.#session.perform(context, this.#window, this.ref, action));
	}
}

class Win {
	readonly id: string;
	readonly app: string;
	readonly title: string;
	readonly pid: number;
	readonly bounds: ComputerBounds;
	readonly onScreen?: boolean;
	/** CGWindow layer: 0 for ordinary windows, 1000 for system auth panels. */
	readonly layer?: number;
	readonly kind?: ComputerWindowKind;
	readonly #session: ComputerBackend;
	readonly #getContext: RunContextAccessor;
	readonly #window: ComputerWindowIdentity;

	constructor(session: ComputerBackend, getContext: RunContextAccessor, window: ComputerWindowIdentity) {
		this.#session = session;
		this.#getContext = getContext;
		this.id = window.id;
		this.app = window.app;
		this.title = window.title;
		this.pid = window.pid;
		this.bounds = Object.freeze({ ...window.bounds });
		this.onScreen = window.onScreen;
		this.layer = window.layer;
		this.kind = window.kind;
		this.#window = Object.freeze({ ...window, bounds: this.bounds });
		Object.freeze(this);
	}

	/**
	 * Tree-only unless `{ screenshot: true }` is asked for. A capture cost the
	 * bench ~90 images a leg, ~70 k tokens of them on default observations the
	 * model had already decided to read as text; acquisition still captures
	 * one, so the first look at a window is still visual.
	 */
	observe(options?: ObserveOptions) {
		return this.#session.observe(operationContext(this.#getContext), this.#window, options);
	}
	screenshot(options?: { silent?: boolean }) {
		return this.#session.captureWindow(operationContext(this.#getContext), this.#window, options);
	}
	async find(query: ElementQuery = {}): Promise<El[]> {
		const observation = await this.observe({ screenshot: false });
		const label = query.label ?? query.title;
		const matches = observation.elements.filter(
			element =>
				(matched(element.role, query.role, query.exact) || matched(element.subrole, query.role, query.exact)) &&
				matched(element.subrole, query.subrole, query.exact) &&
				matched(element.label, label, query.exact) &&
				matched(element.value, query.value, query.exact),
		);
		return matches
			.slice(0, query.limit ?? 40)
			.map(element => new El(this.#session, this.#getContext, this.#window, element));
	}
	ref(ref: string): El {
		return new El(this.#session, this.#getContext, this.#window, this.#session.element(ref, this.#window));
	}
	click(target: ComputerTarget, options?: ActionOptions) {
		const context = mutationContext(this.#getContext);
		return reported(context, this.#session.click(context, this.#window, target, options));
	}
	doubleClick(target: ComputerTarget, options?: ActionOptions) {
		return this.click(target, { ...options, count: 2 });
	}
	hover(x: number, y: number, options?: ActionOptions) {
		return this.#session.hover(mutationContext(this.#getContext), this.#window, x, y, options);
	}
	drag(from: ComputerTarget, to: ComputerTarget, options?: GestureOptions) {
		const context = mutationContext(this.#getContext);
		return reported(context, this.#session.drag(context, this.#window, from, to, options));
	}
	scroll(direction: Direction, options?: ScrollOptions) {
		const context = mutationContext(this.#getContext);
		return reported(context, this.#session.scroll(context, this.#window, direction, options?.target, options));
	}
	type(text: string, options?: TypeTextOptions) {
		const context = mutationContext(this.#getContext);
		return reported(context, this.#session.type(context, this.#window, text, options?.target, options));
	}
	press(chord: string | string[], options?: TextOptions) {
		const context = mutationContext(this.#getContext);
		return reported(context, this.#session.press(context, this.#window, chord, options?.target, options));
	}
	setValue(ref: string, value: string) {
		const context = mutationContext(this.#getContext);
		return reported(context, this.#session.setValue(context, this.#window, ref, value));
	}
	setFrame(frame: ComputerBounds) {
		return this.#session.setFrame(mutationContext(this.#getContext), this.#window, frame);
	}
	menu(menuPath: string[], options?: ActionOptions) {
		const context = mutationContext(this.#getContext);
		return reported(context, this.#session.menu(context, this.#window, menuPath, options));
	}
	verify(expect: Record<string, unknown>[], options?: { timeoutMs?: number; stableSamples?: number }) {
		return this.#session.verify(operationContext(this.#getContext), this.#window, expect, options);
	}
	reveal() {
		return this.#session.raise(mutationContext(this.#getContext), this.#window);
	}
}

/** A launched app gets this long to put its window on the WindowServer. */
const LAUNCHED_WINDOW_TIMEOUT_MS = 15_000;
const LAUNCHED_WINDOW_POLL_MS = 250;
/** Either driver's refusal when a name is not an installed app at all. */
const NOT_AN_APP = /is not an executable on PATH|No installed macOS app found/i;

function isMissedWindow(error: unknown): error is ToolError {
	return error instanceof ToolError && error.message.startsWith("Missing computer window");
}

/**
 * A miss is the first call of a native run as often as a hit is, and only this
 * layer knows what became of it — whether a launch was refused, impossible, or
 * opened nothing — so the sentence and the roster are composed here. The
 * roster is best-effort: a driver that cannot list windows still reports the
 * miss it was asked about.
 */
async function missedWindow(
	session: ComputerBackend,
	getContext: RunContextAccessor,
	error: ToolError,
	head: string,
): Promise<ToolError> {
	let windows: readonly ComputerWindowIdentity[] | undefined;
	try {
		windows = await session.windows(operationContext(getContext), {});
	} catch {
		windows = undefined;
	}
	return new ToolError(windows === undefined ? head : `${head} ${openWindows(windows)}`, error.context);
}

/**
 * Resolve one window, naming what is open when nothing matches it. `acquire`
 * is the caller starting over on the window; rehydrating the handle a prelude
 * method already carries is not.
 */
async function resolveWindow(
	session: ComputerBackend,
	getContext: RunContextAccessor,
	selector: WindowSelector,
	options: WindowResolveOptions,
	acquire = true,
): Promise<ComputerWindowIdentity> {
	const context = operationContext(getContext);
	return await (
		acquire ? session.acquire(context, selector, options) : session.window(context, selector, options)
	).catch(async (error: unknown) => {
		if (!isMissedWindow(error)) throw error;
		throw await missedWindow(session, getContext, error, error.message);
	});
}

/**
 * Launching collapses the three-call acquisition every native run started
 * with — `window()` throws `Missing`, `launch()`, `window()` again — into
 * one call, and it is what an `{ app }` selector matching nothing means.
 * Nothing is launched while a window already matches, and the wait is
 * bounded: an app that opens no window ends in a `Missing` error that says
 * so, and one that opens several is acquired at its frontmost window.
 */
async function launchAndAcquire(
	session: ComputerBackend,
	getContext: RunContextAccessor,
	selector: WindowSelector,
	options: WindowResolveOptions,
): Promise<ComputerWindowIdentity> {
	if (selector.app === undefined || selector.id !== undefined || selector.pid !== undefined)
		throw new ToolError(
			"launch: true needs an { app } selector to name what to launch, and refuses an exact id/pid — those address a window that already exists",
		);
	if ((await session.windows(operationContext(getContext), selector)).length)
		return await resolveWindow(session, getContext, selector, options);
	await session.launch(mutationContext(getContext), { name: selector.app }).catch(async (error: unknown) => {
		if (!(error instanceof ToolError)) throw error;
		// Two facts, and until now the first one was invisible: the filter
		// matched no open window, and the name it carries is not startable —
		// a launch refusal alone reads as if the window question never arose.
		throw await missedWindow(
			session,
			getContext,
			error,
			`No open window matches ${JSON.stringify(selector)} and ${
				NOT_AN_APP.test(error.message) ? "it is not an installed app" : `launching it failed: ${error.message}`
			}.`,
		);
	});
	const deadline = Date.now() + LAUNCHED_WINDOW_TIMEOUT_MS;
	for (;;) {
		const context = operationContext(getContext);
		if ((await session.windows(context, selector)).length || Date.now() >= deadline)
			return await session.acquire(context, selector, options).catch(async (error: unknown) => {
				if (!isMissedWindow(error)) throw error;
				// A `Missing` acquisition used to tell the model to try
				// `{ launch: true }`, which is what this call already did.
				throw await missedWindow(
					session,
					getContext,
					error,
					`Missing computer window ${JSON.stringify(selector)}: launched ${JSON.stringify(
						selector.app,
					)} and no window of it could be acquired — it opened none within ${
						LAUNCHED_WINDOW_TIMEOUT_MS / 1000
					} s, or the one it opened is already gone.`,
				);
			});
		await Bun.sleep(LAUNCHED_WINDOW_POLL_MS);
	}
}

function createDesktopScope(session: ComputerBackend, getContext: RunContextAccessor): object {
	return {
		capabilities: (): DesktopCapabilities => {
			throwIfAborted(getContext().signal);
			return session.capabilities;
		},
		apps: () => session.apps(operationContext(getContext)),
		displays: () => session.displays(operationContext(getContext)),
		windows: (selector: unknown = {}) =>
			session.windows(operationContext(getContext), normalizeWindowSelector(selector)),
		window: async (selector: unknown, options: WindowResolveOptions = {}): Promise<Win> =>
			new Win(
				session,
				getContext,
				await resolveWindow(session, getContext, normalizeWindowSelector(selector, true), options, false),
			),
		acquireWindow: async (selector: unknown, options: AcquireOptions = {}): Promise<ComputerWindowAcquisition> => {
			const { launch, ambiguous, ...observeOptions } = options;
			const target = normalizeWindowSelector(selector, true);
			// An `{ app }` selector that matches nothing is an app that is not
			// running; an exact id/pid names a window that already exists and is
			// never a launch request, whatever the default says.
			const window =
				launch === true ||
				(launch === undefined && target.app !== undefined && target.id === undefined && target.pid === undefined)
					? await launchAndAcquire(session, getContext, target, { ambiguous })
					: await resolveWindow(session, getContext, target, { ambiguous });
			const context = operationContext(getContext);
			try {
				const initialObservation = await session.observe(context, window, { screenshot: true, ...observeOptions });
				return { ...initialObservation.window, initialObservation };
			} catch (error) {
				throwIfAborted(context.signal);
				if (error instanceof ToolAbortError || (error instanceof Error && error.name === "AbortError")) throw error;
				const result: ComputerWindowAcquisition = {
					...window,
					inspectionError: error instanceof Error ? error.message : String(error),
				};
				// AX and pixels are independent. Preserve exact identity when inspection
				// fails so callers can recover without choosing or revealing another window.
				if (observeOptions.screenshot !== false) {
					try {
						result.initialScreenshot = await session.captureWindow(context, window, {
							silent: observeOptions.silent,
						});
					} catch (captureError) {
						throwIfAborted(context.signal);
						if (
							captureError instanceof ToolAbortError ||
							(captureError instanceof Error && captureError.name === "AbortError")
						)
							throw captureError;
						result.screenshotError = captureError instanceof Error ? captureError.message : String(captureError);
					}
				}
				return result;
			}
		},
		// Verification observes an exact historical identity; it must not reacquire a live handle.
		verifyWindow: (
			identity: Pick<ComputerWindowIdentity, "id" | "pid">,
			expect: Record<string, unknown>[],
			options?: { timeoutMs?: number; stableSamples?: number },
		) => session.verify(operationContext(getContext), identity, expect, options),
		focusedWindow: async (): Promise<Win | null> => {
			const window = await session.focusedWindow(operationContext(getContext));
			return window ? new Win(session, getContext, window) : null;
		},
		screenshot: (options?: { silent?: boolean }) => session.screenshot(operationContext(getContext), options),
		launch: (options: unknown) => session.launch(mutationContext(getContext), normalizeLaunchOptions(options)),
		ref: (ref: string): El => {
			throwIfAborted(getContext().signal);
			return new El(session, getContext, session.elementWindow(ref), session.element(ref));
		},
		click: (x: number, y: number, options?: ActionOptions) =>
			session.desktopClick(mutationContext(getContext), x, y, options),
		doubleClick: (x: number, y: number, options?: ActionOptions) =>
			session.desktopClick(mutationContext(getContext), x, y, { ...options, count: 2 }),
		move: (x: number, y: number, options?: ActionOptions) =>
			session.desktopMove(mutationContext(getContext), x, y, options),
		drag: (points: ComputerPoint[], options?: ActionOptions) =>
			session.desktopDrag(mutationContext(getContext), points, options),
		scroll: (x: number, y: number, options?: ActionOptions & { dx?: number; dy?: number }) =>
			session.desktopScroll(mutationContext(getContext), x, y, options),
		type: (text: string, options?: ActionOptions) => session.desktopType(mutationContext(getContext), text, options),
		press: (chord: string | string[], options?: ActionOptions) =>
			session.desktopPress(mutationContext(getContext), chord, options),
		clipboard: {
			read: () => session.clipboardRead(operationContext(getContext)),
			write: (text: string) => session.clipboardWrite(mutationContext(getContext), text),
		},
	};
}

export interface ComputerRunOptions {
	code: string;
	timeoutMs: number;
	snapshot: ComputerSessionSnapshot;
	signal?: AbortSignal;
	/** Dispatches `tool.<name>()` calls made from desktop JavaScript. */
	callTool(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
}

/**
 * Hosts the persistent JavaScript realm that desktop scripts run in. One
 * instance per session; runs are serialized by the supervisor.
 */
export class ComputerRuntime {
	#runtime?: JsRuntime;
	/**
	 * Per-run context, carried through AsyncLocalStorage so async work leaked
	 * from an ended run (timers, dangling promises) keeps that run's aborted
	 * context instead of borrowing the next run's signal and read-only policy.
	 */
	readonly #runContexts = new AsyncLocalStorage<ComputerRunContext>();

	readonly #currentRunContext = (): ComputerRunContext => {
		const context = this.#runContexts.getStore();
		if (!context) throw new ToolError("no active computer run");
		return context;
	};

	async run(session: ComputerBackend, options: ComputerRunOptions): Promise<ComputerRunOk> {
		const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
		const runAc = new AbortController();
		const signal = AbortSignal.any(
			options.signal ? [timeoutSignal, options.signal, runAc.signal] : [timeoutSignal, runAc.signal],
		);
		const output = new RunOutput();
		const screenshots: ComputerScreenshot[] = [];
		const runContext: ComputerRunContext = {
			signal,
			readOnly: options.snapshot.readOnly,
			snapshot: options.snapshot,
			output,
			screenshots,
		};
		const runId = crypto.randomUUID();
		const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers<never>();
		cancelRejection.catch(() => {});
		const onCancel = (): void => {
			const abortError =
				signal.reason instanceof ToolAbortError
					? signal.reason
					: new ToolAbortError(undefined, { cause: signal.reason });
			rejectCancel(
				timeoutSignal.aborted
					? new ToolError(`Computer code execution timed out after ${options.timeoutMs}ms`)
					: abortError,
			);
		};
		let failure: { error: unknown } | undefined;
		let returnValue: unknown;
		try {
			throwIfAborted(signal);
			this.#runtime ??= new JsRuntime({ initialCwd: options.snapshot.cwd, sessionId: options.snapshot.sessionId });
			const runtime = this.#runtime;
			runtime.setCwd(options.snapshot.cwd);
			runtime.setRunScope({
				desktop: bindRunFacade(createDesktopScope(session, this.#currentRunContext), signal),
				assert: (condition: unknown, text?: string): void => {
					if (!condition) throw new ToolError(text ?? "Assertion failed");
				},
				wait: (msOrPredicate: number | (() => unknown), waitOptions?: WaitPredicateOptions): Promise<unknown> => {
					const resolved =
						typeof msOrPredicate === "number"
							? undefined
							: {
									timeout: resolvePredicateTimeout(options.timeoutMs, waitOptions?.timeout),
									interval: waitOptions?.interval,
								};
					return markHandled(waitForRun(msOrPredicate, signal, resolved));
				},
			});
			const hooks: RuntimeHooks = {
				onText: chunk => {
					throwIfAborted(signal);
					output.pushText(chunk);
				},
				onDisplay: display => {
					throwIfAborted(signal);
					output.pushDisplay(display);
				},
				callTool: (name, args) => {
					throwIfAborted(signal);
					return options.callTool(name, args, signal);
				},
			};
			if (signal.aborted) onCancel();
			else signal.addEventListener("abort", onCancel, { once: true });
			try {
				returnValue = await Promise.race([
					this.#runContexts.run(runContext, () =>
						runtime.run(options.code, `computer-run-${runId}.js`, hooks, { runId, cwd: options.snapshot.cwd }),
					),
					cancelRejection,
				]);
			} finally {
				signal.removeEventListener("abort", onCancel);
			}
		} catch (error) {
			failure = { error };
		} finally {
			runAc.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Computer run ended")));
			// A language cancellation must also drain the backend's native work.
			// Keep this run busy until native work settles so a terminal abort result
			// cannot be followed by residual input or a new overlapping action.
			try {
				await session.drain();
			} catch (error) {
				// Losing input completion is a failure even if an earlier cancel won the JS race.
				failure = { error: new ToolError(error instanceof Error ? error.message : String(error)) };
			}
		}
		if (failure) throw failure.error;
		return {
			displays: output.finish(),
			returnValue: cloneSafe(returnValue),
			screenshots,
			capabilities: session.capabilities,
		};
	}

	dispose(): void {
		this.#runtime?.dispose();
		this.#runtime = undefined;
	}
}
