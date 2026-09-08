import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import { withTimeout } from "@oh-my-pi/pi-utils/async";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	type WorkerSpawnCommand,
	workerEnvFromParent,
} from "../../subprocess/worker-client";
import { safeSend as safeSendIpc } from "../../utils/ipc";
import type { ToolSession } from "../index";
import { ToolAbortError, ToolError } from "../tool-errors";
import {
	COMPUTER_WORKER_ARG,
	type ComputerRunOk,
	type ComputerSessionSnapshot,
	type ComputerWorkerInbound,
	type ComputerWorkerOutbound,
	type RunErrorPayload,
} from "./protocol";

const START_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 15_000;
// Cooperative input stops promptly, but bounded AX reads/capture shutdown
// can need longer to acknowledge cleanup. A native task must own its release
// throughout this period; this grace is not a substitute for cancellation.
const GRACE_MS = 15_000;
const SMOKE_TIMEOUT_MS = 5_000;
const TIMEOUT_MESSAGE = "Computer worker did not acknowledge cancellation before its deadline";

/** Runs desktop scripts and owns their persistent worker session. */
export interface ComputerController {
	run(
		code: string,
		timeoutMs: number,
		snapshot: ComputerSessionSnapshot,
		signal?: AbortSignal,
	): Promise<ComputerRunOk>;
	capabilities(): Promise<DesktopCapabilities | undefined>;
	close(): Promise<void>;
}

