/**
 * Preview policy for browser/computer observation stills:
 *  - per tool result, the model-facing content carries one still per control
 *    target (the last displayed) while `details.images` keeps every image for
 *    the renderer;
 *  - at terminal settle, stills superseded by a later result for the same
 *    target leave the model transcript, the renderer's copies untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalBackends from "@oh-my-pi/pi-coding-agent/eval";
import type { ExecutorBackendResult } from "@oh-my-pi/pi-coding-agent/eval/backend";
import type { ControlImageReference } from "@oh-my-pi/pi-tui/tools/eval";
import type { EvalDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as path from "node:path";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const still = (data: string): ImageContent => ({ type: "image", mimeType: "image/png", data });
const imageData = (message: { content: unknown }): string[] =>
	Array.isArray(message.content)
		? message.content.filter((part): part is ImageContent => part.type === "image").map(part => part.data)
		: [];

describe("per-result preview policy", () => {
	afterEach(() => vi.restoreAllMocks());

	it("keeps the last still per control target in content and every image in details", async () => {
		const outputs: EvalDisplayOutput[] = [
			{ type: "image", mimeType: "image/png", data: PNG, control: { kind: "browser", label: "Research tab" } },
			{ type: "image", mimeType: "image/png", data: PNG },
			{ type: "image", mimeType: "image/png", data: PNG, control: { kind: "computer", label: "TextEdit" } },
			{ type: "image", mimeType: "image/png", data: PNG, control: { kind: "browser", label: "Research tab" } },
		];
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
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
		};
		const result = await new EvalTool(session).execute("preview-policy", { language: "js", code: "mocked" });

		// Model sees: the plain display image, the TextEdit still, the LAST Research tab still.
		expect(result.content.filter(part => part.type === "image")).toHaveLength(3);
		expect(result.details?.images).toHaveLength(4);
		const expected: ControlImageReference[] = [
			{ index: 0, kind: "browser", label: "Research tab" },
			{ index: 2, kind: "computer", label: "TextEdit" },
			{ index: 3, kind: "browser", label: "Research tab" },
		];
		expect(result.details?.controlImages).toEqual(expected);
	});
});

describe("turn-end preview disposal", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-preview-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		await tempDir.remove().catch(() => {});
	});

	/** One eval turn step: assistant tool call + tool result carrying one control still per listed target. */
	function seedObservation(id: string, targets: { kind: "browser" | "computer"; label: string }[]): void {
		const stills = targets.map((target, index) => still(`${id}-${target.label}-${index}`));
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "eval", arguments: { language: "js", code: "observe" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "eval",
			content: [{ type: "text", text: "observed" }, ...stills],
			details: {
				images: stills,
				controlImages: targets.map((target, index) => ({ index, ...target })),
			},
			isError: false,
			timestamp: Date.now(),
		});
	}

	function toolResults(): ToolResultMessage[] {
		return sessionManager
			.getBranch()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
	}

	it("leaves one still per target in the model-facing history after the session settles", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "look" }], timestamp: Date.now() });
		seedObservation("call_1", [{ kind: "browser", label: "Research tab" }]);
		seedObservation("call_2", [{ kind: "computer", label: "TextEdit" }]);
		seedObservation("call_3", [{ kind: "browser", label: "Research tab" }]);
		// The sweep is detached from the terminal agent_end; it lands when the
		// stripped branch is persisted, so await that rewrite.
		const persisted = Promise.withResolvers<void>();
		const rewriteEntries = sessionManager.rewriteEntries.bind(sessionManager);
		vi.spyOn(sessionManager, "rewriteEntries").mockImplementation(async () => {
			await rewriteEntries();
			if (imageData(toolResults()[0]).length === 0) persisted.resolve();
		});
		await session.prompt("and now?");
		await persisted.promise;

		const [first, second, third] = toolResults();
		expect(imageData(first)).toEqual([]);
		expect(imageData(second)).toEqual(["call_2-TextEdit-0"]);
		expect(imageData(third)).toEqual(["call_3-Research tab-0"]);
		// The renderer's copies survive.
		for (const message of [first, second, third]) {
			expect((message.details as { images: ImageContent[] }).images).toHaveLength(1);
		}
		// What the model would be sent on the next turn matches the persisted branch.
		const llm = convertToLlm(
			sessionManager.getBranch().flatMap(entry => (entry.type === "message" ? [entry.message as AgentMessage] : [])),
		);
		const llmImages = llm.filter(message => message.role === "toolResult").map(message => imageData(message));
		expect(llmImages).toEqual([[], ["call_2-TextEdit-0"], ["call_3-Research tab-0"]]);
	});

	it("does not rewrite a branch whose stills are all current", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		seedObservation("call_1", [{ kind: "browser", label: "Research tab" }]);
		seedObservation("call_2", [{ kind: "computer", label: "TextEdit" }]);
		const rewrite = vi.spyOn(sessionManager, "rewriteEntries");

		expect(await session.disposeControlPreviews()).toEqual({ removed: 0 });
		expect(rewrite).not.toHaveBeenCalled();
		expect(toolResults().map(message => imageData(message).length)).toEqual([1, 1]);
	});
});
