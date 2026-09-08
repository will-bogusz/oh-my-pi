import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { withTimeout } from "@oh-my-pi/pi-utils/async";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { createComputerPrelude } from "../../src/tools/computer";
import { ToolAbortError, ToolError } from "../../src/tools/tool-errors";
import type {
	ComputerSessionSnapshot,
	ComputerWorkerInbound,
	ComputerWorkerOutbound,
	RunErrorPayload,
} from "../../src/tools/computer/protocol";
import {
	ComputerSupervisor,
	type ComputerWorkerHandle,
	spawnComputerWorker,
	smokeTestComputerWorker,
} from "../../src/tools/computer/supervisor";

const snapshot: ComputerSessionSnapshot = {
	cwd: import.meta.dir,
	sessionId: "process-lifecycle",
	captureMaxWidth: 1280,
	captureMaxHeight: 896,
	display: "primary",
	readOnly: false,
};
const session = (): ToolSession => ({
	cwd: import.meta.dir,
	hasUI: false,
	settings: Settings.isolated({ "computer.enabled": true }),
	getSessionFile: () => null,
	getSessionSpawns: () => null,
});
const fixture = (): ComputerWorkerHandle =>
	spawnComputerWorker({
		cmd: [process.execPath, path.resolve(import.meta.dir, "../fixtures/computer-subprocess-lifecycle.ts")],
	});

function waitFor(
	worker: ComputerWorkerHandle,
	predicate: (message: ComputerWorkerOutbound) => boolean,
): Promise<ComputerWorkerOutbound> {
	const result = Promise.withResolvers<ComputerWorkerOutbound>();
	const unsubscribe = worker.onMessage(message => {
		if (predicate(message)) result.resolve(message);
	});
	const unsubscribeError = worker.onError(result.reject);
	return withTimeout(result.promise, 5_000, "Computer fixture IPC timed out").finally(() => {
		unsubscribe();
		unsubscribeError();
	});
}
function expectExited(worker: ComputerWorkerHandle): void {
	expect(worker.pid).not.toBe(process.pid);
	expect(worker.pid).toBeNumber();
	try {
		process.kill(worker.pid!, 0);
		throw new Error("Computer child is still alive");
	} catch (error) {
		expect(error).toMatchObject({ code: "ESRCH" });
	}
}

