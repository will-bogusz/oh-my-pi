/**
 * Pre-send token counting policy, from the `token-count` rules in the compat
 * cascade (`rules/classes/*.kdl`): which embedded tokenizer counts a model
 * line's text, and the framing its endpoint adds around that text.
 * [`resolveModelTokenCount`](../model-tokenizer.ts) resolves it per model.
 */
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { MODEL_TOKENIZERS, type ModelTokenizer } from "../types";

/** One model line's `token-count` rule; every field is optional. */
export interface TokenCountPolicy {
	/** Embedded tokenizer that counts the line's text; absent counts in o200k_base. */
	tokenizer?: ModelTokenizer;
	/** Billed tokens per locally counted token. */
	scale?: number;
	/** Tokens the endpoint adds to every request. */
	base?: number;
	/** Tokens the endpoint adds per message. */
	perMessage?: number;
	/** Tokens the endpoint adds once when the request carries tools (a tool-use system prompt). */
	toolPreamble?: number;
	/** Tokens the endpoint adds per tool definition. */
	perTool?: number;
	/** Provider billing was measured to match the framing; unset for docs-only rules. */
	verified?: boolean;
}

/** What an unanchored estimate covers besides its locally counted tokens. */
export interface TokenCountRequestShape {
	messages: number;
	tools: number;
}

const COUNT_FIELDS = ["base", "perMessage", "toolPreamble", "perTool"] as const;
const POLICY_FIELDS: ReadonlySet<string> = new Set(["tokenizer", "scale", "verified", ...COUNT_FIELDS]);
const TOKENIZERS: ReadonlySet<unknown> = new Set(MODEL_TOKENIZERS);

/** Why `value` is not a valid `token-count` payload, or [] when it is. */
export function tokenCountProblems(value: unknown): string[] {
	if (!isRecord(value)) return ["not an object"];
	const problems: string[] = [];
	for (const key of Object.keys(value)) {
		if (!POLICY_FIELDS.has(key)) problems.push(`unknown field \`${key}\``);
	}
	if (value.tokenizer !== undefined && !TOKENIZERS.has(value.tokenizer)) {
		problems.push(`unknown tokenizer \`${String(value.tokenizer)}\``);
	}
	if (
		value.scale !== undefined &&
		!(typeof value.scale === "number" && Number.isFinite(value.scale) && value.scale > 0)
	) {
		problems.push("scale must be a positive number");
	}
	for (const key of COUNT_FIELDS) {
		const count = value[key];
		if (count !== undefined && !(typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) {
			problems.push(`${key} must be a non-negative integer`);
		}
	}
	if (value.verified !== undefined && typeof value.verified !== "boolean") problems.push("verified must be a boolean");
	return problems;
}

/** Narrow a resolved catalog value to a {@link TokenCountPolicy}. */
export function isTokenCountPolicy(value: unknown): value is TokenCountPolicy {
	return tokenCountProblems(value).length === 0;
}

/**
 * An estimate with no provider anchor, framed the way the model's endpoint
 * bills it: `round(scale × local) + base + perMessage × messages`, plus the
 * tool preamble once and `perTool` per tool when the request carries tools.
 * Never apply it to a delta added to a provider-reported prompt: the anchor
 * already carries the framing.
 */
export function frameTokenEstimate(
	policy: TokenCountPolicy | undefined,
	localTokens: number,
	shape: TokenCountRequestShape,
): number {
	if (!policy) return localTokens;
	const tools = Math.max(0, shape.tools);
	return (
		Math.round((policy.scale ?? 1) * localTokens) +
		(policy.base ?? 0) +
		(policy.perMessage ?? 0) * Math.max(0, shape.messages) +
		(tools > 0 ? (policy.toolPreamble ?? 0) + (policy.perTool ?? 0) * tools : 0)
	);
}
