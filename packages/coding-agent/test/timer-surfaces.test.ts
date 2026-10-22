import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { TimerProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/timer-protocol";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { parseTimerSugar, runTimerSlash } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-timer";
import { TIMERS_DIR_ENV } from "@oh-my-pi/pi-coding-agent/timers/paths";
import { renderTimerCard } from "@oh-my-pi/pi-coding-agent/timers/render";
import { listTimers, loadTimerRow, setTimer, type TimerRow } from "@oh-my-pi/pi-coding-agent/timers/service";
import { readTimerSpec } from "@oh-my-pi/pi-coding-agent/timers/store";
import type { TimerSpec } from "@oh-my-pi/pi-coding-agent/timers/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { requiresApproval, resolveApproval, resolveToolTier } from "@oh-my-pi/pi-coding-agent/tools/approval";
import {
	timerCardView,
	timerEditPatch,
	timerEditTier,
	timerIdTier,
	timerPillText,
} from "@oh-my-pi/pi-coding-agent/tools/timer-view";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { TempDir } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

let dir: TempDir;
let previous: string | undefined;
beforeEach(() => {
	dir = TempDir.createSync("omp-timer-surfaces-");
	previous = Bun.env[TIMERS_DIR_ENV];
	Bun.env[TIMERS_DIR_ENV] = dir.path();
});
afterEach(async () => {
	if (previous === undefined) delete Bun.env[TIMERS_DIR_ENV];
	else Bun.env[TIMERS_DIR_ENV] = previous;
	await dir.remove();
});

/** The message a rejection settled from store I/O carries. */
async function failure(promise: Promise<unknown>): Promise<string> {
	return String(await rejectionOf(promise));
}

/** Store a timer set by session `sess-a`: a wake of that session, or a shell command. */
async function store(id: string, action: { prompt: string } | { shell: string }): Promise<void> {
	await setTimer(
		{ id, reason: `test ${id}`, every: "daily 09:00", ...action },
		{ cwd: dir.path(), sessionId: "sess-a" },
	);
}

/** The session `/timer` runs in: only its id and file are read. */
function sessionNamed(id: string): AgentSession {
	return { sessionManager: { getSessionId: () => id, getSessionFile: () => undefined } } as unknown as AgentSession;
}

describe("timer approval tiers", () => {
	it("controlling a stored timer is write only for the session it wakes", async () => {
		await store("wake-a", { prompt: "check in" });
		await store("prune", { shell: "true" });
		expect(timerIdTier("wake-a", "sess-a")).toBe("write");
		expect(timerIdTier("wake-a", "sess-b")).toBe("exec");
		expect(timerIdTier("prune", "sess-a")).toBe("exec");
		// An unknown id fails on its own; nothing runs.
		expect(timerIdTier("nope", "sess-a")).toBe("write");
	});

	it("an edit that sets a shell command is exec even on the caller's own wake", async () => {
		await store("wake-a", { prompt: "check in" });
		expect(timerEditTier("wake-a", { at: "in 3h" }, "sess-a")).toBe("write");
		expect(timerEditTier("wake-a", { shell: "make" }, "sess-a")).toBe("exec");
		expect(timerEditTier("wake-a", { at: "in 3h" }, "sess-b")).toBe("exec");
	});
});

describe("write timer://<id>/edit approval", () => {
	/** The write tool as session `sess-a` runs it, with timers on or off. */
	function writeTool(timerEnabled = true): WriteTool {
		return new WriteTool({
			cwd: dir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => "sess-a",
			settings: Settings.isolated({ "timer.enabled": timerEnabled }),
		});
	}

	/** Runs the write only when the `write` approval mode lets it through without a prompt. */
	async function writeUnprompted(tool: WriteTool, path: string, content: string): Promise<boolean> {
		if (requiresApproval(tool, { path, content }, "write").required) return false;
		await tool.execute("call", { path, content });
		return true;
	}

	it.each([
		"timer://wake-a/edit",
		"timer://wake-a/edit:raw",
		"timer://wake-a/edit:conflicts",
		"[timer://wake-a/edit#ABCD]",
		"[timer://wake-a/edit:raw#ABCD]",
	])("turning the caller's own wake into a shell command through %s needs exec", async path => {
		await store("wake-a", { prompt: "check in" });
		const tool = writeTool();
		expect(resolveToolTier(tool, { path, content: '{"shell":"make"}' })).toBe("exec");
		expect(await writeUnprompted(tool, path, '{"shell":"make"}')).toBe(false);
		expect((await readTimerSpec("wake-a"))?.action).toEqual({ kind: "prompt", prompt: "check in" });
	});

	it("a non-shell edit of the caller's own wake through :raw stays write and lands", async () => {
		await store("wake-a", { prompt: "check in" });
		expect(await writeUnprompted(writeTool(), "timer://wake-a/edit:raw", '{"prompt":"check again"}')).toBe(true);
		expect((await readTimerSpec("wake-a"))?.action).toEqual({ kind: "prompt", prompt: "check again" });
	});

	it("refuses a line-range selector at the gate and any edit while timers are disabled", async () => {
		await store("wake-a", { prompt: "check in" });
		const lineRange = resolveApproval(writeTool(), { path: "timer://wake-a/edit:1-2", content: "{}" }, "yolo");
		expect(lineRange.policy).toBe("deny");
		const disabled = await rejectionOf(
			writeTool(false).execute("call", { path: "timer://wake-a/edit:raw", content: '{"prompt":"x"}' }),
		);
		expect(String(disabled)).toContain("timer.enabled");
		expect((await readTimerSpec("wake-a"))?.action).toEqual({ kind: "prompt", prompt: "check in" });
	});
});

describe("timer:// protocol", () => {
	const handler = new TimerProtocolHandler();
	const read = async (url: string) => (await handler.resolve(parseInternalUrl(url))).content;

	it("lists timers, shows the full prompt, and applies pause and remove writes to the store", async () => {
		await store("wake-a", { prompt: "line one\nline two of the prompt" });
		expect(await read("timer://")).toContain("wake-a");
		const shown = await read("timer://wake-a");
		expect(shown).toContain("line two of the prompt");
		expect(shown.split("\n")[0]).not.toContain("paused");

		await handler.write(parseInternalUrl("timer://wake-a/pause"), "");
		expect((await read("timer://wake-a")).split("\n")[0]).toContain("paused");
		await handler.write(parseInternalUrl("timer://wake-a/resume"), "");
		expect((await read("timer://")).split("\n")[1]).toContain("armed");

		await handler.write(parseInternalUrl("timer://wake-a/remove"), "");
		expect(await failure(read("timer://wake-a"))).toContain('No timer "wake-a"');
		expect(await failure(read("timer://wake-a/runs"))).toContain('No timer "wake-a"');
	});

	it("rejects unknown paths and reads of write-only verbs with the URL forms it accepts", async () => {
		await store("wake-a", { prompt: "x" });
		expect(await failure(read("timer://wake-a/logs"))).toContain("timer://<id>/runs");
		expect(await failure(read("timer://wake-a/fire"))).toContain("writable only");
		expect(await failure(read("timer://wake-a/runs/latest"))).toContain("has no runs yet");
		expect(await failure(handler.write(parseInternalUrl("timer://wake-a"), ""))).toContain("read-only");
	});

	it("edits through timer://<id>/edit: a new schedule replaces the old one, other fields stay", async () => {
		await store("wake-a", { prompt: "check in" });
		const url = parseInternalUrl("timer://wake-a/edit");
		const sessA = { getSessionId: () => "sess-a" } as unknown as ToolSession;
		expect(handler.spec.write?.tier(url, '{"at":"in 3h"}', sessA)).toBe("write");
		expect(handler.spec.write?.tier(url, '{"shell":"make"}', sessA)).toBe("exec");
		const result = await handler.write(url, '{"at":"in 3h","expires":"never"}');
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("re-armed") });
		const spec = await readTimerSpec("wake-a");
		expect(spec?.at).toBeDefined();
		expect(spec?.every).toBeUndefined();
		expect(spec?.action).toEqual({ kind: "prompt", prompt: "check in" });
		expect(await failure(handler.write(url, "at in 3h"))).toContain("JSON object");
		expect(await failure(handler.write(url, '{"session":"sess-b"}'))).toContain("another session");
		expect(await failure(handler.write(url, '{"bogus":1}'))).toContain("unknown edit field(s): bogus");
	});
});