describe("computer subprocess boundary", () => {
	for (const cause of ["abort", "crash"] as const) {
		it(`preserves unconfirmed native cleanup after ${cause} even when the actual child exits`, async () => {
			const workers: ComputerWorkerHandle[] = [];
			const admitted = Promise.withResolvers<void>();
			const supervisor = new ComputerSupervisor(
				session(),
				() => {
					const worker = fixture();
					workers.push(worker);
					worker.onMessage(message => {
						if (message.type === "pong" && message.id === "operation-started") admitted.resolve();
					});
					return worker;
				},
				{ startMs: 5000, closeMs: 50, graceMs: 20 },
			);
			const controller = new AbortController();
			const running = supervisor
				.run("return await desktop.apps()", 5000, snapshot, controller.signal)
				.catch(error => error as Error);
			try {
				await withTimeout(admitted.promise, 5000, "Backend operation was not admitted");
				if (cause === "abort") controller.abort();
				else workers[0]!.send({ type: "ping", id: "exit-leader" });
				const failure = await running;
				expect(failure).toBeInstanceOf(ToolError);
				expect(failure).not.toBeInstanceOf(ToolAbortError);
				if (failure instanceof Error)
					expect(failure.message).toContain("Input release and action effects are unconfirmed");
				expectExited(workers[0]!);
				await expect(supervisor.run("return 1", 1000, snapshot)).rejects.toBe(failure);
				await expect(supervisor.close()).rejects.toBe(failure);
				expect(workers).toHaveLength(1);
			} finally {
				controller.abort();
				await Promise.allSettled(workers.map(worker => worker.terminate()));
			}
		}, 15_000);
	}

	it("relays source CLI readiness and close without loading addons in the inner worker", async () => {
		await smokeTestComputerWorker(5_000, () =>
			spawnComputerWorker({
				cmd: [
					process.execPath,
					"--no-addons",
					path.resolve(import.meta.dir, "../../src/cli.ts"),
					"__omp_worker_computer",
				],
			}),
		);
	}, 15_000);

	it.skipIf(process.platform === "win32")(
		"waits for confirmed group absence after a temporarily denied exit probe",
		async () => {
			const worker = fixture();
			const probed = Promise.withResolvers<void>();
			let denyProbe = true;
			let settled = false;
			let deniedProbes = 0;
			const originalKill = process.kill.bind(process);
			const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
				if (pid === -worker.pid! && signal === 0 && denyProbe) {
					if (++deniedProbes === 2) probed.resolve();
					throw Object.assign(new Error("Group exit is not yet observable"), { code: "EPERM" });
				}
				return originalKill(pid, signal);
			});
			try {
				await waitFor(worker, message => message.type === "ready");
				const termination = worker.terminate();
				void termination.then(
					() => {
						settled = true;
					},
					() => {
						settled = true;
					},
				);
				await withTimeout(probed.promise, 5_000, "Group was not probed");
				expect(settled).toBe(false);
				denyProbe = false;
				await termination;
				expectExited(worker);
			} finally {
				kill.mockRestore();
				await worker.terminate();
			}
		},
	);

	for (const exitLeader of [false, true]) {
		it.skipIf(process.platform === "win32" && exitLeader)(
			`terminates an installer with private pipes ${exitLeader ? "after its worker exits" : "when its worker is wedged"}`,
			async () => {
				const worker = fixture();
				let installer: Process | null = null;
				try {
					const started = waitFor(
						worker,
						message => message.type === "pong" && message.id.startsWith("installer:"),
					);
					worker.send({ type: "ping", id: "spawn-installer" });
					const message = await started;
					if (message.type !== "pong") throw new Error("Installer readiness was not a pong");
					installer = Process.fromPid(Number(message.id.slice("installer:".length)));
					expect(installer?.status()).toBe(ProcessStatus.Running);
					if (exitLeader) {
						const exited = Promise.withResolvers<Error>();
						const unsubscribe = worker.onError(exited.resolve);
						worker.send({ type: "ping", id: "exit-leader" });
						await withTimeout(exited.promise, 5_000, "Worker exit was not reported");
						unsubscribe();
						// The boundary must survive the actual worker and retain ownership
						// while its ordinary installer is still alive.
						expect(installer?.status()).toBe(ProcessStatus.Running);
					} else {
						const wedged = waitFor(worker, message => message.type === "pong" && message.id === "wedged");
						worker.send({ type: "ping", id: "wedge" });
						await wedged;
					}
					await withTimeout(worker.terminate(), 10_000, "Installer tree termination timed out");
					expectExited(worker);
					expect(installer?.status()).toBe(ProcessStatus.Exited);
				} finally {
					// Preserve the stable reference for cleanup even when the regression
					// fails; never signal a possibly recycled numeric installer PID.
					try {
						await worker.terminate();
					} finally {
						if (installer?.status() === ProcessStatus.Running) {
							installer.killTree(9);
							await installer.waitForExit({ timeoutMs: 5_000 });
						}
					}
				}
			},
			20_000,
		);
	}

	it("release exits the actual child and discards its persistent runtime before another call", async () => {
		const workers: ComputerWorkerHandle[] = [];
		const currentSession = session();
		const prelude = createComputerPrelude(
			currentSession,
			() =>
				new ComputerSupervisor(currentSession, () => {
					const worker = fixture();
					workers.push(worker);
					return worker;
				}),
		);
		const context = { session: currentSession, toolCallId: "release-process" };
		try {
			await prelude.invoke(
				{ action: "run", code: "globalThis.previousCapture = await desktop.screenshot(); return true" },
				context,
			);
			await prelude.invoke({ action: "release" }, context);
			expectExited(workers[0]!);
			const result = await prelude.invoke({ action: "run", code: "return typeof previousCapture" }, context);
			expect(result).toMatchObject({ details: { value: "undefined" } });
			expect(workers).toHaveLength(2);
			expect(workers[1]?.pid).not.toBe(workers[0]?.pid);
		} finally {
			await prelude.invoke({ action: "close" }, context);
			for (const worker of workers) expectExited(worker);
		}
	});
	it("retains pre-subscription readiness and terminates a synchronously wedged child before resolving", async () => {
		const worker = fixture();
		try {
			await Bun.sleep(150);
			await waitFor(worker, message => message.type === "ready");
			const wedged = waitFor(worker, message => message.type === "pong" && message.id === "wedged");
			worker.send({ type: "ping", id: "wedge" });
			await wedged;
			await worker.terminate();
			expectExited(worker);
		} finally {
			await worker.terminate();
		}
	});

	it("keeps screenshot bytes and binary return values intact over advanced process IPC", async () => {
		const worker = fixture();
		try {
			const response = waitFor(worker, message => message.type === "result");
			worker.send({
				type: "run",
				id: "binary",
				code: "return await desktop.screenshot()",
				timeoutMs: 2_000,
				session: snapshot,
			});
			const message = await response;
			if (message.type !== "result" || !message.ok) throw new Error(JSON.stringify(message));
			const returned = message.payload.returnValue as { bytes: Uint8Array; buffer: ArrayBuffer };
			expect(returned.bytes).toBeInstanceOf(Uint8Array);
			expect(returned.buffer).toBeInstanceOf(ArrayBuffer);
			expect(Array.from(returned.bytes)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
			expect(Array.from(new Uint8Array(returned.buffer))).toEqual(Array.from(returned.bytes));
			expect(message.payload.displays.find(display => display.type === "image")).toEqual({
				type: "image",
				data: "iVBORw0KGgo=",
				mimeType: "image/png",
			});
			expect(message.payload.screenshots).toEqual([
				{
					imageIndex: 0,
					path: "/fixture.png",
					width: 1,
					height: 1,
					sourceWidth: 1,
					sourceHeight: 1,
					target: "fixture",
				},
			]);
		} finally {
			await worker.terminate();
		}
	});

	it("acknowledges normal close only after the admitted backend operation drains", async () => {
		const worker = fixture();
		const messages: ComputerWorkerOutbound[] = [];
		worker.onMessage(message => messages.push(message));
		try {
			const started = waitFor(worker, message => message.type === "pong" && message.id === "operation-started");
			worker.send({ type: "run", id: "drain", code: "await desktop.apps()", timeoutMs: 2_000, session: snapshot });
			await started;
			const closed = waitFor(worker, message => message.type === "closed");
			worker.send({ type: "close" });
			await Bun.sleep(20);
			expect(messages.some(message => message.type === "closed")).toBe(false);
			worker.send({ type: "ping", id: "release" });
			await closed;
			const closeIndex = messages.findIndex(message => message.type === "closed");
			const drainedIndex = messages.findIndex(message => message.type === "pong" && message.id === "backend-closed");
			expect(drainedIndex).toBeGreaterThan(-1);
			expect(closeIndex).toBeGreaterThan(drainedIndex);
			await worker.terminate();
			expectExited(worker);
		} finally {
			await worker.terminate();
		}
	});
});

