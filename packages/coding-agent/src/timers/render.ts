/**
 * Text renderings of stored timer records: the confirmation card (tool result,
 * `omp timer set/show`) and the listing table (`omp timer ls`). Everything is
 * rendered from the record on disk, never from what the caller asked for.
 */
import { formatWallClock } from "./fire-message";
import { ownSessionDir } from "./paths";
import { describeRunResult, formatCost } from "./run-result";
import { formatDuration } from "./schedule";
import type { TimerRow } from "./service";
import type { RunView, TickerStatus } from "./store";
import type { AgentRunResult, TimerSpec } from "./types";

/** A tick older than this means no ticker is running. */
export const TICKER_STALE_MS = 3 * 60_000;

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function describeNext(row: TimerRow, now: number): string {
	if (row.status === "done") return `done (${row.state.done?.why ?? "?"})`;
	if (row.status === "paused") {
		const reason =
			row.spec.pausedReason && row.spec.pausedReason !== "user" ? `: ${oneLine(row.spec.pausedReason, 60)}` : "";
		return `paused${reason}`;
	}
	if (row.next === "gate") return "when gate passes (checked each minute)";
	if (row.next === undefined) return "—";
	const delta = row.next - now;
	return `${formatWallClock(row.next, row.spec.tz)} (${delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} overdue`})`;
}

export function describeCadence(spec: TimerSpec): string {
	if (spec.every) return `every ${spec.every}`;
	if (spec.until) return "once, when its condition holds";
	return "once";
}

export function describeAction(spec: TimerSpec, selfSessionId?: string): string {
	if (spec.action.kind === "shell") return `run \`${oneLine(spec.action.command, 80)}\` in ${spec.cwd}`;
	const prompt = `"${oneLine(spec.action.prompt, 90)}"`;
	if (spec.target.kind !== "session") {
		const where = spec.run.runCwd ? "a per-run dir" : spec.cwd;
		return `${spec.target.kind} session in ${where} → ${prompt}`;
	}
	const self = spec.target.sessionId === selfSessionId ? " (this session)" : "";
	const closed = spec.whenClosed === "hold" ? "hold until opened" : "resume headless";
	return `wake session ${spec.target.sessionId}${self} → ${prompt}\n       if busy: after the current turn · if closed: ${closed}`;
}

/**
 * Run settings of an agent run (prompt timer whose session is fresh or own):
 * `agent reviewer · thinking low · hermetic · cwd per-run · max 20m · max $0.50 · expect out/report.md · before/after hooks · report said`,
 * plus the session dir an `own` timer keeps. Undefined for other timers.
 */
export function describeRunSettings(spec: TimerSpec): string | undefined {
	if (spec.action.kind !== "prompt" || spec.target.kind === "session") return undefined;
	const { run } = spec;
	const hooks =
		run.before && run.after ? "before/after hooks" : run.before ? "before hook" : run.after ? "after hook" : "";
	const parts = [
		run.agent ? `agent ${run.agent}` : undefined,
		run.thinking ? `thinking ${run.thinking}` : undefined,
		run.hermetic ? "hermetic" : undefined,
		run.runCwd ? "cwd per-run" : undefined,
		run.maxTimeMs !== undefined ? `max ${formatDuration(run.maxTimeMs)}` : undefined,
		run.maxCost !== undefined ? `max ${formatCost(run.maxCost)}` : undefined,
		run.expect?.length ? `expect ${run.expect.join(", ")}` : undefined,
		hooks || undefined,
		`report ${spec.report}`,
		spec.target.kind === "own" ? `session ${ownSessionDir(spec.id)}` : undefined,
	].filter(Boolean);
	return parts.join(" · ");
}

