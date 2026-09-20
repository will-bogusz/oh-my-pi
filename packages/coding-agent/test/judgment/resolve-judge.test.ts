import { describe, expect, it } from "bun:test";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { resolveJudge, usesTypeSafeJudge } from "../../src/judgment";
import { ONLINE_MEMORY_MODEL_KEY } from "../../src/tiny/models";

function registryWith(...providers: string[]): ModelRegistry {
	return {
		authStorage: {
			hasAuth: (provider: string) => providers.includes(provider),
			resolver: (provider: string) => async () => `${provider}-key`,
		},
		getAvailable: () => [],
		getApiKey: async () => "test-key",
		resolver: () => async () => "test-key",
	} as unknown as ModelRegistry;
}

function resolve(mode: "auto" | "typesafe" | "llm", registry: ModelRegistry) {
	const settings = Settings.isolated({ "providers.judgmentProvider": mode });
	return { judge: resolveJudge({ settings, registry, backend: ONLINE_MEMORY_MODEL_KEY }), settings };
}

describe("resolveJudge route precedence", () => {
	it("reaches Jev through OpenRouter when only an OpenRouter credential is stored", () => {
		const registry = registryWith("openrouter", "anthropic");
		const { judge, settings } = resolve("auto", registry);
		expect(judge.kind).toBe("typesafe");
		expect(judge.label).toBe("openrouter/typesafe/jev-1.13");
		expect(usesTypeSafeJudge(settings, registry)).toBe(true);
	});

	it("prefers the native TypeSafe route when its credential exists", () => {
		const { judge } = resolve("auto", registryWith("openrouter", "typesafe"));
		expect(judge.kind).toBe("typesafe");
		expect(judge.label).toStartWith("typesafe/");
	});

	it("uses the chat bridge without either credential, and whenever pinned to llm", () => {
		const none = registryWith("anthropic");
		expect(resolve("auto", none).judge.kind).toBe("online");
		expect(usesTypeSafeJudge(Settings.isolated({ "providers.judgmentProvider": "auto" }), none)).toBe(false);

		const pinned = registryWith("openrouter", "typesafe");
		expect(resolve("llm", pinned).judge.kind).toBe("online");
	});

	it("insists on the native route in typesafe mode even without a credential", () => {
		const { judge } = resolve("typesafe", registryWith("anthropic"));
		expect(judge.kind).toBe("typesafe");
		expect(judge.label).toStartWith("typesafe/");
	});
});
