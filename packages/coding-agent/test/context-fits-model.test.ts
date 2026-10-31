/**
 * Contract: `SessionMaintenance.contextFitsModel(model)` judges the request
 * `model` itself would receive. Native Responses reasoning replays only to the
 * model that produced it, and only while its session replays native history,
 * so a different retry candidate is not charged the active model's replayed
 * reasoning, in the local floor or in the provider usage that carried it, while
 * the producing model still is. Likewise a candidate without image input is
 * charged a snapcompact archive's text, not the frames the active request
 * carried.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as snapcompact from "@oh-my-pi/snapcompact";

const active = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6.1-sol");
// Same encoding, another model: it gets the turns re-encoded without their reasoning.
const candidate: Model<"openai-codex-responses"> = {
	...getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6-sol"),
	contextWindow: 2_000,
};
const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "e".repeat(16_000) };

function responsesTurn(producer: Model, text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: producer.api,
		provider: producer.provider,
		model: producer.id,
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: producer.provider,
			dt: true,
			items: [reasoningItem, { type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
		},
		usage: {
			input: 0,
			output: 6_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 6_000,
			reasoningTokens: 5_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

const codexTurn = (text: string, timestamp: number) => responsesTurn(active, text, timestamp);

/**
 * Maintenance over `messages`. Without `usageTokens` there is no provider usage,
 * so the local floor decides (rebuilt history); with it, provider usage anchored
 * to the active model's last request competes, as on the live retry path.
 */
function maintenance(
	messages: AgentMessage[],
	options: { usageTokens?: number; providerSessionState?: Map<string, ProviderSessionState> } = {},
): SessionMaintenance {
	const agent = new Agent({ initialState: { model: active, systemPrompt: [], tools: [], messages } });
	const host = {
		agent,
		settings: Settings.isolated({ "compaction.reserveTokens": 200 }),
		sessionManager: SessionManager.inMemory(),
		model: () => active,
		messages: () => agent.state.messages,
		nonMessageTokenSource: () => ({}),
		providerSessionState: options.providerSessionState,
		getContextUsage: ({ contextWindow }: { contextWindow: number }) =>
			options.usageTokens === undefined
				? undefined
				: { tokens: options.usageTokens, contextWindow, percent: (options.usageTokens / contextWindow) * 100 },
	} as unknown as SessionMaintenanceHost;
	return new SessionMaintenance(host);
}

describe("SessionMaintenance.contextFitsModel", () => {
	it("fits a candidate whose request drops the active model's replayed reasoning", () => {
		const turn = codexTurn("Important conclusion.", 1);
		expect(convertCodexResponsesMessages(candidate, { messages: [turn] }).some(i => i.type === "reasoning")).toBe(
			false,
		);
		expect(maintenance([turn]).contextFitsModel(candidate)).toBe(true);
		// Control: the producing model replays the 5,000 reasoning tokens, so the same window cannot hold them.
		expect(maintenance([turn]).contextFitsModel({ ...active, contextWindow: 2_000 })).toBe(false);
	});

	it("moves provider usage off the reasoning the active model's request replayed", () => {
		const earlier = codexTurn("Important conclusion.", 1);
		const retained: AgentMessage[] = [
			{ role: "user", content: "Question?", timestamp: 0 },
			earlier,
			{ role: "user", content: "And then?", timestamp: 2 },
		];
		// The active model's last prompt replayed `earlier`'s 5,000 reasoning tokens.
		const usageTokens = 5_100;
		expect(maintenance(retained, { usageTokens }).contextFitsModel(candidate)).toBe(true);
		// Control: the producing model replays them again, so its 2,000 window still cannot hold them.
		expect(maintenance(retained, { usageTokens }).contextFitsModel({ ...active, contextWindow: 2_000 })).toBe(false);
	});

	it("moves provider usage off a replay with no reported reasoning tokens at its signature price", () => {
		const unreported: AssistantMessage = {
			...codexTurn("Important conclusion.", 1),
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoningItem) },
				{ type: "text", text: "Important conclusion." },
			],
		};
		delete unreported.usage.reasoningTokens;
		const retained: AgentMessage[] = [
			{ role: "user", content: "Question?", timestamp: 0 },
			unreported,
			{ role: "user", content: "And then?", timestamp: 2 },
		];
		// The active model's last prompt carried the replayed reasoning; locally only its ciphertext prices it.
		const usageTokens = 5_100;
		expect(maintenance(retained, { usageTokens }).contextFitsModel(candidate)).toBe(true);
		expect(maintenance(retained, { usageTokens }).contextFitsModel({ ...active, contextWindow: 2_000 })).toBe(false);
	});

	it("does not charge a candidate whose cold session rebuilds its own reasoning out of the request", () => {
		const copilot = { ...getBundledModel<"openai-responses">("github-copilot", "gpt-5.4"), contextWindow: 2_000 };
		const turn = responsesTurn(copilot, "Important conclusion.", 1);
		// A connection-bound host starts cold until its first response.
		expect(maintenance([turn], { providerSessionState: new Map() }).contextFitsModel(copilot)).toBe(true);
		// Control: a warm session replays the reasoning, which the window cannot hold.
		expect(maintenance([turn]).contextFitsModel(copilot)).toBe(false);
	});

	it("takes a failed turn off the candidate's floor at the candidate's own count", () => {
		// 1,900 tokens of retained text (test counts are bytes/4) overflow the
		// candidate's 1,800-token budget whether or not the failed turn is dropped.
		const retained: AgentMessage = { role: "user", content: "x".repeat(7_600), timestamp: 0 };
		const failed = codexTurn("Partial answer.", 1);
		expect(maintenance([retained, failed]).contextFitsModel(candidate, failed)).toBe(false);
	});
});

