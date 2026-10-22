/**
 * Alert sinks. The tick decides *whether* to alert (incidents, auto-pause,
 * missed runs; see `policy.ts`); this module only delivers each alert to the
 * configured sinks: a desktop notification (`timer.notify`) and the optional
 * `timer.alertCommand`, which gets `OMP_TIMER_*` env and the alert JSON on
 * stdin. A sink failure is logged, never thrown: alerts are best-effort and
 * must not fail the tick that raised them.
 */
import * as os from "node:os";
import { $env, logger } from "@oh-my-pi/pi-utils";
import {
	buildDesktopNotifyCommand,
	hasLinuxDesktopSession,
	resolveDesktopNotifier,
} from "@oh-my-pi/pi-tui/desktop-notify";
import { Settings } from "../config/settings";
import { cfgTimerAlertCommand, cfgTimerNotify } from "./settings";
import type { TimerAlert } from "./types";

/** Bound on one alert command, so a hung sink cannot hold the tick process open. */
const ALERT_COMMAND_TIMEOUT_MS = 30_000;

export interface TimerNotifyConfig {
	desktop: boolean;
	alertCommand?: string;
}

export function timerNotifyConfig(settings: Settings): TimerNotifyConfig {
	return {
		desktop: cfgTimerNotify.get(settings) === "desktop",
		alertCommand: cfgTimerAlertCommand.get(settings)?.trim() || undefined,
	};
}

/** Sinks from the user's global settings (the tick runs from an OS unit, outside any project). */
export async function loadTimerNotifyConfig(): Promise<TimerNotifyConfig> {
	return timerNotifyConfig(await Settings.loadReadOnly({ cwd: os.homedir() }));
}

/** Delivers one argv; the seam tests use to observe sink invocations without spawning. */
export type AlertSpawner = (argv: string[], env: Record<string, string>, stdin: string) => Promise<number>;

async function spawnAlert(argv: string[], env: Record<string, string>, stdin: string): Promise<number> {
	const child = Bun.spawn(argv, {
		env: { ...($env as Record<string, string>), ...env },
		stdin: new Blob([stdin]),
		stdout: "ignore",
		stderr: "pipe",
		timeout: ALERT_COMMAND_TIMEOUT_MS,
	});
	const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0)
		logger.warn("timer alert sink failed", { argv: argv[0], exitCode, stderr: stderr.slice(0, 500) });
	return exitCode;
}

/** `OMP_TIMER_*` env for the alert command. */
export function alertEnv(alert: TimerAlert): Record<string, string> {
	const env: Record<string, string> = {
		OMP_TIMER_ID: alert.timerId,
		OMP_TIMER_EVENT: alert.event,
		OMP_TIMER_OUTCOME: alert.event,
		OMP_TIMER_SUMMARY: alert.summary,
		OMP_TIMER_COUNT: String(alert.count),
	};
	if (alert.runId) env.OMP_TIMER_RUN = alert.runId;
	if (alert.error) env.OMP_TIMER_ERROR = alert.error;
	if (alert.signature) env.OMP_TIMER_SIGNATURE = alert.signature;
	if (alert.logPath) env.OMP_TIMER_LOG = alert.logPath;
	return env;
}

/** argv for a desktop notification on this host, or undefined when none can be shown. */
export function desktopAlertArgv(
	alert: TimerAlert,
	platform: NodeJS.Platform = process.platform,
	env: Record<string, string | undefined> = $env,
): string[] | undefined {
	const title = `omp timer ${alert.timerId}`;
	if (platform === "darwin") {
		// Text travels as argv, never spliced into the AppleScript source.
		return [
			"osascript",
			"-e",
			"on run argv",
			"-e",
			"display notification (item 2 of argv) with title (item 1 of argv)",
			"-e",
			"end run",
			title,
			alert.summary,
		];
	}
	if (!(env.DISPLAY || env.WAYLAND_DISPLAY) || !hasLinuxDesktopSession(platform, env)) return undefined;
	const notifier = resolveDesktopNotifier();
	return notifier ? buildDesktopNotifyCommand(notifier, { title, body: alert.summary }) : undefined;
}

export async function sendTimerAlerts(
	alerts: readonly TimerAlert[],
	config: TimerNotifyConfig,
	spawn: AlertSpawner = spawnAlert,
): Promise<void> {
	for (const alert of alerts) {
		logger.info("timer alert", { id: alert.timerId, event: alert.event, summary: alert.summary });
		const desktop = config.desktop ? desktopAlertArgv(alert) : undefined;
		try {
			if (desktop) await spawn(desktop, {}, "");
			if (config.alertCommand) {
				await spawn(["/bin/sh", "-c", config.alertCommand], alertEnv(alert), `${JSON.stringify(alert)}\n`);
			}
		} catch (err) {
			logger.warn("timer alert sink failed to start", { id: alert.timerId, error: String(err) });
		}
	}
}
