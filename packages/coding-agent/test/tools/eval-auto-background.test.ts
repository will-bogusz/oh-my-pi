import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import type { ExecutorBackendResult } from "@oh-my-pi/pi-coding-agent/eval/backend";
import type { EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

function makeSession(settings: Settings, asyncJobManager: AsyncJobManager): ToolSession {
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
		asyncJobManager,
	};
}

function baseResult(overrides: Record<string, unknown> = {}) {
	return {
		output: "",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		displayOutputs: [] as unknown[],
		...overrides,
	};
}

/**
 * Mock the JS backend with a cell that streams one chunk immediately and then
 * blocks until the returned `release()` gate opens — so backgrounding is decided
 * by the tool's own threshold/steer race, never by a guessed sleep.
 */
function mockGatedCell(finalOutput: string): { release: () => void } {
	const gate = Promise.withResolvers<void>();
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
		_code: string,
		options: { onChunk?: (chunk: string) => void },
	) => {
		options.onChunk?.("start\n");
		await gate.promise;
		return baseResult({ output: finalOutput });
	}) as never);
	return { release: gate.resolve };
}

function steeringContext(steeringSignal: AbortSignal): AgentToolContext {
	return {
		sessionManager: SessionManager.inMemory(),
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
			getApiKey: async () => undefined,
		} as unknown as AgentToolContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		toolNames: [],
		toolCall: {
			batchId: "batch-1",
			index: 0,
			total: 1,
			toolCalls: [{ id: "call-steer", name: "eval" }],
			steeringSignal,
		},
	} as AgentToolContext;
}

/**
 * Defends the eval auto-background contract (mirror of bash's): a cell that
 * finishes before the threshold resolves inline with no job leftovers, a cell
 * that outlives the threshold converts into a running async job whose result is
 * delivered later, and a steering interrupt backgrounds the cell immediately so
 * the queued message can inject while the kernel keeps working.
 */
