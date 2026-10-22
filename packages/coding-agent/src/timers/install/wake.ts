import type { TimerHost } from "./host";

/** Wake the machine this long before the timer fires so the ticker is running when it is due. */
const WAKE_LEAD_MS = 2 * 60_000;

/** argv for `sudo -n pmset schedule wake "<MM/dd/yyyy HH:mm:ss>"` 2 minutes before `at`, in host local time. */
export function machineWakeArgv(at: number): string[] {
	const wake = new Date(at - WAKE_LEAD_MS);
	const pad = (value: number) => String(value).padStart(2, "0");
	const stamp =
		`${pad(wake.getMonth() + 1)}/${pad(wake.getDate())}/${wake.getFullYear()} ` +
		`${pad(wake.getHours())}:${pad(wake.getMinutes())}:${pad(wake.getSeconds())}`;
	return ["sudo", "-n", "pmset", "schedule", "wake", stamp];
}

/**
 * Schedules a macOS wake ahead of `at`. No-op on other platforms. Never throws on a non-zero exit:
 * the failure comes back in `detail` so the caller can warn.
 */
export async function scheduleMachineWake(
	host: TimerHost,
	at: number,
): Promise<{ scheduled: boolean; detail: string }> {
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
