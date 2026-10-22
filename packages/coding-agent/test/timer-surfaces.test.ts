import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { TimerProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/timer-protocol";
import { parseTimerSetArgs, parseTimerSugar } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-timer";
import { TIMERS_DIR_ENV } from "@oh-my-pi/pi-coding-agent/timers/paths";
import { setTimer, type TimerRow } from "@oh-my-pi/pi-coding-agent/timers/service";
import type { TimerSpec } from "@oh-my-pi/pi-coding-agent/timers/types";
import { timerArgsTier, timerPillText } from "@oh-my-pi/pi-coding-agent/tools/timer-view";
import { TempDir } from "@oh-my-pi/pi-utils";

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

/** Store a timer set by session `sess-a`: a wake of that session, or a shell command. */
async function store(id: string, action: { prompt: string } | { shell: string }): Promise<void> {
	await setTimer(
		{ id, reason: `test ${id}`, every: "daily 09:00", ...action },
		{ by: "cli", cwd: dir.path(), sessionId: "sess-a" },
	);
}

describe("timer approval tiers", () => {
	it("tiers a request by what it would run and whose session it wakes", () => {
		expect(timerArgsTier({ op: "list" }, "sess-a")).toBe("read");
		expect(timerArgsTier({ op: "set" }, "sess-a")).toBe("write");
		expect(timerArgsTier({ op: "set", session: "sess-a" }, "sess-a")).toBe("write");
		expect(timerArgsTier({ op: "set", shell: "make" }, "sess-a")).toBe("exec");
		expect(timerArgsTier({ op: "set", session: "fresh" }, "sess-a")).toBe("exec");
		expect(timerArgsTier({ op: "set", session: "sess-b" }, "sess-a")).toBe("exec");
		expect(timerArgsTier({ op: "set", host: "goliath" }, "sess-a")).toBe("exec");
	});

	it("controlling a stored timer is write only for the session it wakes", async () => {
		await store("wake-a", { prompt: "check in" });
		await store("prune", { shell: "true" });
		expect(timerArgsTier({ op: "fire", id: "wake-a" }, "sess-a")).toBe("write");
		expect(timerArgsTier({ op: "remove", id: "wake-a" }, "sess-b")).toBe("exec");
		// Re-arming another session's timer as a wake of your own is not cheaper than controlling it.
		expect(timerArgsTier({ op: "set", id: "wake-a" }, "sess-b")).toBe("exec");
		expect(timerArgsTier({ op: "pause", id: "prune" }, "sess-a")).toBe("exec");
		// Inspecting stays read whatever the timer runs.
		expect(timerArgsTier({ op: "show", id: "prune" }, "sess-b")).toBe("read");
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
		await expect(read("timer://wake-a")).rejects.toThrow('No timer "wake-a"');
		await expect(read("timer://wake-a/runs")).rejects.toThrow('No timer "wake-a"');
	});

	it("rejects unknown paths and reads of write-only verbs with the URL forms it accepts", async () => {
		await store("wake-a", { prompt: "x" });
		await expect(read("timer://wake-a/logs")).rejects.toThrow("timer://<id>/runs");
		await expect(read("timer://wake-a/fire")).rejects.toThrow("writable only");
		await expect(read("timer://wake-a/runs/latest")).rejects.toThrow("has no runs yet");
		await expect(handler.write(parseInternalUrl("timer://wake-a"), "")).rejects.toThrow("read-only");
	});
});

describe("/timer parsing", () => {
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

	it("maps `omp timer set` flags, honoring shell quoting", () => {
		expect(
			parseTimerSetArgs(`nightly --every 'daily 03:00' --shell "make backup" --reason=backup --max-runs 3`),
		).toEqual({ id: "nightly", every: "daily 03:00", shell: "make backup", reason: "backup", maxRuns: 3 });
		expect(() => parseTimerSetArgs("--bogus x")).toThrow("Unknown flag --bogus");
		expect(() => parseTimerSetArgs("--prompt")).toThrow("--prompt needs a value");
	});
});

describe("timers pill", () => {
	const row = (id: string, session: string, status: TimerRow["status"], next: TimerRow["next"]): TimerRow => ({
		spec: { id, created: { session } } as TimerSpec,
		state: { seq: 0, runCount: 0, failStreak: 0 },
		next,
		status,
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
		expect(timerPillText([row("g", "me", "armed", "gate")], "me", now)).toBe("1 · when gate");
		expect(timerPillText(rows, "nobody", now)).toBeUndefined();
	});
});
