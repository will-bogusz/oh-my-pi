/**
 * `omp timer tick`: evaluate every timer once, run due gates, and dispatch
 * fires. Stateless and short: it holds the tick lock only while deciding and
 * dispatching, never across a model turn or a shell action — those run in a
 * detached `omp timer exec` runner that holds the timer's own run lock.
 *
 * Meant to be run once a minute by ONE OS unit per host (launchd
 * StartCalendarInterval / systemd OnCalendar=minutely). The lock makes
 * overlapping ticks harmless; the slot ledger (`state.lastSlot`, written before
 * dispatch) guarantees at most one run per scheduled instant.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type FileLockHandle, acquireFileLock, logger, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { resolveCliCommand, workerEnvFromParent } from "../subprocess/worker-client";
import { runGate } from "./gate";
import { hasLiveMailboxConsumer, hasPendingMailForTimer, postMail } from "./mailbox";
import { runLockPath, tickLockPath, timerStateDir, timersRoot } from "./paths";
import { decideDue, nextFireAt } from "./schedule";
import { currentState, firePayloadPath, runLogPath, tickerStatusPath } from "./service";
import { appendLedger, listTimerSpecs, readTimerSpec, readTimerState, writeTimerState } from "./store";
import type { RunOutcome, RunTrigger, TimerFirePayload, TimerSpec, TimerState } from "./types";

/** Consecutive failures that pause a timer. */
const PAUSE_AFTER_FAILURES = 3;

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
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.find(line => line.trim())
			?.trim()
			.slice(0, 200) ?? ""
	);
}

function record(state: TimerState, runId: string, outcome: RunOutcome, now: number): void {
	state.last = { runId, outcome, at: new Date(now).toISOString() };
}

interface DispatchInput {
	slot?: number;
	missedSlots: number;
	trigger: RunTrigger;
	gateOutput?: string;
}

