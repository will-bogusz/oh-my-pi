/**
 * Failure and notice policy, applied by the tick when it settles a run.
 *
 * - Each failure counts toward `spec.pauseAfter` consecutive failures; at the
 *   limit the tick pauses the timer (spec `paused` + reason) and raises ONE
 *   `paused` alert. A success resets the streak; so does `resume`.
 * - Failures and notices (missed slot, held delivery) open an incident keyed
 *   by a normalized error signature. An incident alerts once: immediately when
 *   nothing will run again (a one-shot), once it has occurred `pauseAfter`
 *   times (a flaky timer whose failures are separated by successes), or as the
 *   pause alert. An alerted incident that keeps occurring re-alerts as a
 *   `reminder` after {@link INCIDENT_REMINDER_MS}.
 * - A success closes alerted incidents (the next failure is news again) but
 *   leaves silent ones counting; a silent incident quiet for longer than the
 *   cooldown starts over, so one failure a week never adds up to an alert.
 */
import type { IncidentRow, TimerDb } from "./store";
import type { TimerAlert, TimerSpec, TimerState } from "./types";

/** An open incident that is still occurring re-alerts after this. */
export const INCIDENT_REMINDER_MS = 24 * 3_600_000;

/** First meaningful line of an error, raw. */
export function firstErrorLine(text: string): string {
	return (
		text
			.split("\n")
			.map(line => line.trim())
			.find(Boolean)
			?.slice(0, 300) ?? ""
	);
}

/**
 * Signature of an error: its first line with the parts that vary between
 * occurrences of the same failure (paths, hex ids, numbers, quoted values)
 * replaced, so `exit 1: /tmp/x.123 not found` and `exit 1: /tmp/x.456 not
 * found` are one incident.
 */
export function errorSignature(kind: string, error: string): string {
	const normalized = firstErrorLine(error)
		.toLowerCase()
		.replace(/(?:~|\.{0,2})?\/[^\s'":]+/g, "<path>")
		.replace(/\b[0-9a-f]{7,}\b/g, "<hex>")
		.replace(/\d+(?:\.\d+)?/g, "<n>")
		.replace(/(["'`]).*?\1/g, "<q>")
		.replace(/\s+/g, " ")
		.trim();
	return `${kind}:${Bun.hash.wyhash(normalized).toString(16).padStart(16, "0").slice(0, 12)}`;
}

export interface FailureInput {
	runId: string;
	error: string;
	at: string;
	now: number;
	/** Nothing will run again on its own (one-shot): alert now rather than waiting for repeats. */
	final: boolean;
	logPath?: string;
}

export interface PolicyOutcome {
	alerts: TimerAlert[];
	/** Set when the streak reached `pauseAfter`: the tick pauses the spec with this reason. */
	pauseReason?: string;
}

function alertFrom(
	spec: TimerSpec,
	incident: IncidentRow,
	event: TimerAlert["event"],
	summary: string,
	input: { runId?: string; error?: string; logPath?: string },
): TimerAlert {
	return {
		timerId: spec.id,
		runId: input.runId,
		event,
		summary,
		error: input.error,
		signature: incident.signature,
		count: incident.count,
		logPath: input.logPath,
	};
}

/** Whether an already-alerted incident is due a reminder. */
function reminderDue(incident: IncidentRow, now: number): boolean {
	return incident.alertedAt !== undefined && now - Date.parse(incident.alertedAt) >= INCIDENT_REMINDER_MS;
}

/** Count one occurrence; a silent incident quiet for longer than the cooldown starts over. */
function bump(db: TimerDb, spec: TimerSpec, signature: string, summary: string, at: string, now: number): IncidentRow {
	const open = db.openIncident(spec.id, signature);
	if (open && open.alertedAt === undefined && now - Date.parse(open.lastAt) >= INCIDENT_REMINDER_MS) {
		db.resolveIncident(open.id, at);
	}
	return db.bumpIncident(spec.id, signature, summary, at);
}

/** One failed run (gate broke, run ended non-zero, runner lost). Mutates `state.failStreak`. */
export function applyFailure(db: TimerDb, spec: TimerSpec, state: TimerState, input: FailureInput): PolicyOutcome {
	state.failStreak++;
	const error = firstErrorLine(input.error) || "failed";
	const incident = bump(db, spec, errorSignature("failed", error), error, input.at, input.now);
	const context = { runId: input.runId, error, logPath: input.logPath };
	if (state.failStreak >= spec.pauseAfter) {
		db.markIncidentAlerted(incident.id, input.at);
		const pauseReason = `failures: ${state.failStreak} in a row; last: ${error}`;
		return {
			pauseReason,
			alerts: [
				alertFrom(
					spec,
					incident,
					"paused",
					`paused after ${state.failStreak} consecutive failures: ${error}`,
					context,
				),
			],
		};
	}
	if (incident.alertedAt === undefined && (input.final || incident.count >= spec.pauseAfter)) {
		db.markIncidentAlerted(incident.id, input.at);
		const times = incident.count > 1 ? ` (${incident.count} times)` : "";
		return { alerts: [alertFrom(spec, incident, "failed", `failed${times}: ${error}`, context)] };
	}
	if (reminderDue(incident, input.now)) {
		db.markIncidentAlerted(incident.id, input.at);
		return {
			alerts: [alertFrom(spec, incident, "reminder", `still failing (${incident.count} times): ${error}`, context)],
		};
	}
	return { alerts: [] };
}

/** A run that succeeded (shell exit 0, delivered turn): resets the streak and closes alerted incidents. */
export function applySuccess(db: TimerDb, spec: TimerSpec, state: TimerState, at: string): void {
	state.failStreak = 0;
	db.resolveIncidents(spec.id, at, { alertedOnly: true });
}

/**
 * Something a person should hear about that is not a failure (a missed slot,
 * a delivery held because the session is open elsewhere, a watch that expired
 * without firing): alert once per incident, remind after the cooldown.
 */
export function applyNotice(
	db: TimerDb,
	spec: TimerSpec,
	event: "missed" | "expired" | "held",
	summary: string,
	input: { runId?: string; at: string; now: number },
): TimerAlert[] {
	const incident = db.bumpIncident(spec.id, `${event}:notice`, summary, input.at);
	if (incident.alertedAt !== undefined && !reminderDue(incident, input.now)) return [];
	const reminder = incident.alertedAt !== undefined;
	db.markIncidentAlerted(incident.id, input.at);
	return [
		alertFrom(spec, incident, reminder ? "reminder" : event, summary, {
			runId: input.runId,
		}),
	];
}
