import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { encodeRequestPrefix } from "@oh-my-pi/pi-ai/request-prefix";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function bytes(s: string): number {
	return Buffer.byteLength(s, "utf-8");
}
function est(s: string): number {
	return (bytes(s) + 3) >> 2;
}

await Settings.init({ inMemory: true, cwd: process.cwd() });
const settings = Settings.isolated({});

// This standalone inspection script has no resolved catalog Model; its counts
// therefore intentionally use the runtime's default estimate policy.
const tokenizer = new Tokenizer();

const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings,
} as ToolSession;

const tools = await createTools(session);
const toolsMap = new Map<string, Tool>(tools.map(t => [t.name, t]));

console.log(`active tools (${tools.length}): ${tools.map(t => t.name).join(", ")}\n`);

// Without a model the encoder serializes each tool as `{name, description, parameters}` JSON.
const encodedTools = encodeRequestPrefix(undefined, undefined, tools).tools;
const rows: Array<{ name: string; descBytes: number; tok: number; schemaTok: number }> = [];
for (const encoded of encodedTools) {
	const description = toolsMap.get(encoded.name)?.description ?? "";
	const tok = tokenizer.countTokens(encoded.definition);
	rows.push({ name: encoded.name, descBytes: bytes(description), tok, schemaTok: tok - est(description) });
}
rows.sort((a, b) => b.tok - a.tok);

const totalTok = tokenizer.countTokens(encodedTools.map(encoded => encoded.definition));
console.log("per-tool tokens (sorted): name | total tok | desc bytes | ~schema tok");
for (const r of rows) {
	console.log(
		`  ${r.name.padEnd(20)} ${String(r.tok).padStart(6)}  ${String(r.descBytes).padStart(7)}  ${String(r.schemaTok).padStart(6)}`,
	);
}
console.log(`\nTOOLS TOTAL tokens: ${totalTok}\n`);

const built = await buildSystemPrompt({
	tools: toolsMap as never,
	toolNames: tools.map(t => t.name),
	inlineToolDescriptors: false,
	nativeTools: true,
	cwd: process.cwd(),
	skills: [],
	contextFiles: [],
	workspaceTree: { rootPath: process.cwd(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
});
const parts = built.systemPrompt;
const part0 = parts[0] ?? "";
const rest = parts.slice(1).join("\n");
console.log(`system prompt parts: ${parts.length}`);
console.log(`SYSTEM PROMPT tokens (part0, no skills): ${tokenizer.countTokens(part0)}  (bytes=${bytes(part0)})`);
console.log(`SYSTEM CONTEXT tokens (parts[1..]): ${tokenizer.countTokens(rest)}  (bytes=${bytes(rest)})`);
