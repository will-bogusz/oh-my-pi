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
	/** A new session per run (an unattended agent run). */
	| { kind: "fresh" }
	/** One session the timer keeps and resumes on every run (an unattended agent run). */
	| { kind: "own" };

/** Agent-run targets: the runner starts and owns the session, so run settings apply. */
export type AgentRunTarget = Extract<TimerTarget, { kind: "fresh" | "own" }>["kind"];

/**
 * When an agent run's result goes back to the origin session (as mail) and the notify sinks:
 * every run, runs that said something (not `[quiet]`; failures always say something), failures
 * only, or never. Failure alerts from the failure policy are separate and always apply.
 */
export type TimerReport = "always" | "said" | "failure" | "never";

/** Settings of an unattended agent run (prompt timers whose session is `fresh` or `own`). */
export interface AgentRunSettings {
	/** Agent profile (as task subagents resolve it): model, thinking, appended system prompt, tools. */
	agent?: string;
	/** Thinking level; wins over the profile's. */
	thinking?: string;
	/** No rules, skills, extensions or title generation in the run's session. */
	hermetic?: boolean;
	/** Run in a fresh per-run directory (`<run dir>/work`) instead of the timer's cwd. */
	runCwd?: boolean;
	/** Wall-clock limit: past it the run is aborted and fails with `timeout`. */
	maxTimeMs?: number;
	/** USD limit on the run's model calls: past it the run is aborted and fails with `budget`. */
	maxCost?: number;
	/** Paths (relative to the run's cwd) that must exist after the run, else it fails with `expect`. */
	expect?: string[];
	/** Shell run before the agent in its cwd; a non-zero exit fails the run without starting the agent. */
	before?: string;
	/** Shell run after the agent with `OMP_TIMER_RESULT`; a non-zero exit fails the run. */
	after?: string;
}

/** Why an agent run failed; rendered as `failed: <failure>`. */
export type AgentRunFailure = "timeout" | "budget" | "approval" | "expect" | "before" | "after" | "model" | "error";

/** How an agent run's report left the runner. */
export type AgentRunReportState = "mailed-live" | "mailed-held" | "notified" | "skipped";

/** `result.json` in an agent run's directory: what the run did, read by `runs`, `logs`, `timer://` and the sheet. */
export interface AgentRunResult {
	v: 1;
	runId: string;
	timerId: string;
	seq: number;
	session: AgentRunTarget;
	ok: boolean;
	failure?: AgentRunFailure;
	/** One line: what failed, or a note on a successful run. */
	detail?: string;
	/** The final message was `[quiet]`: nothing worth reporting. */
	quiet: boolean;
	/** Stop reason of the last assistant message (`stop`, `aborted`, `error`, …). */
	stopReason?: string;
	model?: string;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	/** USD spent by the run's model calls. */
	cost: number;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	/** The agent's working directory. */
	cwd: string;
	/** The run's session file. */
	transcript?: string;
	/** The agent's final message (without the `[quiet]` marker). */
	finalText?: string;
	/** `expect` paths missing after the run. */
	expectMissing?: string[];
	/** Tools that needed an approval nobody could give, so they were denied. */
	approvalsDenied?: string[];
	report?: { mode: TimerReport; state: AgentRunReportState; session?: string; detail?: string };
}

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
	/** macOS one-shots: schedule a wake shortly before `at` with `sudo -n pmset`. */
	wakeMachine: boolean;
	model?: string;
	/** Agent-run settings; only for prompt timers whose session is `fresh` or `own`. */
	run: AgentRunSettings;
	/** Where an agent run's result goes (origin session mail, notify sinks). */
	report: TimerReport;
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
		data?: { source: "gate" | "fire"; text: string };
	};
}

/** One message in a session mailbox. */
export interface TimerMail {
	v: 1;
	/** Stable delivery id; the transcript entry carries it so a re-delivery after a crash is detected. */
	id: string;
	kind: "timer-fire" | "poke" | "timer-report";
	sessionId: string;
	createdAt: string;
	fire?: TimerFirePayload;
	poke?: { text: string; from: string; force?: boolean };
	/** An agent run's result, reported to the session that set the timer. */
	report?: TimerReportPayload;
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

/** The result of one agent run, as the origin session receives it. */
export interface TimerReportPayload {
	timerId: string;
	runId: string;
	seq: number;
	title?: string;
	reason: string;
	session: AgentRunTarget;
	ok: boolean;
	failure?: AgentRunFailure;
	detail?: string;
	quiet: boolean;
	/** Untrusted: the run's final message. */
	finalText?: string;
	cost: number;
	durationMs: number;
	endedAt: string;
	/** `result.json` of the run. */
	resultPath: string;
	transcript?: string;
}

/** Something a person should hear about: sent to the notify sinks once per incident. */
export interface TimerAlert {
	timerId: string;
	runId?: string;
	event: "failed" | "paused" | "missed" | "expired" | "held" | "reminder" | "report";
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
