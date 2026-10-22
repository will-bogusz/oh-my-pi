import { prompt } from "@oh-my-pi/pi-utils";
import timerFireTemplate from "../prompts/session/timer-fire.md" with { type: "text" };
import timerPokeTemplate from "../prompts/session/timer-poke.md" with { type: "text" };
import timerReportTemplate from "../prompts/session/timer-report.md" with { type: "text" };
import { formatCost } from "./run-result";
import { formatDuration, MINUTE } from "./schedule";
import type { AgentRunTarget, TimerMail } from "./types";

/** Lateness the envelope calls out, so the model re-checks a stale instruction before acting on it. */
const NOTABLY_LATE_MS = 10 * MINUTE;

export const TIMER_FIRE_MESSAGE_TYPE = "timer-fire";
export const SESSION_POKE_MESSAGE_TYPE = "session-poke";
export const TIMER_REPORT_MESSAGE_TYPE = "timer-report";

/** The run's final message is exactly this line (or ends with it): nothing worth reporting. */
export const QUIET_MARKER = "[quiet]";

/** How the mail reached the session; rendered into the envelope. `run`: the runner's own agent session. */
export type TimerDeliveryVia = "live" | "headless" | "run";

/** What the envelope of an unattended agent run (fresh/own session) tells the agent about its run. */
export interface AgentRunEnvelope {
	session: AgentRunTarget;
	/** The run's cwd, which `expect` paths are relative to. */
	cwd: string;
	expect?: string[];
}

/** Details persisted on the transcript entry; `mailId` makes re-delivery after a crash detectable. */
export interface TimerMessageDetails {
	mailId: string;
	kind: TimerMail["kind"];
	timerId?: string;
	runId?: string;
	via: TimerDeliveryVia;
}

/** `Wed 2026-10-22 08:00 EDT` in `tz`. */
export function formatWallClock(ms: number, tz?: string): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		weekday: "short",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "short",
	}).formatToParts(new Date(ms));
	const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? "";
	return `${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

/** Untrusted text must not close the wrapper it is placed in. */
function fenceUntrusted(text: string, tag: string): string {
	return text.replaceAll(`</${tag}`, `<\\/${tag}`);
}

/**
 * Render the model-visible message for one mail. The "now" line is computed
 * here, at injection time, so a held or queued fire never carries a stale clock.
 * `run` renders the envelope of an unattended agent run instead of a session wake.
 */
export function renderTimerMail(
	mail: TimerMail,
	via: TimerDeliveryVia,
	now: number,
	tz?: string,
	run?: AgentRunEnvelope,
): string {
	if (mail.kind === "poke" && mail.poke) {
		return prompt.render(timerPokeTemplate, {
			from: mail.poke.from,
			sent: formatWallClock(Date.parse(mail.createdAt), tz),
			text: fenceUntrusted(mail.poke.text, "session-poke"),
			now: formatWallClock(now, tz),
		});
	}
	if (mail.kind === "timer-report" && mail.report) {
		const report = mail.report;
		return prompt.render(timerReportTemplate, {
			timerId: report.timerId,
			seq: report.seq,
			title: report.title,
			reason: report.reason,
			session: report.session,
			own: report.session === "own",
			outcome: report.ok ? (report.quiet ? "ok (quiet)" : "ok") : `failed: ${report.failure ?? "error"}`,
			detail: report.detail,
			cost: formatCost(report.cost),
			duration: formatDuration(report.durationMs),
			ended: formatWallClock(Date.parse(report.endedAt), tz),
			now: formatWallClock(now, tz),
			resultPath: report.resultPath,
			transcript: report.transcript,
			finalText: report.finalText ? fenceUntrusted(report.finalText, "timer-run-output") : undefined,
		});
	}
	const fire = mail.fire;
	if (!fire) throw new Error(`Mail ${mail.id} has no payload`);
	const firedAt = Date.parse(fire.firedAt);
	const scheduledAt = fire.scheduledAt ? Date.parse(fire.scheduledAt) : undefined;
	const lateMs = Math.max(0, now - (scheduledAt ?? firedAt));
	return prompt.render(timerFireTemplate, {
		timerId: fire.timerId,
		seq: fire.seq,
		scheduled: scheduledAt !== undefined ? formatWallClock(scheduledAt, tz) : undefined,
		fired: formatWallClock(firedAt, tz),
		late: formatDuration(lateMs),
		notablyLate: lateMs >= NOTABLY_LATE_MS,
		via,
		headless: via === "headless",
		run: run !== undefined,
		own: run?.session === "own",
		cwd: run?.cwd,
		expect: run?.expect?.length ? run.expect.join(", ") : undefined,
		now: formatWallClock(now, tz),
		setAt: formatWallClock(Date.parse(fire.setAt), tz),
		reason: fire.reason,
		missedSlots: fire.missedSlots,
		manual: fire.trigger === "manual",
		prompt: fire.prompt,
		data: fire.data ? fenceUntrusted(fire.data.text, "timer-data") : undefined,
		dataSource: fire.data?.source,
		dataFromGate: fire.data?.source === "gate",
		once: fire.once,
		next: fire.next ? formatWallClock(Date.parse(fire.next), tz) : undefined,
		nextIsGate: fire.nextIsGate,
		expires: fire.expiresAt && !fire.once ? formatWallClock(Date.parse(fire.expiresAt), tz) : undefined,
	});
}