describe("/timer", () => {
	it("reads the schedule off the front of sugar and keeps the typed text as the reason", () => {
		expect(parseTimerSugar("in 2h re-run the benchmark")).toEqual({
			at: "in 2h",
			prompt: "re-run the benchmark",
			reason: "re-run the benchmark",
		});
		expect(parseTimerSugar("at 2026-12-01 09:30 finish the migration")).toMatchObject({
			at: "2026-12-01 09:30",
			prompt: "finish the migration",
		});
		expect(parseTimerSugar("at 8:00 finish the migration")).toMatchObject({
			at: "8:00",
			prompt: "finish the migration",
		});
		expect(parseTimerSugar("every 30m check the build")).toMatchObject({ every: "30m", prompt: "check the build" });
		expect(parseTimerSugar("every */5 * * * * poll")).toMatchObject({ every: "*/5 * * * *", prompt: "poll" });
	});

	it("is not sugar without a valid schedule and a prompt", () => {
		expect(parseTimerSugar("in soon do it")).toBeUndefined();
		expect(parseTimerSugar("in 2h")).toBeUndefined();
		expect(parseTimerSugar("show wake-a")).toBeUndefined();
	});

	it("`set` takes the omp timer set flags, policy and --when included, honoring shell quoting", async () => {
		const slash = (args: string) => runTimerSlash(args, sessionNamed("sess-a"), dir.path());
		await slash(
			`set nightly --when 'every 2h' --shell "make backup" --reason=backup --max-runs 3 --overlap queue --catchup skip --grace 30m --pause-after 5 --allow-timers`,
		);
		const spec = await readTimerSpec("nightly");
		expect(spec).toMatchObject({
			every: "2h",
			action: { kind: "shell", command: "make backup" },
			maxRuns: 3,
			overlap: "queue",
			catchup: "skip",
			graceMs: 30 * 60_000,
			pauseAfter: 5,
			allowTimers: true,
		});
		expect(spec?.at).toBeUndefined();
		expect(await failure(slash("set --bogus x"))).toContain("--bogus");
		expect(await failure(slash("set nightly --json --reason r --every 2h --shell true"))).toContain("set/edit flags");
	});

	it("`in 2h <prompt>` arms a wake of the calling session, which its pill then counts", async () => {
		const result = await runTimerSlash("in 2h re-run the benchmark", sessionNamed("sess-a"), dir.path());
		expect(result.card).toMatchObject({ verb: "armed", does: 'wake this session → "re-run the benchmark"' });
		expect(result.text).toContain("(this session)");
		const spec = await readTimerSpec(result.card!.id);
		expect(spec?.target).toEqual({ kind: "session", sessionId: "sess-a", sessionFile: undefined });
		expect(spec?.created.session).toBe("sess-a");
		const now = Date.now();
		const { rows } = await listTimers(now);
		expect(timerPillText(rows, "sess-a", now)).toStartWith("1 · next ");
		expect(timerPillText(rows, "sess-b", now)).toBeUndefined();
	});
});