describe("EvalTool auto-background", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps fast cells inline and suppresses their job delivery", async () => {
		const deliveries: string[] = [];
		const asyncJobManager = new AsyncJobManager({
			onJobComplete: async (_jobId, text) => {
				deliveries.push(text);
			},
		});
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async () =>
			baseResult({ output: "quick\n" })) as never);

		const tool = new EvalTool(
			makeSession(
				Settings.isolated({
					"eval.autoBackground.enabled": true,
					"eval.autoBackground.thresholdMs": 2_000,
				}),
				asyncJobManager,
			),
		);
		const result = await tool.execute("call-inline", { language: "js", code: "print('quick')" });

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("quick");
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.cells?.[0]?.status).toBe("complete");
		await asyncJobManager.drainDeliveries({ timeoutMs: 1 });
		expect(deliveries).toEqual([]);
		await asyncJobManager.dispose();
	});

	it("backgrounds a cell that outlives the threshold and delivers its result", async () => {
		const deliveries: Array<{ jobId: string; text: string }> = [];
		const updates: string[] = [];
		const asyncJobManager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				deliveries.push({ jobId, text });
			},
		});
		const cell = mockGatedCell("start\ndone\n");

		const tool = new EvalTool(
			makeSession(
				Settings.isolated({
					"eval.autoBackground.enabled": true,
					"eval.autoBackground.thresholdMs": 10,
				}),
				asyncJobManager,
			),
		);
		// The gated cell cannot finish on its own, so execute() returning proves
		// the threshold path backgrounded it.
		const result = await tool.execute(
			"call-background",
			{ language: "js", code: "print('start'); await work(); print('done')" },
			undefined,
			update => {
				updates.push(update.content?.find(block => block.type === "text")?.text ?? "");
			},
		);

		expect(result.details?.async?.state).toBe("running");
		expect(result.details?.async?.type).toBe("eval");
		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("Backgrounded as job");
		// The snapshot keeps the running cell (with its streamed tail) for the transcript.
		expect(result.details?.cells?.[0]?.status).toBe("running");

		const jobId = result.details?.async?.jobId;
		if (!jobId) {
			throw new Error("expected an auto-backgrounded job id");
		}
		const runningJob = asyncJobManager.getJob(jobId);
		expect(runningJob?.status).toBe("running");
		const updatesAtBackground = updates.slice();
		cell.release();
		await runningJob?.promise;
		await asyncJobManager.drainDeliveries({ timeoutMs: 1 });
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.jobId).toBe(jobId);
		expect(deliveries[0]?.text).toContain("done");
		// Tool-call updates stop once the cell is backgrounded.
		expect(updates).toEqual(updatesAtBackground);
		await asyncJobManager.dispose();
	});

	it.each([false, true])(
		"retains control activity and the final snapshot after background settlement (cancelled=%s)",
		async cancelled => {
			const gate = Promise.withResolvers<void>();
			const updates: AgentToolResult<unknown>[] = [];
			const started = Promise.withResolvers<void>();
			const image = {
				type: "image" as const,
				mimeType: "image/png",
				data: (await Bun.file(new URL("../../../ai/test/data/red-circle.png", import.meta.url)).bytes()).toBase64(),
			};
			const control = { kind: "computer" as const, label: "Exact fixture", path: "/tmp/fixture.png" };
			const activity = { op: "control", id: "control-release", kind: "computer", action: "release" };
			vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation(
				async (_code, options): Promise<ExecutorBackendResult> => {
					options.onStatus?.({ ...activity, phase: "stopping" });
					started.resolve();
					await gate.promise;
					const stopped = { ...activity, phase: cancelled ? "stopped" : "released" };
					options.onStatus?.(stopped);
					return {
						output: cancelled ? "Execution cancelled" : "done",
						exitCode: cancelled ? 130 : 0,
						cancelled,
						truncated: false,
						artifactId: undefined,
						totalLines: 1,
						totalBytes: 4,
						outputLines: 1,
						outputBytes: 4,
						displayOutputs: [
							{ ...image, control },
							{ type: "status", event: stopped },
						],
					};
				},
			);
			const manager = new AsyncJobManager({});
			try {
				const session = makeSession(
					Settings.isolated({ "eval.autoBackground.enabled": true, "eval.autoBackground.thresholdMs": 1 }),
					manager,
				);
				session.createBackgroundToolUpdateSink = (id, name, args) => {
					expect(id).toBe("control-cell");
					expect(name).toBe("eval");
					expect(args).toMatchObject({ language: "js" });
					return update => {
						updates.push(update);
					};
				};
				const initial = await new EvalTool(session).execute("control-cell", {
					language: "js",
					code: "await computer.release()",
				});
				expect(initial.details?.async?.state).toBe("running");
				await started.promise;
				expect((updates.at(-1)!.details as EvalToolDetails).cells?.[0]?.statusEvents).toContainEqual({
					...activity,
					phase: "stopping",
				});
				const job = manager.getJob(initial.details!.async!.jobId)!;
				gate.resolve();
				await job.promise;
				const terminal = updates.at(-1)?.details as EvalToolDetails;
				expect(terminal.async?.state).toBe(cancelled ? "failed" : "completed");
				expect(terminal.statusEvents).toContainEqual({ ...activity, phase: cancelled ? "stopped" : "released" });
				expect(terminal.images).toEqual([image]);
				expect(terminal.controlImages).toEqual([{ index: 0, ...control }]);
				expect(job.latestDetails?.images).toEqual([image]);
				expect(updates.at(-1)?.content.every(block => block.type === "text")).toBe(true);
			} finally {
				gate.resolve();
				await manager.dispose();
			}
		},
	);

	it("backgrounds a running cell when the steering signal fires mid-wait", async () => {
		const asyncJobManager = new AsyncJobManager({});
		const cell = mockGatedCell("steered\n");

		const tool = new EvalTool(
			makeSession(
				Settings.isolated({
					"eval.autoBackground.enabled": true,
					// High threshold: only the steering signal can background this.
					"eval.autoBackground.thresholdMs": 60_000,
				}),
				asyncJobManager,
			),
		);
		const steering = new AbortController();
		steering.abort();
		const result = await tool.execute(
			"call-steer",
			{ language: "js", code: "await work()" },
			undefined,
			undefined,
			steeringContext(steering.signal),
		);

		// The steer backgrounds the cell instead of killing it: the call returns a
		// running job and the cell finishes on its own.
		expect(result.details?.async?.state).toBe("running");
		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("Backgrounded early to handle an incoming message");
		const jobId = result.details?.async?.jobId;
		if (!jobId) {
			throw new Error("expected a steer-backgrounded job id");
		}
		const job = asyncJobManager.getJob(jobId);
		expect(job?.status).toBe("running");
		cell.release();
		await job?.promise;
		expect(asyncJobManager.getJob(jobId)?.status).toBe("completed");
		await asyncJobManager.dispose();
	});
});
