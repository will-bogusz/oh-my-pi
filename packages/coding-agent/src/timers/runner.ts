/**
 * `omp timer exec <id> <seq>`: the detached process that carries one run the
 * tick dispatched, so the tick never holds its lock across a model turn or a
 * shell command. It holds the timer's run lock (overlap) for the run's life
 * and writes the run's start and end (`run_ends`); the next tick applies the
 * end to the failure policy.
 *
 * It runs the spec revision the run was committed against (action, cwd,
 * target), never whichever revision exists by the time it starts.
 *
 * - shell: `/bin/sh -c` in the timer's cwd.
 * - prompt → session nobody has open: headless delivery (an RPC host on
 *   `--resume <session>` whose own mailbox watcher claims the mail).
 *
 * Every child carries `OMP_TIMER_RUN=<id>#<seq>` (recursion guard).
 */
import { acquireFileLock } from "@oh-my-pi/pi-utils";
import { workerEnvFromParent } from "../subprocess/worker-client";
import { deliverHeadless } from "../mailbox/headless";
import { deliveryTarget, describeDeliveryTarget } from "../mailbox/mailbox";
import { runLockPath, TIMER_RUN_ENV, timersRoot } from "./paths";
import { firstErrorLine } from "./policy";
import { type RunResult, runCommand } from "./run-command";
import { HOUR } from "./schedule";
import { openTimerDb, readTimerSpec, readTimerSpecAt } from "./store";
import type { TimerSpec } from "./types";

/** Wall-clock cap per shell run. */
const MAX_SHELL_RUN_MS = HOUR;
/** How long a runner waits for the previous run's runner, which recorded its end, to let go of the run lock. */
const RUN_LOCK_WAIT = { retries: 100, retryDelayMs: 100 };

function runEnv(spec: TimerSpec, runId: string, root: string): Record<string, string> {
	return workerEnvFromParent({ OMP_TIMER_ID: spec.id, [TIMER_RUN_ENV]: runId, OMP_TIMERS_DIR: root });
}

async function runHeadless(
	spec: TimerSpec,
	runId: string,
	env: Record<string, string>,
	root: string,
): Promise<RunResult> {
	if (spec.target.kind !== "session") return { ok: false, detail: "not a session timer" };
	const { sessionId } = spec.target;
	const db = openTimerDb(root);
	const note = (state: "queued" | "held", detail: string): void =>
		db.recordDelivery(spec.id, { runId, at: new Date().toISOString(), state, session: sessionId, detail });
	// The tick saw nobody holding the session, but someone may have opened it since.
	const target = deliveryTarget(sessionId);
	if (target.kind === "live") {
		note("queued", "a live session took over before the headless resume started");
		return { ok: true, detail: "delivered by a live session" };
	}
	if (target.kind === "held") {
		note("held", describeDeliveryTarget(target));
		return { ok: true, detail: "held: session open elsewhere" };
	}
	const result = await deliverHeadless({
		sessionId,
		sessionRef: spec.target.sessionFile ?? sessionId,
		cwd: spec.cwd,
		mailId: runId,
		env,
	});
	switch (result.outcome) {
		case "delivered":
			return { ok: true, detail: result.detail };
		case "live":
			note("queued", result.detail ?? "a live session took the mail");
			return { ok: true, detail: "delivered by a live session" };
		case "held":
			note("held", result.detail ?? "held");
			return { ok: true, detail: `held: ${result.detail ?? ""}`.trim() };
		case "failed":
			return { ok: false, detail: result.detail ?? "headless delivery failed" };
	}
}

export async function execTimerRun(id: string, seq: number, root = timersRoot()): Promise<RunResult> {
	const runId = `${id}#${seq}`;
	const db = openTimerDb(root);
	const started = Date.now();
	const finish = (result: RunResult): RunResult => {
		db.recordRunEnd(id, {
			runId,
			at: new Date().toISOString(),
			ok: result.ok,
			exitCode: result.exitCode,
			durationMs: Date.now() - started,
			detail: result.detail,
		});
		return result;
	};
	// Lock, then claim: a second runner for this run id (re-dispatch after a
	// tick crash, a double spawn) never executes, and never overwrites the
	// first runner's record. One that cannot take the lock records nothing;
	// the tick reports the run lost if no runner ever claims it.
	const lock = await acquireFileLock(runLockPath(id, root), RUN_LOCK_WAIT).catch(() => undefined);
	if (!lock) return { ok: false, detail: "another run of this timer holds the run lock; not started" };
	if (!db.claimRunStart(id, runId, new Date(started).toISOString())) {
		lock.release();
		return { ok: true, detail: `${runId} was already claimed; not run again` };
	}
	// A removed timer's run never starts; otherwise run the revision the run was committed against.
	const run = db.getRun(runId);
	const spec = run && (await readTimerSpec(id, root)) ? await readTimerSpecAt(id, run.rev, root) : undefined;
	if (!spec) {
		lock.release();
		return finish({ ok: false, detail: "timer removed before its run started" });
	}
	try {
		const env = runEnv(spec, runId, root);
		if (spec.action.kind === "shell") {
			return finish(await runCommand(["/bin/sh", "-c", spec.action.command], spec.cwd, env, MAX_SHELL_RUN_MS));
		}
		return finish(await runHeadless(spec, runId, env, root));
	} catch (err) {
		return finish({ ok: false, detail: firstErrorLine(err instanceof Error ? err.message : String(err)) });
	} finally {
		lock.release();
	}
}
