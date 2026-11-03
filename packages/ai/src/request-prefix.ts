/**
 * The system texts and tool definitions a request carries, encoded by the
 * provider adapter that sends it. Counting these instead of the caller's tool
 * objects charges what the wire carries: Anthropic's OAuth identity blocks and
 * tool-name prefix, per-tool flags, schema normalization and JSON structure.
 *
 * Synchronous and local: no network or credential calls. Adapter modules load
 * on first use, as the stream dispatcher loads them.
 */
import { $env } from "@oh-my-pi/pi-utils";
import type * as BedrockProvider from "./providers/amazon-bedrock";
import type * as AnthropicProvider from "./providers/anthropic";
import type * as AzureProvider from "./providers/azure-openai-responses";
import type * as FactoryDroidProvider from "./providers/factory-droid";
import type * as GeminiCliProvider from "./providers/google-gemini-cli";
import type * as GoogleProvider from "./providers/google-shared";
import type * as CodexProvider from "./providers/openai-codex-responses";
import type * as CompletionsProvider from "./providers/openai-completions";
import type * as ResponsesProvider from "./providers/openai-responses";
import { getProviderDefinition } from "./registry";
import type { Model, RequestPrefix, RequestPrefixTool, Tool } from "./types";
import { normalizeSystemPrompts } from "./utils";
import { toolWireSchema } from "./utils/schema";

export interface RequestPrefixOptions {
	/**
	 * Whether the session's credential for the model's provider is an OAuth
	 * login, which shapes Anthropic Messages requests (Claude Code identity
	 * blocks, tool-name prefix). It wins over the model's own `isOAuth`, as the
	 * request option does when the stream dispatcher builds the request.
	 */
	isOAuth?: boolean;
}

/**
 * Encode the system prompt and tools of a request to `model` as its adapter
 * puts them on the wire. APIs without an encoder here (and a roster an adapter
 * cannot encode) fall back to the system prompts plus the JSON of each tool's
 * name, description and wire schema.
 */
export function encodeRequestPrefix(
	model: Model | undefined,
	systemPrompt: readonly string[] | undefined,
	tools: Tool[],
	options: RequestPrefixOptions = {},
): RequestPrefix {
	if (model) {
		try {
			const encoded = encodeForApi(getProviderDefinition(model.provider)?.prepareModel?.(model) ?? model, {
				systemPrompt,
				tools,
				isOAuth: options.isOAuth ?? model.isOAuth ?? false,
			});
			if (encoded) return encoded;
		} catch {
			// A schema the adapter cannot encode fails the request too; count what can be serialized.
		}
	}
	return { system: normalizeSystemPrompts(systemPrompt), tools: encodeToolsGenerically(tools) };
}

interface PrefixInput {
	systemPrompt: readonly string[] | undefined;
	tools: Tool[];
	isOAuth: boolean;
}

function encodeForApi(model: Model, { systemPrompt, tools, isOAuth }: PrefixInput): RequestPrefix | undefined {
	switch (model.api) {
		case "anthropic-messages": {
			const adapter: typeof AnthropicProvider = require("./providers/anthropic");
			return adapter.encodeAnthropicRequestPrefix(
				model as Model<"anthropic-messages">,
				systemPrompt,
				tools,
				isOAuth,
			);
		}
		case "openrouter":
			// The stream dispatcher sends OpenRouter over Responses unless opted out.
			if ($env.PI_OPENROUTER_RESPONSES === "0") return encodeCompletions(model, systemPrompt, tools);
			return encodeResponses(model, systemPrompt, tools);
		case "openai-responses":
			return encodeResponses(model, systemPrompt, tools);
		case "openai-completions":
			return encodeCompletions(model, systemPrompt, tools);
		case "azure-openai-responses": {
			const adapter: typeof AzureProvider = require("./providers/azure-openai-responses");
			return adapter.encodeAzureOpenAIResponsesRequestPrefix(
				model as Model<"azure-openai-responses">,
				systemPrompt,
				tools,
			);
		}
		case "openai-codex-responses": {
			const adapter: typeof CodexProvider = require("./providers/openai-codex-responses");
			return adapter.encodeOpenAICodexResponsesRequestPrefix(
				model as Model<"openai-codex-responses">,
				systemPrompt,
				tools,
			);
		}
		case "google-generative-ai":
		case "google-vertex": {
			const adapter: typeof GoogleProvider = require("./providers/google-shared");
			return adapter.encodeGoogleRequestPrefix(
				model as Model<"google-generative-ai" | "google-vertex">,
				systemPrompt,
				tools,
			);
		}
		case "google-gemini-cli": {
			const adapter: typeof GeminiCliProvider = require("./providers/google-gemini-cli");
			return adapter.encodeGoogleGeminiCliRequestPrefix(model as Model<"google-gemini-cli">, systemPrompt, tools);
		}
		case "factory-droid-agent": {
			const adapter: typeof FactoryDroidProvider = require("./providers/factory-droid");
			return adapter.encodeFactoryDroidRequestPrefix(model as Model<"factory-droid-agent">, systemPrompt, tools);
		}
		case "bedrock-converse-stream": {
			const adapter: typeof BedrockProvider = require("./providers/amazon-bedrock");
			return adapter.encodeBedrockRequestPrefix(systemPrompt, tools);
		}
		default:
			return undefined;
	}
}

function encodeResponses(model: Model, systemPrompt: readonly string[] | undefined, tools: Tool[]): RequestPrefix {
	const adapter: typeof ResponsesProvider = require("./providers/openai-responses");
	return adapter.encodeOpenAIResponsesRequestPrefix(model as Model<"openai-responses">, systemPrompt, tools);
}

function encodeCompletions(model: Model, systemPrompt: readonly string[] | undefined, tools: Tool[]): RequestPrefix {
	const adapter: typeof CompletionsProvider = require("./providers/openai-completions");
	return adapter.encodeOpenAICompletionsRequestPrefix(model as Model<"openai-completions">, systemPrompt, tools);
}

/** `{name, description, parameters}` JSON per tool; a tool whose schema cannot be serialized keeps its own strings. */
function encodeToolsGenerically(tools: readonly Tool[]): RequestPrefixTool[] {
	return tools.map(tool => {
		try {
			const parameters = toolWireSchema(tool);
			return {
				name: tool.name,
				definition: JSON.stringify({ name: tool.name, description: tool.description, parameters }),
			};
		} catch (error) {
			// Schema may contain functions or cycles.
			return {
				name: tool.name,
				definition: JSON.stringify({ name: tool.name, description: tool.description }),
				schemaError: error instanceof Error ? error.message : String(error),
			};
		}
	});
}
