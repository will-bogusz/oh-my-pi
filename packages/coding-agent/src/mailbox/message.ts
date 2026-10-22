import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { escapeXmlAttribute, prompt } from "@oh-my-pi/pi-utils";
import sessionPokeTemplate from "../prompts/session/session-poke.md" with { type: "text" };
import timerFireTemplate from "../prompts/session/timer-fire.md" with { type: "text" };
import { formatDuration, MINUTE } from "../timers/schedule";
import type { SessionMail } from "./types";

/** Lateness the envelope calls out, so the model re-checks a stale instruction before acting on it. */
const NOTABLY_LATE_MS = 10 * MINUTE;

export const SESSION_POKE_MESSAGE_TYPE = "session-poke";
export const TIMER_FIRE_MESSAGE_TYPE = "timer-fire";

/** How the mail reached the session: a process that had it open, or one resumed headless to deliver it. */
export type MailDeliveryVia = "live" | "headless";

/** Details persisted on the transcript entry; `mailId` is how a delivery is confirmed in the session file. */
export interface MailMessageDetails {
	mailId: string;
	kind: SessionMail["kind"];
	timerId?: string;
	runId?: string;
	via: MailDeliveryVia;
}

/** The details a delivered poke or timer fire carries in the transcript; `undefined` for any other message. */
export function mailMessageDetails(message: AgentMessage): MailMessageDetails | undefined {
	if (message.role !== "custom") return undefined;
	if (message.customType !== SESSION_POKE_MESSAGE_TYPE && message.customType !== TIMER_FIRE_MESSAGE_TYPE) {
		return undefined;
	}
	return message.details as MailMessageDetails | undefined;
}

/** `Wed 2026-10-22 08:00 EDT` in `tz` (default: local time). */
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
 * here, at injection time, so held mail never carries a stale clock. A timer
 * fire renders its times in the timer's zone.
 */
export function renderMail(mail: SessionMail, via: MailDeliveryVia, now: number): string {
	if (mail.kind === "poke") {
		return prompt.render(sessionPokeTemplate, {
			from: escapeXmlAttribute(mail.poke.from),
			sent: formatWallClock(Date.parse(mail.createdAt)),
			text: fenceUntrusted(mail.poke.text, "session-poke"),
			now: formatWallClock(now),
		});
	}
	const { fire } = mail;
	const { tz } = fire;
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
