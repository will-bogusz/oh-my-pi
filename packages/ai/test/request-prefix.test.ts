import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { encodeRequestPrefix } from "../src/request-prefix";
import { stream } from "../src/stream";
import type { Api, Context, Model, Tool } from "../src/types";
import { factoryModel, workosJwt } from "./helpers/factory-droid";

const systemPrompt = ["You are a test agent.", "<project-context>\nrepo notes\n</project-context>"];
const tools: Tool[] = [
	{
		name: "read",
		description: "Read a file.",
		parameters: type({ "path /** file to read */": "string", "limit?": "number" }),
	},
	{
		name: "edit",
		description: "Edit a file.",
		parameters: type({ path: "string", patch: "string" }),
		strict: true,
	},
];

type Payload = Record<string, unknown>;

/** The request body the adapter builds for one turn; the request is aborted before it is sent. */
async function capturePayload(model: Model<Api>, apiKey: string, isOAuth?: boolean): Promise<Payload> {
	const context: Context = { systemPrompt, messages: [{ role: "user", content: "hi", timestamp: 1 }], tools };
	let payload: Payload | undefined;
	const controller = new AbortController();
	// Gemini checks the signal before it builds the body, so its request is aborted once the body exists.
	if (model.api !== "google-generative-ai") controller.abort();
	const events = stream(model, context, {
		apiKey,
		isOAuth,
		signal: controller.signal,
		onPayload: (body: unknown) => {
			payload ??= body as Payload;
			controller.abort();
		},
		fetch: async () => Response.json({ error: { message: "captured" } }, { status: 400 }),
	});
	await events.result().catch(() => undefined);
	if (!payload) throw new Error(`${model.provider}/${model.id} built no request body`);
	return payload;
}

type TextPart = { text?: string };
type InputItem = { role?: string; content?: string | TextPart[] };

function texts(content: string | TextPart[] | undefined): string[] {
	if (typeof content === "string") return [content];
	return (content ?? []).map(part => part.text ?? "");
}

function wirePrefix(payload: Payload): { system: string[]; tools: string[] } {
	// Gemini hands `onPayload` its SDK parameters, which carry the system instruction and tools in `config`.
	const body = (payload.config as Payload | undefined) ?? payload;
	const system: string[] = [];
	if (Array.isArray(body.system)) system.push(...texts(body.system as TextPart[]));
	if (typeof body.instructions === "string") system.push(body.instructions);
	const systemInstruction = body.systemInstruction as { parts: TextPart[] } | undefined;
	if (systemInstruction) system.push(...texts(systemInstruction.parts));
	for (const item of ((payload.input ?? payload.messages) as InputItem[] | undefined) ?? []) {
		if (item.role === "system" || item.role === "developer") system.push(...texts(item.content));
	}
	const declared = (body.tools ?? []) as Record<string, unknown>[];
	const definitions = declared.flatMap(tool =>
		Array.isArray(tool.functionDeclarations) ? (tool.functionDeclarations as Record<string, unknown>[]) : [tool],
	);
	// Cache breakpoints are request metadata, not prompt text.
	return { system, tools: definitions.map(({ cache_control: _cacheControl, ...tool }) => JSON.stringify(tool)) };
}

function encoded(model: Model<Api>, isOAuth?: boolean): { system: string[]; tools: string[] } {
	const prefix = encodeRequestPrefix(model, systemPrompt, tools, { isOAuth });
	return { system: prefix.system, tools: prefix.tools.map(tool => tool.definition) };
}

describe("encodeRequestPrefix", () => {
	const cases: Array<{ label: string; model: () => Model<Api>; apiKey: string; isOAuth?: boolean }> = [
		{
			label: "Anthropic OAuth",
			model: () => getBundledModel("anthropic", "claude-opus-5-5"),
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
		},
		{
			label: "Anthropic API key",
			model: () => getBundledModel("anthropic", "claude-opus-5-5"),
			apiKey: "sk-ant-api-test",
			isOAuth: false,
		},
		// The request option wins over the model's own flag, as in the stream dispatcher.
		{
			label: "Anthropic, OAuth model with an API-key option",
			model: () => ({ ...getBundledModel("anthropic", "claude-opus-5-5"), isOAuth: true }),
			apiKey: "sk-ant-api-test",
			isOAuth: false,
		},
		{
			label: "Anthropic, API-key model with an OAuth option",
			model: () => ({ ...getBundledModel("anthropic", "claude-opus-5-5"), isOAuth: false }),
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
		},
		{ label: "OpenAI Responses", model: () => getBundledModel("openai", "gpt-5.1"), apiKey: "sk-test" },
		{
			label: "OpenRouter",
			model: () => getBundledModel("openrouter", "anthropic/claude-3.5-haiku"),
			apiKey: "sk-or-test",
		},
		{ label: "Codex", model: () => getBundledModel("openai-codex", "gpt-6.1-sol"), apiKey: "codex-test" },
		{ label: "Chat Completions", model: () => getBundledModel("deepseek", "deepseek-v4-pro"), apiKey: "sk-test" },
		{ label: "Gemini", model: () => getBundledModel("google", "gemini-2.5-pro"), apiKey: "google-test" },
		{ label: "Factory GLM", model: () => factoryModel("glm-5.3"), apiKey: workosJwt({ external_org_id: "org-1" }) },
		{ label: "Factory Kimi", model: () => factoryModel("kimi-k3"), apiKey: workosJwt({ external_org_id: "org-1" }) },
		{
			label: "Factory Gemini",
			model: () => factoryModel("gemini-3.8-flash"),
			apiKey: workosJwt({ external_org_id: "org-1" }),
		},
	];
	it.each(cases)("matches the request $label sends", async ({ model, apiKey, isOAuth }) => {
		const target = model();
		expect(encoded(target, isOAuth)).toEqual(wirePrefix(await capturePayload(target, apiKey, isOAuth)));
	});

	it("adds the Claude Code identity and tool-name prefix only for an OAuth credential", () => {
		const model = getBundledModel("anthropic", "claude-opus-5-5");
		const oauth = encodeRequestPrefix(model, systemPrompt, tools, { isOAuth: true });
		const apiKey = encodeRequestPrefix(model, systemPrompt, tools, { isOAuth: false });
		expect(oauth.system.slice(2)).toEqual(systemPrompt);
		expect(apiKey.system).toEqual(systemPrompt);
		expect(oauth.tools.map(tool => tool.name)).toEqual(["read", "edit"]);
		expect(oauth.tools[0]!.definition).toContain('"name":"_read"');
		expect(apiKey.tools[0]!.definition).toContain('"name":"read"');
	});

	it("serializes name, description and wire schema for an API without an encoder", () => {
		const model = { ...getBundledModel("anthropic", "claude-opus-5-5"), api: "ollama-chat" } as Model<Api>;
		const prefix = encodeRequestPrefix(model, systemPrompt, tools);
		expect(prefix.system).toEqual(systemPrompt);
		expect(JSON.parse(prefix.tools[0]!.definition)).toMatchObject({ name: "read", description: "Read a file." });
		expect(JSON.parse(prefix.tools[0]!.definition).parameters.properties.path.type).toBe("string");
	});
});
