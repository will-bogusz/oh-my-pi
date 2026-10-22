import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import {
	type HostCommandResult,
	machineWakeCancelArgv,
	type WakeHost,
	wakeStamp,
} from "@oh-my-pi/pi-coding-agent/timers/install/index";
import { specPath } from "@oh-my-pi/pi-coding-agent/timers/paths";
import { editTimer, removeTimer, setPaused, setTimer } from "@oh-my-pi/pi-coding-agent/timers/service";
import { closeTimerDbs, openTimerDb } from "@oh-my-pi/pi-coding-agent/timers/store";
import { fireTimerNow, runTick, type TickDeps } from "@oh-my-pi/pi-coding-agent/timers/tick";
import { TempDir } from "@oh-my-pi/pi-utils";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-21T12:00:00Z");

class FakeWakeHost implements WakeHost {
	user = "tester";
	commands: string[][] = [];
	/** Exit code per argv joined with spaces; unscripted commands succeed. */
	failures = new Map<string, Partial<HostCommandResult>>();

	constructor(public platform: NodeJS.Platform = "darwin") {}

	async run(argv: string[]): Promise<HostCommandResult> {
		this.commands.push(argv);
		return { exitCode: 0, stdout: "", stderr: "", ...this.failures.get(argv.join(" ")) };
	}
}

const scheduleArgv = (at: number) => ["sudo", "-n", "pmset", "schedule", "wake", wakeStamp(at).stamp];
const cancelArgv = (at: number) => machineWakeCancelArgv(wakeStamp(at).stamp);

describe("machine wake follows its timer", () => {
	let dir: TempDir;
	let root: string;
	let host: FakeWakeHost;

	beforeEach(() => {
		dir = TempDir.createSync("omp-timer-wake-");
		root = dir.path();
		host = new FakeWakeHost();
	});
	afterEach(async () => {
		closeTimerDbs();
		await dir.remove();
	});

	const ctx = (now = T0) => ({ by: "cli" as const, cwd: root, now, root, host, testGate: false });
	const deps = (): Partial<TickDeps> => ({
		root,
		host,
		spawnRunner: () => {},
		inFlight: () => false,
		deliveryTarget: () => ({ kind: "free" }),
		notify: async () => {},
	});
	const wakes = () => openTimerDb(root).listMachineWakes();
	const setWake = (extra: Record<string, unknown> = {}) =>
		setTimer({ id: "wake", reason: "test", at: "in 30m", shell: "true", wakeMachine: true, ...extra }, ctx());
	const AT = T0 + 30 * MINUTE;

	it("schedules and records the wake on set", async () => {
		const result = await setWake();
		expect(result.warnings).toEqual([]);
		expect(host.commands).toEqual([scheduleArgv(AT)]);
		expect(wakes()).toEqual([{ timerId: "wake", ...wakeStamp(AT) }]);
	});

	it("cancels the exact stamp on rm", async () => {
		await setWake();
		host.commands = [];
		expect(await removeTimer("wake", root, { now: T0, host })).toBe(true);
		expect(host.commands).toEqual([cancelArgv(AT)]);
		expect(wakes()).toEqual([]);
	});

	it("moves the wake when edit changes at", async () => {
		await setWake();
		host.commands = [];
		const result = await editTimer("wake", { at: "in 90m" }, ctx());
		expect(result.warnings).toEqual([]);
		const moved = T0 + 90 * MINUTE;
		expect(host.commands).toEqual([cancelArgv(AT), scheduleArgv(moved)]);
		expect(wakes()).toEqual([{ timerId: "wake", ...wakeStamp(moved) }]);
	});

	it("cancels when edit turns wakeMachine off, and leaves the wake alone on unrelated edits", async () => {
		await setWake();
		host.commands = [];
		await editTimer("wake", { title: "renamed" }, ctx());
		expect(host.commands).toEqual([]);
		await editTimer("wake", { wakeMachine: false }, ctx());
		expect(host.commands).toEqual([cancelArgv(AT)]);
		expect(wakes()).toEqual([]);
	});

	it("cancels on pause and reschedules on resume", async () => {
		await setWake();
		host.commands = [];
		await setPaused("wake", true, { root, now: T0 + MINUTE, host });
		expect(host.commands).toEqual([cancelArgv(AT)]);
		expect(wakes()).toEqual([]);
		await setPaused("wake", false, { root, now: T0 + 2 * MINUTE, host });
		expect(host.commands).toEqual([cancelArgv(AT), scheduleArgv(AT)]);
		expect(wakes()).toEqual([{ timerId: "wake", ...wakeStamp(AT) }]);
	});

	it("does not reschedule on resume once the wake time has passed", async () => {
		await setWake();
		await setPaused("wake", true, { root, now: T0, host });
		host.commands = [];
		await setPaused("wake", false, { root, now: AT - MINUTE, host });
		expect(host.commands).toEqual([]);
		expect(wakes()).toEqual([]);
	});

	it("a tick cancels the pending wake of a timer that retired before it", async () => {
		await setWake({ maxRuns: 1 });
		await fireTimerNow("wake", T0 + MINUTE, { deps: deps() }); // max-runs: done before the wake
		host.commands = [];
		await runTick(T0 + 2 * MINUTE, deps());
		expect(host.commands).toEqual([cancelArgv(AT)]);
		expect(wakes()).toEqual([]);
	});

	it("a tick drops the record of a wake already past without running pmset", async () => {
		await setWake();
		host.commands = [];
		await runTick(AT + 1_000, deps()); // fires once: done
		expect(host.commands).toEqual([]);
		expect(wakes()).toEqual([]);
	});

	it("a tick cancels the wake of a timer whose spec disappeared without the service", async () => {
		await setWake();
		await fs.rm(specPath("wake", root));
		host.commands = [];
		await runTick(T0 + MINUTE, deps());
		expect(host.commands).toEqual([cancelArgv(AT)]);
		expect(wakes()).toEqual([]);
	});

	it("a tick never schedules a wake for a timer without a record", async () => {
		await setWake();
		openTimerDb(root).deleteMachineWake("wake");
		host.commands = [];
		await runTick(T0 + MINUTE, deps());
		expect(host.commands).toEqual([]);
		expect(wakes()).toEqual([]);
	});

	it("warns off macOS and runs nothing", async () => {
		host = new FakeWakeHost("linux");
		const result = await setWake();
		expect(result.warnings).toEqual(["wakeMachine only applies on macOS; ignored"]);
		expect(host.commands).toEqual([]);
		expect(wakes()).toEqual([]);
	});

	it("records nothing when pmset refuses, and warns", async () => {
		host.failures.set(scheduleArgv(AT).join(" "), { exitCode: 1, stderr: "sudo: a password is required" });
		const result = await setWake();
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toStartWith("machine wake not scheduled: ");
		expect(result.warnings[0]).toContain("sudo: a password is required");
		expect(wakes()).toEqual([]);
	});
});
