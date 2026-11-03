/**
 * Contract: non-message accounting counts the system texts and tool
 * definitions the provider adapter encodes for the request, not omp's own
 * tool objects.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { Agent, type AgentTool, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { normalizeTools } from "@oh-my-pi/pi-agent-core/agent-loop";
import {
	compactionContextTokens,
	DEFAULT_COMPACTION_SETTINGS,
	shouldCompact,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { Tool } from "@oh-my-pi/pi-ai";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { arkToWireSchema, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import {
	type NonMessageTokenSource,
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	encodeNonMessagePrefix,
	estimateContextToolSchemaTokens,
	estimateSkillsTokens,
	getToolSchemaMetadataRevision,
	invalidateToolSchemaMetadata,
} from "../src/status-line/context-usage";

const tokenizer = new Tokenizer();

const claudeSpec: ModelSpec<"anthropic-messages"> = {
	id: "claude-opus-5-5",
	name: "Claude Opus",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8192,
};

/** Tokens of the `{name, description, parameters}` JSON the encoder falls back to without an adapter. */
function genericToolTokens(tools: readonly Tool[]): number {
	return tokenizer.countTokens(
		tools.map(tool =>
			JSON.stringify({ name: tool.name, description: tool.description, parameters: toolWireSchema(tool) }),
		),
	);
}

/** A session whose one tool has a runtime shape the types rule out, as an extension can hand over. */
function untypedRoster(tool: unknown): NonMessageTokenSource {
	return { systemPrompt: [], agent: { state: { tools: [tool] } } } as NonMessageTokenSource;
}

