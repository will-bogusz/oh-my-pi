import { describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEvalTimeoutControlEvent } from "../../src/eval/bridge-timeout";
import { Settings } from "../../src/config/settings";
import { disposeVmContextsByOwner } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import type { EvalPreludeDefinition } from "../../src/eval/preludes";
import { disposeKernelSessionsByOwner, executePython } from "../../src/eval/py/executor";
import type { EvalStatusEvent } from "@oh-my-pi/pi-tui/tools/eval";
import type { ToolSession } from "../../src/tools";
import { ToolAbortError } from "../../src/tools/tool-errors";

function sessionWith(invoke: EvalPreludeDefinition["invoke"]): ToolSession {
	const definition: EvalPreludeDefinition = {
		name: "computer",
		documentation: "",
		javascript: "",
		python: "",
		exports: [],
		invoke,
	};
	return {
		cwd: import.meta.dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getEvalPreludes: () => [definition],
	};
}

describe("typed control interruption", () => {
	it("waits for the operation's typed stop, without claiming resource release or hiding a completion failure", async () => {
		for (const failure of [new ToolAbortError("Computer operation stopped"), new Error("Input completion lost")]) {
			const entered = Promise.withResolvers<void>();
			const operation = Promise.withResolvers<AgentToolResult>();
			const events: EvalStatusEvent[] = [];
			const controller = new AbortController();
			const call = callSessionTool(
				"__prelude__",
				{ name: "computer", parameters: { action: "run" } },
				{
					session: sessionWith(async () => {
						entered.resolve();
						return operation.promise;
					}),
					signal: controller.signal,
					emitStatus: event => {
						if (!isEvalTimeoutControlEvent(event)) events.push(event);
					},
				},
			).catch(error => error as Error);
			await entered.promise;
			controller.abort();
			expect(events.map(event => event.phase)).toEqual(["running", "stopping"]);
			operation.reject(failure);
			expect(await call).toBe(failure);
			expect(events.at(-1)?.phase).toBe(failure instanceof ToolAbortError ? "stopped" : "failed");
			expect(events.some(event => event.phase === "released")).toBe(false);
			expect(new Set(events.map(event => event.id)).size).toBe(1);
		}
	});

	for (const language of ["js", "python"] as const) {
		it(`${language} transports a host stop as concise cancellation, preserves real failures, and leaves the kernel reusable`, async () => {
			const owner = `control-interruption-${language}-${crypto.randomUUID()}`;
			let shouldStop = true;
			const session = sessionWith(async () => {
				if (shouldStop) throw new ToolAbortError("Computer operation stopped");
				throw new Error("Input completion lost");
			});
			const events: EvalStatusEvent[] = [];
			const execute = (code: string) =>
				language === "js"
					? executeJs(code, {
							sessionId: owner,
							kernelOwnerId: owner,
							session,
							onStatus: event => events.push(event),
						})
					: executePython(code, {
							cwd: import.meta.dir,
							sessionId: owner,
							kernelOwnerId: owner,
							toolSession: session,
							onStatus: event => events.push(event),
						});
			const code =
				language === "js"
					? "await __omp_prelude__('computer', {action:'run'})"
					: "await _omp_prelude('computer', {'action':'run'})";
			try {
				const stopped = await execute(code);
				expect(stopped.cancelled).toBe(true);
				expect(stopped.exitCode).toBeUndefined();
				expect(stopped.output).toMatch(/stopped|interrupted/i);
				expect(stopped.output).not.toMatch(/Traceback|\bat .+\.(?:ts|js):/);
				expect(events.filter(event => event.op === "control").map(event => event.phase)).toEqual([
					"running",
					"stopped",
				]);
				shouldStop = false;
				events.length = 0;
				const failed = await execute(code);
				expect(failed.cancelled).toBe(false);
				expect(failed.exitCode).toBe(1);
				expect(failed.output).toContain("Input completion lost");
				expect(failed.output).toMatch(/Traceback|\bat /);
				expect(events.filter(event => event.op === "control").at(-1)?.phase).toBe("failed");
				const recovered = await execute(
					language === "js" ? "console.log('still usable')" : "print('still usable')",
				);
				expect(recovered.exitCode).toBe(0);
				expect(recovered.output).toContain("still usable");
			} finally {
				await disposeVmContextsByOwner(owner);
				await disposeKernelSessionsByOwner(owner);
			}
		}, 20_000);
	}
});
