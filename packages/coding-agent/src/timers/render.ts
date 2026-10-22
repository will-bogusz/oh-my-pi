/**
 * Text renderings of stored timer records: the confirmation card (tool result,
 * `omp timer set/show`) and the listing table (`omp timer ls`). Everything is
 * rendered from the record on disk, never from what the caller asked for.
 */
import { formatWallClock } from "./fire-message";
import { formatDuration } from "./schedule";
import type { TickerStatus, TimerRow } from "./service";
import type { RunView } from "./store";
import type { TimerSpec } from "./types";

/** A tick older than this means no ticker is running. */
const TICKER_STALE_MS = 3 * 60_000;

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function describeNext(row: TimerRow, now: number): string {
	if (row.status === "done") return `done (${row.state.done?.why ?? "?"})`;
	if (row.status === "paused") return "paused";
	if (row.next === "gate") return "when gate passes (checked each minute)";
	if (row.next === undefined) return "—";
	const delta = row.next - now;
	return `${formatWallClock(row.next, row.spec.tz)} (${delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} overdue`})`;
}

export function describeCadence(spec: TimerSpec): string {
	if (spec.every) return `every ${spec.every}`;
	return "once";
}

export function describeAction(spec: TimerSpec, selfSessionId?: string): string {
	if (spec.action.kind === "shell") return `run \`${oneLine(spec.action.command, 80)}\` in ${spec.cwd}`;
	const prompt = `"${oneLine(spec.action.prompt, 90)}"`;
	if (spec.target.kind === "fresh") return `new session in ${spec.cwd} → ${prompt}`;
	const self = spec.target.sessionId === selfSessionId ? " (this session)" : "";
	const closed = spec.whenClosed === "hold" ? "hold until opened" : "resume headless";
	return `wake session ${spec.target.sessionId}${self} → ${prompt}\n       if busy: after the current turn · if closed: ${closed}`;
}

export function describeTicker(ticker: TickerStatus, now: number): string {
	if (!ticker.lastTickAt) {
		return "⚠ no tick recorded yet: timers fire only when `omp timer tick` runs (once a minute from an OS unit)";
	}
	const age = now - Date.parse(ticker.lastTickAt);
	const text = `last tick ${formatDuration(age)} ago`;
	return age > TICKER_STALE_MS ? `⚠ ${text}: no ticker is running, nothing fires until one does` : text;
}

export function describeRun(run: RunView | undefined): string {
	if (!run) return "never ran";
	const delivery = run.delivery ? ` · ${run.delivery.state}` : "";
	const end = run.end
		? ` · ${run.end.ok ? "ok" : `failed${run.end.detail ? `: ${oneLine(run.end.detail, 60)}` : ""}`}`
		: "";
	return `${run.outcome} ${run.at}${delivery}${end}`;
}

export interface CardOptions {
	verb: string;
	selfSessionId?: string;
	ticker: TickerStatus;
	gateNow?: "met" | "not-yet" | "broken";
	gateDetail?: string;
}

/** Compact multi-line card; the same text goes to the model and to the CLI. */
export function renderTimerCard(row: TimerRow, now: number, options: CardOptions): string {
	const { spec } = row;
	const lines = [`timer ${spec.id} ${options.verb} — ${describeNext(row, now)}, ${describeCadence(spec)}`];
	lines.push(`does   ${describeAction(spec, options.selfSessionId)}`);
	if (spec.until) {
		const gateNow = options.gateNow
			? ` · now: ${options.gateNow}${options.gateDetail ? ` (${oneLine(options.gateDetail, 80)})` : ""}`
			: "";
		const condition = spec.condition ?? `\`${spec.until}\` exits 0`;
		lines.push(`gate   ${oneLine(condition, 100)}, checked each minute${gateNow}`);
	}
	const limits = [
		spec.expiresAt ? `expires ${formatWallClock(Date.parse(spec.expiresAt), spec.tz)}` : undefined,
		spec.maxRuns !== undefined ? `max ${spec.maxRuns} runs` : undefined,
		row.state.runCount ? `${row.state.runCount} run(s) so far` : undefined,
	].filter(Boolean);
	if (limits.length) lines.push(`limits ${limits.join(" · ")}`);
	lines.push(`why    ${oneLine(spec.reason, 120)}`);
	lines.push(`last   ${describeRun(row.lastRun)}`);
	lines.push(`ticker ${describeTicker(options.ticker, now)}`);
	if (options.gateNow === "broken") lines.push("⚠ the gate failed its dry run; it will count as a failure each tick");
	if (options.gateNow === "met") {
		lines.push(
			"⚠ the condition already holds: this fires at the next tick. If you meant to wait for a change, fix the check.",
		);
	}
	lines.push(`manage timer {op:"show"|"fire"|"pause"|"remove", id:"${spec.id}"}`);
	return lines.join("\n");
}

/** Table for `omp timer ls`. */
export function renderTimerTable(rows: TimerRow[], now: number, ticker: TickerStatus): string {
	const header = ["ID", "STATUS", "NEXT", "LAST", "ORIGIN", "REASON"];
	const body = rows.map(row => [
		row.spec.id,
		row.status,
		describeNext(row, now),
		row.lastRun ? `${row.lastRun.outcome}${row.lastRun.delivery ? `/${row.lastRun.delivery.state}` : ""}` : "—",
		row.spec.created.session ?? row.spec.created.by,
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

export function renderRuns(runs: RunView[]): string {
	if (runs.length === 0) return "no runs recorded";
	return runs
		.map(run => {
			const parts = [`#${run.seq}`, run.at, run.trigger, run.outcome];
			if (run.missedSlots) parts.push(`missed ${run.missedSlots}`);
			if (run.delivery)
				parts.push(`delivery=${run.delivery.state}${run.delivery.detail ? ` (${run.delivery.detail})` : ""}`);
			if (run.end)
				parts.push(
					`end=${run.end.ok ? "ok" : "failed"} ${formatDuration(run.end.durationMs)}${run.end.detail ? ` (${oneLine(run.end.detail, 80)})` : ""}`,
				);
			if (run.detail) parts.push(run.detail);
			return parts.join("  ");
		})
		.join("\n");
}