/** Spawn the detached runner for one run; its stdout/stderr go to the run log. */
function spawnRunner(spec: TimerSpec, seq: number): void {
	const log = runLogPath(spec.id, seq);
	fs.mkdirSync(path.dirname(log), { recursive: true });
	const fd = fs.openSync(log, "a");
	try {
		const child = Bun.spawn([...resolveCliCommand(), "timer", "exec", spec.id, String(seq)], {
			cwd: spec.cwd,
			env: workerEnvFromParent(),
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

/**
 * Commit one run (advance the ledger before dispatch), then hand it to its
 * delivery path. Returns the tick line describing what happened.
 */
async function dispatch(spec: TimerSpec, state: TimerState, input: DispatchInput, now: number): Promise<TickLine> {
	const seq = state.seq + 1;
	const runId = `${spec.id}#${seq}`;
	const sessionTarget = spec.action.kind === "prompt" && spec.target.kind === "session" ? spec.target : undefined;
	const at = new Date(now).toISOString();
	const slot = input.slot !== undefined ? new Date(input.slot).toISOString() : undefined;
	state.seq = seq;
	if (input.slot !== undefined) state.lastSlot = input.slot;

	// Overlap: the previous run still holds its run lock, or its mail is still unclaimed.
	fs.mkdirSync(timerStateDir(spec.id), { recursive: true });
	const runLock = tryAcquireFileLock(runLockPath(spec.id));
	const overlapping =
		!runLock || (sessionTarget !== undefined && (await hasPendingMailForTimer(sessionTarget.sessionId, spec.id)));
	runLock?.release();
	if (overlapping) {
		record(state, runId, "skipped-overlap", now);
		await writeTimerState(spec.id, state);
		await appendLedger(spec.id, {
			type: "run",
			runId,
			seq,
			at,
			slot,
			trigger: input.trigger,
			outcome: "skipped-overlap",
		});
		return { id: spec.id, action: "skipped-overlap", runId };
	}

	state.runCount++;
	state.failStreak = 0;
	record(state, runId, "fired", now);
	const recurring = spec.every !== undefined && !spec.until;
	if (input.trigger === "gate") state.done = { at, why: "gate-met" };
	else if (input.trigger === "schedule" && !recurring) state.done = { at, why: "once" };
	else if (spec.maxRuns !== undefined && state.runCount >= spec.maxRuns) state.done = { at, why: "max-runs" };
	const next = state.done ? undefined : nextFireAt(spec, state, now);
	const payload: TimerFirePayload = {
		timerId: spec.id,
		runId,
		seq,
		title: spec.title,
		reason: spec.reason,
		setAt: spec.created.at,
		scheduledAt: input.trigger === "schedule" ? slot : undefined,
		firedAt: at,
		trigger: input.trigger,
		prompt: spec.action.kind === "prompt" ? spec.action.prompt : spec.action.command,
		once: state.done !== undefined,
		missedSlots: input.missedSlots || undefined,
		data: input.gateOutput ? { source: "gate", text: input.gateOutput } : undefined,
		next: typeof next === "number" ? new Date(next).toISOString() : undefined,
	};
	// Advance before dispatch: a crash after this point never re-fires the slot.
	await writeTimerState(spec.id, state);
	await appendLedger(spec.id, {
		type: "run",
		runId,
		seq,
		at,
		slot,
		trigger: input.trigger,
		outcome: "fired",
		missedSlots: input.missedSlots || undefined,
	});

	if (!sessionTarget) {
		await Bun.write(firePayloadPath(spec.id, seq), JSON.stringify(payload));
		spawnRunner(spec, seq);
		return { id: spec.id, action: "fired", runId, detail: `runner (${spec.action.kind}, ${spec.target.kind})` };
	}
	await postMail({
		v: 1,
		id: runId,
		kind: "timer-fire",
		sessionId: sessionTarget.sessionId,
		createdAt: at,
		fire: payload,
	});
	if (hasLiveMailboxConsumer(sessionTarget.sessionId)) {
		await appendLedger(spec.id, { type: "delivery", runId, at, state: "queued", session: sessionTarget.sessionId });
		return { id: spec.id, action: "fired", runId, detail: `mailed to live session ${sessionTarget.sessionId}` };
	}
	if (spec.whenClosed === "hold") {
		await appendLedger(spec.id, {
			type: "delivery",
			runId,
			at,
			state: "held",
			session: sessionTarget.sessionId,
			detail: "session not open; held until it opens",
		});
		return { id: spec.id, action: "fired", runId, detail: "held (session not open)" };
	}
	spawnRunner(spec, seq);
	return { id: spec.id, action: "fired", runId, detail: `resuming session ${sessionTarget.sessionId} headless` };
}

async function tickOne(spec: TimerSpec, now: number): Promise<TickLine | undefined> {
	const state = currentState(spec, await readTimerState(spec.id));
	if (state.done || spec.paused) return undefined;
	const decision = decideDue(spec, state, now);
	const at = new Date(now).toISOString();
	switch (decision.kind) {
		case "idle":
			if (state.armedAt !== spec.created.at) await writeTimerState(spec.id, state);
			return undefined;
		case "retire":
			state.done = { at, why: decision.why };
			await writeTimerState(spec.id, state);
			return { id: spec.id, action: "retired", detail: decision.why };
		case "missed": {
			state.seq++;
			const runId = `${spec.id}#${state.seq}`;
			state.lastSlot = decision.slot;
			record(state, runId, "missed", now);
			if (!spec.every) state.done = { at, why: "once" };
			await writeTimerState(spec.id, state);
			await appendLedger(spec.id, {
				type: "run",
				runId,
				seq: state.seq,
				at,
				slot: new Date(decision.slot).toISOString(),
				trigger: "schedule",
				outcome: "missed",
				missedSlots: decision.missedSlots || undefined,
				detail: "later than the late limit; not run",
			});
			return { id: spec.id, action: "missed", runId };
		}
		case "due":
			break;
	}
	if (!spec.until) {
		return dispatch(
			spec,
			state,
			{ slot: decision.slot, missedSlots: decision.missedSlots, trigger: "schedule" },
			now,
		);
	}

	const verdict = await runGate(spec.until, spec.cwd);
	state.gate = {
		checks: (state.gate?.checks ?? 0) + 1,
		lastCheckAt: at,
		lastExit: verdict.kind === "met" ? 0 : verdict.kind === "not-yet" ? 1 : verdict.exitCode,
	};
	if (verdict.kind === "met") {
		return dispatch(
			spec,
			state,
			{ slot: decision.slot, missedSlots: 0, trigger: "gate", gateOutput: verdict.output || undefined },
			now,
		);
	}
	state.lastSlot = decision.slot;
	if (verdict.kind === "not-yet") {
		// Quiet: one ledger line per streak of "not yet", the count lives in state.gate.
		const streaking = state.last?.outcome === "gated-not-yet";
		if (!streaking) {
			state.seq++;
			const runId = `${spec.id}#${state.seq}`;
			record(state, runId, "gated-not-yet", now);
			await appendLedger(spec.id, {
				type: "run",
				runId,
				seq: state.seq,
				at,
				slot: new Date(decision.slot).toISOString(),
				trigger: "gate",
				outcome: "gated-not-yet",
				gateExit: 1,
			});
		}
		await writeTimerState(spec.id, state);
		return { id: spec.id, action: "gated-not-yet", detail: `check #${state.gate.checks}` };
	}
	state.seq++;
	const runId = `${spec.id}#${state.seq}`;
	state.failStreak++;
	record(state, runId, "failed", now);
	const detail = verdict.timedOut
		? "gate timed out"
		: `gate exit ${verdict.exitCode ?? "?"}${verdict.output ? `: ${firstLine(verdict.output)}` : ""}`;
	if (state.failStreak >= PAUSE_AFTER_FAILURES) state.done = { at, why: "failures" };
	await writeTimerState(spec.id, state);
	await appendLedger(spec.id, {
		type: "run",
		runId,
		seq: state.seq,
		at,
		slot: new Date(decision.slot).toISOString(),
		trigger: "gate",
		outcome: "failed",
		gateExit: verdict.exitCode,
		detail,
	});
	return { id: spec.id, action: "failed", runId, detail };
}

function takeTickLock(): FileLockHandle | null {
	fs.mkdirSync(timersRoot(), { recursive: true });
	return tryAcquireFileLock(tickLockPath());
}

export async function runTick(now = Date.now()): Promise<TickReport> {
	const at = new Date(now).toISOString();
	const lock = takeTickLock();
	if (!lock) return { at, locked: true, lines: [] };
	try {
		const { specs, errors } = await listTimerSpecs();
		const lines: TickLine[] = errors.map(({ id, error }) => ({ id, action: "invalid-spec", detail: error }));
		for (const spec of specs) {
			try {
				const line = await tickOne(spec, now);
				if (line) lines.push(line);
			} catch (err) {
				logger.error("timer tick failed", { id: spec.id, error: String(err) });
				lines.push({ id: spec.id, action: "error", detail: err instanceof Error ? err.message : String(err) });
			}
		}
		await Bun.write(tickerStatusPath(), JSON.stringify({ lastTickAt: at, pid: process.pid }));
		return { at, locked: false, lines };
	} finally {
		lock.release();
	}
}

/**
 * Run a timer now, outside its schedule. Waits (bounded) for a running tick to finish.
 * `data` reaches the run fenced as untrusted, like gate output.
 */
export async function fireTimerNow(id: string, now = Date.now(), options: { data?: string } = {}): Promise<TickLine> {
	fs.mkdirSync(timersRoot(), { recursive: true });
	const lock = await acquireFileLock(tickLockPath(), { retries: 600, retryDelayMs: 100 });
	try {
		const spec = await readTimerSpec(id);
		if (!spec) throw new Error(`No timer "${id}"`);
		const state = currentState(spec, await readTimerState(id));
		return await dispatch(spec, state, { missedSlots: 0, trigger: "manual", gateOutput: options.data }, now);
	} finally {
		lock.release();
	}
}