describe("SessionMaintenance.contextFitsModel with a snapcompact archive", () => {
	const gpt = getBundledModel("openai", "gpt-5.4");
	// Takes no image input: it reads the archive as text instead of frames.
	const deepseek = getBundledModel("deepseek", "deepseek-v4-flash");

	function turn(model: Model, text: string, input = 0): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	/** A session standing on a snapcompact archive with frames, whose last reply `gpt` (an image reader) billed. */
	async function archivedSession(): Promise<{ sessionManager: SessionManager; messages: AgentMessage[] }> {
		const sessionManager = SessionManager.inMemory();
		const keptId = sessionManager.appendMessage({ role: "user", content: "Kept turn.", timestamp: Date.now() });
		const filler = "the quick brown fox jumps over the lazy dog. ".repeat(20);
		const archived: Message[] = Array.from({ length: 200 }, (_, i) => [
			{ role: "user" as const, content: `turn ${i}: ${filler}`, timestamp: Date.now() },
			turn(gpt, `reply ${i}: ${filler}`),
		]).flat();
		const archive = await snapcompact.compact(
			{
				firstKeptEntryId: keptId,
				messagesToSummarize: archived,
				turnPrefixMessages: [],
				tokensBefore: 500_000,
				fileOps: snapcompact.createFileOps(),
			},
			{ model: gpt },
		);
		expect(snapcompact.getPreservedArchive(archive.preserveData)?.frames.length).toBeGreaterThan(0);
		sessionManager.appendCompaction(archive.summary, archive.shortSummary, keptId, archive.tokensBefore, {
			details: archive.details,
			preserveData: archive.preserveData,
			method: "snapcompact",
		});
		sessionManager.appendMessage(turn(gpt, "Kept reply.", 1));
		return { sessionManager, messages: sessionManager.buildSessionContext().messages };
	}

	/** Maintenance with `active` selected; the provider usage stays the one `gpt`'s last reply reported. */
	function archiveMaintenance(
		sessionManager: SessionManager,
		messages: AgentMessage[],
		usageTokens: number,
		active: Model = gpt,
	): SessionMaintenance {
		const agent = new Agent({ initialState: { model: active, systemPrompt: [], tools: [], messages } });
		const host = {
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.reserveTokens": 200 }),
			model: () => active,
			modelRegistry: {
				find: (provider: string, id: string) =>
					[gpt, deepseek].find(model => model.provider === provider && model.id === id),
			},
			messages: () => agent.state.messages,
			nonMessageTokenSource: () => ({}),
			getContextUsage: ({ contextWindow }: { contextWindow: number }) => ({
				tokens: usageTokens,
				contextWindow,
				percent: (usageTokens / contextWindow) * 100,
			}),
		} as unknown as SessionMaintenanceHost;
		return new SessionMaintenance(host);
	}

	it("moves provider usage off the frames a candidate without image input reads as text", async () => {
		const { sessionManager, messages } = await archivedSession();
		// The active model's last request carried the archive's frames, at its own count.
		const usageTokens = new Tokenizer(gpt).countMessages(messages);
		// A window under that request, which the archive's text (0.6 of the threshold) and the kept turns fit.
		const contextWindow = Math.floor(usageTokens * 0.8);
		const reader: Model = { ...deepseek, contextWindow };
		expect(archiveMaintenance(sessionManager, messages, usageTokens).contextFitsModel(reader)).toBe(true);
		// Control: a candidate with image input reads the same frames, which the window cannot hold.
		expect(
			archiveMaintenance(sessionManager, messages, usageTokens).contextFitsModel({ ...gpt, contextWindow }),
		).toBe(false);
	});

	it("moves provider usage from the model that reported it, after a switch without a reply since", async () => {
		const { sessionManager, messages } = await archivedSession();
		const usageTokens = new Tokenizer(gpt).countMessages(messages);
		// The smallest window that holds `gpt`'s request while `gpt` is active.
		const fits = (active: Model, contextWindow: number) =>
			archiveMaintenance(sessionManager, messages, usageTokens, active).contextFitsModel({ ...gpt, contextWindow });
		let low = usageTokens;
		let high = usageTokens * 2;
		expect(fits(gpt, high)).toBe(true);
		while (high - low > 1) {
			const mid = Math.floor((low + high) / 2);
			if (fits(gpt, mid)) high = mid;
			else low = mid;
		}
		// After a switch to a reader without image input that has not replied (its window holds only part
		// of the archive's text), the usage still priced `gpt`'s frames, so falling back to `gpt` needs the
		// same window.
		const switched: Model = { ...deepseek, contextWindow: 20_000 };
		expect(fits(switched, high)).toBe(true);
		expect(fits(switched, low)).toBe(false);
	});
});
