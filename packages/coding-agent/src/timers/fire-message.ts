import { prompt } from "@oh-my-pi/pi-utils";
import timerFireTemplate from "../prompts/session/timer-fire.md" with { type: "text" };
import timerPokeTemplate from "../prompts/session/timer-poke.md" with { type: "text" };
import { formatDuration } from "./schedule";
import type { TimerMail } from "./types";

export const TIMER_FIRE_MESSAGE_TYPE = "timer-fire";
export const SESSION_POKE_MESSAGE_TYPE = "session-poke";

/** How the mail reached the session; rendered into the envelope. */
export type TimerDeliveryVia = "live" | "headless";

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
 */
export function renderTimerMail(mail: TimerMail, via: TimerDeliveryVia, now: number, tz?: string): string {
	if (mail.kind === "poke" && mail.poke) {
		return prompt.render(timerPokeTemplate, {
			from: mail.poke.from,
			sent: formatWallClock(Date.parse(mail.createdAt), tz),
			text: fenceUntrusted(mail.poke.text, "session-poke"),
			now: formatWallClock(now, tz),
		});
	}
	const fire = mail.fire;
	if (!fire) throw new Error(`Mail ${mail.id} has no payload`);
	const firedAt = Date.parse(fire.firedAt);
	const scheduledAt = fire.scheduledAt ? Date.parse(fire.scheduledAt) : undefined;
	return prompt.render(timerFireTemplate, {
		timerId: fire.timerId,
		seq: fire.seq,
		scheduled: scheduledAt !== undefined ? formatWallClock(scheduledAt, tz) : undefined,
		fired: formatWallClock(firedAt, tz),
		late: formatDuration(Math.max(0, now - (scheduledAt ?? firedAt))),
		via,
		now: formatWallClock(now, tz),
		setAt: formatWallClock(Date.parse(fire.setAt), tz),
		reason: fire.reason,
		missedSlots: fire.missedSlots,
		manual: fire.trigger === "manual",
		prompt: fire.prompt,
		data: fire.data ? fenceUntrusted(fire.data.text, "timer-data") : undefined,
		dataSource: fire.data?.source,
		once: fire.once,
		next: fire.next ? formatWallClock(Date.parse(fire.next), tz) : undefined,
	});
}
