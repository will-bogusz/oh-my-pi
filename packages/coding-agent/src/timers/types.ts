/**
 * Timers: standing work that fires later — at a time, on a schedule, or once a
 * shell condition holds — and then wakes a session, runs a fresh agent, or runs
 * a shell command.
 *
 * Desired configuration is one Markdown spec per timer (`<root>/specs/<id>.md`,
 * YAML frontmatter + prompt body), written atomically with a `rev` check.
 * Execution state (slots, runs, run ends, deliveries, incidents, ticker
 * heartbeat) lives in SQLite `<root>/timers.db`; see `store.ts` for which
 * process kind writes which table.
 */

/** Where a prompt timer runs when it fires. */
export type TimerTarget =
	/** Wake (or headlessly resume) an existing session with its context. */
	| { kind: "session"; sessionId: string; sessionFile?: string }
	/** A new session per run. */
	| { kind: "fresh" };

export type TimerAction = { kind: "prompt"; prompt: string } | { kind: "shell"; command: string };

/** What the target gets when it is not open in any live omp process. */
export type TimerWhenClosed = "resume" | "hold";

/** A fire while the previous run is still in flight: drop it, or buffer exactly one. */
export type TimerOverlap = "skip" | "queue";

export interface TimerProvenance {
	/** ISO time the timer was first set. */
	at: string;
	by: "tool" | "cli";
	host: string;
	cwd: string;
	session?: string;
	sessionFile?: string;
	/** The `at`/`every`/`when` text as typed, before resolution. */
	whenText: string;
	/** `<timer>#<seq>` when a fired run created this timer. */
	run?: string;
}

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
	/** How late a slot may still run, ms; later ⇒ `missed`. Default: one-shot 12h, recurring min(period, 6h). */
	graceMs?: number;
	/** Consecutive failures that pause the timer. */
	pauseAfter: number;
	/** Let runs this timer fires create or change other timers (recursion guard). */
	allowTimers: boolean;
	/** macOS one-shots: schedule a wake shortly before `at` with `sudo -n pmset`. */
	wakeMachine: boolean;
	model?: string;
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
}

export interface DeliveryRecord {
	runId: string;
	at: string;
	state: DeliveryState;
	session?: string;
	detail?: string;
}

/** Terminal result of a run the runner process executed (shell, headless resume, fresh agent). */
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
	gate?: { checks: number; lastCheckAt: string; lastExit?: number };
	done?: TimerDone;
	/** A run buffered by `overlap: queue`, dispatched once the in-flight run ends. */
	queued?: { seq: number; slot?: number; missedSlots: number };
}

/** One message in a session mailbox. */
export interface TimerMail {
	v: 1;
	/** Stable delivery id; the transcript entry carries it so a re-delivery after a crash is detected. */
	id: string;
	kind: "timer-fire" | "poke";
	sessionId: string;
	createdAt: string;
	fire?: TimerFirePayload;
	poke?: { text: string; from: string; force?: boolean };
	attempts?: number;
}

export interface TimerFirePayload {
	timerId: string;
	runId: string;
	seq: number;
	title?: string;
	reason: string;
	setAt: string;
	/** Scheduled instant (ISO); absent for manual fires. */
	scheduledAt?: string;
	firedAt: string;
	trigger: RunTrigger;
	prompt: string;
	once: boolean;
	missedSlots?: number;
	/** Untrusted payload: gate stdout or `fire --data`. */
	data?: { source: "gate" | "fire"; text: string };
	/** Next scheduled fire after this one, ISO, for recurring timers. */
	next?: string;
	/** Recurring timer whose next action waits on its condition. */
	nextIsGate?: boolean;
	/** ISO expiry, rendered so the model knows when a recurring timer stops on its own. */
	expiresAt?: string;
}

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
