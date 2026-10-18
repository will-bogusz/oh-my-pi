import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentMessage, agentLoop } from "@oh-my-pi/pi-agent-core";
import type { Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => removeWithRetries(directory)));
});

describe("bash and read in one assistant message", () => {
	it("reads the file the earlier bash call rewrote", async () => {
		const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-read-order-")));
		temporaryDirectories.push(directory);
		await Bun.write(path.join(directory, "f"), "old\n");
		const session = {
			cwd: directory,
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			getClientBridge: () => undefined,
		} as unknown as ToolSession;
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "sleep 0.2; echo new > f" } },
						{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "f" } },
					],
				},
				{ content: ["done"] },
			],
		});

		const messages = await agentLoop(
			[{ role: "user", content: "Rewrite f, then read it", timestamp: Date.now() }],
			{ systemPrompt: [""], messages: [], tools: [new BashTool(session), new ReadTool(session)] },
			{
				model: mock.model,
				convertToLlm: (all: AgentMessage[]) =>
					all.filter(
						message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
					) as Message[],
			},
			undefined,
			mock.stream,
		).result();

		const read = messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "read-1",
		);
		const text = read?.content.map(block => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("new");
		expect(text).not.toContain("old");
	});
});
