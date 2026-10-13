/**
 * Contract: the agent handing back (its run settled for good, an interrupt included) lets go of the session's relay
 * tabs; a step within the run (`turn_end`) and a settle a queued steer continues do not.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as tabSupervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession relay tab release at hand-back", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let release: Mock<typeof tabSupervisor.releaseRelayTabsForOwner>;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-relay-release-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		release?.mockRestore();
		if (session) await session.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** Calls of the release made so far, sampled by the tool while the run is still going. */
	const releasesDuringSteps: number[] = [];
	const probeSchema = type({});
	const probeTool: AgentTool<typeof probeSchema, undefined> = {
		name: "probe",
		label: "Probe",
		description: "Probe",
		parameters: probeSchema,
		async execute() {
			releasesDuringSteps.push(release.mock.calls.length);
			return { content: [{ type: "text", text: "probed" }], details: undefined };
		},
	};

	/** Resolves when the model is first asked for a response. */
	let streaming = Promise.withResolvers<void>();

	function createSession(responses: MockResponse[], settings: Record<string, unknown> = {}): AgentSession {
		streaming = Promise.withResolvers<void>();
		release = spyOn(tabSupervisor, "releaseRelayTabsForOwner").mockResolvedValue(0);
		releasesDuringSteps.length = 0;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [probeTool as AgentTool], messages: [] },
			convertToLlm,
			streamFn: (model, context, options) => {
				streaming.resolve();
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, ...settings }),
			modelRegistry,
			toolRegistry: new Map([[probeTool.name, probeTool as AgentTool]]),
		});
		return session;
	}

	const probe: MockResponse = { content: [{ type: "toolCall", name: "probe", arguments: {} }], stopReason: "toolUse" };

	it("releases once when the run hands back, not at each model step", async () => {
		const target = createSession([probe, probe, { content: ["done"] }]);
		await target.prompt("go");
		expect(releasesDuringSteps).toEqual([0, 0]);
		expect(release.mock.calls).toEqual([[target.sessionManager.getSessionId()]]);
	});

	it("keeps the tabs through a steer that continues the run, and releases when it hands back", async () => {
		const target = createSession([{ content: ["first"] }, probe, { content: ["after the steer"] }]);
		let steered = false;
		target.agent.setOnBeforeYield(async () => {
			if (steered) return;
			steered = true;
			await target.promptCustomMessage(
				{ customType: "steer-test", content: "one more thing", display: true, attribution: "user" },
				{ streamingBehavior: "steer" },
			);
		});
		await target.prompt("go");
		expect(steered).toBe(true);
		expect(releasesDuringSteps).toEqual([0]);
		expect(release.mock.calls).toHaveLength(1);
	});

	it("releases when the user interrupts the run", async () => {
		const target = createSession([{ content: ["slow"], delayMs: 5_000 }]);
		const running = target.prompt("go").catch(() => undefined);
		await streaming.promise;
		await target.abort();
		await running;
		expect(release.mock.calls).toEqual([[target.sessionManager.getSessionId()]]);
	});

	it("releases when a run started outside prompt() hands back", async () => {
		// No admitted prompt: the session publishes the run's end at once instead of deferring it to the prompt's unwind.
		const target = createSession([probe, { content: ["done"] }]);
		const ended = Promise.withResolvers<void>();
		target.subscribe(event => {
			if (event.type === "agent_end") ended.resolve();
		});
		await target.agent.prompt("direct");
		await ended.promise;
		expect(releasesDuringSteps).toEqual([0]);
		expect(release.mock.calls).toEqual([[target.sessionManager.getSessionId()]]);
	});

	it("keeps the tabs attached at hand-back when browser.relayReleaseOnTurnEnd is off", async () => {
		const target = createSession([probe, { content: ["done"] }], { "browser.relayReleaseOnTurnEnd": false });
		await target.prompt("go");
		expect(release.mock.calls).toEqual([]);
	});
});
