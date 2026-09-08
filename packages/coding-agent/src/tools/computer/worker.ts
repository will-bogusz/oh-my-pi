import { AsyncLocalStorage } from "node:async_hooks";

import type { DesktopCapabilities, DesktopDisplay } from "@oh-my-pi/pi-natives";
import type {
	ActionOptions,
	ComputerActionResult,
	ComputerBounds,
	ComputerElementSnapshot,
	ComputerImage,
	ComputerLaunchOptions,
	ComputerObservation,
	ComputerTarget,
	ComputerWindowIdentity,
	ComputerWindowAcquisition,
	ComputerOperationContext,
	ObserveOptions,
	WindowSelector,
} from "./types";
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
import { normalizeLaunchOptions, normalizeWindowSelector } from "./selectors";
import type {
	ComputerScreenshot,
	ComputerSessionSnapshot,
	ComputerWorkerInbound,
	ComputerWorkerTransport,
	RunErrorPayload,
	ToolReply,
} from "./protocol";

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
 * Computer operations exposed to the interpreter, independent of a driver class.
 * Implementations own exact window/ref/frame validation and operation admission;
 * unsupported capabilities reject without an alternate target or input replay.
 */
export interface ComputerBackend {
	/** Interrupted runtimes are drained and replaced before another run. */
	readonly requiresReacquisition?: boolean;
	readonly capabilities: DesktopCapabilities & Record<string, unknown>;

	apps(context: ComputerOperationContext): Promise<unknown>;
	displays(context: ComputerOperationContext): Promise<DesktopDisplay[]>;
	windows(context: ComputerOperationContext, selector?: WindowSelector): Promise<ComputerWindowIdentity[]>;
	window(context: ComputerOperationContext, selector: string | WindowSelector): Promise<ComputerWindowIdentity>;
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
		options?: ActionOptions,
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
		from: [number, number],
		to: [number, number],
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
		points: [number, number][],
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

type GestureOptions = ActionOptions & { durationMs?: number; steps?: number };
type TextOptions = ActionOptions & { target?: ComputerTarget };
type ScrollOptions = TextOptions & { amount?: number; by?: "line" | "page" };
type Direction = "up" | "down" | "left" | "right";
type ElementQuery = { role?: string; label?: string; value?: string; limit?: number };

type PendingTool = { resolve(value: unknown): void; reject(reason?: unknown): void };
interface ActiveRun {
	id: string;
	ac: AbortController;
	signal: AbortSignal;
	pendingTools: Map<string, PendingTool>;
}

interface ComputerRunContext {
	signal: AbortSignal;
	readOnly: boolean;
	snapshot: ComputerSessionSnapshot;
	output: RunOutput;
	screenshots: ComputerScreenshot[];
}

type RunContextAccessor = () => ComputerRunContext;

function errorPayload(error: unknown): RunErrorPayload {
	if (error instanceof ToolAbortError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: true };
	}
	if (error instanceof ToolError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: true, isAbort: false };
	}
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: false };
	}
	return { name: "Error", message: String(error), isToolError: false, isAbort: false };
}

