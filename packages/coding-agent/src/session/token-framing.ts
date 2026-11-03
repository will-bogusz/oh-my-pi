import type { Model } from "@oh-my-pi/pi-ai";
import { frameTokenEstimate } from "@oh-my-pi/pi-catalog/compat/token-count";
import { resolveModelTokenCount } from "@oh-my-pi/pi-catalog/model-tokenizer";

/**
 * A whole-request local estimate (system prompt, `tools` and `messages`
 * messages, no provider anchor) framed the way `model`'s endpoint bills it:
 * the catalog `token-count` scale, per-request base, per-message framing, and
 * tool preamble when the tool schemas ship. Never frame an anchored estimate:
 * the provider-reported prompt already carries the framing.
 */
export function frameUnanchoredEstimate(
	model: Model | undefined,
	localTokens: number,
	messages: number,
	tools: readonly unknown[] | undefined,
): number {
	if (!model) return localTokens;
	return frameTokenEstimate(resolveModelTokenCount(model.requestModelId ?? model.id, model.provider), localTokens, {
		messages,
		tools: model.toolSchemasInContext === false ? 0 : (tools?.length ?? 0),
	});
}