describe("edit field mapping", () => {
	it("leaves unset fields alone and clears the other schedule kind only when a schedule is given", () => {
		expect(timerEditPatch({ prompt: "new" })).toMatchObject({ prompt: "new", at: undefined, every: undefined });
		expect(timerEditPatch({ every: "2h" })).toMatchObject({ every: "2h", at: null });
		expect(timerEditPatch({ expires: "never" }).expires).toBeNull();
		expect(() => timerEditPatch({})).toThrow("nothing to change");
	});

	it("`edit` takes the omp timer edit flags: policy, --allow-timers, none clearing a field, and a --rev check", async () => {
		const slash = (args: string) => runTimerSlash(args, sessionNamed("sess-a"), dir.path());
		await slash("set nightly --every 2h --shell true --reason backup --grace 30m");
		const { rev } = (await readTimerSpec("nightly"))!;
		expect(await failure(slash(`edit nightly --overlap queue --rev ${rev + 1}`))).toContain("rev");
		expect((await readTimerSpec("nightly"))?.overlap).toBe("skip");

		await slash(
			`edit nightly --overlap queue --catchup skip --grace none --pause-after 2 --allow-timers --rev ${rev}`,
		);
		expect(await readTimerSpec("nightly")).toMatchObject({
			overlap: "queue",
			catchup: "skip",
			pauseAfter: 2,
			allowTimers: true,
		});
		expect((await readTimerSpec("nightly"))?.graceMs).toBeUndefined();
		await slash("edit nightly --title Nightly");
		expect((await readTimerSpec("nightly"))?.allowTimers).toBe(true);
		expect(await failure(slash("edit --prompt go"))).toContain("needs a timer id");
		expect(await failure(slash("edit nightly"))).toContain("nothing to change");
	});
});

