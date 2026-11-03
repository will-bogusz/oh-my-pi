import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { frameTokenEstimate, type TokenCountPolicy } from "@oh-my-pi/pi-catalog/compat/token-count";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { bareModelId } from "@oh-my-pi/pi-catalog/identity/id";
import { resolveModelTokenCount, resolveModelTokenizer } from "@oh-my-pi/pi-catalog/model-tokenizer";
import { getBundledModel, getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function spec(id: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

/** Resolve a bundled row the way `buildModel` does: by its wire id on its provider. */
function bundledTokenCount(provider: string, id: string) {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`missing bundled model ${provider}/${id}`);
	return resolveModelTokenCount(model.requestModelId ?? model.id, model.provider);
}

describe("resolveModelTokenizer", () => {
	test("routes only tokenizer generations covered by embedded vocabularies", () => {
		expect(resolveModelTokenizer("anthropic/claude-opus-4-7")).toBe("claude-v47");
		expect(resolveModelTokenizer("claude-sonnet-5")).toBe("claude-v5-sonnet");
		expect(resolveModelTokenizer("Qwen/Qwen3.8-27B")).toBe("qwen3");
		expect(resolveModelTokenizer("qwen3-32b")).toBeUndefined();
		expect(resolveModelTokenizer("deepseek-chat")).toBe("deepseek-v3");
		expect(resolveModelTokenizer("deepseek-r1-0528")).toBe("deepseek-v3");
		expect(resolveModelTokenizer("deepseek-r1-distill-qwen-32b")).toBeUndefined();
		expect(resolveModelTokenizer("moonshotai/Kimi-K3")).toBe("kimi-k2");
		expect(resolveModelTokenizer("moonshot-v1-128k")).toBeUndefined();
		expect(resolveModelTokenizer("glm-5.2")).toBe("glm5");
		expect(resolveModelTokenizer("glm-4.7")).toBeUndefined();
		expect(resolveModelTokenizer("gpt-6.1-sol", "openai-codex")).toBe("o200k");
		expect(resolveModelTokenizer("gpt-5.1-codex-max")).toBe("o200k");
		expect(resolveModelTokenizer("openai/gpt-5.5", "openrouter")).toBe("o200k");
		expect(resolveModelTokenizer("gpt-4-turbo")).toBe("cl100k");
		expect(resolveModelTokenizer("gpt-4-0613")).toBe("cl100k");
		expect(resolveModelTokenizer("gpt-3.5-turbo")).toBe("cl100k");
		expect(resolveModelTokenizer("gpt-4.1")).toBeUndefined();
		expect(resolveModelTokenizer("gpt-4o")).toBeUndefined();
		expect(resolveModelTokenizer("gpt-realtime-2.1")).toBeUndefined();
		expect(resolveModelTokenizer("openai/gpt-oss-120b")).toBeUndefined();
		expect(resolveModelTokenizer("yolo")).toBeUndefined();
		expect(resolveModelTokenizer("yolo-auto/yolo", "yolo-auto")).toBe("qwen3");
	});

	test("maps real bundled ids: aliases, gateway ids and collapsed revisions", () => {
		const cases: [provider: string, id: string, tokenizer: string | undefined][] = [
			["anthropic", "claude-opus-5-5", "claude-v5"],
			["anthropic", "claude-haiku-5-5", "claude-v5-sonnet"],
			["anthropic", "claude-sonnet-5-5", "claude-v5-sonnet"],
			["amazon-bedrock", "global.anthropic.claude-opus-5-5", "claude-v5"],
			["google-vertex", "claude-haiku-5-5@default", "claude-v5-sonnet"],
			["openrouter", "anthropic/claude-opus-5.5:batch", "claude-v5"],
			["cursor", "claude-opus-5-5-fast", "claude-v5"],
			["kilo", "~anthropic/claude-opus-latest", "claude-v3"],
			["nanogpt", "anthropic/claude-sonnet-latest", "claude-v3"],
			// Separator-collapsed revisions parse as two digits (Opus 4.5 → 45).
			["venice", "claude-opus-45", "claude-v5"],
			["kimi-code", "k3", "kimi-k2"],
			["kimi-code", "k3.1-pro", "kimi-k2"],
			["openrouter", "moonshotai/kimi-k3:batch", "kimi-k2"],
			["xai", "grok-4.7", "o200k"],
			["amazon-bedrock", "global.xai.grok-4.7", "o200k"],
			["cursor", "grok-4.7", "o200k"],
			["xai", "grok-4.20-0309-reasoning", undefined],
			["aimlapi", "x-ai/grok-4-07-09", undefined],
		];
		for (const [provider, id, tokenizer] of cases) {
			expect([provider, id, bundledTokenCount(provider, id)?.tokenizer]).toEqual([provider, id, tokenizer]);
		}
	});

	// models.json was baked by the generator, so a row whose id the resolver
	// covers carries the resolver's answer from when the row was generated. A KDL
	// edit that moves a covered row onto another vocabulary fails here. Rows with
	// no tokenizer count in o200k, so an explicit `o200k` (Grok 4.7) is the same
	// mapping. A row the resolver leaves unset may carry a tokenizer the generator
	// copied from a reference row, only when its id has no revision a rule could
	// select (GitLab Duo aliases, `glm-5v-turbo`); a revisioned row that loses
	// its tokenizer fails.
	test("keeps every bundled row's baked tokenizer", () => {
		const drifted: string[] = [];
		let checked = 0;
		for (const provider of getBundledProviders()) {
			for (const model of getBundledModels(provider)) {
				const wireId = model.requestModelId ?? model.id;
				const resolved = resolveModelTokenizer(wireId, model.provider);
				if (resolved === undefined && model.tokenizer !== undefined) {
					const identity = classifyModel(model.provider, bareModelId(wireId), { lenient: true });
					if (identity.class === "unknown" || identity.revision === undefined) continue;
				}
				checked++;
				if ((resolved ?? "o200k") !== (model.tokenizer ?? "o200k")) {
					drifted.push(`${model.provider}/${model.id}: ${model.tokenizer} → ${resolved}`);
				}
			}
		}
		expect(checked).toBeGreaterThan(4_000);
		expect(drifted).toEqual([]);
	});

	test("buildModel materializes wire-model tokenizer policy and preserves explicit policy", () => {
		expect(buildModel(spec("deepseek-v4-pro")).tokenizer).toBe("deepseek-v3");
		expect(buildModel({ ...spec("alias"), requestModelId: "deepseek-v4-pro" }).tokenizer).toBe("deepseek-v3");
		expect(buildModel({ ...spec("deepseek-v4-pro"), tokenizer: "qwen3" }).tokenizer).toBe("qwen3");
	});
});

describe("resolveModelTokenCount", () => {
	test("returns the seeded framing for real bundled ids", () => {
		const grok: TokenCountPolicy = { tokenizer: "o200k", verified: true, scale: 1.053, base: 1065 };
		expect(bundledTokenCount("xai", "grok-4.7")).toEqual(grok);
		expect(bundledTokenCount("amazon-bedrock", "global.xai.grok-4.7")).toEqual(grok);
		expect(bundledTokenCount("kimi-code", "k3")).toEqual({ tokenizer: "kimi-k2", base: 78 });
		expect(bundledTokenCount("openrouter", "moonshotai/kimi-k3:batch")).toEqual({ tokenizer: "kimi-k2", base: 78 });
		const claude55 = { base: 9, toolPreamble: 286, perTool: 9 };
		expect(bundledTokenCount("anthropic", "claude-opus-5-5")).toEqual({ tokenizer: "claude-v5", ...claude55 });
		expect(bundledTokenCount("google-vertex", "claude-opus-5-5@default")).toEqual({
			tokenizer: "claude-v5",
			...claude55,
		});
		expect(bundledTokenCount("anthropic", "claude-haiku-5-5")).toEqual({
			tokenizer: "claude-v5-sonnet",
			...claude55,
		});
		expect(bundledTokenCount("anthropic", "claude-sonnet-5-5")).toEqual({
			tokenizer: "claude-v5-sonnet",
			...claude55,
		});
		expect(bundledTokenCount("anthropic", "claude-opus-5")).toEqual({
			tokenizer: "claude-v5",
			base: 7,
			toolPreamble: 286,
			perTool: 9,
		});
		expect(bundledTokenCount("anthropic", "claude-opus-4-7")).toEqual({ tokenizer: "claude-v47", toolPreamble: 675 });
		// Collapsed `claude-opus-45` keeps its vocabulary but takes no 5.x framing.
		expect(bundledTokenCount("venice", "claude-opus-45")).toEqual({ tokenizer: "claude-v5" });
		expect(bundledTokenCount("kilo", "~anthropic/claude-opus-latest")).toEqual({ tokenizer: "claude-v3" });
		// Kimi K2 shares K3's vocabulary without the K3 framing.
		expect(bundledTokenCount("moonshot", "kimi-k2.6")).toEqual({ tokenizer: "kimi-k2" });
	});
});

describe("frameTokenEstimate", () => {
	test("scales the local count and adds per-request, per-message and per-tool framing", () => {
		const policy = { scale: 1.053, base: 1065, perMessage: 3, toolPreamble: 286, perTool: 9 };
		expect(frameTokenEstimate(policy, 10_000, { messages: 4, tools: 2 })).toBe(10_530 + 1065 + 12 + 286 + 18);
		expect(frameTokenEstimate(policy, 10_000, { messages: 4, tools: 0 })).toBe(10_530 + 1065 + 12);
		expect(frameTokenEstimate({}, 10_000, { messages: 4, tools: 2 })).toBe(10_000);
		expect(frameTokenEstimate(undefined, 10_000, { messages: 4, tools: 2 })).toBe(10_000);
	});
});
