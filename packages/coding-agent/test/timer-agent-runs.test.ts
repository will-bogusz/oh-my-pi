import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { type DeliveryTarget, listNewMail, peekNewMail } from "@oh-my-pi/pi-coding-agent/mailbox/mailbox";
import { renderMail } from "@oh-my-pi/pi-coding-agent/mailbox/message";
import { MAILBOX_DIR_ENV } from "@oh-my-pi/pi-coding-agent/mailbox/paths";
import { type AgentRunDeps, type AgentRunHost, runAgent } from "@oh-my-pi/pi-coding-agent/timers/agent-run";
import {
	firePayloadPath,
	ownSessionDir,
	runDirPath,
	TIMER_RUN_ENV,
	TIMERS_DIR_ENV,
} from "@oh-my-pi/pi-coding-agent/timers/paths";
import { readRunResult } from "@oh-my-pi/pi-coding-agent/timers/run-result";
import { execTimerRun } from "@oh-my-pi/pi-coding-agent/timers/runner";
import { editTimer, setTimer, type TimerSetInput } from "@oh-my-pi/pi-coding-agent/timers/service";
import { closeTimerDbs, openTimerDb, readTimerSpec } from "@oh-my-pi/pi-coding-agent/timers/store";
import { fireTimerNow, runTick, type TickDeps } from "@oh-my-pi/pi-coding-agent/timers/tick";
import type { TimerAlert, TimerFirePayload } from "@oh-my-pi/pi-coding-agent/timers/types";
import { NO_UI_APPROVAL_DENIAL } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { TempDir } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

/** The message a rejection settled from store I/O carries. */
async function failure(promise: Promise<unknown>): Promise<string> {
	return String(await rejectionOf(promise));
}

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-21T12:00:00Z");
const ORIGIN = "origin-session-1";

/** The report payload of a `timer-report` mail waiting in the origin session's mailbox. */
function reportMail(name: string) {
	const mail = peekNewMail(ORIGIN, name);
	return mail?.kind === "timer-report" ? mail.report : undefined;
}

/** A scripted stand-in for the run's RPC host. */
class FakeHost implements AgentRunHost {
	readonly listeners = new Set<(event: AgentEvent) => void>();
	prompt = "";
	aborted = false;
	stopped = false;
	finalText: string | null = null;
	sessionFile: string | undefined;
	readonly #abort = Promise.withResolvers<void>();

	/** Exit code once the scripted host process has exited. */
	exit: number | undefined;

	constructor(
		readonly args: string[],
		readonly cwd: string,
		readonly env: Record<string, string>,
		readonly script: (host: FakeHost) => Promise<void>,
		readonly startUp: (host: FakeHost) => Promise<void>,
	) {}

	async start(): Promise<void> {
		await this.startUp(this);
	}
	onEvent(listener: (event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async promptAndWait(message: string): Promise<unknown> {
		this.prompt = message;
		await this.script(this);
		return [];
	}
	async waitForSettled(): Promise<void> {}
	async abort(): Promise<void> {
		this.aborted = true;
		this.#abort.resolve();
	}
	async getLastAssistantText(): Promise<string | null> {
		return this.finalText;
	}
	async getSessionStats(): Promise<{ sessionFile?: string }> {
		return { sessionFile: this.sessionFile };
	}
	async stop(): Promise<void> {
		this.stopped = true;
	}
	async exitCode(): Promise<number | undefined> {
		return this.exit;
	}

	untilAborted(): Promise<void> {
		return this.#abort.promise;
	}
	emit(event: AgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}
	/** One model call: its usage and (as the last message) its text. */
	assistant(text: string, cost: number, stopReason = "stop"): void {
		this.finalText = text;
		this.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				stopReason,
				timestamp: Date.now(),
				usage: {
					input: 100,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 120,
					cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
				},
			},
		} as unknown as AgentEvent);
	}
	flag(name: string): string | undefined {
		const index = this.args.indexOf(name);
		return index === -1 ? undefined : this.args[index + 1];
	}
}