describe("encoded request prefix", () => {
	it("counts the tool definitions and system blocks a Claude OAuth request carries", async () => {
		const model = buildModel(claudeSpec);
		const grep: AgentTool = {
			name: "grep",
			label: "Grep",
			description: "Search files by regex.",
			parameters: type({ "pattern /** regular expression to search for */": "string", "path?": "string" }),
			examples: [{ caption: "Find TODOs", call: { pattern: "TODO", path: "src" } }],
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		// Capture the body the adapter builds from the loop's own provider context; nothing is sent.
		let payload: { system: { text: string }[]; tools: Record<string, unknown>[] } | undefined;
		const agent = new Agent({
			initialState: { model, systemPrompt: ["You are a test agent."], tools: [grep] },
			intentTracing: true,
			getApiKey: () => "sk-ant-oat-test",
			streamFn: (streamModel, context, options) =>
				streamAnthropic(streamModel as Model<"anthropic-messages">, context, {
					...options,
					apiKey: "sk-ant-oat-test",
					isOAuth: true,
					signal: AbortSignal.abort(),
					onPayload: body => {
						payload = body as typeof payload;
					},
				}),
		});
		await agent.prompt("hi").catch(() => undefined);
		if (!payload) throw new Error("the adapter built no request body");

		// Cache breakpoints are request metadata, not prompt text.
		const wireTools = payload.tools.map(({ cache_control: _cacheControl, ...tool }) => JSON.stringify(tool));
		expect(wireTools.join("")).toContain('"name":"_grep"');
		const session: NonMessageTokenSource = {
			model,
			systemPrompt: agent.state.systemPrompt,
			agent,
			usesOAuth: () => true,
		};
		const toolTokens = estimateContextToolSchemaTokens(session, tokenizer);
		expect(toolTokens).toBe(tokenizer.countTokens(wireTools));
		// The billing header's fingerprint hashes the first user turn, which the prefix cannot know.
		const systemTokens = tokenizer.countTokens(payload.system.map(block => block.text));
		expect(Math.abs(computeNonMessageTokens(session, tokenizer) - toolTokens - systemTokens)).toBeLessThanOrEqual(2);
		expect(encodeNonMessagePrefix(session, tokenizer).system[1]).toBe(payload.system[1]!.text);
	});

	it("counts arktype tool schemas by their wire JSON Schema, not arktype internals", () => {
		const parameters = type({
			"query /** search query */": "string",
			"limit?": "number",
		});
		const arktype: NonMessageTokenSource = {
			systemPrompt: [],
			agent: { state: { tools: [{ name: "web_search", description: "Searches the web.", parameters }] } },
		};
		const wire: NonMessageTokenSource = {
			systemPrompt: [],
			agent: {
				state: {
					tools: [
						{ name: "web_search", description: "Searches the web.", parameters: arkToWireSchema(parameters) },
					],
				},
			},
		};
		expect(computeNonMessageTokens(arktype, tokenizer)).toBe(computeNonMessageTokens(wire, tokenizer));
	});

	it("keeps a tool's own strings when its parameters cannot be serialized", () => {
		const session = untypedRoster({ name: "odd", description: "odd tool", parameters: function bareSchema() {} });
		expect(computeNonMessageTokens(session, tokenizer)).toBe(
			tokenizer.countTokens(JSON.stringify({ name: "odd", description: "odd tool" })),
		);
	});

	it("tolerates a tool without a description", () => {
		const session = untypedRoster({ name: "odd", description: undefined, parameters: { type: "object" } });
		expect(computeNonMessageTokens(session, tokenizer)).toBeGreaterThan(0);
	});

	it("does not reread dynamic metadata until its explicit revision changes", () => {
		let description = "short";
		let reads = 0;
		const tool = {
			name: "dynamic",
			get description() {
				reads++;
				return description;
			},
			parameters: {},
		};
		const tools = [tool];
		const session: NonMessageTokenSource = { systemPrompt: [], agent: { state: { tools } } };
		const first = computeNonMessageTokens(session, tokenizer);
		expect(reads).toBe(1);
		expect(computeNonMessageTokens(session, tokenizer)).toBe(first);
		expect(reads).toBe(1);

		description = "a substantially longer dynamic description after a live policy update";
		invalidateToolSchemaMetadata(tools);
		expect(getToolSchemaMetadataRevision(tools)).toBe(1);
		expect(computeNonMessageTokens(session, tokenizer)).toBeGreaterThan(first);
		expect(reads).toBe(2);
	});

	it("separates roster, tokenizer and source-revision cache keys", () => {
		let reads = 0;
		const tool = {
			name: "dynamic",
			get description() {
				reads++;
				return "metadata";
			},
			parameters: {},
		};
		const state = { tools: [tool] };
		const session: NonMessageTokenSource = { systemPrompt: [], agent: { state } };
		computeNonMessageTokens(session, tokenizer, 1);
		computeNonMessageTokens(session, tokenizer, 1);
		expect(reads).toBe(1);

		computeNonMessageTokens(session, tokenizer, 2);
		expect(reads).toBe(2);
		state.tools = [tool];
		computeNonMessageTokens(session, tokenizer, 2);
		expect(reads).toBe(3);
		computeNonMessageTokens(session, new Tokenizer(), 2);
		expect(reads).toBe(4);
	});
});

describe("pruned tool description accounting", () => {
	// With the catalog inlined into the system prompt, normalizeTools ships each
	// tool as its name plus the description-stripped schema. Counting the full
	// specs again double-counts every description (issue #17329).
	const tools: AgentTool[] = [
		{
			name: "grep",
			label: "Grep",
			description: `Search files by regex. ${"Supports globs, context lines, and multiline patterns. ".repeat(20)}`,
			parameters: type({
				"pattern /** regular expression to search for */": "string",
				"path? /** file or directory to search */": "string",
			}),
			examples: [{ caption: "Find TODOs", call: { pattern: "TODO", path: "src" } }],
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		},
	];
	// An API without an adapter encoder: the loop's normalized tools are counted as generic JSON.
	const model = buildModel({
		...claudeSpec,
		api: "ollama-chat",
		provider: "ollama",
		baseUrl: "http://localhost:11434",
	});

	it("counts the pruned wire specs while the agent prunes, and the full specs otherwise", () => {
		const systemPrompt = ["You are an assistant."];
		const agent = new Agent({ initialState: { model, tools }, pruneToolDescriptions: true });
		const session: NonMessageTokenSource = { model, systemPrompt, agent };
		const pruned = computeNonMessageBreakdown(session, tokenizer).toolsTokens;
		expect(pruned).toBe(
			genericToolTokens(normalizeTools(tools, { injectIntent: false, pruneDescriptions: true }) ?? []),
		);
		expect(computeNonMessageTokens(session, tokenizer)).toBe(tokenizer.countTokens(systemPrompt) + pruned);

		// The prune setting flips on the live agent without replacing the roster.
		agent.pruneToolDescriptions = false;
		const full = computeNonMessageBreakdown(session, tokenizer).toolsTokens;
		expect(full).toBe(genericToolTokens(normalizeTools(tools, { injectIntent: false }) ?? []));
		expect(full).toBeGreaterThan(pruned);
		expect(computeNonMessageTokens(session, tokenizer)).toBe(tokenizer.countTokens(systemPrompt) + full);
	});
});

describe("deferred tool schema accounting", () => {
	it("does not let Cursor's server-side MCP catalog force compaction below provider usage", () => {
		const directModel = buildModel(claudeSpec);
		const cursorModel = buildModel({ ...claudeSpec, api: "cursor-agent", provider: "cursor" });
		const tools = Array.from({ length: 200 }, (_, index) => ({
			name: `mcp__service__tool_${index}`,
			description: `Search records ${"search account records with detailed query filters and output metadata ".repeat(110)}`,
			parameters: type({ query: "string" }),
		}));
		const systemPrompt = ["You are an assistant."];
		const session: NonMessageTokenSource & { model: Model } = {
			model: directModel,
			systemPrompt,
			agent: { state: { tools } },
		};
		const direct = computeNonMessageTokens(session, tokenizer);
		expect(shouldCompact(compactionContextTokens(9000, direct), 100_000, DEFAULT_COMPACTION_SETTINGS)).toBe(true);

		session.model = cursorModel;
		const cursor = computeNonMessageTokens(session, tokenizer);
		expect(cursor).toBe(tokenizer.countTokens(systemPrompt));
		expect(computeNonMessageBreakdown(session, tokenizer).toolsTokens).toBe(0);
		expect(shouldCompact(compactionContextTokens(9000, cursor), 100_000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);

		session.model = directModel;
		expect(computeNonMessageTokens(session, tokenizer)).toBe(direct);
	});
});

/**
 * Contract: the non-message token totals reflect the CURRENT system prompt,
 * tools, and skills — including after they change via reference replacement
 * (the setSystemPrompt/setTools pattern), and stay stable while those inputs
 * hold the same identity. The memo must never serve a stale value for changed
 * inputs.
 */
describe("computeNonMessageTokens / computeNonMessageBreakdown memoization", () => {
	function makeSession(systemPrompt: string[], tools: unknown[] = [], skills: unknown[] = []) {
		return { systemPrompt, agent: { state: { tools } }, skills };
	}

	it("recomputes when the system prompt reference changes and caches otherwise", () => {
		const session = makeSession(["system prompt alpha"]);
		const first = computeNonMessageTokens(session as never, tokenizer);
		// Same inputs (identical refs) → cached, identical value.
		expect(computeNonMessageTokens(session as never, tokenizer)).toBe(first);
		// Replace the system prompt reference (mirrors setSystemPrompt).
		session.systemPrompt = ["system prompt beta with more tokens than alpha"];
		const afterChange = computeNonMessageTokens(session as never, tokenizer);
		expect(afterChange).toBeGreaterThan(first);
		// Cached on the new inputs.
		expect(computeNonMessageTokens(session as never, tokenizer)).toBe(afterChange);
	});

	it("recomputes the breakdown when the tools reference changes", () => {
		const session = makeSession(["base"], []);
		const before = computeNonMessageBreakdown(session as never, tokenizer);
		expect(before.toolsTokens).toBe(0);
		// New tools array reference (mirrors setTools).
		session.agent.state.tools = [{ name: "search", description: "search the web", parameters: {} }];
		const after = computeNonMessageBreakdown(session as never, tokenizer);
		expect(after.toolsTokens).toBeGreaterThan(0);
		// Cached on the new tools.
		expect(computeNonMessageBreakdown(session as never, tokenizer).toolsTokens).toBe(after.toolsTokens);
	});

	it("shares one cache entry so tokens and breakdown invalidate together", () => {
		const session = makeSession(["shared prompt"]);
		const tokens = computeNonMessageTokens(session as never, tokenizer);
		const breakdown = computeNonMessageBreakdown(session as never, tokenizer);
		// Changing the system prompt ref must invalidate BOTH fields, not just
		// the one most recently touched.
		session.systemPrompt = ["shared prompt but longer now to shift the count"];
		expect(computeNonMessageTokens(session as never, tokenizer)).not.toBe(tokens);
		expect(computeNonMessageBreakdown(session as never, tokenizer).systemPromptTokens).not.toBe(
			breakdown.systemPromptTokens,
		);
	});

	it("invalidates settings-backed dynamic descriptions on the settings revision", () => {
		let description = "short";
		const tool = {
			name: "dynamic",
			get description() {
				return description;
			},
			parameters: {},
		};
		const session = {
			...makeSession(["base"], [tool]),
			settings: { revision: 1, get: () => true },
		};
		const first = computeNonMessageBreakdown(session as never, tokenizer, session.settings.revision).toolsTokens;
		description = "a longer settings-backed description after a live update";
		session.settings.revision++;
		expect(
			computeNonMessageBreakdown(session as never, tokenizer, session.settings.revision).toolsTokens,
		).toBeGreaterThan(first);
	});
});

/**
 * Contract: the Skills category counts only skills actually rendered into the
 * system prompt (mirroring `buildSystemPrompt`'s filter) — hidden/explicit-only
 * skills, and every skill when the `read` tool is absent, contribute zero. The
 * System-prompt subtraction must not be inflated by unrendered skill metadata
 * and clamped to 0 (issue #6498).
 */
describe("computeNonMessageBreakdown skills filtering", () => {
	const readTool = { name: "read", description: "read files", parameters: {} };
	const hidden = { name: "hidden-skill", description: "X".repeat(4000), filePath: "/s/h.md", hide: true };
	const visible = { name: "vis", description: "small visible skill", filePath: "/s/v.md" };
	// First prompt block as rendered: only the visible skill appears.
	const renderedPrompt = "You are an agent.\nSkills:\n- vis: small visible skill\n";

	function session(tools: unknown[], skills: unknown[]) {
		return { systemPrompt: [renderedPrompt], agent: { state: { tools } }, skills } as never;
	}

	it("excludes hidden skills and does not clamp System prompt to 0", () => {
		const b = computeNonMessageBreakdown(session([readTool], [hidden, visible]), tokenizer);
		// Only the visible skill is counted, not the large hidden one.
		expect(b.skillsTokens).toBe(computeNonMessageBreakdown(session([readTool], [visible]), tokenizer).skillsTokens);
		expect(b.skillsTokens).toBeLessThan(100);
		expect(b.systemPromptTokens).toBeGreaterThan(0);
	});

	it("counts zero Skills tokens when the read tool is unavailable", () => {
		const b = computeNonMessageBreakdown(session([], [hidden, visible]), tokenizer);
		expect(b.skillsTokens).toBe(0);
		expect(b.systemPromptTokens).toBe(computeNonMessageBreakdown(session([], []), tokenizer).systemPromptTokens);
	});

	it("counts frozen rendered descriptions, not full source descriptions", () => {
		const full = { ...visible, description: "Use this skill for browser tasks. ".repeat(50) };
		const rendered = { ...visible, description: "Use for interactive browser tasks." };
		const promptText = `You are an agent.\nSkills:\n- vis: ${rendered.description}\n`;
		const source = {
			systemPrompt: [promptText],
			agent: { state: { tools: [readTool] } },
			skills: [full],
			renderedSkills: [rendered],
		};
		const b = computeNonMessageBreakdown(source as never, tokenizer);
		expect(b.skillsTokens).toBe(estimateSkillsTokens([rendered], tokenizer));
		expect(b.skillsTokens).toBeLessThan(estimateSkillsTokens([full], tokenizer));
		expect(b.systemPromptTokens + b.skillsTokens).toBe(tokenizer.countTokens(promptText));
	});
});

/**
 * Contract: a tool, skill, or system-prompt section with a missing
 * (`undefined`) description/text must not crash the token estimate. Extensions
 * can contribute tools whose `description` is absent at runtime (the field is
 * typed `string` but the extension API does not enforce it); before the guard,
 * the `undefined` fragment reached the tokenizer and threw, killing every
 * subagent before its first turn (issue #9331). Each path must instead yield a
 * finite, non-negative estimate.
 */
describe("non-message estimates tolerate a missing description", () => {
	const readTool = { name: "read", description: "read files", parameters: {} };

	it("computeNonMessageBreakdown does not throw on an undefined skill description", () => {
		const session = {
			systemPrompt: ["You are an agent."],
			agent: { state: { tools: [readTool] } },
			skills: [{ name: "lens", description: undefined, filePath: "/s/l.md" }],
		} as never;
		const b = computeNonMessageBreakdown(session, tokenizer);
		expect(Number.isFinite(b.skillsTokens)).toBe(true);
		expect(b.skillsTokens).toBeGreaterThanOrEqual(0);
	});

	it("computeNonMessageBreakdown does not throw on an undefined system-context section", () => {
		const session = {
			systemPrompt: ["primary prompt", undefined, "trailing context"],
			agent: { state: { tools: [readTool] } },
			skills: [],
		} as never;
		const b = computeNonMessageBreakdown(session, tokenizer);
		expect(Number.isFinite(b.systemContextTokens)).toBe(true);
		expect(b.systemContextTokens).toBeGreaterThanOrEqual(0);
	});
});
