import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { attachIrcWakeTurnMonitor } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { createSessionDefaults } from "../helpers/session-defaults";

function toolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

const wakeAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

describe("IRC wake turn yield reset", () => {
	it("re-arms the empty-last-turn guard at the start of an autonomous wake turn", async () => {
		// The same kept-alive session tool that runSubagentFollowUpTurn reuses is
		// also driven by autonomous IRC wake turns through this observer. A prior
		// run that emitted an incremental section leaves #hasIncrementalSections
		// set; without a per-wake reset a later thinking-only {type:"result"}
		// would skip the guard and finalize with the null-yield warning.
		const yieldTool = new YieldTool(toolSession({ getLastAssistantText: () => undefined }));
		let observer: ((records: unknown[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
		const session = {
			...createSessionDefaults(),
			getToolByName: (name: string) => (name === "yield" ? yieldTool : undefined),
			subscribe: () => () => {},
			setIrcWakeTurnObserver: (obs: typeof observer) => {
				observer = obs;
			},
			trackIrcReply: () => {},
		} as unknown as AgentSession;

		attachIrcWakeTurnMonitor(session, { id: "wake-1", agent: wakeAgent });
		if (!observer) throw new Error("wake-turn observer was not registered");

		// A prior run's incremental section sets the flag on the reused tool.
		await yieldTool.execute("prior-section", { type: ["findings"], data: "one finding" } as never);

		// Starting the wake turn must clear it.
		observer([{ role: "user", content: "wake up" }]);

		await expect(yieldTool.execute("wake-empty", { type: "result" } as never)).rejects.toThrow(
			/no text \(thinking only\)/,
		);
	});
});

describe("IRC wake turn relay", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it.each([false, true])(
		"relays the final report turn, not the turn's narration (structured: %s)",
		async structured => {
			const listeners: Array<(event: AgentSessionEvent) => void> = [];
			const messages: AssistantMessage[] = [];
			let observer:
				| ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
				| undefined;
			const session = {
				...createSessionDefaults(),
				state: { messages },
				subscribe: (listener: (event: AgentSessionEvent) => void) => {
					listeners.push(listener);
					return () => listeners.splice(listeners.indexOf(listener), 1);
				},
				getLastAssistantMessage: () => messages[messages.length - 1],
				setIrcWakeTurnObserver: (obs: typeof observer) => {
					observer = obs;
				},
				trackIrcReply: () => {},
			} as unknown as AgentSession;
			const emit = (event: AgentSessionEvent) => {
				for (const listener of [...listeners]) listener(event);
			};
			const registry = AgentRegistry.global();
			registry.register({ id: "Peer", displayName: "Peer", kind: "main", session, status: "running" });
			registry.register({ id: "wake-2", displayName: "wake-2", kind: "sub", session, status: "idle" });

			attachIrcWakeTurnMonitor(session, { id: "wake-2", agent: wakeAgent, structured });
			if (!observer) throw new Error("wake-turn observer was not registered");
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "what did you find?",
					display: false,
					details: { id: "msg-ask", from: "Peer", message: "what did you find?" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			const relayed = IrcBus.global().wait("Peer", { from: "wake-2" }, 1000);

			// Narration ahead of a tool call, then the report turn.
			messages.push(
				assistantMessage([
					{ type: "text", text: "Checking." },
					{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
				]),
				assistantMessage([{ type: "text", text: "Answer." }]),
			);
			for (const message of messages) emit({ type: "message_end", message } as AgentSessionEvent);
			emit({ type: "agent_end", messages: [...messages] } as AgentSessionEvent);
			await finish?.(undefined);

			expect((await relayed)?.body).toBe("Answer.");
		},
	);
});
