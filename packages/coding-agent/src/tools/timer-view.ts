/**
 * What every timer surface (tool card, `/timer`, `/timers`, `timer://`, the
 * jobs pill) shows about a stored timer, and the approval tier an action on
 * it needs. Views are built from the stored record, never from the request.
 */
import * as fs from "node:fs";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import type { TimerCardView, TimerListRowView } from "@oh-my-pi/pi-tui/tools/timer";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import {
	describeCadence,
	describeNext,
	describeRun,
	describeTicker,
	formatWallClock,
	parseTimerSpec,
	renderRuns,
	requireTimer,
	runLogPath,
	specPath,
	TIMER_ID_PATTERN,
	type TickerStatus,
	type TimerRow,
	type TimerSpec,
	timerRuns,
} from "../timers";

export interface TimerCardOptions {
	/** What just happened (`armed`, `paused`, …); empty for a plain show. */
	verb: string;
	/** The session viewing the card: its own target reads as "this session". */
	selfSessionId?: string;
	ticker: TickerStatus;
	now: number;
	/** Gate dry-run verdict from `set`. */
	gateNow?: "met" | "not-yet" | "broken";
	gateDetail?: string;
}

/** The confirmation card's fields for one stored timer. */
export function timerCardView(row: TimerRow, options: TimerCardOptions): TimerCardView {
	const { spec } = row;
	const card: TimerCardView = {
		id: spec.id,
		verb: options.verb,
		status: row.status,
		fires: describeNext(row, options.now),
		cadence: describeCadence(spec),
		does: "",
		why: spec.reason,
		last: describeRun(row.lastRun),
		ticker: "",
		warnings: [],
	};
	if (spec.action.kind === "shell") {
		card.does = `run \`${spec.action.command}\` in ${spec.cwd}`;
		card.body = spec.action.command;
	} else {
		const prompt = `"${spec.action.prompt.trim()}"`;
		card.body = spec.action.prompt;
		if (spec.target.kind === "fresh") {
			card.does = `new session in ${spec.cwd} → ${prompt}`;
		} else {
			const self = spec.target.sessionId === options.selfSessionId;
			card.does = `wake ${self ? "this session" : `session ${spec.target.sessionId}`} → ${prompt}`;
			card.ifBusy = "after the current turn";
			card.ifClosed = spec.whenClosed === "hold" ? "hold until opened" : "resume headless";
		}
	}
	if (spec.until) {
		const verdict = options.gateNow
			? ` · now: ${options.gateNow}${options.gateDetail ? ` (${options.gateDetail})` : ""}`
			: "";
		card.gate = `${spec.condition ?? `\`${spec.until}\` exits 0`}, checked each minute${verdict}`;
	}
	const limits = [
		spec.expiresAt ? `expires ${formatWallClock(Date.parse(spec.expiresAt), spec.tz)}` : undefined,
		spec.maxRuns !== undefined ? `max ${spec.maxRuns} runs` : undefined,
		row.state.runCount ? `${row.state.runCount} run(s) so far` : undefined,
	].filter(Boolean);
	if (limits.length > 0) card.limits = limits.join(" · ");
	// A stale or missing ticker is a warning, not a fact: the card keeps the short state.
	const ticker = describeTicker(options.ticker, options.now);
	if (ticker.startsWith("⚠ ")) {
		const warning = ticker.slice(2);
		card.ticker = warning.split(":", 1)[0] ?? warning;
		card.warnings.push(warning);
	} else {
		card.ticker = ticker;
	}
	if (options.gateNow === "broken") card.warnings.push("the gate failed its dry run; each check counts as a failure");
	if (options.gateNow === "met") card.warnings.push("the condition already holds: this fires at the next tick");
	return card;
}

/** One listing row. */
export function timerListRowView(row: TimerRow, now: number): TimerListRowView {
	const last = row.lastRun;
	return {
		id: row.spec.id,
		status: row.status,
		next: describeNext(row, now),
		last: last ? `${last.outcome}${last.delivery ? `/${last.delivery.state}` : ""}` : "never ran",
		reason: row.spec.reason,
	};
}

/**
 * Tier for acting on a stored timer from `sessionId`: waking that same
 * session is `write`; a shell command, a new agent session, or another
 * session is `exec`.
 */
export function timerSpecTier(spec: TimerSpec, sessionId: string | undefined): ToolTier {
	if (spec.action.kind === "shell") return "exec";
	if (spec.target.kind !== "session") return "exec";
	return spec.target.sessionId === sessionId ? "write" : "exec";
}

/**
 * Tier for acting on the timer `id` (fire, pause, resume, remove, edit) from
 * `sessionId`. Approval gates cannot await, so the spec is read synchronously.
 * An id with no spec is `write` (the action fails on its own); a spec that
 * exists but cannot be read is `exec`, since its target is unknown.
 */
export function timerIdTier(id: string | undefined, sessionId: string | undefined): ToolTier {
	if (!id || !TIMER_ID_PATTERN.test(id)) return "write";
	const file = specPath(id);
	try {
		return timerSpecTier(parseTimerSpec(id, fs.readFileSync(file, "utf8"), file), sessionId);
	} catch (error) {
		if (isEnoent(error)) return "write";
		logger.debug("timer approval: unreadable spec", { id, error: String(error) });
		return "exec";
	}
}

/** The fields of a timer request that decide its approval tier. */
export interface TimerTierArgs {
	op?: string;
	id?: string;
	shell?: string;
	session?: string;
	host?: string;
}

/**
 * Approval tier for a timer request from `sessionId`: inspecting is `read`;
 * arming, editing or controlling a wake of the calling session is `write`;
 * a shell command, a new agent session, another session, or another host is
 * `exec`. `set` and `edit` on an existing id also take that timer's tier, so
 * re-arming someone else's timer is never cheaper than controlling it.
 */
export function timerArgsTier(args: TimerTierArgs, sessionId: string | undefined): ToolTier {
	if (args.op === "list" || args.op === "show" || args.op === "runs" || args.op === "logs") return "read";
	if (timerIdTier(args.id, sessionId) === "exec") return "exec";
	if (args.op !== "set" && args.op !== "edit") return "write";
	const session = args.session?.trim();
	const foreign = session !== undefined && session !== "" && session !== "origin" && session !== sessionId;
	return args.shell || args.host || foreign ? "exec" : "write";
}

/**
 * Run `seq`'s log, or the newest run's that wrote one, under its run line.
 * Session-target runs deliver into a transcript and write no log.
 */
export async function readTimerRunLog(id: string, seq?: number): Promise<string> {
	const runs = await timerRuns(id);
	if (runs.length === 0) await requireTimer(id);
	const candidates = seq === undefined ? runs.toReversed() : runs.filter(run => run.seq === seq);
	for (const run of candidates) {
		const log = Bun.file(runLogPath(id, run.seq));
		if (await log.exists()) return `${renderRuns([run])}\n\n${await log.text()}`;
	}
	if (seq !== undefined) return `timer ${id} run ${seq}: no log file`;
	return runs.length === 0
		? `timer ${id} has not run yet`
		: `timer ${id}: no run wrote a log (runs that wake a session deliver into its transcript)`;
}

/**
 * The timers pill text for `sessionId`: how many armed timers it set and
 * the next fire (`2 · next 08:00`, a weekday prefix past a day, `when gate`
 * for a condition). Undefined when it owns none.
 */
export function timerPillText(
	rows: readonly TimerRow[],
	sessionId: string | undefined,
	now: number,
): string | undefined {
	if (!sessionId) return undefined;
	const own = rows.filter(row => row.status === "armed" && row.spec.created.session === sessionId);
	if (own.length === 0) return undefined;
	let next: number | undefined;
	for (const row of own) if (typeof row.next === "number" && (next === undefined || row.next < next)) next = row.next;
	if (next === undefined) return own.some(row => row.next === "gate") ? `${own.length} · when gate` : `${own.length}`;
	const date = new Date(next);
	const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const day = next - now > 86_400_000 ? `${date.toLocaleDateString("en-US", { weekday: "short" })} ` : "";
	return `${own.length} · next ${day}${clock}`;
}
