import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	claimMail,
	deliveryTarget,
	isMailDone,
	listClaimedMail,
	listNewMail,
	MAX_MAIL_ATTEMPTS,
	newMailId,
	postMail,
	recordMailAttempt,
} from "@oh-my-pi/pi-coding-agent/mailbox/mailbox";
import { MAILBOX_DIR_ENV, MAILBOX_ENV, mailDir } from "@oh-my-pi/pi-coding-agent/mailbox/paths";
import { listSessionPresence } from "@oh-my-pi/pi-coding-agent/mailbox/presence";
import { SessionMailbox } from "@oh-my-pi/pi-coding-agent/mailbox/watcher";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { resolveCliEntryCmd } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import { firePayloadPath, TIMERS_DIR_ENV } from "@oh-my-pi/pi-coding-agent/timers/paths";
import { setTimer, timerRuns } from "@oh-my-pi/pi-coding-agent/timers/service";
import { closeTimerDbs, readTimerSpec, TimerDb } from "@oh-my-pi/pi-coding-agent/timers/store";
import { runTick } from "@oh-my-pi/pi-coding-agent/timers/tick";
import type { TimerSpec } from "@oh-my-pi/pi-coding-agent/timers/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const SESSION_STORAGE_MODULE = path.resolve(import.meta.dir, "../src/session/session-storage.ts");

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

/** The watcher polls once a second; generous enough for several polls. */
const DELIVERY_TIMEOUT_MS = 10_000;

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

/** Text of every message one model request carried, in order. */
function requestTexts(context: Context): string[] {
	return context.messages.map(message =>
		typeof message.content === "string"
			? message.content
			: message.content.map(part => ("text" in part ? part.text : "")).join(""),
	);
}

