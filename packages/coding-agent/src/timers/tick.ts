/**
 * `omp timer tick`: evaluate every timer once, settle finished runs, run due
 * gates and dispatch fires. Stateless and short: it holds the tick lock only
 * while deciding and dispatching, never across a model turn or a shell action
 * — those run in a detached `omp timer exec` runner that holds the timer's own
 * run lock.
 *
 * Meant to run once a minute from ONE OS unit per host (`omp timer install`).
 * The lock makes overlapping ticks harmless; each decision commits the slot
 * and its run row in one SQLite transaction before any side effect, so a slot
 * is decided at most once. Side effects that a crash cut off (committed but
 * never dispatched) are re-dispatched once by the next tick under the same
 * run id, which mailbox and transcript dedupe by.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireFileLock, type FileLockHandle, logger, tryAcquireFileLock, VERSION } from "@oh-my-pi/pi-utils";
import { resolveCliEntryCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { type GateVerdict, runGate } from "./gate";
import {
	type DeliveryTarget,
	deliveryTarget,
	describeDeliveryTarget,
	hasPendingMailForTimer,
	postMail,
} from "./mailbox";
import { loadTimerNotifyConfig, sendTimerAlerts } from "./notify";
import { firePayloadPath, runLockPath, runLogPath, tickLockPath, timersRoot, timerStateDir } from "./paths";
import { applyFailure, applyNotice, applySuccess, firstErrorLine } from "./policy";
import { type DueDecision, decideDue, MINUTE, nextFireAt } from "./schedule";
import { assertTimerMutationAllowed } from "./scope";
import { listTimerSpecs, mutateTimerSpec, openTimerDb, type RunView, readTimerSpec, type TimerDb } from "./store";
import type { RunTrigger, TimerAlert, TimerFirePayload, TimerSpec, TimerState } from "./types";

/** A runner-carried run with no recorded end this long after dispatch, and no run lock held, was lost. */
const LOST_AFTER_MS = 2 * MINUTE;
/** A committed run that never got its side effect is re-dispatched after this. */
const REDISPATCH_AFTER_MS = MINUTE;

export interface TickLine {
	id: string;
	action: string;
	runId?: string;
	detail?: string;
}

export interface TickReport {
	at: string;
	locked: boolean;
	lines: TickLine[];
	alerts: TimerAlert[];
}

/** Everything a tick does outside the store; tests replace these to run the engine on a fake clock. */
export interface TickDeps {
	root: string;
	/** Start the detached runner for one run. */
	spawnRunner(spec: TimerSpec, seq: number, root: string): void;
	runGate(command: string, cwd: string): Promise<GateVerdict>;
	deliveryTarget(sessionId: string): DeliveryTarget;
	/** Whether the previous run of `spec` is still in flight. */
	inFlight(spec: TimerSpec, root: string): boolean;
	notify(alerts: TimerAlert[]): Promise<void>;
}

/** Spawn the detached runner for one run; its stdout/stderr go to the run log. */
function spawnRunnerProcess(spec: TimerSpec, seq: number, root: string): void {
	const log = runLogPath(spec.id, seq, root);
	fs.mkdirSync(path.dirname(log), { recursive: true });
	const fd = fs.openSync(log, "a");
	try {
		const child = Bun.spawn([...resolveCliEntryCmd(), "timer", "exec", spec.id, String(seq)], {
			cwd: spec.cwd,
			env: workerEnvFromParent({ OMP_TIMERS_DIR: root }),
			stdin: "ignore",
			stdout: fd,
			stderr: fd,
			detached: true,
		});
		child.unref();
	} finally {
		fs.closeSync(fd);
	}
}

/** The run lock is held by a live runner, or the session has not taken the previous fire's mail yet. */
function runInFlight(spec: TimerSpec, root: string): boolean {
	fs.mkdirSync(timerStateDir(spec.id, root), { recursive: true });
	const lock = tryAcquireFileLock(runLockPath(spec.id, root));
	if (!lock) return true;
	lock.release();
	return spec.action.kind === "prompt" && spec.target.kind === "session"
		? hasPendingMailForTimer(spec.target.sessionId, spec.id)
		: false;
}

