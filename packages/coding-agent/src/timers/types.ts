/**
 * Timers: standing work that fires later — at a time, on a schedule, or once a
 * shell condition holds — and then wakes a session or runs a shell command.
 *
 * Desired configuration is one Markdown spec per timer (`<root>/specs/<id>.md`,
 * YAML frontmatter + prompt body), written atomically with a `rev` check.
 * Execution state (slots, runs, run ends, deliveries, incidents, ticker
 * heartbeat) lives in SQLite `<root>/timers.db`; see `store.ts` for which
 * process kind writes which table.
 */
import { type } from "@oh-my-pi/omptype";

/** Where a timer's action goes when it fires. */
export type TimerTarget =
	/** Wake (or headlessly resume) an existing session with its context. */
	| { kind: "session"; sessionId: string; sessionFile?: string }
	/** No session: a shell timer. */
	| { kind: "fresh" };

export type TimerAction = { kind: "prompt"; prompt: string } | { kind: "shell"; command: string };

/** What the target gets when it is not open in any live omp process. */
export type TimerWhenClosed = "resume" | "hold";

/** A fire while the previous run is still in flight: drop it, or buffer exactly one. */
export type TimerOverlap = "skip" | "queue";

export interface TimerProvenance {
	/** ISO time the timer was first set. */
	at: string;
	by: "cli";
	host: string;
	cwd: string;
	/** The `at`/`every`/`when` text as typed, before resolution. */
	whenText: string;
	/** `<timer>#<seq>` when a fired run created this timer. */
	run?: string;
}

export type TimerCatchup = "run" | "skip";

export interface TimerSpec {
	id: string;
	/** Bumped by every write; a writer holding an older rev gets a conflict instead of overwriting. */
	rev: number;
	title?: string;
	reason: string;
	/** One-shot instant (ISO, resolved at set time). With `every`, the first slot is at or after it. */
	at?: string;
	/** Recurring cadence, normalized: `30m`, `daily 09:00`, `weekdays 09:00`, `mon,thu 18:30`, `cron <5 fields>`. */
	every?: string;
	/** Condition gate: exit 0 fire (once), 1 not yet, anything else a failure. */
	until?: string;
	/** Readable form of the condition `until` was compiled from (`CI on o/r#12 finished`). */
	condition?: string;
	/** IANA zone for clock times; captured at set time so a travelling laptop does not move the schedule. */
	tz: string;
	target: TimerTarget;
	whenClosed: TimerWhenClosed;
	action: TimerAction;
	cwd: string;
	/** ISO instant after which the timer retires. */
	expiresAt?: string;
	maxRuns?: number;
	overlap: TimerOverlap;
	/** How late a slot may still run, ms; later ⇒ `missed`. Default: one-shot 12h, recurring one period (always catches up). */
	graceMs?: number;
	/** `skip`: a slot the ticker reached late (asleep, no ticker) is recorded `missed` instead of run late. */
	catchup: TimerCatchup;
	/** Consecutive failures that pause the timer. */
	pauseAfter: number;
	/** Let runs this timer fires create or change other timers (recursion guard). */
	allowTimers: boolean;
	paused: boolean;
	/** Why it is paused: `user`, or the failure that tripped `pauseAfter`. */
	pausedReason?: string;
	/** Start of the schedule generation: set/re-set and schedule edits move it; prompt edits do not. */
	armedAt: string;
	/** Last `resume`; failures before it no longer count toward `pauseAfter`. */
	resumedAt?: string;
	created: TimerProvenance;
}

/** Outcome of one scheduled instant (or manual fire), recorded when the tick decides it. */
export type RunOutcome = "fired" | "queued" | "gated-not-yet" | "skipped-overlap" | "missed" | "failed";

/** How a fired session-targeted run reached its session; separate from {@link RunOutcome}. */
export type DeliveryState = "queued" | "delivered-live" | "resumed-headless" | "held";

export type RunTrigger = "schedule" | "gate" | "manual";