describe("session mailbox delivery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let previousRoot: string | undefined;
	let previousTimersRoot: string | undefined;
	let previousSwitch: string | undefined;
	let sessions: AgentSession[];
	let contexts: Context[];
	let release: PromiseWithResolvers<void>;
	let toolStarted: PromiseWithResolvers<void>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-session-mailbox-");
		previousRoot = Bun.env[MAILBOX_DIR_ENV];
		previousSwitch = Bun.env[MAILBOX_ENV];
		Bun.env[MAILBOX_DIR_ENV] = path.join(tempDir.path(), "mailbox");
		previousTimersRoot = Bun.env[TIMERS_DIR_ENV];
		Bun.env[TIMERS_DIR_ENV] = path.join(tempDir.path(), "timers");
		delete Bun.env[MAILBOX_ENV];
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
		sessions = [];
		contexts = [];
		release = Promise.withResolvers<void>();
		toolStarted = Promise.withResolvers<void>();
	});

	afterEach(async () => {
		release.resolve();
		for (const opened of sessions) await opened.dispose().catch(() => {});
		closeTimerDbs();
		authStorage.close();
		if (previousRoot === undefined) delete Bun.env[MAILBOX_DIR_ENV];
		else Bun.env[MAILBOX_DIR_ENV] = previousRoot;
		if (previousSwitch === undefined) delete Bun.env[MAILBOX_ENV];
		else Bun.env[MAILBOX_ENV] = previousSwitch;
		if (previousTimersRoot === undefined) delete Bun.env[TIMERS_DIR_ENV];
		else Bun.env[TIMERS_DIR_ENV] = previousTimersRoot;
		tempDir.removeSync();
	});

	/** A session file written by an earlier process, closed again. */
	async function savedSessionFile(): Promise<string> {
		const { session: first } = openSession();
		await first.prompt("seed");
		const file = first.sessionManager.getSessionFile()!;
		await first.dispose();
		contexts.length = 0;
		return file;
	}

	/**
	 * A session whose model calls `slow` when the prompt is "go", runs `omp timer set <id>` through the
	 * real bash tool when the prompt says `SET_TIMER:<id>` (a shell timer) or `WAKE_ME:<id>` (a prompt
	 * timer that wakes this session), and answers text otherwise.
	 */
	function openSession(
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions")),
		clientBridge?: ClientBridge,
	): { session: AgentSession; mailbox: SessionMailbox } {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async () => {
				toolStarted.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "SLOW_DONE" }] };
			},
		};
		const bashTool = new BashTool({
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated({ "bash.autoBackground.enabled": false, "bashInterceptor.enabled": false }),
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			// Called only once a tool runs, after `opened` below exists.
			getTimerRun: () => opened.getTimerRun(),
		}) as unknown as AgentTool;
		const timerCommand = (id: string, action: string[]) =>
			[...resolveCliEntryCmd(), "timer", "set", id, "--at", "in 1h", ...action, "--reason", "child"]
				.map(word => `'${word}'`)
				.join(" ");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [slowTool, bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const last = requestTexts(context).at(-1);
				const [, kind, timerId] = last?.match(/(SET_TIMER|WAKE_ME):([a-z0-9-]+)/) ?? [];
				const action =
					kind === "WAKE_ME"
						? ["--prompt", "look again", "--session", sessionManager.getSessionFile() ?? ""]
						: ["--shell", "true"];
				const call =
					last === "go"
						? { name: "slow", arguments: {} }
						: timerId
							? {
									name: "bash",
									arguments: {
										command: `OMP_TIMERS_DIR='${Bun.env[TIMERS_DIR_ENV]}' ${timerCommand(timerId, action)}`,
									},
								}
							: undefined;
				const message: AssistantMessage = {
					role: "assistant",
					content: call
						? [{ type: "toolCall", id: `tc-${contexts.length}`, ...call }]
						: [{ type: "text", text: "ok" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: call ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const mailbox = new SessionMailbox(sessionManager, { deliver: true, host: "test" });
		const opened = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([
				[slowTool.name, slowTool],
				[bashTool.name, bashTool],
			]),
		});
		opened.setClientBridge(clientBridge);
		mailbox.bind(opened);
		sessions.push(opened);
		return { session: opened, mailbox };
	}

	async function poke(sessionId: string, text: string, force?: boolean, id = newMailId("poke")): Promise<string> {
		await postMail({
			v: 1,
			id,
			kind: "poke",
			sessionId,
			createdAt: new Date().toISOString(),
			poke: { text, from: "test", force },
		});
		return id;
	}

	/** Whether another process could take the session's write lease now (the lease is shared within a process). */
	async function leaseFromAnotherProcess(sessionId: string): Promise<string> {
		const probe = path.join(tempDir.path(), "lease-probe.ts");
		await Bun.write(
			probe,
			`import { tryAcquireSessionLease } from ${JSON.stringify(SESSION_STORAGE_MODULE)};
			const lease = tryAcquireSessionLease(${JSON.stringify(sessionId)});
			console.log(lease ? "free" : "taken");
			lease?.release();`,
		);
		const child = Bun.spawn(["bun", probe], { env: { ...process.env }, stdout: "pipe" });
		return (await new Response(child.stdout).text()).trim();
	}

	/** Run a turn into the slow tool, then interrupt it the way Esc does. */
	async function interrupt(opened: AgentSession): Promise<void> {
		const run = opened.prompt("go");
		await toolStarted.promise;
		release.resolve();
		await opened.abort({ reason: USER_INTERRUPT_LABEL });
		await run.catch(() => {});
		await opened.waitForIdle();
		contexts.length = 0;
	}

	it("starts a turn in an idle session and records the mail as delivered", async () => {
		const { session: opened } = openSession();
		const sessionId = opened.sessionManager.getSessionId();
		expect(deliveryTarget(sessionId)).toMatchObject({ kind: "live", host: "test" });

		const mailId = await poke(sessionId, "BUILD_FINISHED");
		await until(() => isMailDone(sessionId, mailId), "the poke to reach the transcript");

		expect(contexts).toHaveLength(1);
		expect(requestTexts(contexts[0]!).at(-1)).toContain("BUILD_FINISHED");
	});

	it("after Esc, delivers a --force poke at once and holds a plain one for the user's next message, ahead of it in the same request", async () => {
		const { session: opened } = openSession();
		const sessionId = opened.sessionManager.getSessionId();
		await interrupt(opened);

		const heldId = await poke(sessionId, "HELD_POKE");
		const forcedId = await poke(sessionId, "FORCED_POKE", true);
		// Every poll that sees the forced poke also lists the held one, posted first.
		await until(() => isMailDone(sessionId, forcedId), "the forced poke to reach the transcript");
		expect(contexts).toHaveLength(1);
		expect(requestTexts(contexts[0]!).at(-1)).toContain("FORCED_POKE");
		expect(listNewMail(sessionId)).toEqual([`${heldId}.json`]);

		await opened.prompt("NEXT_USER_MESSAGE");
		expect(contexts).toHaveLength(2);
		const texts = requestTexts(contexts[1]!);
		const pokeAt = texts.findIndex(text => text.includes("HELD_POKE"));
		expect(pokeAt).toBeGreaterThan(-1);
		expect(texts.indexOf("NEXT_USER_MESSAGE")).toBeGreaterThan(pokeAt);
		await until(() => isMailDone(sessionId, heldId), "the held poke to be recorded as delivered");
	});

	it("after Esc, starts a turn for a timer fire at once and records it delivered live", async () => {
		const { session: opened } = openSession();
		const sessionId = opened.sessionManager.getSessionId();
		await interrupt(opened);

		const now = Date.now();
		await setTimer(
			{
				id: "wake",
				reason: "test",
				at: "in 1m",
				prompt: "TIMER_PROMPT",
				session: opened.sessionManager.getSessionFile(),
			},
			{ cwd: tempDir.path(), now },
		);
		const tick = await runTick(now + 61_000);
		expect(tick.lines).toMatchObject([
			{ id: "wake", action: "fired", detail: `mailed to live session ${sessionId}` },
		]);
		await until(() => isMailDone(sessionId, "wake#1"), "the timer fire to reach the transcript");

		expect(contexts).toHaveLength(1);
		expect(requestTexts(contexts[0]!).at(-1)).toContain("TIMER_PROMPT");
		expect((await timerRuns("wake"))[0]?.delivery?.state).toBe("delivered-live");
	});

	it("after Esc, starts a turn for an agent run's report, its final message fenced as untrusted output", async () => {
		const { session: opened } = openSession();
		const sessionId = opened.sessionManager.getSessionId();
		await interrupt(opened);

		const at = new Date().toISOString();
		await postMail({
			v: 1,
			id: "digest#1.report",
			kind: "timer-report",
			sessionId,
			createdAt: at,
			report: {
				timerId: "digest",
				runId: "digest#1",
				seq: 1,
				reason: "nightly digest",
				session: "fresh",
				ok: true,
				quiet: false,
				finalText: "REPORT_TEXT",
				cost: 0.002,
				durationMs: 12_000,
				endedAt: at,
				resultPath: "/tmp/result.json",
				tz: "UTC",
			},
		});
		await until(() => isMailDone(sessionId, "digest#1.report"), "the report to reach the transcript");

		expect(contexts).toHaveLength(1);
		const text = requestTexts(contexts[0]!).at(-1);
		expect(text).toContain('<timer-report id="digest" run="1" outcome="ok" session="fresh"');
		expect(text).toContain('<timer-run-output untrusted="true">\nREPORT_TEXT\n</timer-run-output>');
	});

	it("takes no waiting mail for a prompt that fails because a turn is running", async () => {
		const { session: opened } = openSession();
		const run = opened.prompt("go");
		await toolStarted.promise;
		let taken = 0;
		opened.setHeldMailProvider(() => {
			taken++;
			return [];
		});

		expect(
			await opened.prompt("busy").then(
				() => undefined,
				(error: Error) => error.name,
			),
		).toBe("AgentBusyError");
		expect(taken).toBe(0);
		release.resolve();
		await run;
	});

	it("withdraws presence when the session closes, so later mail for it is held for the next opener", async () => {
		const { session: opened } = openSession();
		const sessionId = opened.sessionManager.getSessionId();
		expect(listSessionPresence(sessionId)).toHaveLength(1);

		await opened.dispose();
		expect(listSessionPresence(sessionId)).toEqual([]);
		expect(deliveryTarget(sessionId)).toEqual({ kind: "free" });
	});

	it("withdraws presence even when closing the session file fails", async () => {
		const { session: opened } = openSession();
		const sessionId = opened.sessionManager.getSessionId();
		spyOn(opened.sessionManager, "close").mockRejectedValue(new Error("disk gone"));

		expect(
			await opened.dispose().then(
				() => undefined,
				(error: Error) => error.message,
			),
		).toBe("disk gone");
		expect(listSessionPresence(sessionId)).toEqual([]);
	});

	it("opening a saved session leaves its write lease to the first writer while no mail waits", async () => {
		const file = await savedSessionFile();
		const { session: opened } = openSession(await SessionManager.open(file));
		const sessionId = opened.sessionManager.getSessionId();
		expect(deliveryTarget(sessionId)).toMatchObject({ kind: "live" });

		expect(await leaseFromAnotherProcess(sessionId)).toBe("free");
	});

	it("moves a malformed message to failed/, leaves one only a newer omp reads, and delivers the mail behind both", async () => {
		const { session: opened } = openSession();
		const sessionId = opened.sessionManager.getSessionId();
		const newDir = path.join(mailDir(sessionId), "new");
		fs.mkdirSync(newDir, { recursive: true });
		// Both sort ahead of every `poke-…` message.
		fs.writeFileSync(path.join(newDir, "a-truncated.json"), '{"v":1,"id":"a-trunc');
		fs.writeFileSync(
			path.join(newDir, "a-future.json"),
			JSON.stringify({ v: 1, id: "a-future", kind: "later-kind", sessionId, createdAt: new Date().toISOString() }),
		);

		const mailId = await poke(sessionId, "BEHIND_BAD_MAIL");
		await until(() => isMailDone(sessionId, mailId), "the poke behind the bad files to reach the transcript");
		expect(requestTexts(contexts[0]!).at(-1)).toContain("BEHIND_BAD_MAIL");
		expect(fs.readdirSync(path.join(mailDir(sessionId), "failed"))).toEqual(["a-truncated.json"]);
		expect(listNewMail(sessionId)).toEqual(["a-future.json"]);
	});

	it("moves a message out of attempts to failed/ and leaves the write lease to the first writer", async () => {
		const file = await savedSessionFile();
		const sessionId = (await SessionManager.open(file)).getSessionId();
		const name = `${await poke(sessionId, "NEVER_LANDS")}.json`;
		// Consumers that each claimed it and died before it reached the session file.
		claimMail(sessionId, name);
		for (let attempt = 0; attempt < MAX_MAIL_ATTEMPTS; attempt++) recordMailAttempt(sessionId, name);

		openSession(await SessionManager.open(file));
		await until(() => listClaimedMail(sessionId).length === 0, "the left-behind claim to be settled");
		expect(await leaseFromAnotherProcess(sessionId)).toBe("free");
		expect(fs.readdirSync(path.join(mailDir(sessionId), "failed"))).toEqual([name]);
		expect(listNewMail(sessionId)).toEqual([]);
		expect(contexts).toHaveLength(0);
	});

	it("lets one of two session managers in a process consume the session's mail, so a poke is delivered once", async () => {
		const file = await savedSessionFile();
		const { session: first } = openSession(await SessionManager.open(file));
		const { session: second } = openSession(await SessionManager.open(file));
		const sessionId = first.sessionManager.getSessionId();
		expect(second.sessionManager.getSessionId()).toBe(sessionId);
		expect(
			listSessionPresence(sessionId)
				.map(record => record.delivers)
				.sort(),
		).toEqual([false, true]);

		const mailId = await poke(sessionId, "ONE_CONSUMER");
		await until(() => isMailDone(sessionId, mailId), "the poke to reach the session file");
		expect(
			contexts.filter(context => requestTexts(context).some(text => text.includes("ONE_CONSUMER"))),
		).toHaveLength(1);
	});

	it("does not claim mail while extensions load, so a session switched to meanwhile never receives it", async () => {
		const { session: opened } = openSession();
		await opened.prompt("seed");
		const oldId = opened.sessionManager.getSessionId();
		const loading = Promise.withResolvers<void>();
		const loaded = Promise.withResolvers<void>();
		opened.setDeferredExtensionLoader(() => {
			loading.resolve();
			return loaded.promise;
		});
		contexts.length = 0;

		const mailId = await poke(oldId, "OLD_SESSION_POKE");
		// A claimed poke would start the extension load within a poll; give it two.
		await Promise.race([loading.promise, Bun.sleep(2_500)]);
		await opened.newSession();
		loaded.resolve();
		await opened.prompt("in the new session");
		expect(contexts.some(context => requestTexts(context).some(text => text.includes("OLD_SESSION_POKE")))).toBe(
			false,
		);
		expect(listNewMail(oldId)).toEqual([`${mailId}.json`]);
	});

	it("returns a claim its consumer left behind to the mailbox and delivers it once", async () => {
		const file = await savedSessionFile();
		const sessionId = (await SessionManager.open(file)).getSessionId();
		const mailId = await poke(sessionId, "LEFT_BEHIND");
		// A consumer that died after claiming, before the message reached the file.
		claimMail(sessionId, `${mailId}.json`);

		openSession(await SessionManager.open(file));
		await until(() => isMailDone(sessionId, mailId), "the recovered poke to reach the session file");
		expect(contexts).toHaveLength(1);
		expect(requestTexts(contexts[0]!).at(-1)).toContain("LEFT_BEHIND");
		expect(listClaimedMail(sessionId)).toEqual([]);
	});

	it("does not count a left-behind claim as delivered when only other text in the session file names its id", async () => {
		const mailId = newMailId("poke");
		const { session: first } = openSession();
		await first.prompt(`ls ~/.omp/agent/mailbox/mail/*/cur/${mailId}.json`);
		const file = first.sessionManager.getSessionFile()!;
		const sessionId = first.sessionManager.getSessionId();
		await first.dispose();
		contexts.length = 0;
		await poke(sessionId, "ECHOED_POKE", false, mailId);
		claimMail(sessionId, `${mailId}.json`);

		openSession(await SessionManager.open(file));
		await until(() => isMailDone(sessionId, mailId), "the recovered poke to reach the session file");
		expect(contexts).toHaveLength(1);
		expect(requestTexts(contexts[0]!).at(-1)).toContain("ECHOED_POKE");
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"counts a poke as delivered only once its entry is in the session file",
		async () => {
			const { session: opened } = openSession();
			await opened.prompt("seed");
			const sessionId = opened.sessionManager.getSessionId();
			const file = opened.sessionManager.getSessionFile()!;
			// Neither appends nor the manager's repair rewrite can reach the session file.
			fs.chmodSync(file, 0o444);
			fs.chmodSync(path.dirname(file), 0o555);
			let mailId: string;
			try {
				mailId = await poke(sessionId, "DISK_FULL_POKE");
				await until(
					() => contexts.some(context => requestTexts(context).at(-1)?.includes("DISK_FULL_POKE")),
					"delivery",
				);
				await opened.waitForIdle();
				// Absence can only be observed across polls: give the watcher two.
				await Bun.sleep(2_500);
				expect(isMailDone(sessionId, mailId)).toBe(false);
			} finally {
				fs.chmodSync(path.dirname(file), 0o755);
				fs.chmodSync(file, 0o644);
			}
			await opened.prompt("disk is back").catch(() => {});
			await opened.sessionManager.flush().catch(() => {});
			await until(() => isMailDone(sessionId, mailId), "the poke to be confirmed once it is in the file");
			expect(await Bun.file(file).text()).toContain(mailId);
		},
	);

	it("reports an ACP client that keeps agent turns off as taking the poke with its next prompt, and starts no turn", async () => {
		const { session: opened } = openSession(undefined, { capabilities: {}, deferAgentInitiatedTurns: true });
		await opened.prompt("seed");
		const sessionId = opened.sessionManager.getSessionId();
		contexts.length = 0;
		await until(() => {
			const target = deliveryTarget(sessionId);
			return target.kind === "live" && target.deferred;
		}, "the deferred flag");

		const mailId = await poke(sessionId, "ACP_POKE");
		await until(() => listNewMail(sessionId).length === 0, "the poke to be claimed");
		expect(contexts).toHaveLength(0);

		await opened.prompt("client prompt");
		expect(requestTexts(contexts[0]!).some(text => text.includes("ACP_POKE"))).toBe(true);
		await until(() => isMailDone(sessionId, mailId), "the poke to reach the session file");
	});

	const quiet = { notify: async () => {} };

	it("injects a timer fire once when a cut-off dispatch is re-dispatched after the session took it", async () => {
		const { session: opened } = openSession();
		await opened.prompt("seed");
		contexts.length = 0;
		const sessionId = opened.sessionManager.getSessionId();
		const now = Date.now();
		await setTimer(
			{
				id: "dup",
				reason: "test",
				at: "now",
				prompt: "DUP_SENTINEL",
				session: opened.sessionManager.getSessionFile(),
			},
			{ cwd: tempDir.path(), now },
		);
		// The mail is posted, then the tick dies before recording the dispatch.
		const mark = spyOn(TimerDb.prototype, "markDispatched").mockImplementationOnce(() => {
			throw new Error("tick killed");
		});
		try {
			await runTick(now, quiet);
		} finally {
			mark.mockRestore();
		}
		// The retry reads the fire payload while the first copy reaches the transcript.
		const payload = firePayloadPath("dup", 1);
		const file = Bun.file;
		const read = spyOn(Bun, "file").mockImplementation(((target: string) => {
			const real = file(target);
			if (target !== payload) return real;
			return {
				json: async () => {
					await until(() => isMailDone(sessionId, "dup#1"), "the first copy to reach the transcript");
					return real.json();
				},
			};
		}) as unknown as typeof Bun.file);
		try {
			expect((await runTick(now + 61_000, quiet)).lines).toMatchObject([{ id: "dup", action: "redispatched" }]);
		} finally {
			read.mockRestore();
		}
		// A poll that delivers a later poke has also seen any second copy of the fire (listed first).
		const barrier = await poke(sessionId, "BARRIER");
		await until(() => isMailDone(sessionId, barrier), "the barrier poke");
		await opened.waitForIdle();
		expect(contexts.filter(context => requestTexts(context).at(-1)?.includes("DUP_SENTINEL"))).toHaveLength(1);
		expect(
			opened.agent.state.messages.filter(message => JSON.stringify(message).includes("DUP_SENTINEL")),
		).toHaveLength(1);
		await runTick(now + 120_000, quiet);
		expect((await timerRuns("dup"))[0]).toMatchObject({ outcome: "fired", delivery: { state: "delivered-live" } });
		expect((await timerRuns("dup"))[0]?.settledAt).toBeDefined();
	});

	it("counts a timer fire delivered only once the session file has it, not when admission refused it", async () => {
		const file = await savedSessionFile();
		const { session: first } = openSession(await SessionManager.open(file));
		const sessionId = first.sessionManager.getSessionId();
		const now = Date.now();
		await setTimer(
			{ id: "admit", reason: "test", at: "now", prompt: "ADMIT_ME", session: file },
			{ cwd: tempDir.path(), now },
		);
		const send = spyOn(first, "sendCustomMessage").mockRejectedValue(new Error("admission refused"));
		await runTick(now, quiet);
		await until(() => send.mock.calls.length === 1, "the fire to be offered to the session");
		await runTick(now + 60_000, quiet);
		expect(contexts).toHaveLength(0);
		expect((await timerRuns("admit"))[0]).toMatchObject({ delivery: { state: "queued" }, settledAt: undefined });

		// The next opener recovers the claim and delivers it.
		send.mockRestore();
		await first.dispose();
		openSession(await SessionManager.open(file));
		await until(() => isMailDone(sessionId, "admit#1"), "the recovered fire to reach the transcript");
		expect(requestTexts(contexts[0]!).at(-1)).toContain("ADMIT_ME");
		expect((await timerRuns("admit"))[0]?.delivery).toMatchObject({
			state: "delivered-live",
			detail: "re-delivery attempt 2",
		});
		await runTick(now + 120_000, quiet);
		expect((await timerRuns("admit"))[0]?.settledAt).toBeDefined();
	});

	it("keeps delivering mail, and settles the fire, when recording a timer delivery fails", async () => {
		const { session: opened } = openSession();
		await opened.prompt("seed");
		const sessionId = opened.sessionManager.getSessionId();
		const now = Date.now();
		await setTimer(
			{
				id: "book",
				reason: "test",
				at: "now",
				prompt: "BOOKKEEPING",
				session: opened.sessionManager.getSessionFile(),
			},
			{ cwd: tempDir.path(), now },
		);
		const record = TimerDb.prototype.recordDelivery;
		const failing = spyOn(TimerDb.prototype, "recordDelivery").mockImplementation(
			function (this: TimerDb, timerId, delivery) {
				if (delivery.state === "delivered-live") throw new Error("database is locked");
				record.call(this, timerId, delivery);
			},
		);
		try {
			await runTick(now, quiet);
			await until(() => isMailDone(sessionId, "book#1"), "the fire to reach the transcript");
			const mailId = await poke(sessionId, "AFTER_FAILED_RECORD");
			await until(() => isMailDone(sessionId, mailId), "later mail to be delivered");
		} finally {
			failing.mockRestore();
		}
		await runTick(now + 60_000, quiet);
		expect((await timerRuns("book"))[0]).toMatchObject({ outcome: "fired" });
		expect((await timerRuns("book"))[0]?.settledAt).toBeDefined();
	});

	it("settles a closed-session fire that a session opened before the retry took live, with no lost runner", async () => {
		const file = await savedSessionFile();
		const now = Date.now();
		await setTimer(
			{ id: "handoff", reason: "test", at: "now", prompt: "HANDOFF", session: file },
			{ cwd: tempDir.path(), now },
		);
		const crash = {
			...quiet,
			spawnRunner: () => {
				throw new Error("tick killed");
			},
		};
		expect((await runTick(now, crash)).lines).toMatchObject([{ id: "handoff", action: "error" }]);

		const { session: opened } = openSession(await SessionManager.open(file));
		const sessionId = opened.sessionManager.getSessionId();
		const spawned: string[] = [];
		const recording = { ...quiet, spawnRunner: (spec: TimerSpec, seq: number) => spawned.push(`${spec.id}#${seq}`) };
		await runTick(now + 61_000, recording);
		await until(() => isMailDone(sessionId, "handoff#1"), "the live session to take the fire");
		const final = await runTick(now + 240_000, recording);
		expect(final.lines.filter(line => line.action === "lost")).toEqual([]);
		expect((await timerRuns("handoff"))[0]).toMatchObject({ outcome: "fired", runner: false });
		expect((await timerRuns("handoff"))[0]?.settledAt).toBeDefined();
		expect(spawned).toEqual([]);
	});

	/** Text of the newest tool result the model saw. */
	const lastToolOutput = (): string => requestTexts(contexts.at(-1)!).at(-1) ?? "";

	it.skipIf(process.platform === "win32")(
		"runs a live timer turn's commands as that timer's run, and the user's next turn as no run",
		async () => {
			const { session: opened } = openSession();
			await opened.prompt("seed");
			contexts.length = 0;
			const sessionId = opened.sessionManager.getSessionId();
			const now = Date.now();
			await setTimer(
				{
					id: "parent",
					reason: "test",
					at: "now",
					prompt: "SET_TIMER:child-a",
					session: opened.sessionManager.getSessionFile(),
				},
				{ cwd: tempDir.path(), now },
			);
			await runTick(now, quiet);
			await until(() => contexts.length === 2, "the fired turn to run its command");
			await opened.waitForIdle();
			expect(lastToolOutput()).toContain(
				"may set only timer parent or prompt timers that wake this session, not timer child-a",
			);
			expect(await readTimerSpec("child-a")).toBeUndefined();
			await until(() => isMailDone(sessionId, "parent#1"), "the fire to be recorded delivered");

			// The user's next message ends the fire's scope, in the same shell session.
			await opened.prompt("SET_TIMER:child-b");
			expect(await readTimerSpec("child-b")).toBeDefined();
		},
		30_000,
	);

	it.skipIf(process.platform === "win32")(
		"lets a live timer turn's commands arm another timer that wakes this session",
		async () => {
			const { session: opened } = openSession();
			await opened.prompt("seed");
			contexts.length = 0;
			const sessionId = opened.sessionManager.getSessionId();
			const now = Date.now();
			await setTimer(
				{
					id: "parent",
					reason: "test",
					at: "now",
					prompt: "WAKE_ME:follow-up",
					session: opened.sessionManager.getSessionFile(),
				},
				{ cwd: tempDir.path(), now },
			);
			await runTick(now, quiet);
			await until(() => contexts.length === 2, "the fired turn to run its command");
			await opened.waitForIdle();
			expect(await readTimerSpec("follow-up")).toMatchObject({
				target: { kind: "session", sessionId },
				action: { kind: "prompt", prompt: "look again" },
				created: { run: "parent#1" },
			});
		},
		30_000,
	);

	it.skipIf(process.platform === "win32")(
		"runs a held timer fire's turn as that timer's run once an opener delivers it",
		async () => {
			const file = await savedSessionFile();
			const now = Date.now();
			await setTimer(
				{ id: "parent", reason: "test", at: "now", prompt: "SET_TIMER:child-c", session: file, whenClosed: "hold" },
				{ cwd: tempDir.path(), now },
			);
			expect((await runTick(now, quiet)).lines).toMatchObject([{ id: "parent", action: "fired" }]);
			const { session: opened } = openSession(await SessionManager.open(file));
			await until(() => contexts.length === 2, "the delivered turn to run its command");
			await opened.waitForIdle();
			expect(lastToolOutput()).toContain(
				"may set only timer parent or prompt timers that wake this session, not timer child-c",
			);
			expect(await readTimerSpec("child-c")).toBeUndefined();
		},
		30_000,
	);
});