describe("timer agent runs (fresh/own sessions)", () => {
	let dir: TempDir;
	let root: string;
	let previousRoot: string | undefined;
	let previousMailbox: string | undefined;
	let hosts: FakeHost[];
	let script: (host: FakeHost) => Promise<void>;
	let startUp: (host: FakeHost) => Promise<void>;
	let origin: DeliveryTarget;
	/** Where other sessions (an own timer's) stand; the origin's is `origin`. */
	let sessions: Record<string, DeliveryTarget>;
	let notified: TimerAlert[];
	let tickAlerts: TimerAlert[];

	beforeEach(() => {
		dir = TempDir.createSync("@omp-timer-runs-");
		root = dir.path();
		previousRoot = Bun.env[TIMERS_DIR_ENV];
		Bun.env[TIMERS_DIR_ENV] = root;
		previousMailbox = Bun.env[MAILBOX_DIR_ENV];
		Bun.env[MAILBOX_DIR_ENV] = path.join(root, "mailbox");
		hosts = [];
		script = async host => host.assistant("done", 0.001);
		startUp = async () => {};
		sessions = {};
		origin = { kind: "live", pid: 1, host: "h", deferred: false };
		notified = [];
		tickAlerts = [];
	});
	afterEach(async () => {
		if (previousRoot === undefined) delete Bun.env[TIMERS_DIR_ENV];
		else Bun.env[TIMERS_DIR_ENV] = previousRoot;
		if (previousMailbox === undefined) delete Bun.env[MAILBOX_DIR_ENV];
		else Bun.env[MAILBOX_DIR_ENV] = previousMailbox;
		closeTimerDbs();
		await dir.remove();
	});

	const agentDeps = (): AgentRunDeps => ({
		createHost: (args, cwd, env) => {
			const host = new FakeHost(args, cwd, env, script, startUp);
			hosts.push(host);
			return host;
		},
		deliveryTarget: sessionId => sessions[sessionId] ?? origin,
		notify: async alerts => {
			notified.push(...alerts);
		},
	});
	const tickDeps = (): Partial<TickDeps> => ({
		root,
		spawnRunner: () => {},
		deliveryTarget: () => origin,
		runnerAlive: () => false,
		notify: async alerts => {
			tickAlerts.push(...alerts);
		},
	});
	const set = (input: Partial<TimerSetInput> & { id: string }) =>
		setTimer(
			{
				reason: `${input.id}: check the build`,
				every: "1h",
				prompt: "Check the build.",
				session: "fresh",
				...input,
			},
			{ cwd: root, now: T0, root, sessionId: ORIGIN },
		);
	/** Fire by hand and carry the run in this process, as the detached runner would. */
	const fireAndRun = async (id: string, seq: number, now = T0 + seq * MINUTE) => {
		await fireTimerNow(id, now, { deps: tickDeps() });
		const end = await execTimerRun(id, seq, root, agentDeps());
		const result = await readRunResult(id, seq, root);
		return {
			end,
			result,
			record: openTimerDb(root)
				.listRuns(id)
				.find(run => run.seq === seq),
		};
	};

	it("aborts a run once its model calls cost more than maxCost and records failed: budget", async () => {
		await set({ id: "budget", maxCost: 0.01 });
		script = async host => {
			host.assistant("step one", 0.004);
			host.assistant("step two", 0.008);
			await host.untilAborted();
		};
		const { end, result, record } = await fireAndRun("budget", 1);
		expect(hosts[0]?.aborted).toBe(true);
		expect(end.ok).toBe(false);
		expect(result).toMatchObject({ ok: false, failure: "budget", cost: 0.012 });
		expect(record?.end?.detail).toMatch(/^budget: spent \$0\.0120, over maxCost \$0\.0100/);
		// A failure always says something: the origin session gets it as a report.
		expect(reportMail("budget#1.report.json")).toMatchObject({ ok: false, failure: "budget" });
		// The next tick settles it into the failure policy (a first failure of a recurring timer does not alert).
		await runTick(T0 + 2 * MINUTE, tickDeps());
		expect(openTimerDb(root).readState("budget").failStreak).toBe(1);
		expect(tickAlerts).toEqual([]);
	});

	it("aborts a run past maxTime and records failed: timeout", async () => {
		await set({ id: "slow" });
		const spec = await readTimerSpec("slow", root);
		if (!spec) throw new Error("no spec");
		await fireTimerNow("slow", T0 + MINUTE, { deps: tickDeps() });
		const payload = (await Bun.file(firePayloadPath("slow", 1, root)).json()) as TimerFirePayload;
		script = host => host.untilAborted();
		const result = await runAgent(
			{ ...spec, run: { maxTimeMs: 50 } },
			payload,
			{ root, env: { PATH: Bun.env.PATH ?? "" } },
			agentDeps(),
		);
		expect(hosts[0]?.aborted).toBe(true);
		expect(result).toMatchObject({ ok: false, failure: "timeout" });
	});

	it.skipIf(process.platform === "win32")(
		"counts hooks against maxTime and kills a hook that ignores SIGTERM",
		async () => {
			await set({ id: "stubborn" });
			const spec = await readTimerSpec("stubborn", root);
			if (!spec) throw new Error("no spec");
			await fireTimerNow("stubborn", T0 + MINUTE, { deps: tickDeps() });
			const payload = (await Bun.file(firePayloadPath("stubborn", 1, root)).json()) as TimerFirePayload;
			const started = Date.now();
			const result = await runAgent(
				{ ...spec, run: { maxTimeMs: 300, before: "trap '' TERM; while :; do sleep 1; done" } },
				payload,
				{ root, env: { PATH: Bun.env.PATH ?? "" } },
				agentDeps(),
			);
			// SIGTERM at the deadline is ignored; the group SIGKILL follows after the grace.
			expect(Date.now() - started).toBeLessThan(9000);
			expect(hosts).toHaveLength(0);
			expect(result).toMatchObject({
				ok: false,
				failure: "timeout",
				detail: "before hook still running at maxTime 0s",
			});
			expect(await readRunResult("stubborn", 1, root)).toMatchObject({ failure: "timeout" });
		},
		15_000,
	);

	it("records a result when the run cannot even be set up", async () => {
		await set({ id: "broken-cwd" });
		const spec = await readTimerSpec("broken-cwd", root);
		if (!spec) throw new Error("no spec");
		const notADir = path.join(root, "not-a-dir");
		fs.writeFileSync(notADir, "");
		await fireTimerNow("broken-cwd", T0 + MINUTE, { deps: tickDeps() });
		const payload = (await Bun.file(firePayloadPath("broken-cwd", 1, root)).json()) as TimerFirePayload;
		const result = await runAgent(
			{ ...spec, cwd: notADir, run: { after: "true" } },
			payload,
			{ root, env: { PATH: Bun.env.PATH ?? "" } },
			agentDeps(),
		);
		expect(hosts).toHaveLength(0);
		expect(result).toMatchObject({ ok: false, failure: "error" });
		expect(await readRunResult("broken-cwd", 1, root)).toMatchObject({ ok: false, failure: "error" });
		expect(reportMail("broken-cwd#1.report.json")).toMatchObject({ ok: false, failure: "error" });
	});

	it("fails a run whose expected artifacts are missing, and passes one that wrote them", async () => {
		await set({ id: "artifact", expect: ["out/report.md"], session: "fresh", cwd: "run" });
		const missing = await fireAndRun("artifact", 1);
		expect(missing.result).toMatchObject({ ok: false, failure: "expect", expectMissing: ["out/report.md"] });
		expect(missing.record?.end?.detail).toBe("expect: missing after the run: out/report.md");

		script = async host => {
			fs.mkdirSync(path.join(host.cwd, "out"), { recursive: true });
			fs.writeFileSync(path.join(host.cwd, "out/report.md"), "ok\n");
			host.assistant("Wrote the report.", 0.001);
		};
		const written = await fireAndRun("artifact", 2);
		expect(written.result).toMatchObject({ ok: true, finalText: "Wrote the report." });
		// `cwd: run` gives every fresh run its own directory under its run dir.
		expect(hosts[1]?.cwd).toBe(path.join(runDirPath("artifact", 2, root), "work"));
		expect(hosts[1]?.env.OMP_TIMER_RUN_DIR).toBe(runDirPath("artifact", 2, root));
		// The envelope tells the agent what must exist and how to stay quiet.
		expect(hosts[1]?.prompt).toContain("out/report.md");
		expect(hosts[1]?.prompt).toContain("[quiet]");
	});

	it("reports said results to the live origin session as mail, and keeps [quiet] runs to itself", async () => {
		await set({ id: "watch" });
		script = async host => host.assistant("Nothing new.\n[quiet]", 0.001);
		const quiet = await fireAndRun("watch", 1);
		expect(quiet.result).toMatchObject({ ok: true, quiet: true, report: { mode: "said", state: "skipped" } });
		expect(listNewMail(ORIGIN)).toEqual([]);

		script = async host => host.assistant("Two stale branches: a, b.", 0.002);
		const said = await fireAndRun("watch", 2);
		expect(said.result?.report).toMatchObject({ mode: "said", state: "mailed-live", session: ORIGIN });
		expect(listNewMail(ORIGIN)).toEqual(["watch#2.report.json"]);
		const mail = peekNewMail(ORIGIN, "watch#2.report.json");
		expect(mail).toMatchObject({ kind: "timer-report", report: { runId: "watch#2", ok: true, quiet: false } });
		if (!mail) throw new Error("no mail");
		const text = renderMail(mail, "live", T0 + 3 * MINUTE);
		expect(text).toContain('<timer-run-output untrusted="true">\nTwo stale branches: a, b.\n</timer-run-output>');
		expect(said.record?.delivery).toMatchObject({ state: "queued", detail: "report" });
		expect(notified).toEqual([]);
	});

	it("routes by report mode: failure skips a success, always mails a quiet run, a closed origin holds it and notifies", async () => {
		await set({ id: "fails-only", report: "failure" });
		script = async host => host.assistant("All good.", 0.001);
		expect((await fireAndRun("fails-only", 1)).result?.report?.state).toBe("skipped");

		await set({ id: "every", report: "always" });
		script = async host => host.assistant("[quiet]", 0.001);
		expect((await fireAndRun("every", 1)).result?.report?.state).toBe("mailed-live");

		origin = { kind: "free" };
		script = async host => host.assistant("Found one.", 0.001);
		const held = await fireAndRun("every", 2);
		expect(held.result?.report).toMatchObject({ state: "mailed-held", session: ORIGIN });
		expect(listNewMail(ORIGIN)).toContain("every#2.report.json");
		expect(notified).toMatchObject([{ timerId: "every", runId: "every#2", event: "report" }]);
		expect(notified[0]?.summary).toContain("Found one.");

		await editTimer("fails-only", { expect: ["missing.txt"] }, { cwd: root, now: T0, root });
		await fireAndRun("fails-only", 2);
		expect(notified[1]).toMatchObject({ runId: "fails-only#2", event: "report" });
		expect(notified[1]?.summary).toContain("failed: expect: missing after the run: missing.txt");
	});

	it("resumes the same session on every run of an own timer, and gives each fresh run its own", async () => {
		await set({ id: "keeper", session: "own" });
		script = async host => {
			const sessionDir = host.flag("--session-dir") ?? "";
			host.sessionFile = host.flag("--resume") ?? path.join(sessionDir, "2026-10-21_keeper.jsonl");
			fs.writeFileSync(host.sessionFile, "{}\n", { flag: "a" });
			host.assistant("Noted.", 0.001);
		};
		const first = await fireAndRun("keeper", 1);
		const second = await fireAndRun("keeper", 2);
		const sessionFile = path.join(ownSessionDir("keeper", root), "2026-10-21_keeper.jsonl");
		expect(hosts[0]?.flag("--session-dir")).toBe(ownSessionDir("keeper", root));
		expect(hosts[0]?.flag("--resume")).toBeUndefined();
		expect(hosts[1]?.flag("--resume")).toBe(sessionFile);
		expect(first.result?.transcript).toBe(sessionFile);
		expect(second.result?.transcript).toBe(sessionFile);
		expect(hosts[1]?.prompt).toContain("the session this timer keeps across runs");

		await set({ id: "each", session: "fresh" });
		await fireAndRun("each", 1);
		await fireAndRun("each", 2);
		expect(hosts[2]?.flag("--session-dir")).toBe(path.join(runDirPath("each", 1, root), "session"));
		expect(hosts[3]?.flag("--session-dir")).toBe(path.join(runDirPath("each", 2, root), "session"));
		expect(hosts[3]?.flag("--resume")).toBeUndefined();
	});

	it("does not start an own run while its session is open elsewhere, and resumes the same file once it is free", async () => {
		await set({ id: "keeper", session: "own" });
		const sessionDir = ownSessionDir("keeper", root);
		fs.mkdirSync(sessionDir, { recursive: true });
		const file = path.join(sessionDir, "2026-10-21_keeper.jsonl");
		const header = { type: "session", version: 3, id: "own-1", timestamp: new Date(T0).toISOString(), cwd: root };
		fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
		const files = () => fs.readdirSync(sessionDir).sort();

		// Open in a live process: no host starts, nothing is written next to it.
		sessions["own-1"] = { kind: "live", pid: 2, host: "h", deferred: false };
		const open = await fireAndRun("keeper", 1);
		expect(hosts).toHaveLength(0);
		expect(open.result).toMatchObject({ ok: false, failure: "busy" });
		expect(open.result?.detail).toBe(
			"its own session is open in another omp process (h, pid 2); this run did not start",
		);
		expect(files()).toEqual(["2026-10-21_keeper.jsonl"]);

		// Opened between that check and the host's start: the host leaves before writing, and nothing is sent.
		sessions["own-1"] = { kind: "free" };
		startUp = async host => {
			host.exit = 75;
			throw new Error("Agent process exited with code 75");
		};
		const raced = await fireAndRun("keeper", 2);
		expect(hosts[0]?.env.OMP_MAILBOX_HEADLESS).toBe("keeper#2");
		expect(hosts[0]?.prompt).toBe("");
		expect(raced.result).toMatchObject({ ok: false, failure: "busy" });

		// Free again: the next run resumes the same file.
		startUp = async () => {};
		const resumed = await fireAndRun("keeper", 3);
		expect(hosts[1]?.flag("--resume")).toBe(file);
		expect(resumed.result).toMatchObject({ ok: true });
	});

	it("never sends the run to a host that was not ready before maxTime", async () => {
		await set({ id: "late-host" });
		const spec = await readTimerSpec("late-host", root);
		if (!spec) throw new Error("no spec");
		await fireTimerNow("late-host", T0 + MINUTE, { deps: tickDeps() });
		const payload = (await Bun.file(firePayloadPath("late-host", 1, root)).json()) as TimerFirePayload;
		startUp = () => Bun.sleep(150);
		const result = await runAgent(
			{ ...spec, run: { maxTimeMs: 20 } },
			payload,
			{ root, env: { PATH: Bun.env.PATH ?? "" } },
			agentDeps(),
		);
		expect(hosts[0]?.prompt).toBe("");
		expect(hosts[0]?.stopped).toBe(true);
		expect(result).toMatchObject({ ok: false, failure: "timeout", cost: 0 });
		expect(result.detail).toMatch(/not ready within maxTime/);
		expect(await readRunResult("late-host", 1, root)).toMatchObject({ failure: "timeout" });
	});

	it.skipIf(process.platform === "win32")(
		"fails, records and reports a run whose after hook cannot start",
		async () => {
			await set({ id: "gone", session: "fresh", cwd: "run", after: "true" });
			script = async host => {
				host.assistant("done", 0.001);
				fs.rmSync(host.cwd, { recursive: true, force: true });
			};
			const gone = await fireAndRun("gone", 1);
			expect(gone.result).toMatchObject({ ok: false, failure: "after" });
			expect(gone.end.ok).toBe(false);
			expect(listNewMail(ORIGIN)).toEqual(["gone#1.report.json"]);
			expect(reportMail("gone#1.report.json")).toMatchObject({ ok: false, failure: "after" });

			// An earlier failure stays the run's outcome.
			script = async host => {
				host.assistant("provider down", 0.001, "error");
				fs.rmSync(host.cwd, { recursive: true, force: true });
			};
			expect((await fireAndRun("gone", 2)).result).toMatchObject({ ok: false, failure: "model" });
		},
	);

	it("runs the host without a UI, denies calls that need an approval, and fails the run with approval", async () => {
		await set({ id: "guarded", hermetic: true, thinking: "low", model: "anthropic/claude-haiku-4-5" });
		script = async host => {
			host.emit({
				type: "tool_execution_end",
				toolCallId: "c1",
				toolName: "bash",
				isError: true,
				result: { content: [{ type: "text", text: `Tool "bash" requires approval ${NO_UI_APPROVAL_DENIAL}.` }] },
			} as AgentEvent);
			host.assistant("Could not run bash.", 0.001);
		};
		const { result, record } = await fireAndRun("guarded", 1);
		const host = hosts[0];
		expect(host?.args).toContain("--no-ui");
		expect(host?.args).toEqual(
			expect.arrayContaining(["--no-rules", "--no-skills", "--no-extensions", "--no-title"]),
		);
		expect(host?.flag("--thinking")).toBe("low");
		expect(host?.flag("--model")).toBe("anthropic/claude-haiku-4-5");
		// The recursion guard's env reaches the run's session.
		expect(host?.env[TIMER_RUN_ENV]).toBe("guarded#1");
		expect(result).toMatchObject({ ok: false, failure: "approval", approvalsDenied: ["bash"] });
		expect(record?.end?.detail).toMatch(/^approval: /);
	});

	it.skipIf(process.platform === "win32")(
		"skips the agent when the before hook fails, and runs the after hook with the result",
		async () => {
			await set({ id: "hooked", before: "exit 3" });
			const blocked = await fireAndRun("hooked", 1);
			expect(hosts).toHaveLength(0);
			expect(blocked.result).toMatchObject({ ok: false, failure: "before" });

			const copy = path.join(root, "result-copy.json");
			await editTimer(
				"hooked",
				{ before: null, after: `cp "$OMP_TIMER_RESULT" ${copy} && test "$OMP_TIMER_OUTCOME" = ok` },
				{ cwd: root, now: T0, root },
			);
			const ran = await fireAndRun("hooked", 2);
			expect(ran.result).toMatchObject({ ok: true });
			expect(JSON.parse(fs.readFileSync(copy, "utf8"))).toMatchObject({ runId: "hooked#2", ok: true });
		},
	);
});

