import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { withTimeout } from "@oh-my-pi/pi-utils/async";
import { Settings } from "../../src/config/settings";
import { disposeVmContextsByOwner, invokeJsTool } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { disposeKernelSessionsByOwner } from "../../src/eval/py/executor";
import type { EvalPreludeDefinition } from "../../src/eval/preludes";
import type { EvalStatusEvent, EvalToolDetails } from "../../src/eval/types";
import type { ToolSession } from "../../src/tools";
import { createComputerPrelude } from "../../src/tools/computer";
import {
	ComputerSupervisor,
	type ComputerWorkerHandle,
	spawnComputerWorker,
} from "../../src/tools/computer/supervisor";
import { EvalTool } from "../../src/tools/eval";

describe("computer turn cancellation", () => {
	it("a JS-defined tool waits for native drain and exit before returning interrupted, then reuses its kernel with a fresh computer", async () => {
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
		const workers: ComputerWorkerHandle[] = [];
		let exits = 0;
		const definition: EvalPreludeDefinition = createComputerPrelude(
			session,
			() =>
				new ComputerSupervisor(
					session,
					() => {
						const worker = spawnComputerWorker({
							cmd: [
								process.execPath,
								path.resolve(import.meta.dir, "../fixtures/computer-subprocess-lifecycle.ts"),
							],
						});
						workers.push(worker);
						worker.onMessage(message => {
							if (message.type === "pong" && message.id === "operation-started") started.resolve();
						});
						return {
							send: message => worker.send(message),
							onMessage: handler => worker.onMessage(handler),
							onError: handler => worker.onError(handler),
							terminate: async () => {
								await worker.terminate();
								exits++;
							},
						};
					},
					{ startMs: 5_000, closeMs: 1_000, graceMs: 1_000 },
				),
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
			await Bun.sleep(20);
			expect(settled).toBe(false);
			expect(exits).toBe(0);
			workers[0].send({ type: "ping", id: "release" });
			const stopped = await pending;
			expect(stopped.ok).toBe(false);
			expect(exits).toBe(1);
			const resumed = await invokeJsTool(
				{ op: "call", name: "nativeWork", args: { code: "return 42" } },
				{ sessionKey: owner, ownerId: owner, session },
			);
			expect(resumed).toMatchObject({ ok: true, value: 42 });
			expect(workers).toHaveLength(2);
			expect(exits).toBe(1);
			expect(session.settings.get("computer.enabled")).toBe(true);
			await definition.invoke({ action: "release" }, { session, toolCallId: "release" });
			expect(exits).toBe(2);
		} finally {
			signal.abort();
			await Promise.allSettled(workers.map(worker => worker.terminate()));
			await definition.invoke({ action: "close" }, { session, toolCallId: "cleanup" }).catch(() => undefined);
			await disposeVmContextsByOwner(owner);
		}
	}, 20_000);

	for (const language of ["js", "py"] as const) {
		it(`${language} withholds final Eval cancellation through native drain and process exit, then reacquires`, async () => {
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
			const workers: ComputerWorkerHandle[] = [];
			const exited: boolean[] = [];
			const definition: EvalPreludeDefinition = createComputerPrelude(
				session,
				() =>
					new ComputerSupervisor(
						session,
						() => {
							const worker = spawnComputerWorker({
								cmd: [
									process.execPath,
									path.resolve(import.meta.dir, "../fixtures/computer-subprocess-lifecycle.ts"),
								],
							});
							const index = workers.length;
							workers.push(worker);
							exited.push(false);
							worker.onMessage(message => {
								if (message.type === "pong" && message.id === "operation-started") started.resolve();
							});
							return {
								send: message => worker.send(message),
								onMessage: handler => worker.onMessage(handler),
								onError: handler => worker.onError(handler),
								terminate: async () => {
									await worker.terminate();
									exited[index] = true;
								},
							};
						},
						{ startMs: 5_000, closeMs: 1_000, graceMs: 1_000 },
					),
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
							if (event.phase === "stopped") expect(exited[0]).toBe(true);
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
				await Bun.sleep(20);
				expect(settled).toBe(false);
				expect(exited[0]).toBe(false);
				expect(phases).not.toContain("stopped");
				workers[0].send({ type: "ping", id: "release" });
				const result = await execution;
				expect(exited[0]).toBe(true);
				const finalEvents: EvalStatusEvent[] = result.details?.statusEvents ?? [];
				expect(finalEvents.filter(event => event.op === "control").at(-1)?.phase).toBe("stopped");
				expect(finalEvents.some(event => event.phase === "released")).toBe(false);
				expect(session.settings.get("computer.enabled")).toBe(true);
				const next = await tool.execute(`${owner}-fresh`, { language, code: "await computer.run('return 2')" });
				expect(next.details?.isError).not.toBe(true);
				expect(workers).toHaveLength(2);
				expect(exited[1]).toBe(false);
				await tool.execute(`${owner}-release`, { language, code: "await computer.release()" });
				expect(exited[1]).toBe(true);
			} finally {
				controller.abort();
				await Promise.allSettled(workers.map(worker => worker.terminate()));
				await execution.catch(() => undefined);
				await definition.invoke({ action: "close" }, { session, toolCallId: "cleanup" }).catch(() => undefined);
				await disposeVmContextsByOwner(owner);
				await disposeKernelSessionsByOwner(owner);
			}
		}, 20_000);
	}
});