export function defaultTickDeps(overrides: Partial<TickDeps> = {}): TickDeps {
	return {
		root: timersRoot(),
		spawnRunner: spawnRunnerProcess,
		runGate: (command, cwd) => runGate(command, cwd),
		deliveryTarget,
		inFlight: runInFlight,
		notify: async alerts => {
			if (alerts.length) await sendTimerAlerts(alerts, await loadTimerNotifyConfig());
		},
		...overrides,
	};
}

/** Scheduling state for the spec's current generation: a re-armed timer starts fresh counters (seq continues). */
export function currentState(spec: TimerSpec, state: TimerState): TimerState {
	if (state.armedAt === spec.armedAt) return state;
	return { seq: state.seq, runCount: 0, failStreak: 0, armedAt: spec.armedAt, streakResetAt: spec.resumedAt };
}

/** Thrown inside a write transaction when another writer moved the timer's state since it was read. */
class StaleStateError extends Error {}

interface TickContext {
	db: TimerDb;
	deps: TickDeps;
	now: number;
	at: string;
	alerts: TimerAlert[];
}

interface FireInput {
	seq: number;
	slot?: number;
	missedSlots: number;
	trigger: RunTrigger;
	data?: { source: "gate" | "fire"; text: string };
	/** Promote this already-recorded `queued` run instead of inserting a new one. */
	fromQueue?: boolean;
}

/** Commit the state change and run row together; a concurrent writer that got there first aborts this one. */
function commit(ctx: TickContext, spec: TimerSpec, readSeq: number, state: TimerState, apply: () => void): void {
	ctx.db.write(() => {
		if (ctx.db.readState(spec.id).seq !== readSeq) throw new StaleStateError(spec.id);
		apply();
		ctx.db.writeState(spec.id, state);
	});
}

/** A buffered run whose timer expired or ran out of runs while it waited never starts; it is recorded missed. */
function dropStaleQueue(ctx: TickContext, spec: TimerSpec, state: TimerState, decision: DueDecision): void {
	if (!state.queued || decision.kind !== "retire" || decision.why === "once") return;
	ctx.db.markSettled(
		`${spec.id}#${state.queued.seq}`,
		ctx.at,
		"missed",
		`dropped: ${decision.why} before the previous run ended`,
	);
	state.queued = undefined;
}

function recordNonFire(
	ctx: TickContext,
	spec: TimerSpec,
	readSeq: number,
	state: TimerState,
	input: {
		slot?: number;
		missedSlots?: number;
		trigger: RunTrigger;
		outcome: "missed" | "skipped-overlap" | "queued" | "gated-not-yet" | "failed";
		gateExit?: number;
		detail?: string;
		/** Runs inside the same transaction, after the row is written (a gate failure's own accounting). */
		settle?: (runId: string) => void;
	},
): string {
	state.seq++;
	const runId = `${spec.id}#${state.seq}`;
	const seq = state.seq;
	commit(ctx, spec, readSeq, state, () => {
		ctx.db.insertRun(
			spec.id,
			{
				runId,
				seq,
				at: ctx.at,
				slot: input.slot !== undefined ? new Date(input.slot).toISOString() : undefined,
				trigger: input.trigger,
				outcome: input.outcome,
				missedSlots: input.missedSlots || undefined,
				gateExit: input.gateExit,
				detail: input.detail,
				rev: spec.rev,
				generation: spec.armedAt,
			},
			false,
		);
		input.settle?.(runId);
	});
	return runId;
}

/**
 * Commit one fire (slot + run row first), then hand it to its delivery path:
 * the session's mailbox (live session, or held), or the detached runner
 * (shell, fresh agent, headless resume of a closed session).
 */
