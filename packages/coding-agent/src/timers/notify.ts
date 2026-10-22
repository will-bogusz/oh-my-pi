/**
 * Cross-worker stub (Delivery branch): the real user-notification sinks
 * (`timer.notify`, `timer.alertCommand`) live on the Engine branch under the
 * same names. Main takes Engine's file at merge; this one only logs.
 */
import { logger } from "@oh-my-pi/pi-utils";

export interface TimerAlert {
	timerId: string;
	runId?: string;
	event: "failed" | "paused" | "missed" | "expired" | "held" | "reminder";
	summary: string;
	error?: string;
	signature?: string;
	count: number;
	logPath?: string;
}

export type TimerNotifyConfig = Record<string, never>;

export async function loadTimerNotifyConfig(): Promise<TimerNotifyConfig> {
	return {};
}

export async function sendTimerAlerts(alerts: readonly TimerAlert[], _config: TimerNotifyConfig): Promise<void> {
	for (const alert of alerts) logger.info("timer alert", { ...alert });
}
