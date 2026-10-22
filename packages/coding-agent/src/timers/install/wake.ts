import type { TimerDb } from "../store";
import type { TimerSpec, TimerState } from "../types";
import type { TimerHost } from "./host";

/** Wake the machine this long before the timer fires so the ticker is running when it is due. */
const WAKE_LEAD_MS = 2 * 60_000;

/** The host seams a machine wake needs. */
export type WakeHost = Pick<TimerHost, "platform" | "run" | "user">;

/** Epoch ms of the wake that precedes a timer firing at `at`: 2 minutes earlier, whole seconds (pmset's precision). */
export function machineWakeAt(at: number): number {
	return Math.floor((at - WAKE_LEAD_MS) / 1000) * 1000;
}

/**
 * pmset's `MM/dd/yyyy HH:mm:ss` for `wakeAt` in the host's current local time. pmset parses it in the
 * zone it runs in, so a wake is always formatted when the command runs, never replayed from an old stamp.
 */
export function wakeStamp(wakeAt: number): string {
	const wake = new Date(wakeAt);
	const pad = (value: number) => String(value).padStart(2, "0");
	return (
		`${pad(wake.getMonth() + 1)}/${pad(wake.getDate())}/${wake.getFullYear()} ` +
		`${pad(wake.getHours())}:${pad(wake.getMinutes())}:${pad(wake.getSeconds())}`
	);
}

/** argv for `sudo -n pmset schedule wake "<MM/dd/yyyy HH:mm:ss>"` at `wakeAt`. */
export function machineWakeArgv(wakeAt: number): string[] {
	return ["sudo", "-n", "pmset", "schedule", "wake", wakeStamp(wakeAt)];
}

/** argv that cancels the pmset wake scheduled at `wakeAt`. */
export function machineWakeCancelArgv(wakeAt: number): string[] {
	return ["sudo", "-n", "pmset", "schedule", "cancel", "wake", wakeStamp(wakeAt)];
}

async function runPmset(host: WakeHost, argv: string[]): Promise<string | undefined> {
	const result = await host.run(argv);
	if (result.exitCode === 0) return undefined;
	const reason = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
	return `${reason}; sudo -n needs passwordless pmset (sudoers: ${host.user} ALL=(root) NOPASSWD: /usr/bin/pmset)`;
}

/**
 * Schedules a macOS wake at `wakeAt`. No-op on other platforms. Never throws on a non-zero exit:
 * the failure comes back in `detail` so the caller can warn.
 */
export async function scheduleMachineWake(
	host: WakeHost,
	wakeAt: number,
): Promise<{ scheduled: boolean; detail: string }> {
	if (host.platform !== "darwin") return { scheduled: false, detail: "machine wake is only supported on macOS" };
	const failure = await runPmset(host, machineWakeArgv(wakeAt));
	if (failure === undefined) return { scheduled: true, detail: `wake scheduled for ${wakeStamp(wakeAt)}` };
	return { scheduled: false, detail: `pmset schedule wake failed (${failure})` };
}

/** The wake a timer wants: an armed, unfinished `wakeMachine` one-shot gets one 2 minutes before `at`. */
export function desiredMachineWake(spec: TimerSpec | undefined, state: TimerState | undefined): number | undefined {
	if (!spec?.wakeMachine || !spec.at || spec.every || spec.paused || state?.done) return undefined;
	return machineWakeAt(Date.parse(spec.at));
}

export interface MachineWakeSync {
	db: TimerDb;
	host: WakeHost;
	id: string;
	/** `undefined`: the timer was removed. */
	spec: TimerSpec | undefined;
	/** The timer's current-generation state; `done` retires the wake. */
	state: TimerState | undefined;
	now: number;
}

/**
 * Make the pmset wakes recorded for one timer match what the timer wants: cancel every recorded wake
 * that is no longer wanted (removed, paused, retired, `at` moved, `wakeMachine` off), schedule a wanted
 * one that is not recorded. A wake is recorded before pmset is asked to schedule it and dropped only once
 * a cancel succeeded, the schedule failed or its time passed, so a refused cancel or an interrupted
 * schedule stays on record for the next sync to retry. Callers hold the timer's wake lock. Never throws
 * on a command failure; returns warnings for the caller to show.
 */
export async function syncMachineWake(input: MachineWakeSync): Promise<string[]> {
	const { db, host, id, now } = input;
	const desired = desiredMachineWake(input.spec, input.state);
	if (host.platform !== "darwin") return input.spec?.wakeMachine ? ["wakeMachine only applies on macOS; ignored"] : [];
	const warnings: string[] = [];
	let recorded = false;
	for (const { wakeAt } of db.listMachineWakes(id)) {
		if (wakeAt <= now) {
			db.deleteMachineWake(id, wakeAt);
			if (wakeAt === desired) recorded = true;
			continue;
		}
		if (wakeAt === desired) {
			recorded = true;
			continue;
		}
		const failure = await runPmset(host, machineWakeCancelArgv(wakeAt));
		if (failure === undefined) db.deleteMachineWake(id, wakeAt);
		else warnings.push(`machine wake at ${wakeStamp(wakeAt)} not cancelled (${failure}); the next tick retries`);
	}
	if (desired === undefined || recorded) return warnings;
	if (desired <= now) {
		warnings.push(`machine wake not scheduled: its time, 2 minutes before ${input.spec?.at}, has passed`);
		return warnings;
	}
	db.addMachineWake(id, desired);
	const result = await scheduleMachineWake(host, desired);
	if (!result.scheduled) {
		db.deleteMachineWake(id, desired);
		warnings.push(`machine wake not scheduled: ${result.detail}`);
	}
	return warnings;
}
