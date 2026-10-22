import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { type HostCommandResult, type WakeHost, wakeStamp } from "@oh-my-pi/pi-coding-agent/timers/install/index";
import { specPath } from "@oh-my-pi/pi-coding-agent/timers/paths";
import { renderTimerCard } from "@oh-my-pi/pi-coding-agent/timers/render";
import {
	editTimer,
	loadTimerRow,
	removeTimer,
	setPaused,
	setTimer,
	type TimerEditInput,
} from "@oh-my-pi/pi-coding-agent/timers/service";
import { closeTimerDbs, openTimerDb } from "@oh-my-pi/pi-coding-agent/timers/store";
import { fireTimerNow, runTick, type TickDeps } from "@oh-my-pi/pi-coding-agent/timers/tick";
import { TempDir } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-21T12:00:00Z");
const REFUSED = "sudo: a password is required";

/**
 * pmset as the timer sees it: a set of scheduled wake instants. Like pmset, it parses each stamp in the
 * host's current local zone and refuses to cancel a wake it does not hold.
 */
class FakeWakeHost implements WakeHost {
	user = "tester";
	commands: string[][] = [];
	events = new Set<number>();
	/** sudo refuses this verb (`wake` schedules, `cancel` cancels). */
	refuse = new Set<"wake" | "cancel">();
	/** Runs before a schedule is accepted; may block or throw. */
	beforeSchedule?: () => Promise<void>;
	/** Runs after a schedule is accepted, before pmset replies; may block or throw. */
	afterSchedule?: () => Promise<void>;

	constructor(public platform: NodeJS.Platform = "darwin") {}

	async run(argv: string[]): Promise<HostCommandResult> {
		this.commands.push(argv);
		const verb = argv[4] === "cancel" ? "cancel" : "wake";
		if (this.refuse.has(verb)) return { exitCode: 1, stdout: "", stderr: REFUSED };
		const at = new Date(argv.at(-1) ?? "").getTime();
		if (verb === "cancel") {
			if (this.events.delete(at)) return { exitCode: 0, stdout: "", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "Error: no matching scheduled event" };
		}
		await this.beforeSchedule?.();
		this.events.add(at);
		await this.afterSchedule?.();
		return { exitCode: 0, stdout: "", stderr: "" };
	}
}

const wakeAt = (at: number) => at - 2 * MINUTE;
const scheduleArgv = (at: number) => ["sudo", "-n", "pmset", "schedule", "wake", wakeStamp(wakeAt(at))];
const cancelArgv = (at: number) => ["sudo", "-n", "pmset", "schedule", "cancel", "wake", wakeStamp(wakeAt(at))];

