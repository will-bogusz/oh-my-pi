import { describe, expect, it } from "bun:test";
import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import { withTimeout } from "@oh-my-pi/pi-utils/async";
import { Settings } from "../../src/config/settings";
import { disposeVmContextsByOwner, invokeJsTool } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { disposeKernelSessionsByOwner } from "../../src/eval/py/executor";
import type { EvalPreludeDefinition } from "../../src/eval/preludes";
import type { EvalStatusEvent, EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import type { ToolSession } from "../../src/tools";
import { createComputerPrelude } from "../../src/tools/computer";
import type { ComputerBackend } from "../../src/tools/computer/backend";
import { ComputerSupervisor } from "../../src/tools/computer/supervisor";
import { EvalTool } from "../../src/tools/eval";

const capabilities: DesktopCapabilities = {
	backend: "fake",
	displayServer: "memory",
	capture: true,
	input: true,
	ax: true,
	backgroundWindowInput: true,
	deliveryModes: ["background", "foreground"],
	capturePermission: "granted",
	inputPermission: "granted",
	axPermission: "granted",
	displayCount: 1,
};

/**
 * Backend whose one reachable operation blocks until the test completes it, so
 * a cancelled run stays busy through `drain()`. The scripts below only reach
 * `apps`, `drain`, `close` and `capabilities`.
 */
class GatedBackend {
	closeCount = 0;
	readonly #started: { resolve: () => void };
	readonly #gate = Promise.withResolvers<void>();
	#pending?: Promise<unknown>;
	readonly capabilities = capabilities;

	constructor(started: { resolve: () => void }) {
		this.#started = started;
	}

	async apps(): Promise<unknown> {
		this.#started.resolve();
		this.#pending = this.#gate.promise.then(() => []);
		return this.#pending;
	}
	async drain(): Promise<void> {
		await this.#pending;
	}
	async close(): Promise<void> {
		this.closeCount++;
	}
	/** Lets the admitted native operation finish. */
	complete(): void {
		this.#gate.resolve();
	}
}

describe("computer turn cancellation", () => {
	it("a JS-defined tool waits for native drain before returning interrupted, then reuses its kernel and backend", async () => {
		const owner = `defined-computer-abort-${crypto.randomUUID()}`;
		const started = Promise.withResolvers<void>();
		const session: ToolSession = {
			cwd: import.meta.dir,
			hasUI: false,
			settings: Settings.isolated({ "computer.enabled": true }),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getEvalKernelOwnerId: () => owner,
			getEvalPreludes: () => [definition],
		};
		const backends: GatedBackend[] = [];
		const definition: EvalPreludeDefinition = createComputerPrelude(
			session,
			currentSession =>
				new ComputerSupervisor(currentSession, async () => {
					const backend = new GatedBackend(started);
					backends.push(backend);
					return backend as unknown as ComputerBackend;
				}),
		);
		const signal = new AbortController();
		try {
			const registered = await executeJs(
				"tool(async ({code}) => computer.run(code), {name:'nativeWork', description:'Native fixture', parameters:{type:'object', properties:{code:{type:'string'}}, required:['code']}})",
				{ sessionId: owner, kernelOwnerId: owner, session },
			);
			expect(registered.exitCode).toBe(0);
			let settled = false;
			const pending = invokeJsTool(
				{ op: "call", name: "nativeWork", args: { code: "await desktop.apps()" } },
				{ sessionKey: owner, ownerId: owner, session, signal: signal.signal },
			).finally(() => {
				settled = true;
			});
			await withTimeout(started.promise, 5_000, "Defined tool did not enter native operation");
			signal.abort();
			// Proving the invocation does NOT settle needs real loop progress across
			// the kernel's IPC/HTTP hops; a fake clock cannot advance them.
			await Bun.sleep(20);
			expect(settled).toBe(false);
			expect(backends[0].closeCount).toBe(0);
			backends[0].complete();
			const stopped = await pending;
			expect(stopped.ok).toBe(false);
			expect(backends[0].closeCount).toBe(0);
			const resumed = await invokeJsTool(
				{ op: "call", name: "nativeWork", args: { code: "return 42" } },
				{ sessionKey: owner, ownerId: owner, session },
			);
			expect(resumed).toMatchObject({ ok: true, value: 42 });
			expect(backends).toHaveLength(1);
			expect(backends[0].closeCount).toBe(0);
			expect(session.settings.get("computer.enabled")).toBe(true);
			await definition.invoke({ action: "release" }, { session, toolCallId: "release" });
			expect(backends[0].closeCount).toBe(1);
		} finally {
			signal.abort();
			for (const backend of backends) backend.complete();
			await definition.invoke({ action: "close" }, { session, toolCallId: "cleanup" }).catch(() => undefined);
			await disposeVmContextsByOwner(owner);
		}
	}, 20_000);

	for (const language of ["js", "py"] as const) {
		it(`${language} withholds final Eval cancellation through native drain, then reuses its backend`, async () => {
			const owner = `computer-abort-${language}-${crypto.randomUUID()}`;
			const started = Promise.withResolvers<void>();
			const stopping = Promise.withResolvers<void>();
			const session: ToolSession = {
				cwd: import.meta.dir,
				hasUI: false,
				settings: Settings.isolated({ "computer.enabled": true }),
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				getEvalSessionId: () => owner,
				getEvalKernelOwnerId: () => owner,
				getEvalPreludes: () => [definition],
			};
			const backends: GatedBackend[] = [];
			let completed = false;
			const definition: EvalPreludeDefinition = createComputerPrelude(
				session,
				currentSession =>
					new ComputerSupervisor(currentSession, async () => {
						const backend = new GatedBackend(started);
						backends.push(backend);
						return backend as unknown as ComputerBackend;
					}),
			);
			const tool = new EvalTool(session);
			const controller = new AbortController();
			const phases: string[] = [];
			let settled = false;
			const execution = tool
				.execute(
					owner,
					{ language, code: "await computer.run('await desktop.apps()')" },
					controller.signal,
					update => {
						const details: EvalToolDetails | undefined = update.details;
						const events = details?.cells?.flatMap(cell => cell.statusEvents ?? []) ?? [];
						for (const event of events) {
							if (event.op !== "control" || typeof event.phase !== "string") continue;
							phases.push(event.phase);
							if (event.phase === "stopping") stopping.resolve();
							if (event.phase === "stopped") expect(completed).toBe(true);
						}
					},
				)
				.finally(() => {
					settled = true;
				});
			try {
				await withTimeout(started.promise, 5_000, "Native operation did not start");
				controller.abort();
				await withTimeout(stopping.promise, 2_000, "No stopping status");
				// Same negative assertion: only real loop progress can show the result
				// is still withheld while the native operation is gated.
				await Bun.sleep(20);
				expect(settled).toBe(false);
				expect(phases).not.toContain("stopped");
				completed = true;
				backends[0].complete();
				const result = await execution;
				const finalEvents: EvalStatusEvent[] = result.details?.statusEvents ?? [];
				expect(finalEvents.filter(event => event.op === "control").at(-1)?.phase).toBe("stopped");
				expect(finalEvents.some(event => event.phase === "released")).toBe(false);
				expect(backends[0].closeCount).toBe(0);
				expect(session.settings.get("computer.enabled")).toBe(true);
				// The cancelled cell's kernel is interrupted asynchronously, so a late
				// SIGINT can still land on it; drop it before the follow-up cell. The
				// computer session under test belongs to the ToolSession, not the kernel.
				await disposeKernelSessionsByOwner(owner);
				const next = await tool.execute(`${owner}-fresh`, { language, code: "await computer.run('return 2')" });
				expect(next.details?.isError).not.toBe(true);
				expect(backends).toHaveLength(1);
				expect(backends[0].closeCount).toBe(0);
				await tool.execute(`${owner}-release`, { language, code: "await computer.release()" });
				expect(backends[0].closeCount).toBe(1);
			} finally {
				controller.abort();
				for (const backend of backends) backend.complete();
				await execution.catch(() => undefined);
				await definition.invoke({ action: "close" }, { session, toolCallId: "cleanup" }).catch(() => undefined);
				await disposeVmContextsByOwner(owner);
				await disposeKernelSessionsByOwner(owner);
			}
		}, 20_000);
	}
});