describe("timers pill", () => {
	const row = (id: string, session: string, status: TimerRow["status"], next: TimerRow["next"]): TimerRow => ({
		spec: { id, created: { session } } as TimerSpec,
		state: { seq: 0, runCount: 0, failStreak: 0 },
		next,
		status,
		incidents: [],
	});

	it("counts the armed timers this session set and names the soonest fire", () => {
		const now = new Date(2026, 9, 22, 1, 0).getTime();
		const rows = [
			row("a", "me", "armed", new Date(2026, 9, 22, 8, 0).getTime()),
			row("b", "me", "armed", new Date(2026, 9, 22, 6, 5).getTime()),
			row("c", "me", "paused", new Date(2026, 9, 22, 2, 0).getTime()),
			row("d", "other", "armed", new Date(2026, 9, 22, 1, 30).getTime()),
		];
		expect(timerPillText(rows, "me", now)).toBe("2 · next 06:05");
		expect(timerPillText([row("e", "me", "armed", new Date(2026, 9, 24, 9, 0).getTime())], "me", now)).toBe(
			"1 · next Sat 09:00",
		);
		expect(timerPillText(rows, "nobody", now)).toBeUndefined();
	});
});

describe("timer card ticker line", () => {
	it("says a one-shot fires within a minute after its time, and a recurring timer does not", async () => {
		const now = Date.now();
		const ticker = { lastTickAt: new Date(now - 20_000).toISOString() };
		const once = await setTimer({ id: "once", reason: "r", at: "in 2h", shell: "true" }, { cwd: dir.path(), now });
		const daily = await setTimer(
			{ id: "daily", reason: "r", every: "daily 09:00", shell: "true" },
			{ cwd: dir.path(), now },
		);
		const tickerLine = async (spec: TimerSpec) =>
			renderTimerCard(await loadTimerRow(spec, now), now, { verb: "armed", ticker })
				.split("\n")
				.find(line => line.startsWith("ticker "));
		expect(await tickerLine(once.spec)).toContain("fires within a minute after its time");
		expect(await tickerLine(daily.spec)).toStartWith("ticker last tick 20s ago");
		expect(await tickerLine(daily.spec)).not.toContain("fires within");
		expect(timerCardView(await loadTimerRow(once.spec, now), { verb: "armed", ticker, now }).ticker).toContain(
			"fires within a minute",
		);
	});
});
