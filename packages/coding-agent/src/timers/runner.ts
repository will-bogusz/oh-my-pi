/**
 * `omp timer exec <id> <seq>`: the detached process that carries one run the
 * tick dispatched, so the tick never holds its lock across a model turn or a
 * shell command. It holds the timer's run lock (overlap) for the run's life
 * and records the run's terminal `end` line.
 *
 * - shell: `/bin/sh -c` in the timer's cwd.
 * - prompt → fresh: `omp -p` with the rendered fire envelope.
 * - prompt → session nobody has open: `deliverHeadless` (mailbox-headless.ts)
 *   resumes it in an RPC host whose own mailbox watcher delivers the mail, so
 *   the turn lands in the session's own file.
 */
import { tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { resolveCliCommand, workerEnvFromParent } from "../subprocess/worker-client";
import { renderTimerMail } from "./fire-message";
import { deliverHeadless } from "./mailbox-headless";
import { runLockPath } from "./paths";
import { parseDuration } from "./schedule";
import { firePayloadPath } from "./service";
import { appendLedger, readTimerSpec } from "./store";
import type { TimerFirePayload, TimerSpec } from "./types";

/** Wall-clock cap per run. */
const MAX_RUN_MS = parseDuration("30m");

interface RunResult {
	ok: boolean;
	exitCode?: number;
	detail?: string;
}

async function runShell(spec: TimerSpec, command: string, runId: string): Promise<RunResult> {
	const child = Bun.spawn(["/bin/sh", "-c", command], {
		cwd: spec.cwd,
		env: workerEnvFromParent({ OMP_TIMER_ID: spec.id, OMP_TIMER_RUN: runId }),
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		timeout: MAX_RUN_MS,
	});
	const exitCode = await child.exited;
	if (child.signalCode) return { ok: false, detail: `killed by ${child.signalCode}` };
	return { ok: exitCode === 0, exitCode };
}

async function runFresh(spec: TimerSpec, payload: TimerFirePayload, runId: string): Promise<RunResult> {
	const text = renderTimerMail(
		{ v: 1, id: runId, kind: "timer-fire", sessionId: "", createdAt: payload.firedAt, fire: payload },
		"headless",
		Date.now(),
		spec.tz,
	);
	const args = [...resolveCliCommand(), "-p"];
	if (spec.model) args.push("--model", spec.model);
	args.push(text);
	const child = Bun.spawn(args, {
		cwd: spec.cwd,
		env: workerEnvFromParent({ OMP_TIMER_ID: spec.id, OMP_TIMER_RUN: runId }),
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		timeout: MAX_RUN_MS,
	});
	const exitCode = await child.exited;
	return { ok: exitCode === 0, exitCode };
}

/** A delivery note on this run's ledger; `held` leaves the mail for the session's next opener. */
async function noteDelivery(spec: TimerSpec, runId: string, state: "held" | "queued", detail: string): Promise<void> {
	const session = spec.target.kind === "session" ? spec.target.sessionId : undefined;
	await appendLedger(spec.id, { type: "delivery", runId, at: new Date().toISOString(), state, session, detail });
}

async function runHeadlessResume(spec: TimerSpec, sessionRef: string, runId: string): Promise<RunResult> {
	const sessionId = spec.target.kind === "session" ? spec.target.sessionId : "";
	const result = await deliverHeadless({
		sessionId,
		sessionRef,
		cwd: spec.cwd,
		mailId: runId,
		timeoutMs: MAX_RUN_MS,
	});
	switch (result.outcome) {
		case "delivered":
			return { ok: true };
		case "live":
			await noteDelivery(spec, runId, "queued", result.detail ?? "a live session took over");
			return { ok: true, detail: "delivered by a live session" };
		case "held":
			await noteDelivery(spec, runId, "held", result.detail ?? "session open elsewhere");
			return { ok: false, detail: `mail held: ${result.detail ?? "session open elsewhere"}` };
		case "failed":
			return { ok: false, detail: result.detail };
	}
}

export async function execTimerRun(id: string, seq: number): Promise<RunResult> {
	const runId = `${id}#${seq}`;
	const started = Date.now();
	const finish = async (result: RunResult): Promise<RunResult> => {
		await appendLedger(id, {
			type: "end",
			runId,
			at: new Date().toISOString(),
			ok: result.ok,
			exitCode: result.exitCode,
			durationMs: Date.now() - started,
			detail: result.detail,
		});
		return result;
	};
	const spec = await readTimerSpec(id);
	if (!spec) return finish({ ok: false, detail: "timer removed before its run started" });
	const lock = tryAcquireFileLock(runLockPath(id));
	if (!lock) return finish({ ok: false, detail: "overlap: the previous run still holds the run lock" });
	try {
		if (spec.action.kind === "shell") return await finish(await runShell(spec, spec.action.command, runId));
		if (spec.target.kind === "session") {
			const ref = spec.target.sessionFile ?? spec.target.sessionId;
			return await finish(await runHeadlessResume(spec, ref, runId));
		}
		const payload = (await Bun.file(firePayloadPath(id, seq)).json()) as TimerFirePayload;
		return await finish(await runFresh(spec, payload, runId));
	} finally {
		lock.release();
	}
}
