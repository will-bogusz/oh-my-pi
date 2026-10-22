/**
 * Text renderings of stored timer records: the card (`omp timer set/show`) and
 * the listing table (`omp timer ls`). Everything is rendered from the record on
 * disk, never from what the caller asked for.
 */
import { formatWallClock } from "../mailbox/message";
import { formatDuration } from "./schedule";
import type { TimerRow } from "./service";
import type { RunView, TickerStatus } from "./store";
import type { TimerSpec } from "./types";

/** A tick older than this means no ticker is running. */
export const TICKER_STALE_MS = 3 * 60_000;

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Calendar date of `ms` in `tz` as YYYY-MM-DD. */
function localDate(ms: number, tz: string | undefined): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		new Date(ms),
	);
}

/** `today` / `tomorrow` relative to `now` in `tz`, so a date typed across midnight reads as what it is. */
function relativeDay(ms: number, now: number, tz: string | undefined): string | undefined {
	const day = localDate(ms, tz);
	if (day === localDate(now, tz)) return "today";
	if (day === localDate(now + 24 * 60 * 60_000, tz)) return "tomorrow";
	return undefined;
}

export function describeNext(row: TimerRow, now: number): string {
	if (row.status === "done") return `done (${row.state.done?.why ?? "?"})`;
	if (row.status === "paused") {
		const reason =
			row.spec.pausedReason && row.spec.pausedReason !== "user" ? `: ${oneLine(row.spec.pausedReason, 60)}` : "";
		return `paused${reason}`;
	}
	if (row.next === undefined) return "—";
	const delta = row.next - now;
	const day = relativeDay(row.next, now, row.spec.tz);
	return `${formatWallClock(row.next, row.spec.tz)} (${day ? `${day}, ` : ""}${delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} overdue`})`;
}

export function describeCadence(spec: TimerSpec): string {
	return spec.every ? `every ${spec.every}` : "once";
}

export function describeAction(spec: TimerSpec): string {
	const { action, target } = spec;
	if (action.kind === "shell") return `run \`${oneLine(action.command, 80)}\` in ${spec.cwd}`;
	const session = target.kind === "session" ? target.sessionId : "(none)";
	const closed = spec.whenClosed === "hold" ? "hold until opened" : "resume headless";
	return `wake session ${session} → "${oneLine(action.prompt, 90)}"\n       if busy: after the current turn · if closed: ${closed}`;
}

export interface TickAge {
	ms: number;
	/** `last tick 4m ago`. */
	text: string;
	/** Older than {@link TICKER_STALE_MS}: no ticker is running. */
	stale: boolean;
}

/** Age of the newest tick, the one computation the card, `omp timer ls` and `doctor` share; `undefined` when unreadable. */
export function tickAge(lastTickAt: string, now: number): TickAge | undefined {
	const at = Date.parse(lastTickAt);
	if (Number.isNaN(at)) return undefined;
	const ms = Math.max(0, now - at);
	return { ms, text: `last tick ${formatDuration(ms)} ago`, stale: ms > TICKER_STALE_MS };
}

export function describeTicker(ticker: TickerStatus, now: number): string {
	if (!ticker.lastTickAt) {
		return "⚠ no tick recorded yet: timers fire only when `omp timer tick` runs — run `omp timer install`";
	}
	const age = tickAge(ticker.lastTickAt, now);
	if (!age) return `⚠ unreadable heartbeat "${ticker.lastTickAt}" (\`omp timer doctor\`)`;
	return age.stale
		? `⚠ ${age.text}: no ticker is running, nothing fires until one does (\`omp timer doctor\`)`
		: age.text;
}

export function describeRun(run: RunView | undefined): string {
	if (!run) return "never ran";
	const delivery = run.delivery ? ` · ${run.delivery.state}` : "";
	const end =
		run.end?.ok !== undefined
			? ` · ${run.end.ok ? "ok" : `failed${run.end.detail ? `: ${oneLine(run.end.detail, 60)}` : ""}`}`
			: "";
	return `${run.outcome} ${run.at}${delivery}${end}`;
}

export interface CardOptions {
	verb: string;
	ticker: TickerStatus;
	/** Problems `set`/`edit` found that did not block it. */
	warnings?: string[];
	platform?: NodeJS.Platform;
}

