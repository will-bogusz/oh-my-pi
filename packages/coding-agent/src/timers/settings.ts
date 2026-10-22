/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgTimerNotify = register({
	id: "timer.notify",
	type: "enum",
	values: ["desktop", "none"] as const,
	default: "desktop",
	ui: {
		tab: "tools",
		group: "Timers",
		label: "Timer Alerts",
		description:
			"Where timer alerts (a failure incident, auto-pause, missed run) go besides timer.alertCommand: a desktop notification, or nowhere",
		options: [
			{
				value: "desktop",
				label: "Desktop",
				description: "macOS notification; Linux notify-send when a graphical session exists",
			},
			{ value: "none", label: "None", description: "Only timer.alertCommand, `omp timer ls` and `doctor`" },
		],
	},
});

export const cfgTimerAlertCommand = register({
	id: "timer.alertCommand",
	type: "string",
	default: undefined,
	ui: {
		tab: "tools",
		group: "Timers",
		label: "Timer Alert Command",
		description:
			"Shell command run once per timer alert, with OMP_TIMER_ID/RUN/EVENT/OUTCOME/ERROR/LOG/SUMMARY in env and the alert JSON on stdin",
	},
});
