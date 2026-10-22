import { logger } from "@oh-my-pi/pi-utils";
import type { TimerDb } from "../store";
import type { TimerSpec, TimerState } from "../types";
import type { TimerHost } from "./host";

/** Wake the machine this long before the timer fires so the ticker is running when it is due. */
const WAKE_LEAD_MS = 2 * 60_000;

/** The host seams a machine wake needs. */
export type WakeHost = Pick<TimerHost, "platform" | "run" | "user">;

export interface MachineWake {
	/** Epoch ms of the wake: 2 minutes before the timer's `at`. */
	wakeAt: number;
	/** pmset's local `MM/dd/yyyy HH:mm:ss` for `wakeAt`; schedule and cancel must name the same stamp. */
	stamp: string;
}

/** The wake that precedes a timer firing at `at`, in host local time. */
export function wakeStamp(at: number): MachineWake {
	const wakeAt = at - WAKE_LEAD_MS;
	const wake = new Date(wakeAt);
	const pad = (value: number) => String(value).padStart(2, "0");
	const stamp =
		`${pad(wake.getMonth() + 1)}/${pad(wake.getDate())}/${wake.getFullYear()} ` +
		`${pad(wake.getHours())}:${pad(wake.getMinutes())}:${pad(wake.getSeconds())}`;
	return { wakeAt, stamp };
}

/** argv for `sudo -n pmset schedule wake "<MM/dd/yyyy HH:mm:ss>"` 2 minutes before `at`, in host local time. */
export function machineWakeArgv(at: number): string[] {
	return ["sudo", "-n", "pmset", "schedule", "wake", wakeStamp(at).stamp];
}

/** argv that cancels the pmset wake scheduled at exactly `stamp`. */
export function machineWakeCancelArgv(stamp: string): string[] {
	return ["sudo", "-n", "pmset", "schedule", "cancel", "wake", stamp];
}

/**
 * Schedules a macOS wake ahead of `at`. No-op on other platforms. Never throws on a non-zero exit:
 * the failure comes back in `detail` so the caller can warn.
 */
export async function scheduleMachineWake(host: WakeHost, at: number): Promise<{ scheduled: boolean; detail: string }> {
	if (host.platform !== "darwin") return { scheduled: false, detail: "machine wake is only supported on macOS" };
	const argv = machineWakeArgv(at);
	const result = await host.run(argv);
	if (result.exitCode === 0) return { scheduled: true, detail: `wake scheduled for ${argv[argv.length - 1]}` };
	const reason = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
	return {
		scheduled: false,
		detail: `pmset schedule wake failed (${reason}); sudo -n needs passwordless pmset (sudoers: ${host.user} ALL=(root) NOPASSWD: /usr/bin/pmset)`,
	};
}

/** The wake a timer wants now: an armed, unfinished one-shot `wakeMachine` timer whose wake is still ahead. */
export function desiredMachineWake(
	spec: TimerSpec | undefined,
	state: TimerState | undefined,
	now: number,
): MachineWake | undefined {
	if (!spec?.wakeMachine || !spec.at || spec.paused || state?.done) return undefined;
	const wake = wakeStamp(Date.parse(spec.at));
	return wake.wakeAt > now ? wake : undefined;
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
 * Make the pmset wake recorded for one timer match what the timer wants: cancel a recorded wake that is
 * no longer wanted (removed, paused, retired, `at` moved, `wakeMachine` off), schedule a wanted one that
 * is not recorded. A wake is recorded only once pmset accepted it. Never throws on a command failure;
 * returns warnings for the caller to show.
 */
export async function syncMachineWake(input: MachineWakeSync): Promise<string[]> {
	const { db, host, id, now } = input;
	const desired = desiredMachineWake(input.spec, input.state, now);
	const recorded = db.readMachineWake(id);
	if (recorded && recorded.stamp !== desired?.stamp) {
		if (recorded.wakeAt > now) {
			const result = await host.run(machineWakeCancelArgv(recorded.stamp));
			if (result.exitCode !== 0) {
				logger.warn("timer machine wake cancel failed", {
					id,
					stamp: recorded.stamp,
					error: result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`,
				});
			}
		}
		db.deleteMachineWake(id);
	}
	if (!desired || recorded?.stamp === desired.stamp) return [];
	if (host.platform !== "darwin") return ["wakeMachine only applies on macOS; ignored"];
	const result = await scheduleMachineWake(host, Date.parse(input.spec?.at ?? ""));
	if (!result.scheduled) return [`machine wake not scheduled: ${result.detail}`];
	db.upsertMachineWake({ timerId: id, wakeAt: desired.wakeAt, stamp: desired.stamp });
	return [];
}
