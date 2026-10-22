import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TimerTool } from "@oh-my-pi/pi-coding-agent/tools/timer";
import { TIMERS_DIR_ENV } from "@oh-my-pi/pi-coding-agent/timers/paths";
import { renderTimerCard } from "@oh-my-pi/pi-coding-agent/timers/render";
import { editTimer, loadTimerRow, setTimer, type TimerSetInput } from "@oh-my-pi/pi-coding-agent/timers/service";
import { closeTimerDbs } from "@oh-my-pi/pi-coding-agent/timers/store";
import { TempDir } from "@oh-my-pi/pi-utils";

const T0 = Date.parse("2026-10-22T08:33:00Z"); // Thu 01:33 in Los Angeles
const LA = "America/Los_Angeles";

describe("timer set guards (tool callers)", () => {
	let dir: TempDir;
	let root: string;
	const tool = (extra: { now?: number; testGate?: boolean } = {}) => ({
		by: "tool" as const,
		cwd: root,
		now: T0,
		root,
		sessionId: "s1",
		testGate: false,
		...extra,
	});
	const cli = () => ({ by: "cli" as const, cwd: root, now: T0, root, testGate: false });
	const base: TimerSetInput = { reason: "test", tz: LA, prompt: "Do the thing.", session: "fresh" };

	beforeEach(() => {
		dir = TempDir.createSync("omp-timer-guards-");
		root = dir.path();
	});
	afterEach(async () => {
		closeTimerDbs();
		await dir.remove();
	});

	it("refuses a condition that already holds, explains why, and arms it when the same call is repeated", async () => {
		const met = { ...base, id: "deploy-done", when: { cmd: "echo IN_PROGRESS" } };
		await expect(setTimer(met, tool({ testGate: true }))).rejects.toThrow(
			/not armed: the condition already holds .*printed: IN_PROGRESS.*send this same call again/s,
		);
		const repeated = await setTimer(met, tool({ testGate: true }));
		expect(repeated.gateNow).toBe("met");
		// a repeat after the confirmation window is a new call, checked again
		const late = {
			...base,
			id: "export-ready",
			reason: "export",
			prompt: "Fetch the export.",
			when: { cmd: "echo RUNNING" },
		};
		await expect(setTimer(late, tool({ testGate: true }))).rejects.toThrow(/already holds/);
		await expect(setTimer(late, tool({ testGate: true, now: T0 + 11 * 60_000 }))).rejects.toThrow(/already holds/);
		const pending = await setTimer(
			{ ...base, id: "upload-wait", reason: "upload", when: { cmd: "echo PROCESSING | grep -q DONE" } },
			tool({ testGate: true }),
		);
		expect(pending.gateNow).toBe("not-yet");
	});

	it("refuses an edit to a condition that already holds and keeps the old one", async () => {
		await setTimer({ ...base, id: "wait", when: { cmd: "exit 1" } }, tool({ testGate: true }));
		await expect(editTimer("wait", { when: { cmd: "true" } }, tool({ testGate: true }))).rejects.toThrow(
			/already holds/,
		);
		const kept = await editTimer("wait", { prompt: "Changed." }, tool({ testGate: true }));
		expect(kept.spec.until).toBe("exit 1");
	});

	it("leaves the CLI free to arm a condition that already holds", async () => {
		const result = await setTimer({ ...base, id: "cli-met", when: { cmd: "true" } }, { ...cli(), testGate: true });
		expect(result.gateNow).toBe("met");
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
		await expect(setTimer(again, tool())).rejects.toThrow(/timer "market-check" .* already looks like this job/);
		// re-arming the same id is the way to change it; repeating the refused call arms a deliberate second one
		expect((await setTimer({ ...again, id: "market-check" }, tool())).replaced).toBe(true);
		const second = { ...again, id: "market-check-2" };
		await expect(setTimer(second, tool())).rejects.toThrow(/send this same call again within 10m/);
		expect((await setTimer(second, tool())).spec.id).toBe("market-check-2");
	});

	it("catches a second watcher on the same condition and a re-check under a new id after a one-shot fired", async () => {
		await setTimer({ ...base, id: "pr-479-ci", when: { ci: "will-bogusz/apt-tools#479" } }, cli());
		await expect(
			setTimer({ ...base, id: "ci-479", when: { ci: "will-bogusz/apt-tools#479" }, prompt: "Fix it." }, tool()),
		).rejects.toThrow(/"pr-479-ci"/);
		const deploy = "Check `scripts/deploy-status.sh prod`. If it finished, tell Will the result.";
		await setTimer(
			{ ...base, id: "prod-deploy", at: "now", prompt: deploy, reason: "Will: how did the deploy go" },
			cli(),
		);
		await expect(
			setTimer(
				{ ...base, id: "prod-deploy-recheck", at: "in 10m", prompt: deploy, reason: "deploy still running" },
				tool(),
			),
		).rejects.toThrow(/set` with id "prod-deploy"/);
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
		const watch = await setTimer(
			{ ...base, when: { cmd: "test -f out/report.csv" }, prompt: "Send the report.", reason: "report ready" },
			tool(),
		);
		expect([reminder.replaced, watch.replaced]).toEqual([false, false]);
	});
});

describe("timer card dates", () => {
	let dir: TempDir;
	let root: string;
	const ctx = () => ({ by: "cli" as const, cwd: root, now: T0, root, testGate: false });
	const ticker = { lastTickAt: new Date(T0 - 20_000).toISOString() };

	beforeEach(() => {
		dir = TempDir.createSync("omp-timer-dates-");
		root = dir.path();
	});
	afterEach(async () => {
		closeTimerDbs();
		await dir.remove();
	});

	it("says today/tomorrow and warns when a typed date skips the sooner same clock time", async () => {
		const input = { reason: "resume after the reset", tz: LA, prompt: "Resume.", session: "fresh" };
		const slipped = await setTimer({ ...input, id: "slip", at: "2026-10-23 04:43" }, ctx());
		const card = renderTimerCard(await loadTimerRow(slipped.spec, T0), T0, {
			verb: "armed",
			ticker,
			warnings: slipped.warnings,
			platform: "linux",
		});
		expect(card).toContain("Fri 2026-10-23 04:43 PDT (tomorrow, in 1d3h");
		expect(card).toContain(`Thu 2026-10-22 04:43 PDT (in 3h10m). If that is the one meant, edit at to "04:43"`);

		const today = await setTimer({ ...input, id: "today", at: "04:43" }, ctx());
		expect(today.warnings).toEqual([]);
		expect(renderTimerCard(await loadTimerRow(today.spec, T0), T0, { verb: "armed", ticker })).toContain(
			"(today, in 3h10m)",
		);
		// a date two days out names the day it means; no warning
		expect((await setTimer({ ...input, id: "later", at: "2026-10-24 04:43" }, ctx())).warnings).toEqual([]);
		// in daytime a date one day out is what "tomorrow" means; no warning
		const noon = T0 + 10 * 60 * 60_000; // Thu 11:33
		const daytime = await setTimer({ ...input, id: "daytime", at: "2026-10-23 12:00" }, { ...ctx(), now: noon });
		expect(daytime.warnings).toEqual([]);
	});
});

describe("timer tool fire", () => {
	let dir: TempDir;
	let previousRoot: string | undefined;

	beforeEach(() => {
		dir = TempDir.createSync("omp-timer-fire-");
		previousRoot = Bun.env[TIMERS_DIR_ENV];
		Bun.env[TIMERS_DIR_ENV] = dir.path();
	});
	afterEach(async () => {
		closeTimerDbs();
		if (previousRoot === undefined) delete Bun.env[TIMERS_DIR_ENV];
		else Bun.env[TIMERS_DIR_ENV] = previousRoot;
		await dir.remove();
	});

	it("refuses to fire a timer into the session that calls it: firing checks nothing", async () => {
		const session = {
			cwd: dir.path(),
			getSessionId: () => "s1",
			getSessionFile: () => null,
		} as unknown as ToolSession;
		const tool = new TimerTool(session);
		await tool.execute("c1", { op: "set", id: "deploy-wait", reason: "deploy", at: "in 1h", prompt: "Run smoke." });
		await expect(tool.execute("c2", { op: "fire", id: "deploy-wait" })).rejects.toThrow(
			/same session right now, skipping its schedule and condition: it checks nothing/,
		);
	});
});