async function fire(
	ctx: TickContext,
	spec: TimerSpec,
	readSeq: number,
	state: TimerState,
	input: FireInput,
): Promise<TickLine> {
	const { db, deps, now, at } = ctx;
	const runId = `${spec.id}#${input.seq}`;
	const sessionId =
		spec.action.kind === "prompt" && spec.target.kind === "session" ? spec.target.sessionId : undefined;
	const target = sessionId !== undefined ? deps.deliveryTarget(sessionId) : undefined;
	const viaRunner = !target || (target.kind === "free" && spec.whenClosed === "resume");

	if (!input.fromQueue) state.seq = input.seq;
	if (input.slot !== undefined) state.lastSlot = Math.max(state.lastSlot ?? input.slot, input.slot);
	if (input.fromQueue) state.queued = undefined;
	state.runCount++;
	const recurring = spec.every !== undefined && !spec.until;
	if (input.trigger === "gate") state.done = { at, why: "gate-met" };
	else if (input.trigger === "schedule" && !recurring) state.done = { at, why: "once" };
	else if (spec.maxRuns !== undefined && state.runCount >= spec.maxRuns) state.done = { at, why: "max-runs" };
	const next = state.done ? undefined : nextFireAt(spec, state, now);
	const slotIso = input.slot !== undefined ? new Date(input.slot).toISOString() : undefined;
	const payload: TimerFirePayload = {
		timerId: spec.id,
		runId,
		seq: input.seq,
		title: spec.title,
		reason: spec.reason,
		setAt: spec.created.at,
		scheduledAt: input.trigger === "manual" ? undefined : slotIso,
		firedAt: at,
		trigger: input.trigger,
		prompt: spec.action.kind === "prompt" ? spec.action.prompt : spec.action.command,
		once: state.done !== undefined,
		missedSlots: input.missedSlots || undefined,
		data: input.data,
		next: typeof next === "number" ? new Date(next).toISOString() : undefined,
		nextIsGate: next === "gate" || undefined,
		expiresAt: spec.expiresAt,
	};
	// The payload exists before the commit, so a re-dispatch after a crash finds it.
	await Bun.write(firePayloadPath(spec.id, input.seq, deps.root), JSON.stringify(payload));
	commit(ctx, spec, readSeq, state, () => {
		if (input.fromQueue) db.promoteQueuedRun(runId, at, viaRunner);
		else
			db.insertRun(
				spec.id,
				{
					runId,
					seq: input.seq,
					at,
					slot: slotIso,
					trigger: input.trigger,
					outcome: "fired",
					missedSlots: input.missedSlots || undefined,
					rev: spec.rev,
					generation: spec.armedAt,
				},
				viaRunner,
			);
	});
	const detail = await sideEffects(ctx, spec, payload, target, viaRunner);
	db.markDispatched(runId, at);
	return { id: spec.id, action: "fired", runId, detail };
}

async function sideEffects(
	ctx: TickContext,
	spec: TimerSpec,
	payload: TimerFirePayload,
	target: DeliveryTarget | undefined,
	viaRunner: boolean,
): Promise<string> {
	const { db, deps, at } = ctx;
	const runId = payload.runId;
	if (!target || spec.target.kind !== "session") {
		deps.spawnRunner(spec, payload.seq, deps.root);
		return `runner (${spec.action.kind}, ${spec.target.kind})`;
	}
	const sessionId = spec.target.sessionId;
	await postMail({ v: 1, id: runId, kind: "timer-fire", sessionId, createdAt: at, fire: payload });
	if (target.kind === "live") {
		db.recordDelivery(spec.id, { runId, at, state: "queued", session: sessionId });
		return `mailed to live session ${sessionId}`;
	}
	if (viaRunner) {
		deps.spawnRunner(spec, payload.seq, deps.root);
		return `resuming session ${sessionId} headless`;
	}
	const why =
		target.kind === "held"
			? `session ${sessionId}: ${describeDeliveryTarget(target)}`
			: `session ${sessionId} is not open; held until it opens`;
	db.recordDelivery(spec.id, { runId, at, state: "held", session: sessionId, detail: why });
	ctx.alerts.push(...applyNotice(db, spec, "held", why, { runId, at, now: ctx.now }));
	return why;
}

