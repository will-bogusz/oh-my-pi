import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const result = (state: string) => ({
	content: [{ type: "text" as const, text: state }],
	details: { async: { state, jobId: "job-eval", type: "eval" } },
});

describe("AgentSession background tool display sink", () => {
	const sessions: AgentSession[] = [];
	const storage: AuthStorage[] = [];
	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const auth of storage.splice(0)) auth.close();
	});

	async function fixture(options: { settleBeforeReturn?: boolean; inline?: boolean } = {}) {
		let update: AgentToolUpdateCallback<unknown> = () => {
			throw new Error("tool has not executed");
		};
		const tool: AgentTool = {
			name: "display_probe",
			label: "Display probe",
			description: "Test display lifecycle",
			parameters: type({}),
			async execute(id, args) {
				update = session.createBackgroundToolUpdateSink(id, "display_probe", args);
				if (options.settleBeforeReturn) update(result("completed"));
				return result(options.inline ? "completed" : "running");
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call-eval", name: tool.name, arguments: {} }] },
				{ content: ["The call returned."] },
			],
		});
		const agent = new Agent({
			initialState: {
				model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
				tools: [tool],
				systemPrompt: ["Test"],
			},
			getApiKey: () => "test-key",
			convertToLlm,
			streamFn: mock.stream,
		});
		const auth = await AuthStorage.create(":memory:");
		storage.push(auth);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(auth),
		});
		sessions.push(session);
		const events: AgentSessionEvent[] = [];
		const ended = Promise.withResolvers<void>();
		session.subscribe(event => {
			events.push(event);
			if (event.type === "agent_end") ended.resolve();
		});
		await agent.prompt("Run the display probe.");
		await ended.promise;
		await session.settleInFlightMessagePersistence();
		return { session, events, mock, update: (state: string) => update(result(state)) };
	}

	it("updates the original card after agent_end without creating messages or model calls", async () => {
		const { session, events, mock, update } = await fixture();
		expect(events.some(event => event.type === "agent_end")).toBe(true);
		const messages = session.messages.length;
		const calls = mock.calls.length;
		const delivered = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "tool_execution_update") delivered.resolve();
		});
		update("completed");
		await delivered.promise;
		expect(events.at(-1)).toMatchObject({
			type: "tool_execution_update",
			toolCallId: "call-eval",
			args: {},
			partialResult: result("completed"),
		});
		expect(session.activeToolExecutionUpdates()).toHaveLength(1);
		expect(session.messages).toHaveLength(messages);
		expect(mock.calls).toHaveLength(calls);
		update("running");
		expect(session.activeToolExecutionUpdates()[0]?.partialResult).toEqual(result("completed"));
	});

	it("queues an early terminal snapshot behind the initial tool end", async () => {
		const { events, session } = await fixture({ settleBeforeReturn: true });
		const end = events.findIndex(event => event.type === "tool_execution_end");
		const terminal = events.findIndex(event => event.type === "tool_execution_update");
		expect(end).toBeGreaterThanOrEqual(0);
		expect(terminal).toBeGreaterThan(end);
		expect(session.activeToolExecutionUpdates()[0]?.partialResult).toEqual(result("completed"));
	});

	it("discards display continuations for inline results", async () => {
		const { events, session, update } = await fixture({ inline: true, settleBeforeReturn: true });
		update("failed");
		expect(events.filter(event => event.type === "tool_execution_update")).toEqual([]);
		expect(session.activeToolExecutionUpdates()).toEqual([]);
	});

	it("invalidates old sinks when the logical session changes", async () => {
		const { session, update } = await fixture();
		await session.sessionManager.newSession();
		update("completed");
		expect(session.activeToolExecutionUpdates()).toEqual([]);
	});

	it("invalidates sinks as soon as disposal begins", async () => {
		const { session, update } = await fixture();
		session.beginDispose();
		update("completed");
		expect(session.activeToolExecutionUpdates()).toEqual([]);
	});
});
