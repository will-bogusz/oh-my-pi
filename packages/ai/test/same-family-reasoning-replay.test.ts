/**
 * Reasoning that the same model family produced on another host replays in
 * the target's native reasoning slot when the target declares (KDL
 * `replay-same-family-reasoning`) that the slot reaches the model. Everything
 * else keeps today's demotion to visible `<think>` text.
 *
 * Models are built from specs so the KDL rule, not a baked row, decides.
 */
import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const CARRIED = "Earlier K3 reasoning: read foo.ts, then patch bar().";

function priorTurn(
	source: Pick<AssistantMessage, "provider" | "api" | "model">,
	thinkingSignature?: string,
): AssistantMessage {
	return {
		role: "assistant",
		...source,
		content: [
			{ type: "thinking", thinking: CARRIED, thinkingSignature },
			{ type: "text", text: "Patched." },
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function history(prior: AssistantMessage): Message[] {
	return [
		{ role: "user", content: "fix the bug", timestamp: 0 },
		prior,
		{ role: "user", content: "continue", timestamp: 2 },
	];
}

function completionsTarget(provider: string, id: string, baseUrl: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 32_768,
	} satisfies ModelSpec<"openai-completions">);
}

const moonshotK3 = () => completionsTarget("moonshot", "kimi-k3", "https://api.moonshot.ai/v1");
const factoryK3 = { provider: "factory-droid", api: "openai-completions", model: "kimi-k3" } as const;

function assistantWire(target: Model<"openai-completions">, messages: Message[]): Record<string, unknown> {
	const assistant = convertMessages(target, { messages }, target.compat).find(
		(message): message is Extract<typeof message, { role: "assistant" }> => message.role === "assistant",
	);
	if (!assistant) throw new Error("assistant message missing");
	return assistant as unknown as Record<string, unknown>;
}

describe("same-family reasoning replay across hosts", () => {
	it("replays another host's K3 reasoning in Moonshot's reasoning_content", () => {
		const wire = assistantWire(moonshotK3(), history(priorTurn(factoryK3, "reasoning_content")));

		expect(wire.reasoning_content).toBe(CARRIED);
		expect(wire.content).toBe("Patched.");
	});

	it("drops a Responses item signature from another host and keeps only the text", () => {
		const openRouterItem = JSON.stringify({
			id: "rs_tmp_abc123",
			type: "reasoning",
			status: "completed",
			content: [{ type: "reasoning_text", text: CARRIED }],
			summary: [],
		});
		const wire = assistantWire(
			moonshotK3(),
			history(priorTurn({ provider: "openrouter", api: "openrouter", model: "moonshotai/kimi-k3" }, openRouterItem)),
		);

		expect(wire.reasoning_content).toBe(CARRIED);
		expect(wire.content).toBe("Patched.");
	});

	it("still demotes reasoning from a different Kimi family", () => {
		const wire = assistantWire(
			moonshotK3(),
			history(
				priorTurn({ provider: "moonshot", api: "openai-completions", model: "kimi-k2.6" }, "reasoning_content"),
			),
		);

		expect(wire.reasoning_content).toBeUndefined();
		expect(wire.content).toBe(`<think>\n${CARRIED}\n</think>\nPatched.`);
	});

	it("still demotes on a K3 host that has not declared the capability", () => {
		const fireworksK3 = completionsTarget(
			"fireworks",
			"accounts/fireworks/models/kimi-k3",
			"https://api.fireworks.ai/inference/v1",
		);
		expect(fireworksK3.identity).toMatchObject({ class: "kimi", family: "k3" });

		const wire = assistantWire(fireworksK3, history(priorTurn(factoryK3, "reasoning_content")));

		expect(wire.content).toBe(`<think>\n${CARRIED}\n</think>\nPatched.`);
	});

	it("replays carried K3 reasoning as a plaintext reasoning item on OpenRouter's Responses wire", () => {
		const target = buildModel({
			id: "moonshotai/kimi-k3",
			name: "Kimi K3",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262_144,
			maxTokens: 32_768,
		} satisfies ModelSpec<"openrouter">) as unknown as Model<"openai-responses">;

		const { params } = buildParams(
			target,
			{ messages: history(priorTurn(factoryK3, "reasoning_content")) },
			{ reasoning: "low" },
			undefined,
		);
		const replayed: unknown[] = (params.input ?? []).filter(
			item => item.type === "reasoning" || ("role" in item && item.role === "assistant"),
		);

		expect(replayed).toEqual([
			{ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: CARRIED }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Patched.", annotations: [] }],
				status: "completed",
			},
		]);
	});
});
