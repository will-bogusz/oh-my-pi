/**
 * `when` grammar and slot math.
 *
 * - `at`: `now`, `in 2m` / `in 1h30m`, `HH:MM` (next occurrence in tz),
 *   `tomorrow 09:30`, `mon 09:00` (next such weekday), `YYYY-MM-DD HH:MM`
 *   (that wall time in tz), or an ISO instant with offset.
 * - `every`: a duration (`5m`, `2h`, `1d`), `daily 09:00`, `weekdays 09:00`,
 *   `weekends 10:00`, `mon,thu 18:30`, `hourly`, or `cron <5 fields>` (bare 5
 *   fields too).
 * - Tern/Carly `when` strings (`in 20m`, `at 15:00`, `every 30m`,
 *   `daily 09:00`, …) map onto those through {@link parseWhen}.
 *
 * Slot rules (each one has an engine test):
 * - A duration counts elapsed time from arming: the first slot is one full
 *   interval after `armedAt` (or exactly `at` when both are given), never
 *   snapped to the clock. `every 24h` therefore drifts across DST; use
 *   `daily HH:MM` for wall-clock time.
 * - Calendar cadences go through croner in the spec's tz. A wall time that
 *   does not exist (spring forward) runs at the same offset after the gap
 *   (02:30 → 03:30); a repeated wall time (fall back) runs once, at its first
 *   occurrence. Day-of-month and day-of-week both restricted means either
 *   matches (cron OR semantics).
 * - Every evaluation re-derives due slots from `now`, never from elapsed
 *   ticks: missed slots coalesce into one run of the newest slot. By default
 *   a recurring timer's newest slot runs however late it is (it is never
 *   older than one period, or the next slot would be the newest: systemd
 *   `Persistent=` semantics). A slot later than its grace (spec `grace`, or
 *   {@link CATCHUP_SKIP_GRACE_MS} with `catchup: skip`, or 12 h for a
 *   one-shot) is recorded `missed` instead of run.
 */
import { Cron } from "croner";
import type { TimerSpec, TimerState } from "./types";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const UNIT_MS: Record<string, number> = { s: 1000, m: MINUTE, h: HOUR, d: DAY };

/** A one-shot fires late up to this by default, then is recorded `missed`. */
export const ONE_SHOT_GRACE_MS = 12 * HOUR;
/** `catchup: skip`: lateness still counted on time (a tick delayed by the scheduler or a wake), beyond it the slot is missed. */
export const CATCHUP_SKIP_GRACE_MS = 5 * MINUTE;
/** Minimum spacing between runs: a model turn every minute is never what anyone meant. */
export const MIN_PROMPT_INTERVAL_MS = 5 * MINUTE;
export const MIN_SHELL_INTERVAL_MS = MINUTE;
/** Bound on slot iteration when counting coalesced missed slots of a calendar cadence. */
const MAX_SLOT_SCAN = 5000;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** `90s`, `5m`, `1h30m`, `2d` → ms. */
export function parseDuration(text: string): number {
	const trimmed = text.trim().toLowerCase();
	const re = /(\d+)\s*([smhd])/g;
	let total = 0;
	let consumed = 0;
	for (const match of trimmed.matchAll(re)) {
		total += Number(match[1]) * UNIT_MS[match[2]];
		consumed += match[0].replace(/\s+/g, "").length;
	}
	if (total <= 0 || consumed !== trimmed.replace(/\s+/g, "").length) {
		throw new Error(`Invalid duration "${text}": use forms like 90s, 5m, 1h30m, 2d`);
	}
	return total;
}