export interface RunRecord {
	runId: string;
	seq: number;
	at: string;
	/** Scheduled instant this run covers (ISO). Absent for manual fires. */
	slot?: string;
	trigger: RunTrigger;
	outcome: RunOutcome;
	/** Earlier slots coalesced into this one (machine asleep, no ticker). */
	missedSlots?: number;
	gateExit?: number;
	detail?: string;
	/** Spec rev the run was decided against. */
	rev: number;
	/** Schedule generation (`spec.armedAt`) the run belongs to; failures of an older generation never count. */
	generation?: string;
}

export interface DeliveryRecord {
	runId: string;
	at: string;
	state: DeliveryState;
	session?: string;
	detail?: string;
}

/** Terminal result of a run the runner process executed (shell, headless resume). */
export interface EndRecord {
	runId: string;
	at: string;
	ok: boolean;
	exitCode?: number;
	durationMs: number;
	detail?: string;
}

export type TimerDoneWhy = "once" | "max-runs" | "expired" | "gate-met" | "missed";

export interface TimerDone {
	at: string;
	why: TimerDoneWhy;
}

/** Untrusted text handed to a run: gate stdout or `fire --data`. */
export interface TimerFireData {
	source: "gate" | "fire";
	text: string;
}

/** Per-timer scheduling state; written only by the tick (and manual fire, under the tick lock). */
export interface TimerState {
	/** Schedule generation this state belongs to (`spec.armedAt`); a mismatch starts fresh counters. */
	armedAt?: string;
	/** Epoch ms of the newest scheduled instant already consumed (fired, queued, skipped, or missed). */
	lastSlot?: number;
	seq: number;
	runCount: number;
	/** Consecutive failed runs since the generation started or the last `resume`. */
	failStreak: number;
	/** `spec.resumedAt` the streak was last reset for. */
	streakResetAt?: string;
	/** The streak reached `pauseAfter`: the tick pauses the spec with this reason (kept until the spec write lands). */
	pendingPause?: string;
	gate?: { checks: number; lastCheckAt: string; lastExit?: number };
	done?: TimerDone;
	/** A run buffered by `overlap: queue`, dispatched once the in-flight run ends. */
	queued?: {
		seq: number;
		slot?: number;
		missedSlots: number;
		/** Untrusted `fire --data` of a queued manual fire. */
		data?: TimerFireData;
	};
}

/** What a timer fire hands its session (as `timer-fire` mail, validated when read back) or its runner. */
export const TimerFirePayloadSchema = type({
	timerId: "string",
	runId: "string",
	seq: "number.integer",
	"title?": "string",
	reason: "string",
	setAt: "string",
	/** Scheduled instant (ISO); absent for manual fires. */
	"scheduledAt?": "string",
	/** The timer's zone: the envelope renders its times there. */
	tz: "string",
	firedAt: "string",
	trigger: "'schedule' | 'gate' | 'manual'",
	prompt: "string",
	once: "boolean",
	"missedSlots?": "number.integer",
	"data?": { source: "'gate' | 'fire'", text: "string" },
	/** Next scheduled fire after this one, ISO, for recurring timers. */
	"next?": "string",
	/** Recurring timer whose next action waits on its condition. */
	"nextIsGate?": "boolean",
	/** ISO expiry, rendered so the model knows when a recurring timer stops on its own. */
	"expiresAt?": "string",
});
export type TimerFirePayload = typeof TimerFirePayloadSchema.infer;

/** Something a person should hear about: sent to the notify sinks once per incident. */
export interface TimerAlert {
	timerId: string;
	runId?: string;
	event: "failed" | "paused" | "missed" | "expired" | "held" | "reminder";
	/** One line: what happened. */
	summary: string;
	/** First error line, raw. */
	error?: string;
	/** Normalized error signature the incident is keyed by. */
	signature?: string;
	/** Occurrences of this incident so far. */
	count: number;
	logPath?: string;
}
