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
import { ToolAbortError, ToolError, throwIfAborted } from "../tool-errors";
import type { ComputerBackend } from "./backend";
import { normalizeLaunchOptions, normalizeWindowSelector } from "./selectors";
import type {
	ActionOptions,
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
	ObserveOptions,
} from "./types";

type GestureOptions = ActionOptions & { durationMs?: number; steps?: number };
type TextOptions = ActionOptions & { target?: ComputerTarget };
type ScrollOptions = TextOptions & { amount?: number; by?: "line" | "page" };
type Direction = "up" | "down" | "left" | "right";
type ElementQuery = { role?: string; label?: string; value?: string; limit?: number };

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
		emitImage: (image, content, silent) => {
			throwIfAborted(context.signal);
			const screenshot: ComputerScreenshot = { ...image };
			context.screenshots.push(screenshot);
			if (!silent) {
				context.output.push({
					type: "text",
					text: `screenshot ${image.target} ${image.width}×${image.height} → ${image.path}`,
				});
				screenshot.imageIndex = context.output.imageCount;
				context.output.push(content);
			}
		},
	};
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
	readonly label: string;
	readonly value?: string;
	readonly placeholder?: string;
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
		this.pid = window.pid;
		this.windowId = window.id;
		this.role = snapshot.role;
		this.label = snapshot.label;
		this.value = snapshot.value;
		this.placeholder = snapshot.placeholder;
		this.enabled = snapshot.enabled;
		this.selected = snapshot.selected;
		this.actions = snapshot.actions ? Object.freeze([...snapshot.actions]) : undefined;
		this.bounds = snapshot.bounds ? Object.freeze({ ...snapshot.bounds }) : undefined;
		Object.freeze(this);
	}

	click(options?: ActionOptions) {
		return this.#session.click(mutationContext(this.#getContext), this.#window, this.ref, options);
	}
	doubleClick(options?: ActionOptions) {
		return this.click({ ...options, count: 2 });
	}
	setValue(value: string) {
		return this.#session.setValue(mutationContext(this.#getContext), this.#window, this.ref, value);
	}
	type(text: string, options?: ActionOptions) {
		return this.#session.type(mutationContext(this.#getContext), this.#window, text, this.ref, options);
	}
	press(chord: string | string[], options?: ActionOptions) {
		return this.#session.press(mutationContext(this.#getContext), this.#window, chord, this.ref, options);
	}
	scroll(direction: Direction, options?: ScrollOptions) {
		return this.#session.scroll(mutationContext(this.#getContext), this.#window, direction, this.ref, options);
	}
	perform(action: string) {
		return this.#session.perform(mutationContext(this.#getContext), this.#window, this.ref, action);
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

	observe(options?: ObserveOptions) {
		return this.#session.observe(operationContext(this.#getContext), this.#window, { screenshot: true, ...options });
	}
	screenshot(options?: { silent?: boolean }) {
		return this.#session.captureWindow(operationContext(this.#getContext), this.#window, options);
	}
	async find(query: ElementQuery = {}): Promise<El[]> {
		const observation = await this.observe({ screenshot: false });
		const matches = observation.elements.filter(
			element =>
				(query.role === undefined || element.role.toLowerCase().includes(query.role.toLowerCase())) &&
				(query.label === undefined || element.label.toLowerCase().includes(query.label.toLowerCase())) &&
				(query.value === undefined || element.value === query.value),
		);
		return matches
			.slice(0, query.limit ?? 40)
			.map(element => new El(this.#session, this.#getContext, this.#window, element));
	}
	ref(ref: string): El {
		return new El(this.#session, this.#getContext, this.#window, this.#session.element(ref, this.#window));
	}
	click(target: ComputerTarget, options?: ActionOptions) {
		return this.#session.click(mutationContext(this.#getContext), this.#window, target, options);
	}
	doubleClick(target: ComputerTarget, options?: ActionOptions) {
		return this.click(target, { ...options, count: 2 });
	}
	hover(x: number, y: number, options?: ActionOptions) {
		return this.#session.hover(mutationContext(this.#getContext), this.#window, x, y, options);
	}
	drag(from: [number, number], to: [number, number], options?: GestureOptions) {
		return this.#session.drag(mutationContext(this.#getContext), this.#window, from, to, options);
	}
	scroll(direction: Direction, options?: ScrollOptions) {
		return this.#session.scroll(mutationContext(this.#getContext), this.#window, direction, options?.target, options);
	}
	type(text: string, options?: TextOptions) {
		return this.#session.type(mutationContext(this.#getContext), this.#window, text, options?.target, options);
	}
	press(chord: string | string[], options?: TextOptions) {
		return this.#session.press(mutationContext(this.#getContext), this.#window, chord, options?.target, options);
	}
	setValue(ref: string, value: string) {
		return this.#session.setValue(mutationContext(this.#getContext), this.#window, ref, value);
	}
	setFrame(frame: ComputerBounds) {
		return this.#session.setFrame(mutationContext(this.#getContext), this.#window, frame);
	}
	menu(menuPath: string[], options?: ActionOptions) {
		return this.#session.menu(mutationContext(this.#getContext), this.#window, menuPath, options);
	}
	verify(expect: Record<string, unknown>[], options?: { timeoutMs?: number; stableSamples?: number }) {
		return this.#session.verify(operationContext(this.#getContext), this.#window, expect, options);
	}
	reveal() {
		return this.#session.raise(mutationContext(this.#getContext), this.#window);
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
		windows: (selector: unknown = {}) => session.windows(operationContext(getContext), normalizeWindowSelector(selector)),
		window: async (selector: unknown): Promise<Win> =>
			new Win(
				session,
				getContext,
				await session.window(operationContext(getContext), normalizeWindowSelector(selector, true)),
			),
		acquireWindow: async (selector: unknown, options: ObserveOptions = {}): Promise<ComputerWindowAcquisition> => {
			const context = operationContext(getContext);
			const window = await session.window(context, normalizeWindowSelector(selector, true));
			try {
				const initialObservation = await session.observe(context, window, { screenshot: true, ...options });
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
				if (options.screenshot !== false) {
					try {
						result.initialScreenshot = await session.captureWindow(context, window, { silent: options.silent });
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
		move: (x: number, y: number, options?: ActionOptions) => session.desktopMove(mutationContext(getContext), x, y, options),
		drag: (points: Array<[number, number]>, options?: ActionOptions) =>
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
				signal.reason instanceof ToolAbortError ? signal.reason : new ToolAbortError(undefined, { cause: signal.reason });
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