/** Re-run the side effect of a committed fire that never got one (crash between commit and dispatch). */
async function redispatch(ctx: TickContext, spec: TimerSpec, run: RunView): Promise<TickLine | undefined> {
	let payload: TimerFirePayload;
	try {
		payload = (await Bun.file(firePayloadPath(spec.id, run.seq, ctx.deps.root)).json()) as TimerFirePayload;
	} catch (err) {
		logger.warn("timer redispatch: payload missing", { runId: run.runId, error: String(err) });
		ctx.db.markSettled(run.runId, ctx.at, "failed", "lost before dispatch: fire payload missing");
		return { id: spec.id, action: "lost", runId: run.runId };
	}
	const target = spec.target.kind === "session" ? ctx.deps.deliveryTarget(spec.target.sessionId) : undefined;
	const detail = await sideEffects(ctx, spec, payload, target, run.runner);
	ctx.db.markDispatched(run.runId, ctx.at);
	return { id: spec.id, action: "redispatched", runId: run.runId, detail };
}

/**
 * Apply finished runs to the failure policy, oldest first. Each run's
 * settlement (incident, streak, pause intent, `settled_at`) commits in one
 * transaction, so a crash never leaves a run settled without its accounting.
 * Runs of an earlier schedule generation, or that ran before the last
 * `resume`, are settled for the record but never count toward the streak.
 */
async function settleRuns(ctx: TickContext, spec: TimerSpec, state: TimerState, lines: TickLine[]): Promise<void> {
	const { db, deps, now, at } = ctx;
	for (const run of db.unsettledRuns(spec.id)) {
		let error: string | undefined;
		let lost = false;
		if (run.end?.at !== undefined) {
			if (run.end.ok !== true) {
				error = run.end.detail ?? (run.end.exitCode !== undefined ? `exit ${run.end.exitCode}` : "failed");
			}
		} else if (
			!run.runner &&
			(run.delivery?.state === "delivered-live" || run.delivery?.state === "resumed-headless")
		) {
			// A live session took the mail: the turn is the session's own, so the fire succeeded.
		} else if (!run.dispatchedAt && !run.end) {
			// Committed but its side effect never happened (the tick died in between). A runner that
			// did start has claimed the run, so this re-dispatch can never execute it twice.
			if (now - Date.parse(run.at) >= REDISPATCH_AFTER_MS) {
				const line = await redispatch(ctx, spec, run);
				if (line) lines.push(line);
			}
			continue;
		} else if (
			run.runner &&
			now - Date.parse(run.dispatchedAt ?? run.at) >= LOST_AFTER_MS &&
			!deps.inFlight(spec, deps.root)
		) {
			lost = true;
			error = run.end?.startedAt
				? "lost: the runner exited without recording a result"
				: "lost: the runner never started";
		} else {
			continue; // still in flight
		}
		const counts = run.generation === spec.armedAt && (!spec.resumedAt || run.at >= spec.resumedAt);
		let alerts: TimerAlert[] = [];
		db.write(() => {
			if (counts && error === undefined) applySuccess(db, spec, state, at);
			if (counts && error !== undefined) {
				alerts = applyFailure(db, spec, state, {
					runId: run.runId,
					error,
					at,
					now,
					final: !spec.every && !spec.until,
					logPath: runLogPath(spec.id, run.seq, deps.root),
				}).alerts;
			}
			db.markSettled(run.runId, at, lost ? "failed" : undefined, lost ? error : undefined);
			db.writeState(spec.id, state);
		});
		// Alerts leave only after their transaction committed.
		ctx.alerts.push(...alerts);
		if (lost) lines.push({ id: spec.id, action: "lost", runId: run.runId, detail: error });
	}
}

