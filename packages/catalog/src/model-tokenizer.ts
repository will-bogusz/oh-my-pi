import { resolveCascade } from "./compat/cascade";
import { isTokenCountPolicy, type TokenCountPolicy } from "./compat/token-count";
import { classifyModel } from "./compat/taxonomy";
import { bareModelId } from "./identity/id";
import type { ModelTokenizer } from "./types";

// Resolution is pure and catalog ids recur across providers and aliases.
const MAX_TOKEN_COUNT_CACHE_ENTRIES = 2_048;
const tokenCountCache = new Map<string, TokenCountPolicy | null>();

/**
 * Resolve the `token-count` policy (`rules/classes/*.kdl`) for a canonical
 * model id: its embedded tokenizer and its endpoint's framing constants.
 */
export function resolveModelTokenCount(modelId: string, provider = ""): TokenCountPolicy | undefined {
	const cacheKey = `${provider}\0${modelId}`;
	const cached = tokenCountCache.get(cacheKey);
	if (cached !== undefined) return cached ?? undefined;
	// Provider-scoped identity overrides (e.g. Yolo-Auto's `yolo` alias for
	// Qwen3.8 Flash) only apply when the provider is known; bare ids stay
	// provider-agnostic so unrelated namespaces never inherit them.
	const model = bareModelId(modelId);
	const identity = classifyModel(provider, model, { lenient: true });
	const rule = resolveCascade({
		provider,
		api: "",
		class: identity.class,
		model,
		reasoning: false,
		...(identity.family !== undefined && { family: identity.family }),
		...(identity.revision !== undefined && { revision: identity.revision }),
	}).catalog.tokenCount;
	const policy = isTokenCountPolicy(rule) ? rule : undefined;
	if (tokenCountCache.size === MAX_TOKEN_COUNT_CACHE_ENTRIES) tokenCountCache.clear();
	tokenCountCache.set(cacheKey, policy ?? null);
	return policy;
}

/**
 * Resolve the exact locally embedded tokenizer for a canonical model id: the
 * `tokenizer` of its `token-count` policy.
 *
 * This is catalog policy, not a runtime caller heuristic: [`buildModel`](./build.ts)
 * materializes the result as `Model.tokenizer`; consumers read that property.
 */
export function resolveModelTokenizer(modelId: string, provider = ""): ModelTokenizer | undefined {
	return resolveModelTokenCount(modelId, provider)?.tokenizer;
}
