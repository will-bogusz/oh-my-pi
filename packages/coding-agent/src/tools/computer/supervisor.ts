import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import type { ToolSession } from "../index";
import { throwIfAborted } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ComputerBackend, ComputerBackendFactory } from "./backend";
import { ComputerRuntime } from "./runtime";
import type { ComputerRunOk, ComputerSessionSnapshot } from "./types";

/** Runs desktop scripts and owns their persistent session. */
export interface ComputerController {
	run(
		code: string,
		timeoutMs: number,
		snapshot: ComputerSessionSnapshot,
		signal?: AbortSignal,
	): Promise<ComputerRunOk>;
	/** Probes the driver when needed; never a cache read that can answer undefined. */
	capabilities(): Promise<DesktopCapabilities>;
	close(): Promise<void>;
}

/** Dispatches a tool call requested from desktop JavaScript. */
export type ComputerSessionToolCaller = (
	name: string,
	args: unknown,
	options: { session: ToolSession; signal?: AbortSignal },
) => Promise<unknown>;

// Deliberately dynamic: cua-session transitively loads the pi-natives desktop
// addon (window roster), which ordinary CLI startup must never touch.
const createNativeBackend: ComputerBackendFactory = async options =>
	(await import("./cua-session")).createCuaBackend(options);

/**
 * One lazily started computer session per agent session: a JavaScript realm
 * for desktop scripts plus the backend that owns the driver child. Closing
 * ends the child; the owning lifetime may create a fresh supervisor later.
 */
export class ComputerSupervisor implements ComputerController {
	readonly #session: ToolSession;
	readonly #createBackend: ComputerBackendFactory;
	readonly #callSessionTool: ComputerSessionToolCaller;
	readonly #runtime = new ComputerRuntime();
	#backend?: Promise<ComputerBackend>;
	#active = false;
	#closed = false;
	#closing?: Promise<void>;

	constructor(
		session: ToolSession,
		createBackend: ComputerBackendFactory = createNativeBackend,
		callSessionTool: ComputerSessionToolCaller = async () => {
			throw new ToolError("Computer session tool bridge is unavailable");
		},
	) {
		this.#session = session;
		this.#createBackend = createBackend;
		this.#callSessionTool = callSessionTool;
	}

	async #ensureBackend(display: string): Promise<ComputerBackend> {
		if (this.#closed) throw new ToolError("Computer session is closed");
		this.#backend ??= this.#createBackend({ display }).catch((error: unknown) => {
			// A failed start must not poison the session; the next call retries.
			this.#backend = undefined;
			throw error;
		});
		return this.#backend;
	}

	async capabilities(): Promise<DesktopCapabilities> {
		return (await this.#ensureBackend(this.#session.settings.get("computer.display") ?? "all")).capabilities;
	}

	async run(
		code: string,
		timeoutMs: number,
		snapshot: ComputerSessionSnapshot,
		signal?: AbortSignal,
	): Promise<ComputerRunOk> {
		if (this.#closed) throw new ToolError("Computer session is closed");
		throwIfAborted(signal);
		if (this.#active) throw new ToolError("Computer session is busy");
		this.#active = true;
		try {
			const backend = await this.#ensureBackend(snapshot.display);
			return await this.#runtime.run(backend, {
				code,
				timeoutMs,
				snapshot,
				signal,
				callTool: (name, args, runSignal) =>
					this.#callSessionTool(name, args, { session: this.#session, signal: runSignal }),
			});
		} finally {
			this.#active = false;
		}
	}

	close(): Promise<void> {
		this.#closing ??= (async () => {
			this.#closed = true;
			const backend = await this.#backend?.catch(() => undefined);
			this.#backend = undefined;
			try {
				await backend?.close();
			} finally {
				this.#runtime.dispose();
			}
		})();
		return this.#closing;
	}
}

/** Session lifetime can release a driver without permanently closing the prelude. */
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

/** Release current drivers while retaining their session lifetimes for later use. */
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
