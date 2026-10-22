/**
 * `when` grammar and slot math.
 *
 * - `at`: `now`, `in 2m` / `in 1h30m`, `HH:MM` (next occurrence in tz),
 *   `YYYY-MM-DD HH:MM` (that wall time in tz), or an ISO instant with offset.
 * - `every`: `5m` / `2h` / `1d`, `daily HH:MM`, `cron <5 fields>` (or 5 bare fields).
 *
 * Every evaluation re-derives due slots from wall-clock `now`, never from
 * elapsed time, so sleep, clock jumps and DST cannot double-fire or skip. Cron
 * math (and every clock-aligned interval) goes through `croner`, which is
 * tz-aware.
 */
import { Cron } from "croner";
import type { TimerSpec, TimerState } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UNIT_MS: Record<string, number> = { s: 1000, m: MINUTE, h: HOUR, d: DAY };

/** A one-shot fires late up to this, then is recorded `missed`. */
export const ONE_SHOT_LATE_LIMIT_MS = 12 * HOUR;
/** Bound on slot iteration when counting coalesced missed slots. */
const MAX_SLOT_SCAN = 5000;

/** `90s`, `5m`, `1h30m`, `2d` → ms. */
export function parseDuration(text: string): number {
	const trimmed = text.trim().toLowerCase();
	const re = /(\d+)\s*([smhd])/g;
	let total = 0;
	let consumed = 0;
	for (const match of trimmed.matchAll(re)) {
		total += Number(match[1]) * UNIT_MS[match[2]];
		consumed += match[0].length;
	}
	if (total <= 0 || consumed !== trimmed.replace(/\s+/g, "").length) {
		throw new Error(`Invalid duration "${text}": use forms like 90s, 5m, 1h30m, 2d`);
	}
	return total;
}

export function formatDuration(ms: number): string {
	const abs = Math.abs(ms);
	if (abs < MINUTE) return `${Math.round(abs / 1000)}s`;
	const days = Math.floor(abs / DAY);
	const hours = Math.floor((abs % DAY) / HOUR);
	const minutes = Math.floor((abs % HOUR) / MINUTE);
	const parts: string[] = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (minutes && !days) parts.push(`${minutes}m`);
	return parts.join("") || "0m";
}

export function hostTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function assertTimeZone(tz: string): void {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
	} catch {
		throw new Error(`Unknown time zone "${tz}"`);
	}
}

function parseClock(text: string): { hour: number; minute: number } | undefined {
	const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
	if (!match) return undefined;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 23 || minute > 59) throw new Error(`Invalid clock time "${text}"`);
	return { hour, minute };
}

/** Resolve a one-shot `at` expression to an epoch-ms instant. */
export function resolveAt(text: string, now: number, tz: string): number {
	assertTimeZone(tz);
	const trimmed = text.trim();
	const lower = trimmed.toLowerCase();
	if (lower === "now") return now;
	if (lower.startsWith("in ")) return now + parseDuration(trimmed.slice(3));
	const clock = parseClock(trimmed);
	if (clock) {
		const next = new Cron(`${clock.minute} ${clock.hour} * * *`, { timezone: tz }).nextRun(new Date(now));
		if (!next) throw new Error(`Cannot resolve "${text}"`);
		return next.getTime();
	}
	const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(trimmed);
	if (local) {
		const [, year, month, day, hour, minute] = local;
		const pattern = `0 ${Number(minute)} ${Number(hour)} ${Number(day)} ${Number(month)} * ${year}`;
		const next = new Cron(pattern, { timezone: tz }).nextRun(new Date(now - DAY * 366));
		if (!next) throw new Error(`Cannot resolve "${text}" in ${tz}`);
		return next.getTime();
	}
	const parsed = Date.parse(trimmed);
	if (Number.isNaN(parsed)) {
		throw new Error(`Invalid at "${text}": use now, in 2m, HH:MM, YYYY-MM-DD HH:MM, or an ISO time`);
	}
	return parsed;
}

/** Parsed `every` cadence. Clock-aligned cadences compile to cron so slots land on :00/:05/…. */
export type Cadence = { kind: "cron"; pattern: string } | { kind: "interval"; ms: number };

/** Normalize the user's `every` text to the stored form (`5m`, `daily 09:00`, `cron …`). */
export function normalizeEvery(text: string): string {
	const trimmed = text.trim().replace(/^every\s+/i, "");
	const cadence = parseEvery(trimmed);
	const isCron = cadence.kind === "cron" && trimmed.replace(/^cron\s+/i, "").split(/\s+/).length === 5;
	return isCron ? `cron ${cadence.pattern}` : trimmed.toLowerCase().replace(/\s+/g, " ");
}

export function parseEvery(text: string): Cadence {
	const trimmed = text.trim().replace(/^every\s+/i, "");
	const daily = /^daily\s+(.+)$/i.exec(trimmed);
	if (daily) {
		const clock = parseClock(daily[1]);
		if (!clock) throw new Error(`Invalid daily time "${daily[1]}": use HH:MM`);
		return { kind: "cron", pattern: `${clock.minute} ${clock.hour} * * *` };
	}
	const cronText = trimmed.replace(/^cron\s+/i, "");
	if (cronText.split(/\s+/).length === 5) {
		new Cron(cronText); // validates
		return { kind: "cron", pattern: cronText };
	}
	const ms = parseDuration(trimmed);
	if (ms < MINUTE) throw new Error(`every ${text}: the minimum interval is 1m (the ticker runs once a minute)`);
	const minutes = ms / MINUTE;
	if (Number.isInteger(minutes) && minutes < 60 && 60 % minutes === 0) {
		return { kind: "cron", pattern: minutes === 1 ? "* * * * *" : `*/${minutes} * * * *` };
	}
	const hours = ms / HOUR;
	if (Number.isInteger(hours) && hours < 24 && 24 % hours === 0) {
		return { kind: "cron", pattern: `0 ${hours === 1 ? "*" : `*/${hours}`} * * *` };
	}
	if (ms === DAY) return { kind: "cron", pattern: "0 0 * * *" };
	return { kind: "interval", ms };
}