/** Land a pause the failure policy decided; idempotent, so a crash between the two writes just retries. */
async function applyPendingPause(
	ctx: TickContext,
	spec: TimerSpec,
	state: TimerState,
	readSeq: number,
): Promise<TickLine | undefined> {
	const reason = state.pendingPause;
	if (!reason) return undefined;
	if (!spec.paused) {
		await mutateTimerSpec(
			spec.id,
			current => (current && !current.paused ? { ...current, paused: true, pausedReason: reason } : current),
			{ root: ctx.deps.root },
		);
	}
	state.pendingPause = undefined;
	commit(ctx, spec, readSeq, state, () => {});
	return spec.paused ? undefined : { id: spec.id, action: "paused", detail: reason };
}

async function tickOne(ctx: TickContext, spec: TimerSpec): Promise<TickLine[]> {
	const { db, deps, now, at } = ctx;
	const lines: TickLine[] = [];
	const stored = db.readState(spec.id);
	const readSeq = stored.seq;
	const state = currentState(spec, stored);
	if (spec.resumedAt && spec.resumedAt !== state.streakResetAt) {
		state.failStreak = 0;
		state.pendingPause = undefined;
		state.streakResetAt = spec.resumedAt;
		db.resolveIncidents(spec.id, at);
	}

	await settleRuns(ctx, spec, state, lines);
	const paused = await applyPendingPause(ctx, spec, state, readSeq);
	if (paused) {
		lines.push(paused);
		return lines;
	}
	// A done timer can still owe a buffered run (a manual fire queued behind its last run).
	if (spec.paused || (state.done && !state.queued)) {
		if (JSON.stringify(state) !== JSON.stringify(stored)) commit(ctx, spec, readSeq, state, () => {});
		return lines;
	}

	const decision = decideDue(spec, state, now);
	dropStaleQueue(ctx, spec, state, decision);
	if (state.queued) {
		const queued = state.queued;
		if (!deps.inFlight(spec, deps.root)) {
			lines.push(
				await fire(ctx, spec, readSeq, state, {
					seq: queued.seq,
					slot: queued.slot,
					missedSlots: queued.missedSlots,
					// A queued manual fire has no slot; it stays manual so it never consumes the schedule.
					trigger: queued.slot === undefined ? "manual" : "schedule",
					data: queued.data,
					fromQueue: true,
				}),
			);
			return lines;
		}
		if (decision.kind === "retire" || state.done) {
			// Wait for the buffered run; never retire past it.
			if (JSON.stringify(state) !== JSON.stringify(stored)) commit(ctx, spec, readSeq, state, () => {});
			return lines;
		}
	}
	if (state.done) {
		commit(ctx, spec, readSeq, state, () => {});
		return lines;
	}

	switch (decision.kind) {
		case "idle":
			if (JSON.stringify(state) !== JSON.stringify(stored)) commit(ctx, spec, readSeq, state, () => {});
			return lines;
		case "retire": {
			state.done = { at, why: decision.why };
			commit(ctx, spec, readSeq, state, () => {});
			if (decision.why === "expired" && spec.until && state.runCount === 0) {
				ctx.alerts.push(
					...applyNotice(
						db,
						spec,
						"expired",
						`expired without its condition holding: ${spec.condition ?? spec.until}`,
						{
							at,
							now,
						},
					),
				);
			}
			lines.push({ id: spec.id, action: "retired", detail: decision.why });
			return lines;
		}
		case "missed": {
			state.lastSlot = decision.slot;
			if (!spec.every) state.done = { at, why: "missed" };
			const late = now - decision.slot;
			const detail = `${Math.round(late / MINUTE)}m late, past its grace; not run`;
			const runId = recordNonFire(ctx, spec, readSeq, state, {
				slot: decision.slot,
				missedSlots: decision.missedSlots,
				trigger: "schedule",
				outcome: "missed",
				detail,
			});
			ctx.alerts.push(
				...applyNotice(db, spec, "missed", `missed the ${new Date(decision.slot).toISOString()} run (${detail})`, {
					runId,
					at,
					now,
				}),
			);
			lines.push({ id: spec.id, action: "missed", runId, detail });
			return lines;
		}
		case "due":
			break;
	}

	if (!spec.until) {
		if (deps.inFlight(spec, deps.root)) {
			const queue = spec.overlap === "queue" && !state.queued;
			state.lastSlot = decision.slot;
			if (queue) state.queued = { seq: state.seq + 1, slot: decision.slot, missedSlots: decision.missedSlots };
			const runId = recordNonFire(ctx, spec, readSeq, state, {
				slot: decision.slot,
				missedSlots: decision.missedSlots,
				trigger: "schedule",
				outcome: queue ? "queued" : "skipped-overlap",
				detail: queue ? "previous run still in flight; runs when it ends" : "previous run still in flight",
			});
			lines.push({ id: spec.id, action: queue ? "queued" : "skipped-overlap", runId });
			return lines;
		}
		lines.push(
			await fire(ctx, spec, readSeq, state, {
				seq: state.seq + 1,
				slot: decision.slot,
				missedSlots: decision.missedSlots,
				trigger: "schedule",
			}),
		);
		return lines;
	}

	// Condition timer: the gate runs outside any transaction (it may take up to its timeout).
	const verdict = await deps.runGate(spec.until, spec.cwd);
	state.gate = {
		checks: (state.gate?.checks ?? 0) + 1,
		lastCheckAt: at,
		lastExit: verdict.kind === "met" ? 0 : verdict.kind === "not-yet" ? 1 : verdict.exitCode,
	};
	if (verdict.kind === "met") {
		lines.push(
			await fire(ctx, spec, readSeq, state, {
				seq: state.seq + 1,
				slot: decision.slot,
				missedSlots: 0,
				trigger: "gate",
				data: verdict.output ? { source: "gate", text: verdict.output } : undefined,
			}),
		);
		return lines;
	}
	state.lastSlot = decision.slot;
	if (verdict.kind === "not-yet") {
		// A healthy check ends a failure streak. Quiet: one run row per streak of "not yet"; the count lives in state.
		state.failStreak = 0;
		const latest = db.listRuns(spec.id, 1)[0];
		if (latest?.outcome === "gated-not-yet" && latest.rev === spec.rev) commit(ctx, spec, readSeq, state, () => {});
		else
			recordNonFire(ctx, spec, readSeq, state, {
				slot: decision.slot,
				trigger: "gate",
				outcome: "gated-not-yet",
				gateExit: 1,
			});
		lines.push({ id: spec.id, action: "gated-not-yet", detail: `check #${state.gate.checks}` });
		return lines;
	}
	const error = verdict.timedOut
		? "gate timed out"
		: `gate exit ${verdict.exitCode ?? "?"}${verdict.output ? `: ${firstErrorLine(verdict.output)}` : ""}`;
	let gateAlerts: TimerAlert[] = [];
	const runId = recordNonFire(ctx, spec, readSeq, state, {
		slot: decision.slot,
		trigger: "gate",
		outcome: "failed",
		gateExit: verdict.exitCode,
		detail: error,
		// The failure is its own result: account for it in the same transaction as the run row.
		settle: id => {
			gateAlerts = applyFailure(db, spec, state, { runId: id, error, at, now, final: false }).alerts;
			db.markSettled(id, at);
		},
	});
	// Alerts leave only after their transaction committed.
	ctx.alerts.push(...gateAlerts);
	lines.push({ id: spec.id, action: "failed", runId, detail: error });
	const gatePause = await applyPendingPause(ctx, spec, state, state.seq);
	if (gatePause) lines.push(gatePause);
	return lines;
}