/** Subprocess lifetime ends only when terminate() has observed actual OS exit. */
export interface ComputerWorkerHandle {
	readonly pid?: number;
	send(message: ComputerWorkerInbound): void;
	onMessage(handler: (message: ComputerWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

/** Startup and shutdown deadlines for a computer worker. */
export interface ComputerSupervisorTimeouts {
	startMs: number;
	closeMs: number;
	graceMs?: number;
}

const DEFAULT_TIMEOUTS: ComputerSupervisorTimeouts = {
	startMs: START_TIMEOUT_MS,
	closeMs: CLOSE_TIMEOUT_MS,
};

/** Dispatches a tool call requested from desktop JavaScript. */
export type ComputerSessionToolCaller = (
	name: string,
	args: unknown,
	options: { session: ToolSession; signal?: AbortSignal; emitStatus?: () => void },
) => Promise<unknown>;

/** Creates an isolated computer worker handle. */
export type ComputerWorkerFactory = () => ComputerWorkerHandle;

interface PendingRun {
	resolve(value: ComputerRunOk): void;
	reject(error: unknown): void;
	signal?: AbortSignal;
	toolCalls: Map<string, AbortController>;
}

/** Re-enters the CLI in a separate address space; never falls back to a thread. */
export function spawnComputerWorker(
	spawnCommand: WorkerSpawnCommand = resolveWorkerSpawnCmd(COMPUTER_WORKER_ARG),
): ComputerWorkerHandle {
	const spawned = createWorkerSubprocess<ComputerWorkerOutbound>({
		spawnCommand,
		env: workerEnvFromParent(),
		exitLabel: "Computer worker",
		reportCleanExit: true,
		unref: false,
		ownedProcessTree: true,
	});
	const base = createWorkerHandle<ComputerWorkerInbound, ComputerWorkerOutbound>(spawned, message =>
		safeSendIpc(spawned.proc, message, "computer"),
	);
	const messages = new Set<(message: ComputerWorkerOutbound) => void>();
	const errors = new Set<(error: Error) => void>();
	const inbox: ComputerWorkerOutbound[] = [];
	const earlyErrors: Error[] = [];
	base.onMessage(message => {
		if (!messages.size) inbox.push(message);
		else for (const handler of messages) handler(message);
	});
	base.onError(error => {
		if (!errors.size) earlyErrors.push(error);
		else for (const handler of errors) handler(error);
	});
	let terminating: Promise<void> | undefined;
	return {
		pid: spawned.proc.pid,
		send: message => base.send(message),
		onMessage(handler) {
			messages.add(handler);
			for (const message of inbox.splice(0)) handler(message);
			return () => {
				messages.delete(handler);
			};
		},
		onError(handler) {
			errors.add(handler);
			for (const error of earlyErrors.splice(0)) handler(error);
			return () => {
				errors.delete(handler);
			};
		},
		terminate() {
			return (terminating ??= (async () => {
				await base.terminate();
				await spawned.proc.exited;
				await spawned.stderrDrained;
			})());
		},
	};
}

function errorFromPayload(payload: RunErrorPayload): Error {
	const error = payload.isAbort
		? new ToolAbortError(payload.message)
		: payload.isToolError
			? new ToolError(payload.message)
			: new Error(payload.message);
	error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function toErrorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { name: "Error", message: String(error), isAbort: false, isToolError: false };
}

/** Supervises one lazy, crash-isolated computer worker per agent session. */
export class ComputerSupervisor implements ComputerController {
	readonly #session: ToolSession;
	readonly #createWorker: ComputerWorkerFactory;
	readonly #callSessionTool: ComputerSessionToolCaller;
	readonly #timeouts: ComputerSupervisorTimeouts;
	#worker?: ComputerWorkerHandle;
	#startPromise?: Promise<void>;
	#startReject?: (error: unknown) => void;
	#startResolve?: () => void;
	#latestCapabilities?: DesktopCapabilities;
	#pending = new Map<string, PendingRun>();
	#nextId = 0;
	#closed = false;
	#closing?: Promise<void>;
	#terminating?: Promise<void>;
	#terminationFailure?: Error;
	#cleanupFailure?: Error;
	#cleanupAcknowledged = false;
	#unsubscribeMessage?: () => void;
	#unsubscribeError?: () => void;

	constructor(
		session: ToolSession,
		createWorker: ComputerWorkerFactory = spawnComputerWorker,
		timeouts: ComputerSupervisorTimeouts = DEFAULT_TIMEOUTS,
		callSessionTool: ComputerSessionToolCaller = async () => {
			throw new ToolError("Computer session tool bridge is unavailable");
		},
	) {
		this.#session = session;
		this.#createWorker = createWorker;
		this.#timeouts = timeouts;
		this.#callSessionTool = callSessionTool;
	}

	async capabilities(): Promise<DesktopCapabilities | undefined> {
		return this.#latestCapabilities;
	}

	async run(
		code: string,
		timeoutMs: number,
		snapshot: ComputerSessionSnapshot,
		signal?: AbortSignal,
	): Promise<ComputerRunOk> {
		if (this.#closed) throw new ToolError("Computer session is closed");
		if (signal?.aborted) throw new ToolAbortError();
		await this.#start();
		if (this.#closed) throw new ToolAbortError("Computer operation stopped");
		if (signal?.aborted) throw new ToolAbortError();

		const id = `computer-${++this.#nextId}`;
		const { promise, resolve, reject } = Promise.withResolvers<ComputerRunOk>();
		const pending: PendingRun = { resolve, reject, signal, toolCalls: new Map() };
		this.#pending.set(id, pending);
		const abort = (): void => {
			this.#safeSend({ type: "abort", id });
			for (const controller of pending.toolCalls.values()) controller.abort(signal?.reason);
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });

		try {
			this.#worker?.send({ type: "run", id, code, timeoutMs, session: snapshot });
			return await this.#raceWithGrace(promise, timeoutMs, signal);
		} finally {
			signal?.removeEventListener("abort", abort);
			this.#pending.delete(id);
		}
	}

	async #start(): Promise<void> {
		if (this.#terminating) await this.#terminating;
		if (this.#terminationFailure) throw this.#terminationFailure;
		if (this.#cleanupFailure) throw this.#cleanupFailure;
		if (this.#closed) throw new ToolError("Computer session is closed");
		if (this.#startPromise) return this.#startPromise;
		const started = Promise.withResolvers<void>();
		this.#startReject = started.reject;
		this.#startResolve = started.resolve;
		try {
			logger.debug("Starting computer worker");
			const worker = this.#createWorker();
			this.#worker = worker;
			this.#cleanupAcknowledged = false;
			this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
			this.#unsubscribeError = worker.onError(error => {
				void this.#workerFailed(error);
			});
		} catch (error) {
			started.reject(error);
		}
		this.#startPromise = withTimeout(
			started.promise,
			this.#timeouts.startMs,
			"Timed out starting computer worker",
		).catch(async error => {
			await this.#terminate(error);
			throw error;
		});
		return this.#startPromise;
	}

	#handleMessage(message: ComputerWorkerOutbound): void {
		if (message.type === "closed") {
			this.#cleanupAcknowledged = !message.error;
			return;
		}
		if (message.type === "ready") {
			this.#startResolve?.();
			this.#startResolve = undefined;
			this.#startReject = undefined;
			return;
		}
		if (message.type === "result") {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			if (message.ok) {
				this.#latestCapabilities = message.payload.capabilities;
				pending.resolve(message.payload);
			} else {
				pending.reject(errorFromPayload(message.error));
			}
			return;
		}
		if (message.type === "tool-call") {
			void this.#dispatchToolCall(message);
		}
	}

	async #dispatchToolCall(message: Extract<ComputerWorkerOutbound, { type: "tool-call" }>): Promise<void> {
		const pending = this.#pending.get(message.runId);
		if (!pending) {
			this.#safeSend({
				type: "tool-reply",
				id: message.id,
				reply: {
					ok: false,
					error: { name: "ToolError", message: "No active run for tool call", isToolError: true, isAbort: false },
				},
			});
			return;
		}
		const controller = new AbortController();
		pending.toolCalls.set(message.id, controller);
		const onParentAbort = (): void => controller.abort(pending.signal?.reason);
		if (pending.signal?.aborted) onParentAbort();
		else pending.signal?.addEventListener("abort", onParentAbort, { once: true });
		try {
			const value = await this.#callSessionTool(message.name, message.args, {
				session: this.#session,
				signal: controller.signal,
				emitStatus: () => {},
			});
			this.#safeSend({ type: "tool-reply", id: message.id, reply: { ok: true, value } });
		} catch (error) {
			this.#safeSend({ type: "tool-reply", id: message.id, reply: { ok: false, error: toErrorPayload(error) } });
		} finally {
			pending.toolCalls.delete(message.id);
			pending.signal?.removeEventListener("abort", onParentAbort);
		}
	}

	#safeSend(message: ComputerWorkerInbound): void {
		try {
			this.#worker?.send(message);
		} catch (error) {
			logger.debug("Computer worker send failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #raceWithGrace(
		promise: Promise<ComputerRunOk>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<ComputerRunOk> {
		const grace = this.#timeouts.graceMs ?? GRACE_MS;
		const timeout = Promise.withResolvers<never>();
		let forced = false;
		const expire = (error: Error): void => {
			forced = true;
			timeout.reject(error);
		};
		const deadline = setTimeout(() => expire(new ToolError(TIMEOUT_MESSAGE)), timeoutMs + grace);
		let abortDeadline: Timer | undefined;
		const onAbort = (): void => {
			abortDeadline ??= setTimeout(() => expire(new ToolAbortError()), grace);
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([promise, timeout.promise]);
		} catch (error) {
			if (forced) await this.#terminate(error);
			throw this.#cleanupFailure ?? error;
		} finally {
			clearTimeout(deadline);
			if (abortDeadline) clearTimeout(abortDeadline);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async #workerFailed(error: Error): Promise<void> {
		logger.warn("Computer worker failed", { error: error.message });
		try {
			await this.#terminate(error);
		} catch (failure) {
			logger.error("Computer process exit could not be confirmed", { error: String(failure) });
		}
	}

	#terminate(reason: unknown): Promise<void> {
		if (this.#terminating) return this.#terminating;
		const worker = this.#worker;
		this.#worker = undefined;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = undefined;
		this.#unsubscribeError?.();
		this.#unsubscribeError = undefined;
		const pendingRuns = [...this.#pending.values()];
		if (worker && pendingRuns.length && !this.#cleanupAcknowledged) {
			// OS exit stops the process, but cannot prove that admitted native work
			// released held input. Do not convert that uncertainty to a clean abort
			// or admit another controller automatically.
			this.#cleanupFailure ??= new ToolError(
				`Native cleanup could not be confirmed; computer control cannot restart in this session. ` +
					`Input release and action effects are unconfirmed; inspect the target and input state before retrying. ` +
					`Cause: ${reason instanceof Error ? reason.message : String(reason)}`,
			);
		}
		for (const pending of pendingRuns) {
			for (const controller of pending.toolCalls.values()) controller.abort(reason);
		}
		this.#pending.clear();
		this.#terminating = (async () => {
			let failure = this.#cleanupFailure ?? reason;
			try {
				await worker?.terminate();
			} catch (error) {
				this.#terminationFailure = new ToolError(
					`Computer process exit could not be confirmed; this session cannot restart: ${String(error)}`,
				);
				failure = this.#terminationFailure;
				throw this.#terminationFailure;
			} finally {
				this.#startReject?.(failure);
				this.#startReject = undefined;
				this.#startResolve = undefined;
				this.#startPromise = undefined;
				this.#latestCapabilities = undefined;
				for (const pending of pendingRuns) pending.reject(failure);
			}
		})();
		const terminating = this.#terminating;
		void terminating
			.finally(() => {
				if (this.#terminating === terminating) this.#terminating = undefined;
			})
			.catch(() => undefined);
		return terminating;
	}

	close(): Promise<void> {
		return (this.#closing ??= this.#close());
	}
	async #close(): Promise<void> {
		this.#closed = true;
		if (this.#terminating) await this.#terminating;
		const worker = this.#worker;
		if (!worker) {
			if (this.#terminationFailure) throw this.#terminationFailure;
			if (this.#cleanupFailure) throw this.#cleanupFailure;
			return;
		}
		const closed = Promise.withResolvers<void>();
		const unsubscribe = worker.onMessage(message => {
			if (message.type === "closed") {
				logger.debug("Computer worker cleanup acknowledged", {
					pid: worker.pid,
					success: !message.error,
					error: message.error?.message,
				});
				if (message.error) closed.reject(errorFromPayload(message.error));
				else closed.resolve();
			}
		});
		let cleanupFailure: unknown;
		try {
			worker.send({ type: "close" });
			await withTimeout(closed.promise, this.#timeouts.closeMs, "Timed out closing computer worker");
		} catch (error) {
			cleanupFailure = error;
		} finally {
			unsubscribe();
			await this.#terminate(new ToolAbortError("Computer operation stopped"));
		}
		if (cleanupFailure) throw new ToolError(`Native cleanup could not be confirmed: ${String(cleanupFailure)}`);
	}
}

/** Session lifetime can release a worker without permanently closing the prelude. */
export interface ComputerSessionLifetime {
	release(): Promise<void>;
	close(): Promise<void>;
}

const ownedSupervisors = new Map<string, Set<ComputerSessionLifetime>>();

/** Registers a controller for owner-scoped session cleanup. */
export function registerComputerController(
	ownerId: string | undefined,
	controller: ComputerSessionLifetime,
): () => void {
	if (!ownerId) return () => {};
	const controllers = ownedSupervisors.get(ownerId) ?? new Set<ComputerSessionLifetime>();
	controllers.add(controller);
	ownedSupervisors.set(ownerId, controllers);
	return () => {
		controllers.delete(controller);
		if (controllers.size === 0) ownedSupervisors.delete(ownerId);
	};
}

/** Drain current workers while retaining their session lifetimes for later use. */
export async function releaseComputerResourcesForOwner(ownerId: string | undefined): Promise<void> {
	if (!ownerId) return;
	const controllers = ownedSupervisors.get(ownerId);
	if (!controllers) return;
	const results = await Promise.allSettled(Array.from(controllers, controller => controller.release()));
	const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
	if (errors.length) throw new AggregateError(errors, "Computer resources could not be released");
}

/** Closes every computer session owned by an agent session. */
export async function releaseComputerSessionsForOwner(ownerId: string | undefined): Promise<void> {
	if (!ownerId) return;
	const controllers = ownedSupervisors.get(ownerId);
	if (!controllers) return;
	ownedSupervisors.delete(ownerId);
	await Promise.allSettled(Array.from(controllers, controller => controller.close()));
}

/** Verifies computer worker startup, messaging, and bounded shutdown. */
export async function smokeTestComputerWorker(
	timeoutMs = SMOKE_TIMEOUT_MS,
	createWorker: ComputerWorkerFactory = spawnComputerWorker,
): Promise<void> {
	const worker = createWorker();
	const waitFor = async (expected: ComputerWorkerOutbound["type"], failureMessage: string): Promise<void> => {
		const response = Promise.withResolvers<void>();
		const unsubscribeMessage = worker.onMessage(received => {
			if (received.type === expected) response.resolve();
			else if (received.type === "result" && !received.ok) response.reject(errorFromPayload(received.error));
		});
		const unsubscribeError = worker.onError(error => response.reject(error));
		try {
			await withTimeout(response.promise, timeoutMs, failureMessage);
		} finally {
			unsubscribeMessage();
			unsubscribeError();
		}
	};

	try {
		const pong = waitFor("pong", "Computer worker smoke ping timed out");
		worker.send({ type: "ping", id: `computer-smoke-${Snowflake.next()}` });
		await pong;
		const closed = waitFor("closed", "Computer worker smoke close timed out");
		worker.send({ type: "close" });
		await closed;
	} finally {
		await worker.terminate();
	}
}