/** Slots of a recurring cadence. Intervals that don't align to the clock are anchored at creation. */
interface SlotSource {
	/** First slot strictly after `t`. */
	after(t: number): number | undefined;
	/** Newest slot at or before `t`. */
	atOrBefore(t: number): number | undefined;
}

function slotSource(cadence: Cadence, tz: string, anchor: number): SlotSource {
	if (cadence.kind === "interval") {
		const { ms } = cadence;
		return {
			after: t => (t < anchor ? anchor : anchor + (Math.floor((t - anchor) / ms) + 1) * ms),
			atOrBefore: t => (t < anchor ? undefined : anchor + Math.floor((t - anchor) / ms) * ms),
		};
	}
	const cron = new Cron(cadence.pattern, { timezone: tz });
	return {
		after: t => cron.nextRun(new Date(t))?.getTime(),
		// croner's previousRuns is exclusive of the reference second.
		atOrBefore: t => cron.previousRuns(1, new Date(t + 1000))[0]?.getTime(),
	};
}

export type DueDecision =
	/** Nothing to do this tick. */
	| { kind: "idle" }
	/** Fire (or, with a gate, check the gate) for `slot`; `missedSlots` older slots were coalesced into it. */
	| { kind: "due"; slot: number; missedSlots: number }
	/** The newest slot is older than the late limit: record `missed`, consume it, don't run. */
	| { kind: "missed"; slot: number; missedSlots: number }
	/** The timer is finished (expired, or a one-shot whose slot is consumed). */
	| { kind: "retire"; why: "expired" | "once" | "max-runs" };

function graceFor(source: SlotSource, slot: number): number {
	const next = source.after(slot);
	const period = next !== undefined ? next - slot : HOUR;
	return Math.min(6 * HOUR, Math.max(2 * MINUTE, period / 2));
}

/**
 * Decide what this tick owes a timer at `now`. Pure: callers persist
 * `state.lastSlot = slot` before dispatching so a crash after dispatch never
 * re-fires the same instant.
 */
export function decideDue(spec: TimerSpec, state: TimerState, now: number): DueDecision {
	if (spec.expiresAt && Date.parse(spec.expiresAt) <= now) return { kind: "retire", why: "expired" };
	if (spec.maxRuns !== undefined && state.runCount >= spec.maxRuns) return { kind: "retire", why: "max-runs" };
	const created = Date.parse(spec.created.at);
	const startAt = spec.at ? Date.parse(spec.at) : undefined;

	if (spec.every) {
		const source = slotSource(parseEvery(spec.every), spec.tz, startAt ?? created);
		const latest = source.atOrBefore(now);
		const floor = Math.max(state.lastSlot ?? -Infinity, startAt !== undefined ? startAt - 1 : created);
		if (latest === undefined || latest <= floor) return { kind: "idle" };
		let missedSlots = 0;
		let cursor = source.after(floor);
		while (cursor !== undefined && cursor < latest && missedSlots < MAX_SLOT_SCAN) {
			missedSlots++;
			cursor = source.after(cursor);
		}
		if (now - latest > graceFor(source, latest)) return { kind: "missed", slot: latest, missedSlots };
		return { kind: "due", slot: latest, missedSlots };
	}

	if (startAt !== undefined) {
		if (now < startAt) return { kind: "idle" };
		// A gated one-shot keeps checking once per tick-minute after `at`; each minute is its own slot.
		if (spec.until) {
			const slot = Math.floor(now / MINUTE) * MINUTE;
			if (state.lastSlot !== undefined && slot <= state.lastSlot) return { kind: "idle" };
			return { kind: "due", slot, missedSlots: 0 };
		}
		if (state.lastSlot !== undefined && state.lastSlot >= startAt) return { kind: "retire", why: "once" };
		if (now - startAt > ONE_SHOT_LATE_LIMIT_MS) return { kind: "missed", slot: startAt, missedSlots: 0 };
		return { kind: "due", slot: startAt, missedSlots: 0 };
	}

	if (spec.until) {
		// Gate-only: checked once per tick-minute.
		const slot = Math.floor(now / MINUTE) * MINUTE;
		if (state.lastSlot !== undefined && slot <= state.lastSlot) return { kind: "idle" };
		return { kind: "due", slot, missedSlots: 0 };
	}
	// External-only timers (no at/every/until) fire only through `fire`.
	return { kind: "idle" };
}

/** Next instant a timer will act, for listings. `undefined` = never on its own (done, paused, external). */
export function nextFireAt(spec: TimerSpec, state: TimerState, now: number): number | "gate" | undefined {
	if (state.done || spec.paused) return undefined;
	if (spec.expiresAt && Date.parse(spec.expiresAt) <= now) return undefined;
	const startAt = spec.at ? Date.parse(spec.at) : undefined;
	if (spec.every) {
		const source = slotSource(parseEvery(spec.every), spec.tz, startAt ?? Date.parse(spec.created.at));
		const floor = Math.max(now, state.lastSlot ?? -Infinity, startAt !== undefined ? startAt - 1 : -Infinity);
		return source.after(floor);
	}
	if (startAt !== undefined && now < startAt) return startAt;
	if (spec.until) return "gate";
	if (startAt !== undefined && (state.lastSlot === undefined || state.lastSlot < startAt)) return startAt;
	return undefined;
}