function takeTickLock(root: string): FileLockHandle | null {
	fs.mkdirSync(root, { recursive: true });
	return tryAcquireFileLock(tickLockPath(root));
}

export async function runTick(now = Date.now(), overrides: Partial<TickDeps> = {}): Promise<TickReport> {
	const deps = defaultTickDeps(overrides);
	const at = new Date(now).toISOString();
	const lock = takeTickLock(deps.root);
	if (!lock) return { at, locked: true, lines: [], alerts: [] };
	const ctx: TickContext = { db: openTimerDb(deps.root), deps, now, at, alerts: [] };
	const lines: TickLine[] = [];
	try {
		const { specs, errors } = await listTimerSpecs(deps.root);
		for (const { id, error } of errors) lines.push({ id, action: "invalid-spec", detail: error });
		for (const spec of specs) {
			try {
				lines.push(...(await tickOne(ctx, spec)));
			} catch (err) {
				if (err instanceof StaleStateError) {
					lines.push({ id: spec.id, action: "raced", detail: "another writer decided this timer first" });
					continue;
				}
				logger.error("timer tick failed", { id: spec.id, error: String(err) });
				lines.push({ id: spec.id, action: "error", detail: err instanceof Error ? err.message : String(err) });
			}
		}
		ctx.db.writeHeartbeat({ lastTickAt: at, pid: process.pid, version: VERSION });
	} finally {
		lock.release();
	}
	// Alerts go out after the lock is released: a slow sink never delays the next tick.
	await deps.notify(ctx.alerts);
	return { at, locked: false, lines, alerts: ctx.alerts };
}

