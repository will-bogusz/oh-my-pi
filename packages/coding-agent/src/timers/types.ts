/**
 * Timers: standing work that fires later — at a time, on a schedule, or once a
 * shell condition holds — and then wakes a session, runs a fresh agent, or runs
 * a shell command.
 *
 * Source of truth is one spec file per timer (`<root>/specs/<id>.md`, YAML
 * frontmatter + prompt body). Run history is an append-only ledger
 * (`<root>/state/<id>/runs.jsonl`); the slot ledger and counters live in
 * `<root>/state/<id>/state.json`, written only under the tick lock.
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

export interface TimerProvenance {
	/** ISO time the timer was set. */
	at: string;
	by: "tool" | "cli";
	host: string;
	cwd: string;
	session?: string;
	sessionFile?: string;
	/** The `at`/`every` text as typed, before resolution. */
	whenText: string;
}

export interface TimerSpec {
	id: string;
	title?: string;
	reason: string;
	/** One-shot instant (ISO, resolved at set time). */
	at?: string;
	/** Recurring cadence, normalized: `5m`, `daily 09:00`, `cron <5 fields>`. */
	every?: string;
	/** Condition gate: exit 0 fire (once), 1 not yet, anything else a failure. */
	until?: string;
	/** Readable form of the condition `until` was compiled from (`CI on o/r#12 finished`). */
	condition?: string;
	/** IANA zone for clock times. */
	tz: string;
	target: TimerTarget;
	whenClosed: TimerWhenClosed;
	action: TimerAction;
	cwd: string;
	/** ISO instant after which the timer retires. */
	expiresAt?: string;
	maxRuns?: number;
	/** Only `skip` is implemented: a fire while the previous run is in flight is recorded and dropped. */
	overlap: "skip";
	model?: string;
	paused: boolean;
	created: TimerProvenance;
}

/** Outcome of one scheduled instant (or manual fire), recorded when the tick decides it. */
export type RunOutcome = "fired" | "gated-not-yet" | "skipped-overlap" | "missed" | "failed";

/** How a fired session-targeted run reached its session; separate from {@link RunOutcome}. */
export type DeliveryState = "queued" | "delivered-live" | "resumed-headless" | "held";

export type RunTrigger = "schedule" | "gate" | "manual";

export interface RunRecord {
	type: "run";
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
}

export interface DeliveryRecord {
	type: "delivery";
	runId: string;
	at: string;
	state: DeliveryState;
	session?: string;
	detail?: string;
}

/** Terminal result of a run the runner process executed (shell, headless resume, fresh agent). */
export interface EndRecord {
	type: "end";
	runId: string;
	at: string;
	ok: boolean;
	exitCode?: number;
	durationMs: number;
	detail?: string;
}

export type LedgerRecord = RunRecord | DeliveryRecord | EndRecord;

export interface TimerDone {
	at: string;
	why: "once" | "max-runs" | "expired" | "gate-met" | "failures";
}

/** Per-timer mutable state; single writer (the tick, under the tick lock). */
export interface TimerState {
	/** Epoch ms of the newest scheduled instant already consumed (fired, skipped, or missed). */
	lastSlot?: number;
	seq: number;
	runCount: number;
	failStreak: number;
	last?: { runId: string; outcome: RunOutcome; at: string };
	gate?: { checks: number; lastCheckAt: string; lastExit?: number };
	done?: TimerDone;
	/** `created.at` of the spec this state belongs to; a re-set spec starts from fresh counters. */
	armedAt?: string;
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
	/** `force`: deliver even while an Esc holds the session (`omp poke --force`). */
	poke?: { text: string; from: string; force?: boolean };
	/** Injection attempts so far, summed over every consumer that claimed it. */
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
	/** Untrusted payload (gate stdout). */
	data?: { source: "gate"; text: string };
	/** Next scheduled fire after this one, ISO, for recurring timers. */
	next?: string;
}
