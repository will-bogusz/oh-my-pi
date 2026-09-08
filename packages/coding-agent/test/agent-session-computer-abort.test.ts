import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { registerComputerController } from "../src/tools/computer/supervisor";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession computer interruption cleanup", () => {
	for (const fail of [false, true]) {
		it(`waits for actor-owned idle resources and ${fail ? "surfaces failed exit" : "preserves enabled state"}`, async () => {
			const auth = createInMemoryAuthStorage();
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model");
			const settings = Settings.isolated({ "computer.enabled": true });
			const session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: [], tools: [] } }),
				sessionManager: SessionManager.inMemory(import.meta.dir),
				settings,
				modelRegistry: new ModelRegistry(auth),
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let otherReleased = false;
			const unregister = registerComputerController(session.getEvalKernelOwnerId(), {
				release: async () => {
					entered.resolve();
					await release.promise;
				},
				close: async () => {},
			});
			const unregisterOther = registerComputerController(`other-${crypto.randomUUID()}`, {
				release: async () => {
					otherReleased = true;
				},
				close: async () => {},
			});
			let settled = false;
			const aborting = session.abort().then(
				() => {
					settled = true;
				},
				error => {
					settled = true;
					return error as Error;
				},
			);
			try {
				await entered.promise;
				await Bun.sleep(10);
				expect(settled).toBe(false);
				expect(otherReleased).toBe(false);
				if (fail) release.reject(new Error("Native exit not confirmed"));
				else release.resolve();
				const outcome = await aborting;
				if (fail) expect(outcome).toBeInstanceOf(AggregateError);
				else expect(outcome).toBeUndefined();
				expect(settings.get("computer.enabled")).toBe(true);
				expect(otherReleased).toBe(false);
			} finally {
				release.resolve();
				unregister();
				unregisterOther();
				await session.dispose();
				auth.close();
			}
		});
	}
});

it("computer off stops the agent before a failed computer call can lead to another control route", async () => {
	const auth = createInMemoryAuthStorage();
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let fallbackEffects = 0;
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", name: "native_work", arguments: {} }] },
			{ content: [{ type: "toolCall", name: "fallback", arguments: {} }] },
			{ content: ["Finished through another route"] },
		],
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: [],
			tools: [
				{
					name: "native_work",
					label: "Native work",
					description: "Fixture operation",
					parameters: type({}),
					async execute() {
						entered.resolve();
						await release.promise;
						throw new Error("Computer is disabled");
					},
				},
				{
					name: "fallback",
					label: "Alternate route",
					description: "Fixture fallback",
					parameters: type({}),
					async execute() {
						fallbackEffects++;
						return { content: [{ type: "text", text: "Saved" }], details: {} };
					},
				},
			],
		},
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(import.meta.dir),
		settings: Settings.isolated({ "computer.enabled": true, "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
	});
	const unregister = registerComputerController(session.getEvalKernelOwnerId(), {
		async release() {
			release.resolve();
		},
		async close() {},
	});
	try {
		const running = agent.prompt("Run the analysis and save its result");
		await entered.promise;
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, [
			"/computer off",
			{ session, output: async () => {} },
		]);
		await running;
		expect(session.settings.get("computer.enabled")).toBe(false);
		expect(agent.state.isStreaming).toBe(false);
		expect(fallbackEffects).toBe(0);
		// The agent loop may drain an already-aborted provider stream, but must
		// never resume a live continuation or execute its alternate-route tool.
		for (const call of mock.calls.slice(1)) expect(call.options?.signal?.aborted).toBe(true);
	} finally {
		release.resolve();
		unregister();
		await session.dispose();
		auth.close();
	}
});