describe("machine wake follows its timer", () => {
	let dir: TempDir;
	let root: string;
	let host: FakeWakeHost;
	const zone = process.env.TZ;

	beforeEach(() => {
		dir = TempDir.createSync("omp-timer-wake-");
		root = dir.path();
		host = new FakeWakeHost();
	});
	afterEach(async () => {
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
		closeTimerDbs();
		await dir.remove();
	});

	const ctx = (now = T0) => ({ cwd: root, now, root, host });
	const deps = (): Partial<TickDeps> => ({
		root,
		host,
		spawnRunner: () => {},
		runnerAlive: () => false,
		deliveryTarget: () => ({ kind: "free" }),
		notify: async () => {},
	});
	const wakes = () => openTimerDb(root).listMachineWakes();
	const record = (at: number) => ({ timerId: "wake", wakeAt: wakeAt(at) });
	const setWake = (extra: Record<string, unknown> = {}) =>
		setTimer({ id: "wake", reason: "test", at: "in 30m", shell: "true", wakeMachine: true, ...extra }, ctx());
	const AT = T0 + 30 * MINUTE;
	const MOVED = T0 + 90 * MINUTE;

	it("schedules and records the wake on set", async () => {
		const result = await setWake();
		expect(result.warnings).toEqual([]);
		expect(host.commands).toEqual([scheduleArgv(AT)]);
		expect(wakes()).toEqual([record(AT)]);
		expect([...host.events]).toEqual([wakeAt(AT)]);
	});

	it("cancels the wake on rm", async () => {
		await setWake();
		host.commands = [];
		expect(await removeTimer("wake", root, { now: T0, host })).toEqual({ removed: true, warnings: [] });
		expect(host.commands).toEqual([cancelArgv(AT)]);
		expect(wakes()).toEqual([]);
		expect(host.events.size).toBe(0);
	});

	it("moves the wake when edit changes at", async () => {
		await setWake();
		host.commands = [];
		const result = await editTimer("wake", { at: "in 90m" }, ctx());
		expect(result.warnings).toEqual([]);
		expect(host.commands).toEqual([cancelArgv(AT), scheduleArgv(MOVED)]);
		expect(wakes()).toEqual([record(MOVED)]);
		expect([...host.events]).toEqual([wakeAt(MOVED)]);
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
		expect(wakes()).toEqual([record(AT)]);
	});

	it("does not reschedule on resume once the wake time has passed, and says so", async () => {
		await setWake();
		await setPaused("wake", true, { root, now: T0, host });
		host.commands = [];
		const { spec, warnings } = await setPaused("wake", false, { root, now: AT - MINUTE, host });
		expect(spec.paused).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toStartWith("machine wake not scheduled: ");
		expect(host.commands).toEqual([]);
		expect(wakes()).toEqual([]);
	});

	it("returns the refusal when resume cannot restore the wake", async () => {
		await setWake();
		await setPaused("wake", true, { root, now: T0, host });
		host.refuse.add("wake");
		const { spec, warnings } = await setPaused("wake", false, { root, now: T0 + MINUTE, host });
		expect(spec.paused).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toStartWith("machine wake not scheduled: ");
		expect(warnings[0]).toContain(REFUSED);
		expect(wakes()).toEqual([]);
		expect(host.events.size).toBe(0);
	});

	const mutations: [string, (now: number) => Promise<{ warnings: string[] }>, number[]][] = [
		["rm", now => removeTimer("wake", root, { now, host }), []],
		["--no-wake-machine", now => editTimer("wake", { wakeMachine: false }, ctx(now)), []],
		["moving at", now => editTimer("wake", { at: "in 89m" }, ctx(now)), [wakeAt(MOVED)]],
	];
	it.each(mutations)(
		"keeps a wake whose cancel pmset refused on %s, and the next tick cancels it",
		async (_, mutate, left) => {
			await setWake();
			host.refuse.add("cancel");
			const { warnings } = await mutate(T0 + MINUTE);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("not cancelled");
			expect(warnings[0]).toContain(REFUSED);
			expect(wakes()).toContainEqual(record(AT));

			host.refuse.clear();
			await runTick(T0 + 2 * MINUTE, deps());
			expect([...host.events]).toEqual(left);
			expect(wakes().map(wake => wake.wakeAt)).toEqual(left);
		},
	);

	it("an edit during a set's pmset call waits for it instead of racing it", async () => {
		const reached = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<void>();
		host.beforeSchedule = async () => {
			host.beforeSchedule = undefined;
			reached.resolve();
			await reply.promise;
		};
		const set = setWake();
		await reached.promise;
		const edit = editTimer("wake", { at: "in 90m" }, ctx());
		// Give the edit every chance to run its own wake sync while set's schedule is still in flight. A
		// correct edit is parked polling the wake file lock, which emits nothing a test could await.
		await Promise.race([edit, Bun.sleep(300)]);
		reply.resolve();
		const [, edited] = await Promise.all([set, edit]);
		expect(edited.warnings).toEqual([]);
		expect([...host.events]).toEqual([wakeAt(MOVED)]);
		expect(wakes()).toEqual([record(MOVED)]);

		await removeTimer("wake", root, { now: T0, host });
		expect(host.events.size).toBe(0);
		expect(wakes()).toEqual([]);
	});

	it("a schedule cut off after pmset accepted it stays on record, so rm still cancels it", async () => {
		host.afterSchedule = async () => {
			throw new Error("omp died before pmset replied");
		};
		expect(String(await rejectionOf(setWake()))).toContain("omp died");
		host.afterSchedule = undefined;
		expect([...host.events]).toEqual([wakeAt(AT)]);

		await removeTimer("wake", root, { now: T0, host });
		expect(host.events.size).toBe(0);
		expect(wakes()).toEqual([]);
	});

	it("rm cancels the wake's instant after the Mac changed time zone", async () => {
		process.env.TZ = "America/New_York";
		await setWake();
		process.env.TZ = "America/Los_Angeles";
		await removeTimer("wake", root, { now: T0, host });
		expect(host.events.size).toBe(0);
		expect(wakes()).toEqual([]);
	});

	it("a tick cancels the wake's instant after the Mac changed time zone", async () => {
		process.env.TZ = "America/New_York";
		await setWake();
		await fs.rm(specPath("wake", root));
		process.env.TZ = "Asia/Tokyo";
		await runTick(T0 + MINUTE, deps());
		expect(host.events.size).toBe(0);
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
		openTimerDb(root).deleteMachineWake("wake", wakeAt(AT));
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

	it("warns off macOS even when the timer is too close for a wake", async () => {
		host = new FakeWakeHost("linux");
		const result = await setWake({ at: "in 1m" });
		expect(result.warnings).toEqual(["wakeMachine only applies on macOS; ignored"]);
		expect(host.commands).toEqual([]);
	});

	it("records nothing when pmset refuses, and warns", async () => {
		host.refuse.add("wake");
		const result = await setWake();
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toStartWith("machine wake not scheduled: ");
		expect(result.warnings[0]).toContain(REFUSED);
		expect(wakes()).toEqual([]);
	});

	it("says no wake was scheduled when the timer is under 2 minutes away, and the card keeps the sleep warning", async () => {
		const { spec, warnings } = await setWake({ at: "in 1m" });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toStartWith("machine wake not scheduled: ");
		expect(host.commands).toEqual([]);
		const card = renderTimerCard(await loadTimerRow(spec, T0, root), T0, {
			verb: "",
			ticker: {},
			platform: "darwin",
		});
		expect(card).toContain("a sleeping Mac runs this late");
	});

	it("drops the sleep warning from the card only once the wake is scheduled", async () => {
		host.refuse.add("wake");
		const { spec } = await setWake();
		const card = () =>
			loadTimerRow(spec, T0, root).then(row =>
				renderTimerCard(row, T0, { verb: "", ticker: {}, platform: "darwin" }),
			);
		expect(await card()).toContain("a sleeping Mac runs this late");
		host.refuse.clear();
		await editTimer("wake", { title: "retry" }, ctx());
		expect(await card()).not.toContain("a sleeping Mac");
	});

	it.each([
		["every", { at: undefined, every: "1h" }],
		["every with at", { every: "1h" }],
	])("rejects wakeMachine on a recurring timer (%s)", async (_, extra) => {
		expect(String(await rejectionOf(setWake(extra)))).toContain("wakeMachine needs a one-shot");
		expect(host.commands).toEqual([]);
	});

	it.each<[string, TimerEditInput]>([
		["clearing at for every", { at: null, every: "1h" }],
		["adding every", { every: "1h" }],
	])("rejects an edit that makes a wakeMachine timer recurring (%s)", async (_, patch) => {
		await setWake();
		host.commands = [];
		expect(String(await rejectionOf(editTimer("wake", patch, ctx())))).toContain("wakeMachine needs a one-shot");
		expect(host.commands).toEqual([]);
		expect(wakes()).toEqual([record(AT)]);
	});
});