function replyError(payload: RunErrorPayload): Error {
	if (payload.isAbort) {
		const error = new ToolAbortError(payload.message || "Tool call aborted");
		if (payload.stack) error.stack = payload.stack;
		return error;
	}
	const ErrorType = payload.isToolError ? ToolError : Error;
	const error = new ErrorType(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function nativeError(error: unknown): ToolError {
	return new ToolError(error instanceof Error ? error.message : String(error));
}

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

/** Hosts the persistent JavaScript runtime and native desktop session. */
export class ComputerWorkerCore {
	readonly #transport: ComputerWorkerTransport;
	readonly #createSession?: ComputerBackendFactory;
	readonly #unsubscribe: () => void;
	#session?: ComputerBackend;
	#runtime?: JsRuntime;
	#active: ActiveRun | null = null;
	/**
	 * Per-run context, carried through AsyncLocalStorage so async work leaked
	 * from an ended run (timers, dangling promises) keeps that run's aborted
	 * context instead of borrowing the next run's signal and read-only policy.
	 */
	readonly #runContexts = new AsyncLocalStorage<ComputerRunContext>();
	#closed = false;
	#drainFailed = false;

	constructor(transport: ComputerWorkerTransport, createSession?: ComputerBackendFactory) {
		this.#transport = transport;
		this.#createSession = createSession;
		this.#unsubscribe = transport.onMessage(message => this.handle(message));
		this.#transport.send({ type: "ready" });
	}

	/** Routes one supervisor command into the persistent worker state. */
	handle(message: ComputerWorkerInbound): void {
		switch (message.type) {
			case "ping":
				this.#transport.send({ type: "pong", id: message.id });
				return;
			case "run":
				void this.#run(message);
				return;
			case "abort":
				if (this.#active?.id === message.id) this.#active.ac.abort(new ToolAbortError());
				return;
			case "tool-reply":
				this.#deliverToolReply(message.id, message.reply);
				return;
			case "close":
				void this.#close();
		}
	}

	async #ensureSession(snapshot: ComputerSessionSnapshot): Promise<ComputerBackend> {
		if (this.#session) return this.#session;
		try {
			// This module imports native libraries. Defer its initialization until approved
			// use so the readiness handshake and ordinary CLI startup remain native-free.
			const createSession = this.#createSession ?? (await import("./backend")).createComputerBackend;
			const session = await createSession({ display: snapshot.display });
			if (this.#closed) {
				await session.close();
				throw new ToolAbortError("Computer operation stopped");
			}
			this.#session = session;
			return session;
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			throw nativeError(error);
		}
	}

	#ensureRuntime(snapshot: ComputerSessionSnapshot): JsRuntime {
		if (this.#runtime) return this.#runtime;
		this.#runtime = new JsRuntime({ initialCwd: snapshot.cwd, sessionId: snapshot.sessionId });
		return this.#runtime;
	}

	async #run(message: Extract<ComputerWorkerInbound, { type: "run" }>): Promise<void> {
		if (this.#closed || this.#drainFailed) {
			this.#transport.send({
				type: "result",
				id: message.id,
				ok: false,
				error: errorPayload(
					new ToolError(
						this.#drainFailed
							? "Computer worker cannot be reused after input completion failed; restart computer control"
							: "Computer worker is closed",
					),
				),
			});
			return;
		}
		if (this.#active) {
			this.#transport.send({
				type: "result",
				id: message.id,
				ok: false,
				error: errorPayload(new ToolError("Computer worker is busy")),
			});
			return;
		}
		const timeoutSignal = AbortSignal.timeout(message.timeoutMs);
		const ac = new AbortController();
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, ac.signal, runAc.signal]);
		const active: ActiveRun = { id: message.id, ac, signal, pendingTools: new Map() };
		this.#active = active;
		const output = new RunOutput();
		const screenshots: ComputerScreenshot[] = [];
		const runContext: ComputerRunContext = {
			signal,
			readOnly: message.session.readOnly,
			snapshot: message.session,
			output,
			screenshots,
		};
		let returnValue: unknown;
		let failure: { error: unknown } | undefined;
		let completed = false;
		try {
			throwIfAborted(signal);
			const session = await this.#ensureSession(message.session);
			const runtime = this.#ensureRuntime(message.session);
			runtime.setCwd(message.session.cwd);
			const desktop = this.#createDesktopScope(session);
			runtime.setRunScope({
				desktop: bindRunFacade(desktop, signal),
				assert: (condition: unknown, text?: string): void => {
					if (!condition) throw new ToolError(text ?? "Assertion failed");
				},
				wait: (msOrPredicate: number | (() => unknown), options?: WaitPredicateOptions): Promise<unknown> => {
					const resolved =
						typeof msOrPredicate === "number"
							? undefined
							: {
									timeout: resolvePredicateTimeout(message.timeoutMs, options?.timeout),
									interval: options?.interval,
								};
					return markHandled(waitForRun(msOrPredicate, signal, resolved));
				},
			});
			const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers<never>();
			const onCancel = (): void => {
				const abortError =
					signal.reason instanceof ToolAbortError
						? signal.reason
						: new ToolAbortError(undefined, { cause: signal.reason });
				rejectCancel(
					timeoutSignal.aborted
						? new ToolError(`Computer code execution timed out after ${message.timeoutMs}ms`)
						: abortError,
				);
				const toolAbort = timeoutSignal.aborted
					? postmortem.markExpectedCleanupError(new ToolAbortError(undefined, { cause: timeoutSignal.reason }))
					: abortError;
				for (const pending of active.pendingTools.values()) pending.reject(toolAbort);
				active.pendingTools.clear();
			};
			if (signal.aborted) onCancel();
			else signal.addEventListener("abort", onCancel, { once: true });
			try {
				returnValue = await Promise.race([
					this.#runContexts.run(runContext, () =>
						runtime.run(message.code, `computer-run-${message.id}.js`, this.#runtimeHooks(active, output), {
							runId: message.id,
							cwd: message.session.cwd,
						}),
					),
					cancelRejection,
				]);
				completed = true;
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
				await this.#session?.drain();
				if (this.#session?.requiresReacquisition) {
					await this.#session.close();
					this.#session = undefined;
				}
			} catch (error) {
				this.#drainFailed = true;
				// Losing input completion is a failure even if an earlier cancel won the JS race.
				failure = { error: nativeError(error) };
			}
			if (this.#active?.id === message.id) this.#active = null;
		}
		if (failure !== undefined) {
			this.#transport.send({ type: "result", id: message.id, ok: false, error: errorPayload(failure.error) });
			return;
		}
		if (completed) {
			let capabilities: DesktopCapabilities;
			try {
				capabilities = (await this.#ensureSession(message.session)).capabilities;
			} catch (error) {
				this.#transport.send({
					type: "result",
					id: message.id,
					ok: false,
					error: errorPayload(nativeError(error)),
				});
				return;
			}
			this.#transport.send({
				type: "result",
				id: message.id,
				ok: true,
				payload: { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots, capabilities },
			});
		}
	}

	#runtimeHooks(active: ActiveRun, output: RunOutput): RuntimeHooks {
		return {
			onText: chunk => {
				throwIfAborted(active.signal);
				output.pushText(chunk);
			},
			onDisplay: display => {
				throwIfAborted(active.signal);
				output.pushDisplay(display);
			},
			callTool: (name, args) => {
				throwIfAborted(active.signal);
				return this.#callTool(active, name, args);
			},
		};
	}

	async #callTool(active: ActiveRun, name: string, args: unknown): Promise<unknown> {
		const id = `computer-tc-${active.id}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { resolve, reject });
		this.#transport.send({ type: "tool-call", id, runId: active.id, name, args });
		return await promise;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		const pending = this.#active?.pendingTools.get(id);
		if (!pending) return;
		this.#active?.pendingTools.delete(id);
		if (reply.ok) pending.resolve(reply.value);
		else pending.reject(replyError(reply.error));
	}

	#currentRunContext = (): ComputerRunContext => {
		const context = this.#runContexts.getStore();
		if (!context) throw new ToolError("no active computer run");
		return context;
	};

	#createDesktopScope(session: ComputerBackend): object {
		const getContext = this.#currentRunContext;
		return {
			capabilities: (): DesktopCapabilities => {
				throwIfAborted(getContext().signal);
				return session.capabilities;
			},
			apps: () => session.apps(operationContext(getContext)),
			displays: () => session.displays(operationContext(getContext)),
			windows: (selector: unknown = {}) =>
				session.windows(operationContext(getContext), normalizeWindowSelector(selector)),
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
					if (error instanceof ToolAbortError || (error instanceof Error && error.name === "AbortError"))
						throw error;
					const result: ComputerWindowAcquisition = {
						...window,
						inspectionError: error instanceof Error ? error.message : String(error),
					};
					// AX and pixels are independent. Preserve exact identity when inspection
					// fails so callers can recover without choosing or revealing another window.
					if (options.screenshot !== false) {
						try {
							result.initialScreenshot = await session.captureWindow(context, window, {
								silent: options.silent,
							});
						} catch (captureError) {
							throwIfAborted(context.signal);
							if (
								captureError instanceof ToolAbortError ||
								(captureError instanceof Error && captureError.name === "AbortError")
							)
								throw captureError;
							result.screenshotError =
								captureError instanceof Error ? captureError.message : String(captureError);
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
			drag: (points: Array<[number, number]>, options?: ActionOptions) =>
				session.desktopDrag(mutationContext(getContext), points, options),
			scroll: (x: number, y: number, options?: ActionOptions & { dx?: number; dy?: number }) =>
				session.desktopScroll(mutationContext(getContext), x, y, options),
			type: (text: string, options?: ActionOptions) =>
				session.desktopType(mutationContext(getContext), text, options),
			press: (chord: string | string[], options?: ActionOptions) =>
				session.desktopPress(mutationContext(getContext), chord, options),
			clipboard: {
				read: () => session.clipboardRead(operationContext(getContext)),
				write: (text: string) => session.clipboardWrite(mutationContext(getContext), text),
			},
		};
	}

	async #close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#active?.ac.abort(new ToolAbortError("Computer operation stopped"));
		let cleanupError: RunErrorPayload | undefined;
		try {
			await this.#session?.close();
		} catch (error) {
			cleanupError = errorPayload(nativeError(error));
		} finally {
			this.#session = undefined;
			this.#unsubscribe();
			this.#transport.send({ type: "closed", error: cleanupError });
			this.#transport.close();
		}
	}
}
