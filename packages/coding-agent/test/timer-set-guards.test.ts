import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TimerTool } from "@oh-my-pi/pi-coding-agent/tools/timer";
import { compileCondition } from "@oh-my-pi/pi-coding-agent/timers/conditions";
import { findDuplicateTimer } from "@oh-my-pi/pi-coding-agent/timers/duplicates";
import { TIMERS_DIR_ENV } from "@oh-my-pi/pi-coding-agent/timers/paths";
import { editTimer, setTimer, type TimerSetInput } from "@oh-my-pi/pi-coding-agent/timers/service";
import { closeTimerDbs, readTimerSpec } from "@oh-my-pi/pi-coding-agent/timers/store";
import type { TimerSpec } from "@oh-my-pi/pi-coding-agent/timers/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

/** The message a rejection settled from store I/O carries. */
async function failure(promise: Promise<unknown>): Promise<string> {
	return String(await rejectionOf(promise));
}

const T0 = Date.parse("2026-10-22T08:33:00Z");
const LA = "America/Los_Angeles";

describe("timer set guards (tool callers)", () => {
	let dir: TempDir;
	let root: string;
	const tool = (extra: { now?: number } = {}) => ({
		by: "tool" as const,
		cwd: root,
		now: T0,
		root,
		sessionId: "s1",
		...extra,
	});
	const cli = () => ({ by: "cli" as const, cwd: root, now: T0, root, sessionId: "s1" });
	const base: TimerSetInput = { reason: "test", tz: LA, prompt: "Do the thing." };
	/** Condition checks run through `/bin/sh`. */
	const posixIt = it.skipIf(process.platform === "win32");

	beforeEach(() => {
		dir = TempDir.createSync("@omp-timer-guards-");
		root = dir.path();
	});
	afterEach(async () => {
		closeTimerDbs();
		await dir.remove();
	});

	it("refuses a new id that repeats an existing timer's job, and points at that id", async () => {
		await setTimer(
			{
				...base,
				id: "market-check",
				every: "2h",
				prompt: "Check which markets are open right now and append notable moves to notes/markets.md.",
				reason: "Will: every 2 hours, check which markets are open",
			},
			cli(),
		);
		const again = {
			...base,
			every: "2h",
			prompt: "Check which major markets are open and note significant moves in notes/markets.md.",
			reason: "Track which markets are open every couple of hours",
		};
		expect(await failure(setTimer(again, tool()))).toMatch(/timer "market-check" .* already looks like this job/);
		// re-arming the same id is the way to change it; repeating the refused call arms a deliberate second one
		expect((await setTimer({ ...again, id: "market-check" }, tool())).replaced).toBe(true);
		const second = { ...again, id: "market-check-2" };
		expect(await failure(setTimer(second, tool()))).toMatch(/send this same call again within 10m/);
		expect((await setTimer(second, tool())).spec.id).toBe("market-check-2");
		// a repeat after the confirmation window is a new call, checked again
		const third = { ...again, id: "market-check-3" };
		expect(await failure(setTimer(third, tool()))).toMatch(/already looks like this job/);
		expect(await failure(setTimer(third, tool({ now: T0 + 11 * 60_000 })))).toMatch(/already looks like this job/);
		// the CLI and /timer are not refused
		expect((await setTimer({ ...again, id: "market-check-cli" }, cli())).replaced).toBe(false);
	});

	it("catches a re-check under a new id after a one-shot, and tells PRs apart", async () => {
		const deploy = "Check `scripts/deploy-status.sh prod`. If it finished, tell Will the result.";
		await setTimer(
			{ ...base, id: "prod-deploy", at: "now", prompt: deploy, reason: "Will: how did the deploy go" },
			cli(),
		);
		expect(
			await failure(
				setTimer(
					{ ...base, id: "prod-deploy-recheck", at: "in 10m", prompt: deploy, reason: "deploy still running" },
					tool(),
				),
			),
		).toMatch(/set` with id "prod-deploy"/);
		await setTimer(
			{ ...base, id: "pr-479", at: "in 1h", prompt: "Check CI on PR 479 and fix failures.", reason: "PR 479 CI" },
			cli(),
		);
		const other = await setTimer(
			{ ...base, id: "pr-482", at: "in 1h", prompt: "Check CI on PR 482 and fix failures.", reason: "PR 482 CI" },
			tool(),
		);
		expect(other.replaced).toBe(false);
	});

	it("arms unrelated timers side by side", async () => {
		await setTimer(
			{ ...base, id: "nightly", every: "daily 02:00", prompt: "Summarize today's commits into notes/daily.md." },
			cli(),
		);
		const reminder = await setTimer(
			{
				...base,
				at: "in 3h",
				prompt: "Post the release note for apt-tools in #eng.",
				reason: "Will: post the release note",
			},
			tool(),
		);
		const prune = await setTimer(
			{ reason: "prune the cache", tz: LA, every: "6h", shell: "rm -rf .cache/tmp" },
			tool(),
		);
		expect([reminder.replaced, prune.replaced]).toEqual([false, false]);
	});

	posixIt(
		"refuses a condition that already holds, explains why, and arms it when the same call is repeated",
		async () => {
			const met = { ...base, id: "deploy-done", when: { cmd: "echo IN_PROGRESS" } };
			expect(await failure(setTimer(met, tool()))).toMatch(
				/not armed: the condition already holds .*printed: IN_PROGRESS.*send this same call again/s,
			);
			expect(await readTimerSpec("deploy-done", root)).toBeUndefined();
			const repeated = await setTimer(met, tool());
			expect(repeated.gateNow).toBe("met");
			// a repeat after the confirmation window is a new call, checked again
			const late = {
				...base,
				id: "export-ready",
				reason: "export",
				prompt: "Fetch it.",
				when: { cmd: "echo RUNNING" },
			};
			expect(await failure(setTimer(late, tool()))).toMatch(/already holds/);
			expect(await failure(setTimer(late, tool({ now: T0 + 11 * 60_000 })))).toMatch(/already holds/);
			const pending = await setTimer(
				{ ...base, id: "upload-wait", reason: "upload", when: { cmd: "echo PROCESSING | grep -q DONE" } },
				tool(),
			);
			expect(pending.gateNow).toBe("not-yet");
			// the CLI and /timer arm it and show the verdict on the card
			const cliMet = await setTimer({ ...base, id: "cli-met", reason: "cli", when: { cmd: "true" } }, cli());
			expect(cliMet.gateNow).toBe("met");
		},
	);

	posixIt("refuses an edit to a condition that already holds and keeps the old one", async () => {
		await setTimer({ ...base, id: "wait", when: { cmd: "exit 1" } }, tool());
		expect(await failure(editTimer("wait", { when: { cmd: "true" } }, tool()))).toMatch(/already holds/);
		const kept = await editTimer("wait", { prompt: "Changed." }, tool());
		expect(kept.spec.until).toBe("exit 1");
	});

	posixIt(
		"catches a second watcher on the same condition, and gives an agent's condition timer a 24-hour expiry",
		async () => {
			const ci = { ...base, id: "pr-479-ci", reason: "PR 479 CI", when: { cmd: "exit 1" } };
			const first = await setTimer(ci, tool());
			expect(first.spec.expiresAt).toBe(new Date(T0 + 24 * 60 * 60_000).toISOString());
			expect(await failure(setTimer({ ...ci, id: "ci-479", prompt: "Fix it." }, tool()))).toMatch(/"pr-479-ci"/);
			const user = await setTimer({ ...ci, id: "user-gate", reason: "user's", prompt: "Other." }, cli());
			expect(user.spec.expiresAt).toBeUndefined();
		},
	);

	posixIt(
		"says a process condition that already holds runs on no process here, and how to wait for one on another host",
		async () => {
			const exited = Bun.spawn(["true"]);
			await exited.exited;
			const refusal = await failure(setTimer({ ...base, id: "train-done", when: { pid: exited.pid } }, tool()));
			expect(refusal).toContain(`the condition already holds — process ${exited.pid} exited`);
			expect(refusal).toContain(`No process ${exited.pid} runs on this machine`);
			expect(refusal).toContain(`ssh <host> 'kill -0 ${exited.pid} 2>/dev/null && exit 1 || exit 0'`);
			expect(refusal).toContain("If it really finished, do the work now");
			expect(refusal).toContain("send this same call again");
			expect(refusal).not.toContain("It has already happened");
			expect(refusal).not.toContain("No such process");
			expect(refusal).not.toContain("grep -q DONE");
		},
	);

	it("gives a recurring wake set by an agent a 7-day expiry unless it names one; a recurring shell command none", async () => {
		const agent = await setTimer({ ...base, id: "babysit", every: "30m" }, tool());
		expect(agent.spec.expiresAt).toBe(new Date(T0 + 7 * 24 * 60 * 60_000).toISOString());
		const kept = await setTimer({ ...base, id: "kept", every: "1h", reason: "kept", expires: "never" }, tool());
		expect(kept.spec.expiresAt).toBeUndefined();
		const once = await setTimer({ ...base, id: "once", at: "in 2h", reason: "once" }, tool());
		expect(once.spec.expiresAt).toBeUndefined();
		const user = await setTimer({ ...base, id: "user", every: "30m", reason: "user's" }, cli());
		expect(user.spec.expiresAt).toBeUndefined();
		const prune = await setTimer({ reason: "prune", tz: LA, id: "prune", every: "6h", shell: "true" }, tool());
		expect(prune.spec.expiresAt).toBeUndefined();
	});
});

describe("timer tool", () => {
	let dir: TempDir;
	let previousRoot: string | undefined;
	const session = (timerRun?: string, cwd = dir.path()): ToolSession =>
		({
			cwd,
			getSessionId: () => "s1",
			getSessionFile: () => null,
			getTimerRun: () => timerRun,
		}) as unknown as ToolSession;

	beforeEach(() => {
		dir = TempDir.createSync("@omp-timer-tool-");
		previousRoot = Bun.env[TIMERS_DIR_ENV];
		Bun.env[TIMERS_DIR_ENV] = dir.path();
	});
	afterEach(async () => {
		closeTimerDbs();
		if (previousRoot === undefined) delete Bun.env[TIMERS_DIR_ENV];
		else Bun.env[TIMERS_DIR_ENV] = previousRoot;
		await dir.remove();
	});

	it("arms a wake of the calling session and returns the stored card with how to manage it", async () => {
		const tool = new TimerTool(session());
		const result = await tool.execute("c1", {
			op: "set",
			id: "finish-migration",
			reason: "finish the migration",
			at: "in 2h",
			prompt: "Run the migration's last step.",
		});
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(text).toContain("timer finish-migration armed (rev 1)");
		expect(text).toContain("(this session)");
		expect(text.split("\n").at(-1)).toBe(
			'manage timer {op:"show"|"runs"|"edit"|"pause"|"remove", id:"finish-migration"}',
		);
		expect(result.details?.card?.does).toBe('wake this session → "Run the migration\'s last step."');
		const spec = await readTimerSpec("finish-migration");
		expect(spec?.created.by).toBe("tool");
		expect(spec?.target).toEqual({ kind: "session", sessionId: "s1", sessionFile: undefined });
	});

	it("lists the live timers in its description, as of when it was created", async () => {
		expect(new TimerTool(session()).description).not.toContain("Timers in the registry");
		await setTimer(
			{ id: "market-check", reason: "check which markets are open", every: "2h", shell: "true" },
			{ cwd: dir.path() },
		);
		await setTimer(
			{ id: "paused-one", reason: "a paused reminder", at: "in 1h", shell: "true" },
			{ cwd: dir.path() },
		);
		const tool = new TimerTool(session());
		await tool.execute("c1", { op: "pause", id: "paused-one" });
		expect(tool.description).toContain("- market-check · every 2h · check which markets are open");
		expect(tool.description).not.toContain("paused-one · once · paused");
		expect(new TimerTool(session()).description).toContain("- paused-one · once · paused · a paused reminder");
	});

	it("lists only this session's and this project's timers in its description, with credentials redacted", async () => {
		const projectA = path.join(dir.path(), "project-a");
		const projectB = path.join(dir.path(), "project-b");
		fs.mkdirSync(projectA);
		fs.mkdirSync(projectB);
		// `/timer in 2h <prompt>` stores the prompt as the reason.
		const secret = "PRIVATE_MARKER renew https://u:p@x.invalid/?token=synthetic";
		await setTimer({ id: "secret", reason: secret, at: "in 2h", prompt: secret }, { cwd: projectA, sessionId: "s2" });
		await setTimer(
			{ id: "wakes-me", reason: "wake s1 from project A", at: "in 2h", prompt: "Check in." },
			{ cwd: projectA, sessionId: "s1" },
		);
		await setTimer(
			{
				id: "b-deploy",
				reason: "watch https://u:p@ci.invalid/run?token=synthetic&page=2",
				at: "in 2h",
				shell: "true",
			},
			{ cwd: projectB },
		);
		const description = new TimerTool(session(undefined, projectB)).description;
		expect(description).not.toContain("PRIVATE_MARKER");
		expect(description).not.toContain("- secret ·");
		expect(description).toContain("- wakes-me · once · wake s1 from project A");
		expect(description).toContain("- b-deploy · once · watch https://ci.invalid/run?token=");
		expect(description).toContain("page=2");
		expect(description).not.toContain("u:p@");
		expect(description).not.toContain("synthetic");
	});

	it("tiers and acts on a padded id as the timer it names", async () => {
		await setTimer(
			{ id: "foreign-shell", reason: "nightly", every: "daily 02:00", shell: "true" },
			{ cwd: dir.path() },
		);
		await setTimer(
			{ id: "foreign-wake", reason: "theirs", at: "in 1h", prompt: "Check in." },
			{ cwd: dir.path(), sessionId: "s2" },
		);
		const tool = new TimerTool(session());
		const replace = { op: "set", reason: "replacement", at: "in 1h", prompt: "Replacement prompt" } as const;
		expect(tool.approval({ ...replace, id: " foreign-shell " })).toBe("exec");
		expect(tool.approval({ ...replace, id: "\tforeign-wake\n" })).toBe("exec");
		expect(tool.approval({ op: "pause", id: " foreign-wake " })).toBe("exec");
		expect(tool.approval({ ...replace, id: " new-one " })).toBe("write");
		const shown = await tool.execute("c1", { op: "show", id: " foreign-wake " });
		expect(shown.details?.id).toBe("foreign-wake");
	});

	it("refuses to fire a timer into the session that calls it until the call is repeated", async () => {
		const tool = new TimerTool(session());
		await tool.execute("c1", { op: "set", id: "deploy-wait", reason: "deploy", at: "in 1h", prompt: "Run smoke." });
		expect(await failure(tool.execute("c2", { op: "fire", id: "deploy-wait" }))).toMatch(
			/same session right now, skipping its schedule and condition: it checks nothing/,
		);
		const fired = await tool.execute("c3", { op: "fire", id: "deploy-wait" });
		expect(fired.content.map(part => (part.type === "text" ? part.text : "")).join("")).toContain(
			"timer deploy-wait",
		);
	});

	it("in a turn a timer fire started, arms and changes timers that wake this session", async () => {
		const tool = new TimerTool(session());
		await tool.execute("c1", { op: "set", id: "deploy-wait", reason: "deploy", at: "in 1h", prompt: "Run smoke." });
		const fired = new TimerTool(session("deploy-wait#1"));
		await fired.execute("c2", { op: "set", id: "follow-up", reason: "again", at: "in 2h", prompt: "Recheck." });
		await fired.execute("c3", { op: "edit", id: "deploy-wait", at: "in 3h" });
		expect(await readTimerSpec("follow-up")).toMatchObject({
			target: { kind: "session", sessionId: "s1" },
			created: { run: "deploy-wait#1" },
		});
		expect((await fired.execute("c4", { op: "list" })).details?.rows).toHaveLength(2);
	});

	it("in a turn a timer fire started, refuses shell timers, other sessions' timers and firing another timer", async () => {
		const tool = new TimerTool(session());
		await tool.execute("c1", { op: "set", id: "deploy-wait", reason: "deploy", at: "in 1h", prompt: "Run smoke." });
		await tool.execute("c2", {
			op: "set",
			id: "notes",
			reason: "notes",
			at: "in 4h",
			prompt: "Draft the release notes.",
		});
		await tool.execute("c3", { op: "set", id: "nightly", reason: "nightly", every: "daily 02:00", shell: "true" });
		await setTimer(
			{ id: "theirs", reason: "theirs", at: "in 1h", prompt: "Check in." },
			{ cwd: dir.path(), sessionId: "s2" },
		);
		const fired = new TimerTool(session("deploy-wait#1"));
		expect(await failure(fired.execute("c4", { op: "edit", id: "theirs", at: "in 2h" }))).toMatch(
			/may edit only timer deploy-wait or prompt timers that wake this session, not timer theirs/,
		);
		const otherFile = path.resolve(dir.path(), "s2.jsonl");
		fs.writeFileSync(
			otherFile,
			`${JSON.stringify({ type: "session", id: "s2", timestamp: new Date(T0).toISOString(), cwd: dir.path() })}\n`,
		);
		expect(
			await failure(
				fired.execute("c5", { op: "set", reason: "other", at: "in 2h", prompt: "x", session: otherFile }),
			),
		).toMatch(/not a new timer/);
		expect(await failure(fired.execute("c6", { op: "pause", id: "nightly" }))).toMatch(/may pause only timer/);
		expect(await failure(fired.execute("c7", { op: "fire", id: "notes" }))).toMatch(
			/may fire only timer deploy-wait, not timer notes/,
		);
		expect((await readTimerSpec("theirs"))?.rev).toBe(1);
	});

	it("takes origin, this and current as the calling session, at the tier of a wake of itself", async () => {
		const tool = new TimerTool(session());
		const prompts = { origin: "Review the open PR.", this: "Water the plants.", current: "Rotate the logs." };
		for (const [name, prompt] of Object.entries(prompts)) {
			const request = { op: "set", id: `via-${name}`, reason: name, at: "in 1h", prompt, session: name } as const;
			expect(tool.approval(request)).toBe("write");
			await tool.execute(name, request);
			expect((await readTimerSpec(`via-${name}`))?.target).toEqual({
				kind: "session",
				sessionId: "s1",
				sessionFile: undefined,
			});
		}
	});

	it("sets allowTimers only at the exec tier", async () => {
		const tool = new TimerTool(session());
		const request = {
			op: "set",
			id: "chain",
			reason: "chain",
			at: "in 1h",
			prompt: "Set the next.",
			allowTimers: true,
		} as const;
		expect(tool.approval(request)).toBe("exec");
		await tool.execute("c1", request);
		expect((await readTimerSpec("chain"))?.allowTimers).toBe(true);
	});

	it("asks exec approval for a when.cmd check, as for a shell command, and write for ci or pid", () => {
		const tool = new TimerTool(session());
		const wake = { op: "set", id: "wait", reason: "wait", prompt: "Go on." } as const;
		expect(tool.approval({ ...wake, when: { cmd: "test -f dist/app.js" } })).toBe("exec");
		expect(tool.approval({ ...wake, when: { ci: "owner/repo#123" } })).toBe("write");
		expect(tool.approval({ ...wake, when: { pid: 4242 } })).toBe("write");
	});

	it("keeps a shell condition's text out of its description, credentials and all, and names a process condition", async () => {
		const cmd =
			"exit 1; curl -H 'Authorization: Bearer AUTH_SECRET' -H 'Cookie: sid=COOKIE_SECRET' -u user:BASIC_SECRET 'https://u:p@ci.invalid/run?token=QUERY_SECRET'; API_KEY=ENV_SECRET true";
		await setTimer(
			{ id: "deploy-gate", reason: "deploy", when: { cmd }, prompt: "Go on." },
			{ cwd: dir.path(), sessionId: "s1" },
		);
		await setTimer(
			{ id: "train-gate", reason: "training", when: { pid: process.pid }, prompt: "Read the loss." },
			{ cwd: dir.path(), sessionId: "s1" },
		);
		const description = new TimerTool(session()).description;
		expect(description).toContain("- deploy-gate · when a shell check passes · deploy");
		expect(description).toContain(`- train-gate · when process ${process.pid} exited · training`);
		for (const secret of [
			"AUTH_SECRET",
			"COOKIE_SECRET",
			"BASIC_SECRET",
			"QUERY_SECRET",
			"ENV_SECRET",
			"u:p@",
			"curl",
		]) {
			expect(description).not.toContain(secret);
		}
	});

	it("asks exec approval to control a stored timer with a shell check, write for one with a process condition", async () => {
		const ctx = { cwd: dir.path(), sessionId: "s1" };
		await setTimer({ id: "deploy-gate", reason: "deploy", when: { cmd: "exit 1" }, prompt: "Go on." }, ctx);
		await setTimer({ id: "train-gate", reason: "training", when: { pid: process.pid }, prompt: "Read it." }, ctx);
		const tool = new TimerTool(session());
		for (const op of ["resume", "pause", "fire", "remove"] as const) {
			expect(tool.approval({ op, id: "deploy-gate" })).toBe("exec");
			expect(tool.approval({ op, id: "train-gate" })).toBe("write");
		}
		expect(tool.approval({ op: "edit", id: "deploy-gate", prompt: "Changed." })).toBe("exec");
		expect(tool.approval({ op: "show", id: "deploy-gate" })).toBe("read");
	});
});

describe("timer duplicate check", () => {
	const watch = (id: string, ci: string, prompt = "CI finished: fix failures, else tell Will it is green.") => {
		const { until, text } = compileCondition({ ci });
		return { id, action: { kind: "prompt", prompt }, reason: "watch CI", until, condition: text } as TimerSpec;
	};

	it("tells CI watchers on other PRs and commits apart, and catches one on the same PR", () => {
		const existing = [watch("pr-479-ci", "will-bogusz/apt-tools#479")];
		expect(findDuplicateTimer(watch("pr-482-ci", "will-bogusz/apt-tools#482"), existing)).toBeUndefined();
		const tag = watch(
			"tag-after-ci",
			"will-bogusz/apt-tools@15f6793b20e4",
			"CI is green: tag v2.3 and push the tag.",
		);
		expect(findDuplicateTimer({ ...tag, reason: "tag v2.3 once CI on the push is green" }, existing)).toBeUndefined();
		expect(findDuplicateTimer(watch("ci-479", "will-bogusz/apt-tools#479", "Fix it."), existing)?.id).toBe(
			"pr-479-ci",
		);
	});

	it("keeps typed CI conditions apart when their labels share a PR number or a commit prefix", () => {
		const alpha = { ...watch("alpha-ci", "o/repo-a#479", "Deploy alpha artifact."), reason: "CI" };
		const beta = { ...watch("beta-ci", "o/repo-b#479", "Archive beta artifact."), reason: "CI" };
		expect(findDuplicateTimer(beta, [alpha])).toBeUndefined();
		const fix = { ...watch("fix", "o/repo-a@123456789abc1111111111111111111111111111", "Fix it."), reason: "CI" };
		const tag = { ...watch("tag", "o/repo-a@123456789abc2222222222222222222222222222", "Tag it."), reason: "CI" };
		expect(findDuplicateTimer(tag, [fix])).toBeUndefined();
		expect(findDuplicateTimer(watch("pr-13", "o/r#13"), [watch("pr-12", "o/r#12")])).toBeUndefined();
		const same = { ...watch("again", "o/repo-a#479", "Something else entirely."), reason: "other words" };
		expect(findDuplicateTimer(same, [alpha])?.id).toBe("alpha-ci");
	});
});