export interface FireNowOptions {
	/** Untrusted text handed to the run, fenced as `<timer-data source="fire">`. */
	data?: string;
	deps?: Partial<TickDeps>;
}

/** Run a timer now, outside its schedule. Waits (bounded) for a running tick to finish. */
export async function fireTimerNow(id: string, now = Date.now(), options: FireNowOptions = {}): Promise<TickLine> {
	const deps = defaultTickDeps(options.deps);
	await assertTimerMutationAllowed(id, "fire", deps.root);
	fs.mkdirSync(deps.root, { recursive: true });
	const lock = await acquireFileLock(tickLockPath(deps.root), { retries: 600, retryDelayMs: 100 });
	const ctx: TickContext = { db: openTimerDb(deps.root), deps, now, at: new Date(now).toISOString(), alerts: [] };
	try {
		const spec = await readTimerSpec(id, deps.root);
		if (!spec) throw new Error(`No timer "${id}"`);
		const stored = ctx.db.readState(id);
		const state = currentState(spec, stored);
		const data = options.data ? { source: "fire" as const, text: options.data } : undefined;
		let busy = deps.inFlight(spec, deps.root);
		const dispatched: TickLine[] = [];
		dropStaleQueue(ctx, spec, state, decideDue(spec, state, now));
		if (state.queued && !busy) {
			// A buffered run was accepted first: start it now, and treat this fire as overlapping it.
			const queued = state.queued;
			dispatched.push(
				await fire(ctx, spec, stored.seq, state, {
					seq: queued.seq,
					slot: queued.slot,
					missedSlots: queued.missedSlots,
					trigger: queued.slot === undefined ? "manual" : "schedule",
					data: queued.data,
					fromQueue: true,
				}),
			);
			busy = true;
		}
		if (busy) {
			const queue = spec.overlap === "queue" && !state.queued;
			if (queue) state.queued = { seq: state.seq + 1, missedSlots: 0, data };
			const detail = dispatched.length
				? `queued run ${dispatched[0].runId} started first`
				: "previous run still in flight";
			const runId = recordNonFire(ctx, spec, stored.seq, state, {
				trigger: "manual",
				outcome: queue ? "queued" : "skipped-overlap",
				detail,
			});
			return { id, action: queue ? "queued" : "skipped-overlap", runId, detail };
		}
		// A manual fire never consumes the schedule (only maxRuns counts it).
		return await fire(ctx, spec, stored.seq, state, { seq: state.seq + 1, missedSlots: 0, trigger: "manual", data });
	} finally {
		lock.release();
		await deps.notify(ctx.alerts);
	}
}
