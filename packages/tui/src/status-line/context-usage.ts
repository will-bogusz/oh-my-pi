import type { AgentMessage, RequestTools, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { CompactionSettings } from "@oh-my-pi/pi-agent-core/compaction";
import { effectiveReserveTokens, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Tool as AiTool, Model, RequestPrefix } from "@oh-my-pi/pi-ai";
import { encodeRequestPrefix } from "@oh-my-pi/pi-ai/request-prefix";

interface ContextSkill {
	readonly name: string;
	readonly description?: string;
	readonly hide?: boolean;
}

type ContextTool = Pick<AiTool, "name" | "description" | "parameters" | "examples">;

/** Savings computed by the host's inline-image planner, not by the renderer. */
export interface ContextSavingsEstimate {
	visionCapable: boolean;
	systemPrompt?: {
		applied: boolean;
		reason?: "empty" | "margin" | "budget";
		textTokens: number;
		frames: number;
		imageTokens: number;
		savedTokens: number;
		scope: "agents-md" | "all";
	};
	toolResults?: {
		total: number;
		swapped: number;
		textTokens: number;
		frames: number;
		imageTokens: number;
		savedTokens: number;
	};
	savedTokens: number;
}

/** Real sessions satisfy this view without wrapping or copying their state. */
export interface ContextUsageSession extends NonMessageTokenSource {
	readonly model: Model | undefined;
	readonly agent: {
		readonly tokenizer: Tokenizer;
		readonly state?: { readonly tools?: readonly ContextTool[] };
	};
	readonly messages?: AgentMessage[];
	getContextBreakdown?():
		| {
				messagesTokens: number;
				skillsTokens: number;
				systemToolsTokens: number;
				systemContextTokens: number;
				systemPromptTokens: number;
				usedTokens: number;
		  }
		| undefined;
}

export interface ContextUsageOptions {
	compaction: CompactionSettings;
	sourceRevision?: number;
	skillful?: boolean;
	snapcompact?: ContextSavingsEstimate;
}

type CategoryId = "systemPrompt" | "systemContext" | "systemTools" | "skills" | "messages";

interface CategoryInfo {
	id: CategoryId;
	label: string;
	tokens: number;
}

export interface ContextBreakdown {
	model: Model | undefined;
	contextWindow: number;
	categories: CategoryInfo[];
	usedTokens: number;
	autoCompactBufferTokens: number;
	freeTokens: number;
	/** Where auto-compaction fires, in tokens; undefined when compaction is off. */
	thresholdTokens?: number;
	/** Estimated snapcompact wire savings; set when requested and a snapcompact.* setting is enabled. */
	snapcompact?: ContextSavingsEstimate;
}

/** Percent positions (0–100 of the context window) for the auto-compaction boundaries. */
export interface CompactionBoundaries {
	/** Where auto-compaction fires. */
	thresholdPercent: number;
	/**
	 * Where the background speculative summarizer starts (threshold − lead), or
	 * `null` when no speculation will run (async compaction disabled, or the
	 * first available method is local — snapcompact/shake — and thus instant).
	 */
	speculationPercent: number | null;
}

/**
 * Boundary positions for the status line's annotated context gauge. `null`
 * when compaction is disabled/off or the window is unknown — the gauge then
 * renders without markers. The host supplies a lead only when its configured
 * method and async policy allow speculative compaction.
 */
export function computeCompactionBoundaries(
	compactionSettings: CompactionSettings,
	contextWindow: number,
	speculationLeadTokens?: number,
): CompactionBoundaries | null {
	if (!(contextWindow > 0)) return null;
	if (!compactionSettings.enabled || compactionSettings.strategy === "off") return null;
	const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
	if (!(thresholdTokens > 0) || thresholdTokens > contextWindow) return null;
	return {
		thresholdPercent: (thresholdTokens / contextWindow) * 100,
		speculationPercent:
			speculationLeadTokens === undefined
				? null
				: (Math.max(0, thresholdTokens - speculationLeadTokens) / contextWindow) * 100,
	};
}

/** Stable inputs used to cache non-message token estimates. */
export interface NonMessageTokenSource {
	readonly model?: Model;
	readonly systemPrompt?: readonly string[];
	readonly agent?: {
		readonly state?: {
			readonly tools?: readonly ContextTool[];
		};
		/**
		 * The tool definitions the loop sends `model` (`Agent.requestToolsFor`).
		 * Without it the roster is counted as the adapter would send it unchanged.
		 */
		requestToolsFor?(model: Model, revision?: number): RequestTools;
	};
	readonly skills?: readonly ContextSkill[];
	/** Provider-facing, session-frozen descriptions when available. */
	readonly renderedSkills?: readonly ContextSkill[];
	/** Whether the session's credential for `model`'s provider is an OAuth login, which shapes some requests. */
	usesOAuth?(model: Model): boolean;
}

/** Shared empty system-prompt part list, avoiding an allocation per render. */
export const EMPTY_STRING_PARTS: string[] = [];
const EMPTY_TOOLS: readonly ContextTool[] = [];
const EMPTY_SKILLS: readonly ContextSkill[] = [];

/**
 * Skills actually rendered into the system prompt, mirroring the filter in
 * `buildSystemPrompt` (`system-prompt.ts`): the `read` tool must be present so
 * the model can fetch skill content, and skills with frontmatter `hide: true`
 * (or `disable-model-invocation`, normalized onto `hide`) are excluded.
 * Accounting must count only these so the Skills category and the System-prompt
 * subtraction stay aligned with the provider-facing prompt.
 */
function renderedSkills(skills: readonly ContextSkill[], tools: readonly ContextTool[]): readonly ContextSkill[] {
	if (!tools.some(tool => tool.name === "read")) return EMPTY_SKILLS;
	return skills.filter(skill => skill.hide !== true);
}

export function estimateSkillsTokens(skills: readonly ContextSkill[], tokenizer: Tokenizer): number {
	const fragments: string[] = [];
	for (const skill of skills) {
		// "- name: description\n" wire framing tokenizes ~identically to the
		// concatenated form, so encode each piece separately and sum.
		fragments.push(skill.name, skill.description ?? "");
	}
	return tokenizer.countTokens(fragments);
}

type ToolRoster = readonly ContextTool[];

/**
 * Per-roster metadata revisions. Tool arrays are caller-owned and may be
 * frozen, so a WeakMap is the only safe place to keep them without changing
 * their observable shape.
 */
const TOOL_METADATA_REVISIONS = new WeakMap<ToolRoster, number>();

/**
 * Current dynamic metadata revision for one tool roster.
 *
 * Consumers caching a larger context breakdown must key on both the tools
 * array identity and this revision. Array replacement covers roster changes;
 * {@link invalidateToolSchemaMetadata} covers live description/schema changes
 * while the roster object remains stable.
 */
export function getToolSchemaMetadataRevision(tools: ToolRoster): number {
	return TOOL_METADATA_REVISIONS.get(tools) ?? 0;
}

/**
 * Invalidate token estimates after a live tool description or parameter schema
 * can change without replacing the tools array (settings, model, policy, or
 * discovered-agent metadata changes).
 */
export function invalidateToolSchemaMetadata(tools: ToolRoster): void {
	TOOL_METADATA_REVISIONS.set(tools, getToolSchemaMetadataRevision(tools) + 1);
}

/** The system texts and tool definitions a session's next request carries, as its provider adapter encodes them. */
export interface EncodedNonMessagePrefix extends RequestPrefix {
	/** An owned dialect's tool definitions, rendered in-band after the system prompt. */
	inbandToolPrompt?: string;
}

// The per-turn threshold and compaction paths call these helpers repeatedly.
// Cache by prompt, roster, metadata and settings revisions, skills, tokenizer,
// model, credential kind and the agent's sent-tool definitions;
// setSystemPrompt/setTools replace their arrays rather than mutating them.
interface NonMessageTokenCache {
	systemPromptRef: readonly string[];
	toolsRef: ToolRoster;
	toolsRevision: number;
	sourceRevision: number;
	/** Revision handed to `requestToolsFor`, advanced whenever the metadata or settings revision moves. */
	requestToolsRevision: number;
	requestToolsRef: RequestTools | undefined;
	modelRef: Model | undefined;
	usesOAuth: boolean;
	skillful: boolean;
	skillsRef: readonly ContextSkill[];
	// The Agent swaps its Tokenizer instance when the model's encoding changes,
	// so instance identity doubles as the encoding key.
	tokenizerRef: Tokenizer;
	prefix: EncodedNonMessagePrefix | undefined;
	prefixTokens: { systemTokens: number; toolsTokens: number } | undefined;
	breakdown:
		| {
				skillsTokens: number;
				toolsTokens: number;
				systemContextTokens: number;
				systemPromptTokens: number;
		  }
		| undefined;
}

const NON_MESSAGE_TOKEN_CACHE = Symbol("non-message-token-cache");

interface CachedNonMessageTokenSource extends NonMessageTokenSource {
	[NON_MESSAGE_TOKEN_CACHE]?: NonMessageTokenCache;
}

function nonMessageTokenCacheEntry(
	session: NonMessageTokenSource,
	tokenizer: Tokenizer,
	sourceRevision: number,
	model: Model | undefined,
): NonMessageTokenCache {
	const cachedSession: CachedNonMessageTokenSource = session;
	const systemPromptRef = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const toolsRef = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const toolsRevision = getToolSchemaMetadataRevision(toolsRef);
	const skillsRef = session.renderedSkills ?? session.skills ?? EMPTY_SKILLS;
	const usesOAuth = model !== undefined && session.usesOAuth?.(model) === true;
	let entry = cachedSession[NON_MESSAGE_TOKEN_CACHE];
	const requestToolsRevision =
		entry?.toolsRevision === toolsRevision && entry.sourceRevision === sourceRevision
			? entry.requestToolsRevision
			: (entry?.requestToolsRevision ?? 0) + 1;
	const requestToolsRef = model ? requestToolsOf(session, model, requestToolsRevision) : undefined;
	if (
		entry &&
		entry.systemPromptRef === systemPromptRef &&
		entry.toolsRef === toolsRef &&
		entry.toolsRevision === toolsRevision &&
		entry.sourceRevision === sourceRevision &&
		entry.requestToolsRef === requestToolsRef &&
		entry.modelRef === model &&
		entry.usesOAuth === usesOAuth &&
		entry.skillsRef === skillsRef &&
		entry.tokenizerRef === tokenizer
	) {
		return entry;
	}
	entry = {
		systemPromptRef,
		toolsRef,
		toolsRevision,
		sourceRevision,
		requestToolsRevision,
		requestToolsRef,
		modelRef: model,
		usesOAuth,
		skillful: true,
		skillsRef,
		tokenizerRef: tokenizer,
		prefix: undefined,
		prefixTokens: undefined,
		breakdown: undefined,
	};
	cachedSession[NON_MESSAGE_TOKEN_CACHE] = entry;
	return entry;
}

/** The loop's tool definitions for `model`, or none when a tool's schema defeats normalization (the roster is counted). */
function requestToolsOf(session: NonMessageTokenSource, model: Model, revision: number): RequestTools | undefined {
	try {
		return session.agent?.requestToolsFor?.(model, revision);
	} catch {
		// A schema that cannot be walked (cyclic, function-valued) fails the request the same way.
		return undefined;
	}
}

function encodedPrefixOf(entry: NonMessageTokenCache): EncodedNonMessagePrefix {
	if (entry.prefix) return entry.prefix;
	const tools = entry.requestToolsRef?.tools ?? Array.from(entry.toolsRef);
	// An extension can leave a system-prompt section undefined at runtime (issue #9331).
	const systemPrompt = entry.systemPromptRef.filter(part => typeof part === "string");
	const prefix: EncodedNonMessagePrefix = encodeRequestPrefix(entry.modelRef, systemPrompt, tools, {
		isOAuth: entry.usesOAuth,
	});
	const inbandToolPrompt = entry.requestToolsRef?.inbandToolPrompt;
	if (inbandToolPrompt !== undefined) prefix.inbandToolPrompt = inbandToolPrompt;
	entry.prefix = prefix;
	return prefix;
}

function prefixTokensOf(entry: NonMessageTokenCache): { systemTokens: number; toolsTokens: number } {
	if (entry.prefixTokens) return entry.prefixTokens;
	const prefix = encodedPrefixOf(entry);
	const tokenizer = entry.tokenizerRef;
	// Server-side deferred catalogs carry no schemas in context.
	const toolsTokens =
		entry.modelRef?.toolSchemasInContext === false
			? 0
			: tokenizer.countTokens(prefix.tools.map(tool => tool.definition)) +
				(prefix.inbandToolPrompt === undefined ? 0 : tokenizer.countTokens(prefix.inbandToolPrompt));
	entry.prefixTokens = { systemTokens: tokenizer.countTokens(prefix.system), toolsTokens };
	return entry.prefixTokens;
}

/**
 * The system texts and tool definitions the session's next request to `model`
 * carries, as its provider adapter encodes them; cached like the token counts.
 */
export function encodeNonMessagePrefix(
	session: NonMessageTokenSource,
	tokenizer: Tokenizer,
	sourceRevision = 0,
	model: Model | undefined = session.model,
): EncodedNonMessagePrefix {
	return encodedPrefixOf(nonMessageTokenCacheEntry(session, tokenizer, sourceRevision, model));
}

/** Tool-definition tokens the request to `model` carries, as its adapter encodes them; 0 for server-side deferred catalogs. */
export function estimateContextToolSchemaTokens(
	session: NonMessageTokenSource,
	tokenizer: Tokenizer,
	sourceRevision = 0,
	model: Model | undefined = session.model,
): number {
	return prefixTokensOf(nonMessageTokenCacheEntry(session, tokenizer, sourceRevision, model)).toolsTokens;
}

/**
 * Compute just the NON-MESSAGE token total: the system texts and tool
 * definitions the provider adapter encodes for the session's model.
 *
 * Exposed so callers like `StatusLineComponent` can cache the non-message
 * total separately from the growing message total. A model switch changes the
 * adapter, and with it the encoded prefix, without changing the roster.
 */
export function computeNonMessageTokens(
	session: NonMessageTokenSource,
	tokenizer: Tokenizer,
	sourceRevision = 0,
): number {
	const { systemTokens, toolsTokens } = prefixTokensOf(
		nonMessageTokenCacheEntry(session, tokenizer, sourceRevision, session.model),
	);
	return systemTokens + toolsTokens;
}

/**
 * Shared helper for the four non-message token totals used by
 * `computeContextBreakdown` (/context panel). The categories sum to
 * `computeNonMessageTokens`: tools are the encoded definitions; system context
 * is the system prompt after its first part; skills come out of the encoded
 * system text, and the rest of it (adapter-added identity text included) is
 * the system prompt.
 */
export function computeNonMessageBreakdown(
	session: NonMessageTokenSource,
	tokenizer: Tokenizer,
	sourceRevision = 0,
	skillful = true,
): {
	skillsTokens: number;
	toolsTokens: number;
	systemContextTokens: number;
	systemPromptTokens: number;
} {
	const entry = nonMessageTokenCacheEntry(session, tokenizer, sourceRevision, session.model);
	if (entry.breakdown && entry.skillful === skillful) return entry.breakdown;
	const { systemTokens, toolsTokens } = prefixTokensOf(entry);
	const skillsTokens =
		skillful === false ? 0 : estimateSkillsTokens(renderedSkills(entry.skillsRef, entry.toolsRef), tokenizer);
	const systemContextTokens = Math.min(
		systemTokens,
		tokenizer.countTokens(Array.from(entry.systemPromptRef.slice(1), part => part ?? "")),
	);
	const systemPromptTokens = Math.max(0, systemTokens - systemContextTokens - skillsTokens);
	const breakdown = { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens };
	entry.skillful = skillful;
	entry.breakdown = breakdown;
	return breakdown;
}

/**
 * Compute a breakdown of estimated context usage by category for the active
 * session and model.
 */
export function computeContextBreakdown(session: ContextUsageSession, options: ContextUsageOptions): ContextBreakdown {
	const model = session.model;
	const tokenizer = session.agent.tokenizer;
	const contextWindow = model?.contextWindow ?? 0;

	const breakdown = typeof session.getContextBreakdown === "function" ? session.getContextBreakdown() : undefined;

	let messagesTokens = 0;
	let skillsTokens = 0;
	let toolsTokens = 0;
	let systemContextTokens = 0;
	let systemPromptTokens = 0;
	let usedTokens = 0;

	if (breakdown) {
		messagesTokens = breakdown.messagesTokens;
		skillsTokens = breakdown.skillsTokens;
		toolsTokens = breakdown.systemToolsTokens;
		systemContextTokens = breakdown.systemContextTokens;
		systemPromptTokens = breakdown.systemPromptTokens;
		usedTokens = breakdown.usedTokens;
	} else {
		// Category split needs a messages-only number, so this walk stays local:
		// an anchored total folds the system prompt and tool schemas into it.
		messagesTokens = tokenizer.countMessages(session.messages ?? []);
		const nonMessage = computeNonMessageBreakdown(session, tokenizer, options.sourceRevision, options.skillful);
		skillsTokens = nonMessage.skillsTokens;
		toolsTokens = nonMessage.toolsTokens;
		systemContextTokens = nonMessage.systemContextTokens;
		systemPromptTokens = nonMessage.systemPromptTokens;
		usedTokens = skillsTokens + toolsTokens + systemContextTokens + systemPromptTokens + messagesTokens;
	}

	const categories: CategoryInfo[] = [
		{ id: "systemPrompt", label: "System prompt", tokens: systemPromptTokens },
		{ id: "systemTools", label: "System tools", tokens: toolsTokens },
		{ id: "systemContext", label: "System context", tokens: systemContextTokens },
		{ id: "skills", label: "Skills", tokens: skillsTokens },
		{ id: "messages", label: "Messages", tokens: messagesTokens },
	];

	let autoCompactBufferTokens = 0;
	let thresholdTokens: number | undefined;
	if (contextWindow > 0) {
		const compactionSettings = options.compaction;
		if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
			const threshold = resolveThresholdTokens(contextWindow, compactionSettings);
			if (threshold > 0 && threshold <= contextWindow) thresholdTokens = threshold;
			autoCompactBufferTokens = Math.max(0, contextWindow - threshold);
		} else {
			autoCompactBufferTokens = 0;
		}
		// Even when fully disabled, fall back to a sensible reserve floor for display.
		if (autoCompactBufferTokens === 0 && compactionSettings.enabled) {
			autoCompactBufferTokens = effectiveReserveTokens(contextWindow, compactionSettings);
		}
	}
	autoCompactBufferTokens = Math.min(autoCompactBufferTokens, Math.max(0, contextWindow - usedTokens));

	const freeTokens = Math.max(0, contextWindow - usedTokens - autoCompactBufferTokens);

	return {
		model,
		contextWindow,
		categories,
		usedTokens,
		autoCompactBufferTokens,
		freeTokens,
		thresholdTokens,
		snapcompact: options.snapcompact,
	};
}