/** Compact multi-line card. */
export function renderTimerCard(row: TimerRow, now: number, options: CardOptions): string {
	const { spec } = row;
	const verb = options.verb ? ` ${options.verb}` : "";
	const lines = [`timer ${spec.id}${verb} (rev ${spec.rev}) — ${describeNext(row, now)}, ${describeCadence(spec)}`];
	lines.push(`does   ${describeAction(spec)}`);
	const limits = [
		spec.expiresAt ? `expires ${formatWallClock(Date.parse(spec.expiresAt), spec.tz)}` : undefined,
		spec.maxRuns !== undefined ? `max ${spec.maxRuns} runs` : undefined,
		spec.every ? `overlap ${spec.overlap}` : undefined,
		spec.catchup === "skip" ? "late slots skipped" : undefined,
		spec.graceMs !== undefined ? `grace ${formatDuration(spec.graceMs)}` : undefined,
		`pauses after ${spec.pauseAfter} failures`,
		row.state.runCount ? `${row.state.runCount} run(s) so far` : undefined,
	].filter(Boolean);
	lines.push(`limits ${limits.join(" · ")}`);
	lines.push(`why    ${oneLine(spec.reason, 120)}`);
	lines.push(`last   ${describeRun(row.lastRun)}`);
	for (const incident of row.incidents) {
		lines.push(`⚠ open incident ×${incident.count} since ${incident.firstAt}: ${oneLine(incident.summary, 90)}`);
	}
	// The ticker runs once a minute, so a one-shot lands up to a minute after its time.
	const granularity = spec.at && !spec.every ? " · fires within a minute after its time" : "";
	lines.push(`ticker ${describeTicker(options.ticker, now)}${granularity}`);
	if ((options.platform ?? process.platform) === "darwin" && row.machineWakeAt === undefined) {
		lines.push(
			spec.catchup === "skip"
				? "⚠ a sleeping Mac misses the slots it sleeps through (catchup: skip)"
				: "⚠ a sleeping Mac runs this late, once, on wake",
		);
	}
	for (const warning of options.warnings ?? []) lines.push(`⚠ ${warning}`);
	return lines.join("\n");
}

/** Table for `omp timer ls`. */
export function renderTimerTable(rows: TimerRow[], now: number, ticker: TickerStatus): string {
	const header = ["ID", "STATUS", "NEXT", "LAST", "REASON"];
	const body = rows.map(row => [
		row.spec.id,
		row.incidents.length ? `${row.status}⚠` : row.status,
		describeNext(row, now),
		row.lastRun ? `${row.lastRun.outcome}${row.lastRun.delivery ? `/${row.lastRun.delivery.state}` : ""}` : "—",
		oneLine(row.spec.reason, 48),
	]);
	const widths = header.map((h, i) => Math.max(h.length, ...body.map(cells => Bun.stringWidth(cells[i]))));
	const fmt = (cells: string[]): string =>
		cells
			.map((cell, i) => (i === cells.length - 1 ? cell : cell + " ".repeat(widths[i] - Bun.stringWidth(cell))))
			.join("  ");
	const out = [fmt(header), ...body.map(fmt)];
	out.push("", `ticker: ${describeTicker(ticker, now)}`);
	return out.join("\n");
}

/** Run history for `omp timer runs`. */
export function renderRuns(runs: RunView[]): string {
	if (runs.length === 0) return "no runs recorded";
	return runs
		.map(run => {
			const parts = [`#${run.seq}`, run.at, run.trigger, run.outcome];
			if (run.slot && run.trigger !== "manual") parts.push(`slot ${run.slot}`);
			if (run.missedSlots) parts.push(`coalesced ${run.missedSlots} missed`);
			if (run.delivery)
				parts.push(`delivery=${run.delivery.state}${run.delivery.detail ? ` (${run.delivery.detail})` : ""}`);
			if (run.end?.ok !== undefined)
				parts.push(
					`end=${run.end.ok ? "ok" : "failed"} ${formatDuration(run.end.durationMs ?? 0)}${run.end.detail ? ` (${oneLine(run.end.detail, 80)})` : ""}`,
				);
			else if (run.end?.startedAt) parts.push("running");
			if (run.detail) parts.push(run.detail);
			return parts.join("  ");
		})
		.join("\n");
}