export function describeTicker(ticker: TickerStatus, now: number): string {
	if (!ticker.lastTickAt) {
		return "⚠ no tick recorded yet: timers fire only when `omp timer tick` runs — run `omp timer install`";
	}
	const age = now - Date.parse(ticker.lastTickAt);
	const text = `last tick ${formatDuration(age)} ago`;
	return age > TICKER_STALE_MS
		? `⚠ ${text}: no ticker is running, nothing fires until one does (\`omp timer doctor\`)`
		: text;
}

/** The last run; an agent run's `result.json` summary replaces the runner's end line. */
export function describeRun(run: RunView | undefined, result?: AgentRunResult): string {
	if (!run) return "never ran";
	const delivery = run.delivery ? ` · ${run.delivery.state}` : "";
	if (result) return `${run.outcome} ${run.at}${delivery} · ${describeRunResult(result)}`;
	const end =
		run.end?.ok !== undefined
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
	warnings?: string[];
	platform?: NodeJS.Platform;
	/** `result.json` of the last run, when it was an agent run that ended. */
	lastResult?: AgentRunResult;
}

/** Compact multi-line card; the same text goes to the model and to the CLI. */
export function renderTimerCard(row: TimerRow, now: number, options: CardOptions): string {
	const { spec } = row;
	const verb = options.verb ? ` ${options.verb}` : "";
	const lines = [`timer ${spec.id}${verb} (rev ${spec.rev}) — ${describeNext(row, now)}, ${describeCadence(spec)}`];
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
		spec.every ? `overlap ${spec.overlap}` : undefined,
		spec.catchup === "skip" ? "late slots skipped" : undefined,
		spec.graceMs !== undefined ? `grace ${formatDuration(spec.graceMs)}` : undefined,
		`pauses after ${spec.pauseAfter} failures`,
		row.state.runCount ? `${row.state.runCount} run(s) so far` : undefined,
	].filter(Boolean);
	lines.push(`limits ${limits.join(" · ")}`);
	const run = describeRunSettings(spec);
	if (run) lines.push(`run    ${run}`);
	lines.push(`why    ${oneLine(spec.reason, 120)}`);
	lines.push(`last   ${describeRun(row.lastRun, options.lastResult)}`);
	for (const incident of row.incidents) {
		lines.push(`⚠ open incident ×${incident.count} since ${incident.firstAt}: ${oneLine(incident.summary, 90)}`);
	}
	lines.push(`ticker ${describeTicker(options.ticker, now)}`);
	if (options.gateNow === "broken") lines.push("⚠ the gate failed its test run; it counts as a failure each tick");
	if (options.gateNow === "met") {
		lines.push(
			"⚠ the condition already holds: this fires at the next tick. If you meant to wait for a change, fix the check.",
		);
	}
	if ((options.platform ?? process.platform) === "darwin" && (spec.at || spec.every) && !spec.wakeMachine) {
		lines.push(
			spec.catchup === "skip"
				? "⚠ a sleeping Mac misses the slots it sleeps through (catchup: skip)"
				: "⚠ a sleeping Mac runs this late, once, on wake",
		);
	}
	for (const warning of options.warnings ?? []) lines.push(`⚠ ${warning}`);
	lines.push(`manage timer {op:"show"|"edit"|"fire"|"pause"|"remove", id:"${spec.id}"}`);
	return lines.join("\n");
}

/** Table for `omp timer ls`. */
export function renderTimerTable(rows: TimerRow[], now: number, ticker: TickerStatus): string {
	const header = ["ID", "STATUS", "NEXT", "LAST", "ORIGIN", "REASON"];
	const body = rows.map(row => [
		row.spec.id,
		row.incidents.length ? `${row.status}⚠` : row.status,
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

/** Run history; `results` (seq → `result.json`) adds each ended agent run's summary. */
export function renderRuns(runs: RunView[], results?: ReadonlyMap<number, AgentRunResult>): string {
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
			const result = results?.get(run.seq);
			if (result) parts.push(`result=${describeRunResult(result)}`);
			return parts.join("  ");
		})
		.join("\n");
}