class DelayedExitWorker implements ComputerWorkerHandle {
	readonly exit = Promise.withResolvers<void>();
	readonly killing = Promise.withResolvers<void>();
	readonly runStarted = Promise.withResolvers<void>();
	readonly messages = new Set<(message: ComputerWorkerOutbound) => void>();
	respond = false;
	closeError?: RunErrorPayload;
	send(message: ComputerWorkerInbound): void {
		if (message.type === "run") {
			this.runStarted.resolve();
			if (this.respond)
				queueMicrotask(() =>
					this.emit({
						type: "result",
						id: message.id,
						ok: true,
						payload: { displays: [], returnValue: "fresh", screenshots: [] },
					}),
				);
		} else if (message.type === "close") queueMicrotask(() => this.emit({ type: "closed", error: this.closeError }));
	}
	emit(message: ComputerWorkerOutbound): void {
		for (const handler of this.messages) handler(message);
	}
	onMessage(handler: (message: ComputerWorkerOutbound) => void): () => void {
		this.messages.add(handler);
		queueMicrotask(() => handler({ type: "ready" }));
		return () => {
			this.messages.delete(handler);
		};
	}
	onError(_handler: (error: Error) => void): () => void {
		return () => {};
	}
	async terminate(): Promise<void> {
		this.killing.resolve();
		await this.exit.promise;
	}
}

