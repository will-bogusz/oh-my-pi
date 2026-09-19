import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEvalTimeoutControlEvent } from "../../src/eval/bridge-timeout";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalBackends from "@oh-my-pi/pi-coding-agent/eval";
import type { ExecutorBackendResult } from "@oh-my-pi/pi-coding-agent/eval/backend";
import { JsRuntime } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { JsDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/js/shared/types";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { renderKernelDisplay } from "@oh-my-pi/pi-coding-agent/eval/py/display";
import { PYTHON_PRELUDE } from "@oh-my-pi/pi-coding-agent/eval/py/prelude";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import type { ControlImageReference, EvalStatusEvent, EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import type { EvalDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { $which } from "@oh-my-pi/pi-utils";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const image = () => ({ type: "image" as const, mimeType: "image/png", data: PNG });

function sessionWith(name: string, invoke: EvalPreludeDefinition["invoke"]): ToolSession {
	const definition: EvalPreludeDefinition = {
		name,
		documentation: "",
		javascript: "",
		python: "",
		exports: [],
		invoke,
	};
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getEvalPreludes: () => [definition],
	};
}

function browserResult(): AgentToolResult {
	return {
		content: [{ type: "text", text: "captured" }, image(), image(), image()],
		details: {
			name: "Research tab",
			screenshots: [
				{ dest: "/tmp/silent.png" },
				{ imageIndex: 1, dest: "/tmp/actual-screenshot.png" },
				{ imageIndex: 99, dest: "/tmp/out-of-range.png" },
			],
		},
	};
}

describe("control activity and exact image provenance", () => {
	afterEach(() => vi.restoreAllMocks());

	it("keeps release stopping until the admitted host cleanup resolves, with one event identity and no generic duplicate", async () => {
		const gate = Promise.withResolvers<AgentToolResult>();
		const entered = Promise.withResolvers<void>();
		const session = sessionWith("computer", async () => {
			entered.resolve();
			return gate.promise;
		});
		const events: EvalStatusEvent[] = [];
		const call = callSessionTool(
			"__prelude__",
			{ name: "computer", parameters: { action: "release" } },
			{
				session,
				emitStatus: event => {
					if (!isEvalTimeoutControlEvent(event)) events.push(event);
				},
			},
		);
		await entered.promise;
		expect(events.map(event => event.phase)).toEqual(["running", "stopping"]);
		gate.resolve({ content: [{ type: "text", text: "released" }], details: {} });
		await call;
		expect(events.map(event => event.phase)).toEqual(["running", "stopping", "released"]);
		expect(new Set(events.map(event => event.id)).size).toBe(1);
		expect(events.every(event => event.op === "control" && event.kind === "computer")).toBe(true);
	});

	it("abort and failure never claim released and activity never carries typed input or run source", async () => {
		const gate = Promise.withResolvers<AgentToolResult>();
		const entered = Promise.withResolvers<void>();
		const signal = new AbortController();
		const events: EvalStatusEvent[] = [];
		const session = sessionWith("computer", async () => {
			entered.resolve();
			return gate.promise;
		});
		const call = callSessionTool(
			"__prelude__",
			{ name: "computer", parameters: { action: "close" } },
			{
				session,
				signal: signal.signal,
				emitStatus: event => {
					if (!isEvalTimeoutControlEvent(event)) events.push(event);
				},
			},
		);
		await entered.promise;
		signal.abort();
		expect(events.at(-1)?.phase).toBe("stopping");
		gate.resolve({ content: [], details: {} });
		await call;
		expect(events.at(-1)?.phase).toBe("failed");
		expect(events.some(event => event.phase === "released")).toBe(false);
		const failing = sessionWith("computer", async () => {
			throw new Error("private-input-from-failure");
		});
		await expect(
			callSessionTool(
				"__prelude__",
				{
					name: "computer",
					parameters: {
						action: "call",
						chain: [
							{ method: "window", args: [{ id: "42", pid: 123 }] },
							{ method: "type", args: ["secret-typed-value"] },
						],
						code: "secret-run-source",
					},
				},
				{
					session: failing,
					emitStatus: event => {
						if (!isEvalTimeoutControlEvent(event)) events.push(event);
					},
				},
			),
		).rejects.toThrow("private-input-from-failure");
		expect(events.at(-1)).toMatchObject({
			op: "control",
			action: "type",
			target: "window 42 (PID 123)",
			phase: "failed",
		});
		const serialized = JSON.stringify(events);
		for (const secret of ["secret-typed-value", "secret-run-source", "private-input-from-failure"])
			expect(serialized).not.toContain(secret);
	});

	it("does not attribute unrelated registered preludes or ambiguous screenshot ordinals", async () => {
		const other = await callSessionTool(
			"__prelude__",
			{ name: "other", parameters: { action: "run" } },
			{
				session: sessionWith("other", async () => browserResult()),
			},
		);
		expect(other).toMatchObject({ images: [imageWithoutType(), imageWithoutType(), imageWithoutType()] });
		if (typeof other !== "object" || !("images" in other)) throw new Error("Expected image response");
		expect(other.images).toEqual([imageWithoutType(), imageWithoutType(), imageWithoutType()]);
		const events: EvalStatusEvent[] = [];
		const duplicate = await callSessionTool(
			"__prelude__",
			{ name: "browser", parameters: { action: "run" } },
			{
				session: sessionWith("browser", async () => ({
					content: [image()],
					details: {
						screenshots: [0, 1, 2].map(index => ({ imageIndex: 0, dest: `/tmp/ambiguous-${index}.png` })),
					},
				})),
				emitStatus: event => {
					if (!isEvalTimeoutControlEvent(event)) events.push(event);
				},
			},
		);
		expect(duplicate).toMatchObject({ images: [imageWithoutType()] });
		if (typeof duplicate !== "object" || !("images" in duplicate)) throw new Error("Expected image response");
		expect(duplicate.images?.[0]).not.toHaveProperty("control");
	});

	it("carries only the exact host screenshot through JS, mixed outputs and Eval resizing/partial/final aggregation", async () => {
		const session = sessionWith("browser", async () => browserResult());
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: crypto.randomUUID() });
		const outputs: JsDisplayOutput[] = [];
		try {
			await runtime.run(
				`display(${JSON.stringify(image())}); await __omp_prelude__('browser', {action:'run'}); display(${JSON.stringify(image())})`,
				undefined,
				{
					onText: () => {},
					onDisplay: output => outputs.push(output),
					callTool: (name, args) => callSessionTool(name, args, { session }),
				},
			);
		} finally {
			runtime.dispose();
		}
		const imageOutputs = outputs.filter(output => output.type === "image");
		expect(imageOutputs.map(output => output.control)).toEqual([
			undefined,
			undefined,
			{ kind: "browser", label: "Research tab", path: "/tmp/actual-screenshot.png" },
			undefined,
			undefined,
		]);
		const big = await new Bun.Image(Buffer.from(PNG, "base64")).resize(2400, 1200).png().bytes();
		imageOutputs[2].data = Buffer.from(big).toString("base64");
		const backendResult: ExecutorBackendResult = {
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			artifactId: undefined,
			totalLines: 0,
			totalBytes: 0,
			outputLines: 0,
			outputBytes: 0,
			displayOutputs: outputs,
		};
		vi.spyOn(evalBackends.jsBackend, "execute").mockResolvedValue(backendResult);
		vi.spyOn(evalBackends.jsBackend, "isAvailable").mockResolvedValue(true);
		const updates: EvalToolDetails[] = [];
		const tool = new EvalTool(session);
		const result = await tool.execute(
			"mixed-control-images",
			{ language: "js", code: "irrelevant mocked execution" },
			undefined,
			update => {
				if (update.details) updates.push(update.details);
			},
		);
		const expected: ControlImageReference[] = [
			{ index: 2, kind: "browser", label: "Research tab", path: "/tmp/actual-screenshot.png" },
		];
		expect(result.details?.controlImages).toEqual(expected);
		expect(updates.find(update => update.images?.length === 5)?.controlImages).toEqual(expected);
		const finalImages = result.content.filter(content => content.type === "image");
		expect(finalImages).toHaveLength(5);
		expect(finalImages[2].data).not.toBe(imageOutputs[2].data);
		// The renderer's list carries every displayed image; nothing was superseded here.
		expect(result.details?.images).toHaveLength(5);
	});

	it("preserves computer screenshot provenance through the real Python HTTP/prelude/MIME display route", async () => {
		const sessionId = crypto.randomUUID();
		const runId = crypto.randomUUID();
		const session = sessionWith("computer", async () => ({
			content: [image(), image()],
			details: {
				screenshots: [
					{ path: "/tmp/hidden.png", target: "window 10" },
					{ imageIndex: 0, path: "/tmp/native-legacy.png", target: "window 10" },
					{ imageIndex: 1, path: "/tmp/native-exact.png", target: "window 42", label: "Notes: Report" },
				],
			},
		}));
		const info = await ensurePyToolBridge();
		const unregister = registerPyToolBridge(sessionId, runId, { toolSession: session });
		const setup =
			"from __future__ import annotations\n_captured = []\ndef __omp_display(value, raw=False): _captured.append(value)";
		const source = PYTHON_PRELUDE.replace("from __future__ import annotations", setup);
		try {
			const script = `${source}\n__omp_run_id__ = ${JSON.stringify(runId)}\n_omp_display({'image/png': ${JSON.stringify(PNG)}}, raw=True)\nasyncio.run(_omp_prelude('computer', {'action':'run'}))\nprint(json.dumps(_captured))\n`;
			const child = Bun.spawn([$which("python3") ?? "python", "-c", script], {
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					PI_TOOL_BRIDGE_URL: info.url,
					PI_TOOL_BRIDGE_TOKEN: info.token,
					PI_TOOL_BRIDGE_SESSION: sessionId,
				},
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(stderr).toBe("");
			expect(code).toBe(0);
			const bundles = JSON.parse(stdout) as Record<string, unknown>[];
			const displays: EvalDisplayOutput[] = [];
			for (const bundle of bundles) displays.push(...(await renderKernelDisplay(bundle)).outputs);
			expect(displays.filter(output => output.type === "image").map(output => output.control)).toEqual([
				undefined,
				{ kind: "computer", label: "window 10", path: "/tmp/native-legacy.png" },
				{ kind: "computer", label: "Notes: Report", path: "/tmp/native-exact.png" },
			]);
		} finally {
			unregister();
			await disposePyToolBridge();
		}
	});
});

function imageWithoutType() {
	return { mimeType: "image/png", data: PNG };
}
