import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import TimerCommand from "@oh-my-pi/pi-coding-agent/commands/timer";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { TimerProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/timer-protocol";
import {
	parseTimerEditArgs,
	parseTimerSetArgs,
	parseTimerSugar,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-timer";
import { runResultPath, TIMERS_DIR_ENV } from "@oh-my-pi/pi-coding-agent/timers/paths";
import { renderRuns } from "@oh-my-pi/pi-coding-agent/timers/render";
import { writeRunResult } from "@oh-my-pi/pi-coding-agent/timers/run-result";
import { setTimer, type TimerRow } from "@oh-my-pi/pi-coding-agent/timers/service";
import { openTimerDb, type RunView, readTimerSpec } from "@oh-my-pi/pi-coding-agent/timers/store";
import type { AgentRunResult, TimerSpec } from "@oh-my-pi/pi-coding-agent/timers/types";
import { timerArgsTier, timerEditPatch, timerPillText } from "@oh-my-pi/pi-coding-agent/tools/timer-view";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
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
		await expect(handler.write(url, "at in 3h")).rejects.toThrow("JSON object");
		await expect(handler.write(url, '{"session":"fresh"}')).rejects.toThrow("another session");
		await expect(handler.write(url, '{"bogus":1}')).rejects.toThrow("unknown edit field(s): bogus");
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

describe("edit field mapping", () => {
	it("leaves unset fields alone and clears the other schedule kinds only when a schedule is given", () => {
		expect(timerEditPatch({ prompt: "new" })).toMatchObject({ prompt: "new", at: undefined, every: undefined });
		expect(timerEditPatch({ every: "2h" })).toMatchObject({ every: "2h", at: null, when: null });
		expect(timerEditPatch({ expires: "never" }).expires).toBeNull();
		expect(() => timerEditPatch({})).toThrow("nothing to change");
	});

	it("maps /timer edit flags, with none clearing a field", () => {
		expect(parseTimerEditArgs("nightly --every none --at 'in 2h' --prompt go")).toEqual({
			id: "nightly",
			patch: expect.objectContaining({ every: null, at: "in 2h", prompt: "go", reason: undefined }),
		});
		expect(() => parseTimerEditArgs("--prompt go")).toThrow("needs a timer id");
		expect(() => parseTimerEditArgs("nightly")).toThrow("nothing to change");
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
		expect(timerPillText([row("g", "me", "armed", "gate")], "me", now)).toBe("1 · when gate");
		expect(timerPillText(rows, "nobody", now)).toBeUndefined();
	});
});

describe("agent-run surfaces", () => {
	const at = "2026-10-22T09:00:00.000Z";
	const result = (overrides: Partial<AgentRunResult> = {}): AgentRunResult => ({
		v: 1,
		runId: "triage#1",
		timerId: "triage",
		seq: 1,
		session: "own",
		ok: true,
		quiet: true,
		tokens: { input: 3000, output: 100, cacheRead: 0, cacheWrite: 0, total: 3100 },
		cost: 0.0021,
		startedAt: at,
		endedAt: at,
		durationMs: 12_000,
		cwd: dir.path(),
		finalText: "nothing new since yesterday",
		...overrides,
	});
	const runView: RunView = {
		runId: "triage#1",
		seq: 1,
		at,
		trigger: "manual",
		outcome: "fired",
		rev: 1,
		runner: true,
	};

	/** Run `omp timer <argv>` in-process; returns what it printed and its exit code. */
	async function omp(...argv: string[]): Promise<{ out: string; code: number | undefined }> {
		const write = spyOn(process.stdout, "write").mockImplementation(() => true);
		const before = process.exitCode;
		try {
			await new TimerCommand(argv, { bin: "omp", version: "0.0.0-test", commands: new Map() }).run();
			const code = process.exitCode === undefined ? undefined : Number(process.exitCode);
			return { out: write.mock.calls.map(call => String(call[0])).join(""), code };
		} finally {
			write.mockRestore();
			process.exitCode = before;
		}
	}

	it("omp timer set/edit store the agent-run flags; edit clears with none and --no-hermetic", async () => {
		const set = await omp(
			"set",
			"triage",
			"--every",
			"daily 09:00",
			"--session",
			"own",
			"--thinking",
			"low",
			"--hermetic",
			"--cwd",
			"run",
			"--max-time",
			"20m",
			"--max-cost",
			"0.5",
			"--expect",
			"out/a.md",
			"--expect",
			"out/b.md",
			"--before",
			"make prep",
			"--after",
			"make check",
			"--report",
			"failure",
			"--prompt",
			"triage new issues",
			"--reason",
			"morning triage",
			"--json",
		);
		expect(set).toMatchObject({ code: 0 });
		const spec = await readTimerSpec("triage");
		expect(spec?.target).toEqual({ kind: "own" });
		expect(spec?.report).toBe("failure");
		expect(spec?.run).toEqual({
			thinking: "low",
			hermetic: true,
			runCwd: true,
			maxTimeMs: 20 * 60_000,
			maxCost: 0.5,
			expect: ["out/a.md", "out/b.md"],
			before: "make prep",
			after: "make check",
		});

		const edit = await omp(
			"edit",
			"triage",
			"--max-cost",
			"none",
			"--expect",
			"none",
			"--before",
			"none",
			"--no-hermetic",
			"--thinking",
			"high",
			"--json",
		);
		expect(edit).toMatchObject({ code: 0 });
		expect((await readTimerSpec("triage"))?.run).toEqual({
			thinking: "high",
			runCwd: true,
			maxTimeMs: 20 * 60_000,
			after: "make check",
		});
	});

	it("/timer set maps the agent-run flags, with --expect repeatable", () => {
		expect(
			parseTimerSetArgs(
				`triage --session own --agent reviewer --thinking low --hermetic --cwd run --max-time 20m --max-cost 0.5 --expect out/a.md --expect out/b.md --before 'make prep' --after "make check" --report said`,
			),
		).toEqual({
			id: "triage",
			reason: "",
			session: "own",
			agent: "reviewer",
			thinking: "low",
			hermetic: true,
			cwd: "run",
			maxTime: "20m",
			maxCost: 0.5,
			expect: ["out/a.md", "out/b.md"],
			before: "make prep",
			after: "make check",
			report: "said",
		});
		expect(() => parseTimerSetArgs("--max-cost cheap")).toThrow("--max-cost takes a USD amount");
		expect(() => parseTimerSetArgs("--report sometimes")).toThrow("--report takes");
	});

	it("/timer edit clears agent-run keys with none and turns hermetic off with --no-hermetic", () => {
		const { patch } = parseTimerEditArgs(
			"triage --agent none --max-cost none --expect none --before none --no-hermetic --thinking high --report never",
		);
		expect(patch).toMatchObject({
			agent: null,
			maxCost: null,
			expect: null,
			before: null,
			hermetic: false,
			thinking: "high",
			report: "never",
		});
		expect(patch.after).toBeUndefined();
		expect(parseTimerEditArgs("triage --expect out/c.md").patch.expect).toEqual(["out/c.md"]);
	});

	it("tool edit fields map onto the agent-run edit keys", () => {
		expect(
			timerEditPatch({
				agent: "none",
				thinking: "low",
				hermetic: false,
				maxTime: "30m",
				maxCost: 0,
				expect: [],
				before: "make prep",
				after: "none",
				report: "always",
			}),
		).toMatchObject({
			agent: null,
			thinking: "low",
			hermetic: false,
			maxTime: "30m",
			maxCost: null,
			expect: null,
			before: "make prep",
			after: null,
			report: "always",
		});
		expect(timerEditPatch({ maxCost: 2, expect: ["out/a.md"] })).toMatchObject({
			maxCost: 2,
			expect: ["out/a.md"],
		});
	});

	it("before/after hooks are shell commands: they raise the tier like shell does", () => {
		expect(timerArgsTier({ op: "set", session: "origin" }, "sess-a")).toBe("write");
		expect(timerArgsTier({ op: "set", before: "make prep" }, "sess-a")).toBe(
			timerArgsTier({ op: "set", shell: "make prep" }, "sess-a"),
		);
		expect(timerArgsTier({ op: "edit", after: "make check" }, "sess-a")).toBe("exec");
		const url = parseInternalUrl("timer://wake-a/edit");
		const sessA = { getSessionId: () => "sess-a" } as unknown as ToolSession;
		expect(new TimerProtocolHandler().spec.write?.tier(url, '{"before":"make prep"}', sessA)).toBe("exec");
	});

	it("renderRuns appends the result summary of runs that have one", () => {
		const text = renderRuns([runView, { ...runView, runId: "triage#2", seq: 2 }], new Map([[1, result()]]));
		const [first, second] = text.split("\n");
		expect(first).toContain("result=ok · quiet · $0.0021 · 3.1k tok");
		expect(second).not.toContain("result=");
		expect(renderRuns([runView], new Map([[1, result({ ok: false, failure: "budget", quiet: false })]]))).toContain(
			"result=failed: budget",
		);
	});

	it("timer://<id>/runs/<seq> returns the run with its result.json; the card shows run settings and the result", async () => {
		await setTimer(
			{
				id: "triage",
				reason: "morning triage",
				every: "daily 09:00",
				prompt: "triage new issues",
				session: "own",
				cwd: "run",
				thinking: "low",
				maxCost: 0.5,
			},
			{ by: "cli", cwd: dir.path(), sessionId: "sess-a" },
		);
		openTimerDb().insertRun(
			"triage",
			{ runId: "triage#1", seq: 1, at, trigger: "manual", outcome: "fired", rev: 1 },
			true,
		);
		await writeRunResult(result());
		const handler = new TimerProtocolHandler();
		const read = async (url: string) => (await handler.resolve(parseInternalUrl(url))).content;

		const run = await read("timer://triage/runs/1");
		expect(run).toContain("result=ok · quiet · $0.0021");
		expect(run).toContain(runResultPath("triage", 1));
		expect(run).toContain('"finalText": "nothing new since yesterday"');
		expect(await read("timer://triage/runs/latest")).toContain(runResultPath("triage", 1));
		await expect(read("timer://triage/runs/2")).rejects.toThrow("has no run 2");

		const card = await read("timer://triage");
		expect(card).toContain("own session in a per-run dir");
		expect(card).toMatch(/^run {4}thinking low · cwd per-run · max \$0\.50 · report said · session /m);
		expect(card).toMatch(/^last {3}fired .* · ok · quiet · \$0\.0021/m);
		expect(await read("timer://triage/runs")).toContain("result=ok · quiet");
	});
});