describe("computer supervisor exit barrier", () => {
	it("reports a failed native cleanup receipt even when the process exits normally", async () => {
		const worker = new DelayedExitWorker();
		worker.respond = true;
		worker.exit.resolve();
		worker.closeError = { name: "ToolError", message: "native release failed", isAbort: false, isToolError: true };
		const supervisor = new ComputerSupervisor(session(), () => worker, { startMs: 1000, closeMs: 50 });
		await supervisor.run("ready", 1000, snapshot);
		await expect(supervisor.close()).rejects.toThrow("Native cleanup could not be confirmed");
	});

	for (const outcome of ["exit", "failure"] as const) {
		it(`deliberate close reports ${outcome === "exit" ? "a typed stop" : "failure"} only after process exit settles`, async () => {
			const worker = new DelayedExitWorker();
			const supervisor = new ComputerSupervisor(session(), () => worker, { startMs: 1_000, closeMs: 50 });
			let settled = false;
			const running = supervisor.run("pending operation", 10_000, snapshot).catch(error => {
				settled = true;
				return error as Error;
			});
			await worker.runStarted.promise;
			const closing = supervisor.close().catch(error => error as Error);
			await worker.killing.promise;
			expect(settled).toBe(false);
			if (outcome === "exit") worker.exit.resolve();
			else worker.exit.reject(new Error("Exit could not be observed"));
			const result = await running;
			const closed = await closing;
			if (outcome === "exit") {
				expect(result).toBeInstanceOf(ToolAbortError);
				expect(closed).toBeUndefined();
			} else {
				expect(result).not.toBeInstanceOf(ToolAbortError);
				expect(result).toBeInstanceOf(Error);
				expect(closed).toBeInstanceOf(Error);
			}
		});
	}

	for (const outcome of ["exit", "failure"] as const) {
		it(`release ${outcome} holds replacement behind actual process shutdown`, async () => {
			const old = new DelayedExitWorker();
			old.respond = true;
			const fresh = new DelayedExitWorker();
			fresh.respond = true;
			fresh.exit.resolve();
			let spawns = 0;
			const currentSession = session();
			const prelude = createComputerPrelude(
				currentSession,
				() =>
					new ComputerSupervisor(currentSession, () => (++spawns === 1 ? old : fresh), {
						startMs: 1_000,
						closeMs: 50,
					}),
			);
			const context = { session: currentSession, toolCallId: "release-exit" };
			await prelude.invoke({ action: "run", code: "first" }, context);
			let released = false;
			const releasing = prelude.invoke({ action: "release" }, context).then(
				result => {
					released = true;
					return result;
				},
				error => error as Error,
			);
			await old.killing.promise;
			const next = prelude.invoke({ action: "run", code: "next" }, context).catch(error => error as Error);
			await Bun.sleep(10);
			expect(released).toBe(false);
			expect(spawns).toBe(1);
			if (outcome === "failure") old.exit.reject(new Error("exit observation failed"));
			else old.exit.resolve();
			const releaseResult = await releasing;
			const nextResult = await next;
			if (outcome === "failure") {
				expect(releaseResult).toBeInstanceOf(Error);
				expect(nextResult).toBeInstanceOf(Error);
				expect(spawns).toBe(1);
				await expect(prelude.invoke({ action: "run", code: "unsafe" }, context)).rejects.toThrow("cannot restart");
			} else {
				expect(released).toBe(true);
				expect(nextResult).toMatchObject({ details: { value: "fresh" } });
				expect(spawns).toBe(2);
				await prelude.invoke({ action: "close" }, context);
			}
		});
	}
	for (const cause of ["timeout", "abort"] as const) {
		it(`withholds ${cause} completion until exit and refuses replacement without native cleanup`, async () => {
			const old = new DelayedExitWorker();
			const fresh = new DelayedExitWorker();
			fresh.respond = true;
			fresh.exit.resolve();
			let spawns = 0;
			const supervisor = new ComputerSupervisor(session(), () => (++spawns === 1 ? old : fresh), {
				startMs: 1_000,
				closeMs: 50,
				graceMs: 5,
			});
			const controller = new AbortController();
			let settled = false;
			const result = supervisor
				.run("hang", cause === "timeout" ? 5 : 10_000, snapshot, controller.signal)
				.catch(error => {
					settled = true;
					return error as Error;
				});
			await old.runStarted.promise;
			if (cause === "abort") controller.abort();
			await old.killing.promise;
			const replacement = supervisor.run("next", 1_000, snapshot).catch(error => error as Error);
			await Bun.sleep(10);
			expect(settled).toBe(false);
			expect(spawns).toBe(1);
			old.exit.resolve();
			const failure = await result;
			expect(failure).toBeInstanceOf(ToolError);
			expect(failure).not.toBeInstanceOf(ToolAbortError);
			if (failure instanceof Error)
				expect(failure.message).toMatch(/Input release and action effects are unconfirmed/);
			expect(await replacement).toBe(failure);
			expect(spawns).toBe(1);
			await expect(supervisor.close()).rejects.toBe(failure);
		});
	}

	it("refuses a new process after exit confirmation fails", async () => {
		const worker = new DelayedExitWorker();
		let spawns = 0;
		const supervisor = new ComputerSupervisor(
			session(),
			() => {
				spawns++;
				return worker;
			},
			{ startMs: 1_000, closeMs: 50, graceMs: 5 },
		);
		const result = supervisor.run("hang", 5, snapshot).catch(error => error as Error);
		await worker.killing.promise;
		worker.exit.reject(new Error("exit observation failed"));
		const failure = await result;
		if (!(failure instanceof Error)) throw new Error("Expected failed exit confirmation");
		expect(failure.message).toMatch(/exit could not be confirmed/);
		await expect(supervisor.run("unsafe replacement", 50, snapshot)).rejects.toThrow(/cannot restart/);
		expect(spawns).toBe(1);
		await expect(supervisor.close()).rejects.toThrow(/exit could not be confirmed/);
	});
});
