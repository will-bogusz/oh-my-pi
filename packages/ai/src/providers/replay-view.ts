/**
 * How each reader's request encoder replays a stored assistant turn, as data a
 * local count can read: the turn's blocks after the reader's replay passes,
 * for the model the request actually encodes for. Counting these blocks
 * replaces mirrored copies of the encoders' signature and thinking rules.
 */
import { resolveFactoryDroidPolicy } from "@oh-my-pi/pi-catalog/compat/factory-droid";
import type { AssistantMessage, Model } from "../types";
import { adoptFactoryReplay } from "./factory-droid/gemini";
import { factoryDroidDefaultUpstream, factoryDroidWireTarget } from "./factory-droid/route";
import { ollamaChatDropsOwnThinking } from "./ollama";
import { completionsDropsOwnThinking, isLiteLLMThinkingSignature } from "./openai-completions";
import { isSameModelTurn, replayAssistantTurn } from "./transform-messages";

/** A reader's replay of stored assistant turns. */
export interface ReplayView {
	/**
	 * The model the request encodes the history for: the reader itself, or the
	 * inner model an agent proxy forwards to (Factory's shared wires).
	 */
	readonly target: Model;
	/** Readers with equal keys replay every turn alike. */
	readonly key: string;
	/**
	 * `turn` as the reader's request carries it, or `undefined` when the request
	 * drops it. `latest`: the turn is the history's latest surviving assistant turn.
	 */
	assistantTurn(turn: AssistantMessage, latest: boolean): AssistantMessage | undefined;
}

/** A model as far as its replay depends on it; partial rows replay with an empty compat. */
export type ReplayReaderModel = Pick<Model, "api" | "provider" | "id"> &
	Partial<Pick<Model, "compat" | "thinking" | "reasoning" | "requestModelId" | "factoryDroidApiProviders">>;

type TurnReplay = (turn: AssistantMessage, latest: boolean) => AssistantMessage | undefined;

const VIEWS = new WeakMap<object, ReplayView | null>();

/**
 * The replay view of `model`'s requests, or `undefined` for an API whose
 * encoder this module does not know (extension APIs), whose turns count as
 * stored. Memoized per model object.
 */
export function replayView(model: ReplayReaderModel): ReplayView | undefined {
	let view = VIEWS.get(model);
	if (view === undefined) {
		view = buildView(withCompat(model)) ?? null;
		VIEWS.set(model, view);
	}
	return view ?? undefined;
}

function withCompat(model: ReplayReaderModel): Model {
	return (model.compat ? model : { ...model, compat: {} }) as Model;
}

function viewKey(model: Model, outer?: Model): string {
	return JSON.stringify([
		outer?.api,
		model.api,
		model.provider,
		model.id,
		model.requestModelId,
		model.reasoning,
		model.thinking?.prefixBinding,
		model.compat,
	]);
}

function buildView(model: Model): ReplayView | undefined {
	const replay = turnReplay(model);
	if (replay === undefined) {
		if (model.api !== "factory-droid-agent") return undefined;
		return factoryDroidView(model as Model<"factory-droid-agent">);
	}
	return viewOf(model, viewKey(model), replay);
}

/**
 * A view over `replay`. A persisted turn without its origin (records that
 * predate provider stamps) is something no replay pass can classify; it
 * counts as stored.
 */
function viewOf(target: Model, key: string, replay: TurnReplay): ReplayView {
	return {
		target,
		key,
		assistantTurn: (turn, latest) =>
			typeof turn.provider === "string" && typeof turn.api === "string" && typeof turn.model === "string"
				? replay(turn, latest)
				: turn,
	};
}

/** The turn replay of a reader that encodes its history itself, without a proxy hop. */
function turnReplay(model: Model): TurnReplay | undefined {
	switch (model.api) {
		case "openai-completions":
			return completionsReplay(model);
		case "ollama-chat":
			return ollamaReplay(model);
		case "devin-agent":
			return devinReplay(model);
		case "cursor-agent":
			return cursorReplay(model);
		case "gitlab-duo-agent":
			return gitLabReplay;
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
		case "openrouter":
		case "anthropic-messages":
		case "bedrock-converse-stream":
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
		case "apple-foundation-models":
			return (turn, latest) => replayAssistantTurn(turn, model, latest);
		default:
			return undefined;
	}
}

/**
 * Chat completions (`convertMessages`) drops the reader's own past thinking
 * unless a reasoning slot carries it, or LiteLLM replays a raw signature in
 * `thinking_blocks`; another model's thinking arrives demoted to text.
 */