describe("timer agent-run settings in specs", () => {
	let dir: TempDir;
	let root: string;
	beforeEach(() => {
		dir = TempDir.createSync("@omp-timer-runs-");
		root = dir.path();
	});
	afterEach(async () => {
		closeTimerDbs();
		await dir.remove();
	});
	const ctx = { cwd: "", now: T0, root: "", sessionId: ORIGIN };

	it("writes and reads back every run key", async () => {
		const { spec } = await setTimer(
			{
				id: "weekly",
				reason: "weekly review",
				every: "fri 16:00",
				prompt: "Review the week.",
				session: "own",
				cwd: "run",
				thinking: "medium",
				hermetic: true,
				maxTime: "20m",
				maxCost: 0.5,
				expect: ["review.md"],
				before: "true",
				after: "true",
				report: "failure",
			},
			{ ...ctx, cwd: root, root },
		);
		const stored = await Bun.file(path.join(root, "specs", "weekly.md")).text();
		expect(stored).toContain("session: own");
		expect(stored).toContain("cwd: run");
		expect(stored).toContain("max_time: 20m");
		const read = await readTimerSpec("weekly", root);
		expect(read?.target).toEqual({ kind: "own" });
		expect(read?.report).toBe("failure");
		expect(read?.run).toEqual(spec.run);
		expect(read?.run).toMatchObject({ runCwd: true, maxTimeMs: 20 * MINUTE, maxCost: 0.5, expect: ["review.md"] });
		expect(read?.cwd).toBe(root);
	});

	it("rejects run keys on timers that do not run an agent, and unknown profiles or levels", async () => {
		const base = { reason: "r", every: "1h", prompt: "p" };
		const at = { ...ctx, cwd: root, root };
		expect(await failure(setTimer({ ...base, id: "a", maxCost: 1 }, at))).toMatch(
			/maxCost: only prompt timers whose session is fresh or own/,
		);
		expect(
			await failure(setTimer({ id: "b", reason: "r", every: "1h", shell: "true", report: "always" }, at)),
		).toMatch(/report: only prompt timers/);
		expect(await failure(setTimer({ ...base, id: "c", session: "fresh", agent: "no-such-profile" }, at))).toMatch(
			/No agent profile "no-such-profile"/,
		);
		expect(await failure(setTimer({ ...base, id: "d", session: "fresh", thinking: "galaxy" }, at))).toMatch(
			/thinking "galaxy"/,
		);
		expect((await setTimer({ ...base, id: "e", session: "fresh", agent: "scout" }, at)).spec.run.agent).toBe("scout");
	});

	it("refuses to edit a shell timer into a prompt, which would start an agent run nobody asked for", async () => {
		const at = { ...ctx, cwd: root, root };
		await setTimer({ id: "convert", reason: "convert", every: "5m", shell: "true" }, at);
		expect(await failure(editTimer("convert", { prompt: "Do a review" }, at))).toMatch(
			/runs a shell command; to run a prompt instead, set it again with a session/,
		);
		expect(await readTimerSpec("convert", root)).toMatchObject({
			rev: 1,
			action: { kind: "shell" },
			target: { kind: "fresh" },
		});
		// Set again with a session, it is an agent run on purpose.
		const again = { id: "convert", reason: "convert", every: "5m", prompt: "Do a review", session: "fresh" };
		expect((await setTimer(again, at)).spec).toMatchObject({ action: { kind: "prompt" }, target: { kind: "fresh" } });
	});

	it("gives recurring agent runs the tool sets the 7-day expiry of a recurring wake; never keeps one", async () => {
		const tool = { ...ctx, cwd: root, root, by: "tool" as const };
		const week = new Date(T0 + 7 * 24 * 60 * MINUTE).toISOString();
		const jobs = [
			{ id: "digest", session: "fresh", prompt: "Summarize the nightly build log.", reason: "build digest" },
			{ id: "review", session: "own", prompt: "Review open pull requests for stale branches.", reason: "PR sweep" },
			{ id: "wake", session: undefined, prompt: "Check the release notes draft.", reason: "release notes" },
		];
		for (const job of jobs) expect((await setTimer({ ...job, every: "1h" }, tool)).spec.expiresAt).toBe(week);
		const kept = { id: "kept", reason: "quota", every: "1h", prompt: "Check the API quota.", session: "fresh" };
		expect((await setTimer({ ...kept, expires: "never" }, tool)).spec.expiresAt).toBeUndefined();
	});
});