/** Lossless inverse of {@link parseDuration} for whole seconds (`90s` → `1m30s`); {@link formatDuration} is for display. */
export function serializeDuration(ms: number): string {
	let rest = Math.round(ms / 1000);
	const parts: string[] = [];
	for (const [unit, size] of [
		["d", 86_400],
		["h", 3600],
		["m", 60],
		["s", 1],
	] as const) {
		const count = Math.floor(rest / size);
		if (count) parts.push(`${count}${unit}`);
		rest -= count * size;
	}
	return parts.join("") || "0s";
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

export function assertTimeZone(tz: string): void {
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

/** `mon`, `Mon`, `monday`, `mon,thu` → cron day-of-week list (`1,4`); undefined when not a day list. */
function parseDayList(text: string): string | undefined {
	const days = text.toLowerCase().split(",");
	const numbers: number[] = [];
	for (const day of days) {
		const index = WEEKDAYS.findIndex(name => day.trim().startsWith(name) && day.trim().length >= 3);
		if (index < 0) return undefined;
		numbers.push(index);
	}
	return [...new Set(numbers)].sort((a, b) => a - b).join(",");
}

function nextCron(pattern: string, tz: string, after: number): number {
	const next = new Cron(pattern, { timezone: tz }).nextRun(new Date(after));
	if (!next) throw new Error(`No upcoming time matches "${pattern}"`);
	return next.getTime();
}

/** Resolve a one-shot `at` expression to an epoch-ms instant. */
export function resolveAt(text: string, now: number, tz: string): number {
	assertTimeZone(tz);
	const trimmed = text
		.trim()
		.replace(/^at\s+/i, "")
		.trim();
	const lower = trimmed.toLowerCase();
	if (lower === "now") return now;
	if (lower.startsWith("in ")) return now + parseDuration(trimmed.slice(3));
	const clock = parseClock(trimmed);
	if (clock) return nextCron(`${clock.minute} ${clock.hour} * * *`, tz, now);
	const dayClock = /^(\S+)\s+(\d{1,2}:\d{2})$/.exec(trimmed);
	if (dayClock) {
		const time = parseClock(dayClock[2]);
		const day = dayClock[1].toLowerCase();
		if (time && day === "tomorrow") {
			// The first such wall time after the next local midnight.
			const midnight = nextCron("0 0 * * *", tz, now);
			return nextCron(`${time.minute} ${time.hour} * * *`, tz, midnight - 1000);
		}
		const days = parseDayList(day);
		if (time && days !== undefined) return nextCron(`${time.minute} ${time.hour} * * ${days}`, tz, now);
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
		throw new Error(
			`Invalid at "${text}": use now, in 2m, HH:MM, tomorrow 09:30, mon 09:00, YYYY-MM-DD HH:MM, or an ISO time`,
		);
	}
	return parsed;
}

/** Parsed `every` cadence. Durations count elapsed time; everything else is a calendar pattern. */
export type Cadence = { kind: "cron"; pattern: string } | { kind: "interval"; ms: number };

function stripEvery(text: string): string {
	return text
		.trim()
		.replace(/^every\s+/i, "")
		.trim();
}

export function parseEvery(text: string): Cadence {
	const trimmed = stripEvery(text);
	const lower = trimmed.toLowerCase();
	if (lower === "hourly") return { kind: "cron", pattern: "0 * * * *" };
	const named = /^(\S+)\s+(\d{1,2}:\d{2})$/.exec(trimmed);
	if (named) {
		const clock = parseClock(named[2]);
		const word = named[1].toLowerCase();
		if (clock) {
			const base = `${clock.minute} ${clock.hour} * *`;
			if (word === "daily") return { kind: "cron", pattern: `${base} *` };
			if (word === "weekdays") return { kind: "cron", pattern: `${base} 1-5` };
			if (word === "weekends") return { kind: "cron", pattern: `${base} 0,6` };
			const days = parseDayList(word);
			if (days !== undefined) return { kind: "cron", pattern: `${base} ${days}` };
		}
		throw new Error(`Invalid every "${text}": use daily|weekdays|weekends|mon,thu followed by HH:MM`);
	}
	const cronText = trimmed.replace(/^cron\s+/i, "");
	if (cronText.split(/\s+/).length === 5) {
		try {
			new Cron(cronText);
		} catch (err) {
			throw new Error(`Invalid cron "${cronText}": ${err instanceof Error ? err.message : String(err)}`);
		}
		return { kind: "cron", pattern: cronText };
	}
	const ms = parseDuration(trimmed);
	if (ms < MINUTE) throw new Error(`every ${text}: the minimum interval is 1m (the ticker runs once a minute)`);
	return { kind: "interval", ms };
}

/** Normalize the user's `every` text to the stored form (`30m`, `daily 09:00`, `cron …`). */
export function normalizeEvery(text: string): string {
	const trimmed = stripEvery(text);
	const cadence = parseEvery(trimmed);
	if (cadence.kind === "interval") return serializeDuration(cadence.ms);
	if (trimmed.replace(/^cron\s+/i, "").split(/\s+/).length === 5) return `cron ${cadence.pattern}`;
	return trimmed.toLowerCase().replace(/\s+/g, " ");
}

/** A Tern/Carly `when` string split into the spec's `at` or `every`. */
export function parseWhen(text: string): { at?: string; every?: string } {
	const trimmed = text.trim();
	if (/^every\s+/i.test(trimmed)) return { every: stripEvery(trimmed) };
	if (/^(in|at)\s+/i.test(trimmed) || /^(now|tomorrow\b)/i.test(trimmed)) return { at: trimmed };
	try {
		parseEvery(trimmed);
		// A bare duration reads as a delay ("20m" = in 20m), not a cadence.
		if (parseEvery(trimmed).kind === "interval") return { at: `in ${trimmed}` };
		return { every: trimmed };
	} catch {
		return { at: trimmed };
	}
}

/** Slots of a recurring cadence for one schedule generation. */
export interface SlotSource {
	/** First slot strictly after `t`. */
	after(t: number): number | undefined;
	/** Newest slot at or before `t`. */
	atOrBefore(t: number): number | undefined;
	/** Number of slots in the open interval (`from`, `to`), bounded. */
	countBetween(from: number, to: number): number;
}

/**
 * Slots begin strictly after `armedAt`, or at `at` (inclusive) when the spec
 * names a start. A duration counts from that start.
 */
export function slotSource(spec: Pick<TimerSpec, "every" | "at" | "tz" | "armedAt">): SlotSource {
	const cadence = parseEvery(spec.every ?? "");
	const startAt = spec.at ? Date.parse(spec.at) : undefined;
	const armed = Date.parse(spec.armedAt);
	if (cadence.kind === "interval") {
		const { ms } = cadence;
		const first = startAt ?? armed + ms;
		const index = (t: number): number => Math.floor((t - first) / ms);
		return {
			after: t => (t < first ? first : first + (index(t) + 1) * ms),
			atOrBefore: t => (t < first ? undefined : first + index(t) * ms),
			countBetween: (from, to) => {
				if (to <= first) return 0;
				const lo = from < first ? 0 : index(from) + 1;
				const hi = Math.ceil((to - first) / ms) - 1;
				return Math.max(0, hi - lo + 1);
			},
		};
	}
	const cron = new Cron(cadence.pattern, { timezone: spec.tz });
	// Slots never precede the generation start: one second before `at` keeps an exact `at` slot inclusive.
	const floor = startAt !== undefined ? startAt - 1000 : armed;
	const after = (t: number): number | undefined => cron.nextRun(new Date(Math.max(t, floor)))?.getTime();
	return {
		after,
		atOrBefore: t => {
			// croner's previousRuns excludes the reference second; take the newest result not after `t`.
			const slot = cron
				.previousRuns(2, new Date(t + 1000))
				.find(run => run.getTime() <= t)
				?.getTime();
			return slot !== undefined && slot > floor ? slot : undefined;
		},
		countBetween: (from, to) => {
			let count = 0;
			let cursor = after(from);
			while (cursor !== undefined && cursor < to && count < MAX_SLOT_SCAN) {
				count++;
				cursor = after(cursor);
			}
			return count;
		},
	};
}

/** Smallest spacing between consecutive slots over the next few occurrences. */
export function minCadenceGapMs(every: string, tz: string, from: number): number {
	const cadence = parseEvery(every);
	if (cadence.kind === "interval") return cadence.ms;
	const runs = new Cron(cadence.pattern, { timezone: tz }).nextRuns(8, new Date(from)).map(run => run.getTime());
	let gap = Number.POSITIVE_INFINITY;
	for (let i = 1; i < runs.length; i++) gap = Math.min(gap, runs[i] - runs[i - 1]);
	return gap;
}

export type DueDecision =
	/** Nothing to do this tick. */
	| { kind: "idle" }
	/** Fire for `slot`; `missedSlots` older slots were coalesced into it. */
	| { kind: "due"; slot: number; missedSlots: number }
	/** The newest slot is later than its grace: record `missed`, consume it, don't run. */
	| { kind: "missed"; slot: number; missedSlots: number }
	/** The timer is finished (expired, maxRuns reached, or a one-shot whose slot is consumed). */
	| { kind: "retire"; why: "expired" | "once" | "max-runs" };

/** How late `slot` may still run. */
export function graceFor(
	spec: Pick<TimerSpec, "graceMs" | "catchup">,
	source: SlotSource | undefined,
	slot: number,
): number {
	if (spec.graceMs !== undefined) return spec.graceMs;
	if (spec.catchup === "skip") return CATCHUP_SKIP_GRACE_MS;
	if (!source) return ONE_SHOT_GRACE_MS;
	// One full period: the newest slot always runs once, however late.
	const next = source.after(slot);
	return next !== undefined ? next - slot : Number.POSITIVE_INFINITY;
}

/**
 * Decide what this tick owes a timer at `now`. Pure: callers persist
 * `state.lastSlot = slot` in the same transaction that records the run, so a
 * second tick (or a crash and restart) never decides the same slot again.
 */
export function decideDue(spec: TimerSpec, state: TimerState, now: number): DueDecision {
	if (spec.expiresAt && Date.parse(spec.expiresAt) <= now) return { kind: "retire", why: "expired" };
	if (spec.maxRuns !== undefined && state.runCount >= spec.maxRuns) return { kind: "retire", why: "max-runs" };
	const startAt = spec.at ? Date.parse(spec.at) : undefined;

	if (spec.every) {
		const source = slotSource(spec);
		const latest = source.atOrBefore(now);
		if (latest === undefined || (state.lastSlot !== undefined && latest <= state.lastSlot)) return { kind: "idle" };
		const missedSlots = source.countBetween(state.lastSlot ?? Number.NEGATIVE_INFINITY, latest);
		if (now - latest > graceFor(spec, source, latest)) return { kind: "missed", slot: latest, missedSlots };
		return { kind: "due", slot: latest, missedSlots };
	}

	if (startAt !== undefined) {
		if (now < startAt) return { kind: "idle" };
		if (state.lastSlot !== undefined && state.lastSlot >= startAt) return { kind: "retire", why: "once" };
		if (now - startAt > graceFor(spec, undefined, startAt)) return { kind: "missed", slot: startAt, missedSlots: 0 };
		return { kind: "due", slot: startAt, missedSlots: 0 };
	}

	// Timers without at/every fire only through `fire`.
	return { kind: "idle" };
}

/** Next instant a timer will act, for listings. `undefined` = never on its own (done, paused, manual-only). */
export function nextFireAt(spec: TimerSpec, state: TimerState, now: number): number | undefined {
	if (state.done || spec.paused) return undefined;
	if (spec.expiresAt && Date.parse(spec.expiresAt) <= now) return undefined;
	if (spec.maxRuns !== undefined && state.runCount >= spec.maxRuns) return undefined;
	const startAt = spec.at ? Date.parse(spec.at) : undefined;
	let next: number | undefined;
	if (spec.every) {
		next = slotSource(spec).after(Math.max(now, state.lastSlot ?? Number.NEGATIVE_INFINITY));
	} else if (startAt !== undefined && (state.lastSlot === undefined || state.lastSlot < startAt)) {
		next = startAt;
	}
	if (next !== undefined && spec.expiresAt && next >= Date.parse(spec.expiresAt)) return undefined;
	return next;
}