function completionsReplay(model: Model): TurnReplay {
	const dropsOwnThinking = completionsDropsOwnThinking(model);
	return (turn, latest) => {
		const replayed = replayAssistantTurn(turn, model, latest);
		if (!replayed || !dropsOwnThinking || !isSameModelTurn(turn, model)) return replayed;
		return withContent(
			replayed,
			replayed.content.filter(
				block => block.type !== "thinking" || isLiteLLMThinkingSignature(block.thinkingSignature),
			),
		);
	};
}

/**
 * Ollama chat sends a turn's thinking as plain `thinking` text, without
 * signatures or redacted payloads, and strips it from history unless the
 * model's compat keeps it.
 */
function ollamaReplay(model: Model): TurnReplay {
	const dropsThinking = ollamaChatDropsOwnThinking(model);
	return (turn, latest) => {
		const replayed = replayAssistantTurn(turn, model, latest);
		if (!replayed) return undefined;
		const content: AssistantMessage["content"] = [];
		for (const block of replayed.content) {
			if (block.type === "redactedThinking") continue;
			if (block.type === "thinking") {
				if (!dropsThinking)
					content.push(block.thinkingSignature ? { ...block, thinkingSignature: undefined } : block);
				continue;
			}
			content.push(block);
		}
		return withContent(replayed, content);
	};
}

/**
 * Devin's prompt carries text, every thinking block's text and tool calls;
 * only a native Devin turn sends a signature, its first one. Redacted
 * thinking and server-tool blocks have no field.
 */
function devinReplay(model: Model): TurnReplay {
	return (turn, latest) => {
		const replayed = replayAssistantTurn(turn, model, latest);
		if (!replayed) return undefined;
		let signed = !isSameModelTurn(turn, model);
		const content: AssistantMessage["content"] = [];
		for (const block of replayed.content) {
			if (block.type === "text" || block.type === "toolCall") {
				content.push(block);
			} else if (block.type === "thinking") {
				if (signed && block.thinkingSignature) content.push({ ...block, thinkingSignature: undefined });
				else content.push(block);
				signed ||= block.thinkingSignature !== undefined && block.thinkingSignature !== "";
			}
		}
		return withContent(replayed, content);
	};
}

/**
 * Cursor builds its history itself: text and tool calls for every turn,
 * thinking (with its signature) only for the target model's own turns, which
 * replay as their server records or as same-model content. Another model's
 * reasoning never goes out.
 */
function cursorReplay(model: Model): TurnReplay {
	return turn => {
		const own = isSameModelTurn(turn, model);
		return withContent(
			turn,
			turn.content.filter(
				block =>
					block.type === "text" ||
					block.type === "toolCall" ||
					(own && block.type === "thinking" && block.thinking !== ""),
			),
		);
	};
}

/** GitLab Duo's goal transcript renders text and tool calls; thinking never goes out. */
const gitLabReplay: TurnReplay = turn =>
	withContent(
		turn,
		turn.content.filter(block => block.type === "text" || block.type === "toolCall"),
	);

/**
 * Factory replays history on the wire it routes the model to: its native
 * Gemini client keeps only signed Google-origin thinking (dropped, never
 * demoted, otherwise), and the shared wires replay to the inner model the
 * route builds, under that API's own rules.
 */
function factoryDroidView(model: Model<"factory-droid-agent">): ReplayView | undefined {
	const registry = resolveFactoryDroidPolicy(model);
	const wire = registry?.wire ?? "openai-completions";
	if (wire === "google-generate") {
		return viewOf(model, viewKey(model), (turn, latest) => {
			const replayed = replayAssistantTurn(adoptFactoryReplay(turn, model) as AssistantMessage, model, latest);
			if (!replayed) return undefined;
			// The generate contents carry text, signed thinking and calls.
			return withContent(
				replayed,
				replayed.content.filter(
					block =>
						block.type === "text" ||
						block.type === "toolCall" ||
						(block.type === "thinking" && !!block.thinkingSignature),
				),
			);
		});
	}
	const upstream = factoryDroidDefaultUpstream(model, registry);
	if (upstream === undefined) return undefined;
	// The inner model's identity, compat and thinking; the transport-only fields
	// the request adds (limits, host) play no part in replay.
	const inner = factoryDroidWireTarget(model, wire, upstream).target as Model;
	const replay = turnReplay(inner);
	if (replay === undefined) return undefined;
	return viewOf(inner, viewKey(inner, model), replay);
}

function withContent(turn: AssistantMessage, content: AssistantMessage["content"]): AssistantMessage {
	return content.length === turn.content.length && content.every((block, index) => block === turn.content[index])
		? turn
		: { ...turn, content };
}
