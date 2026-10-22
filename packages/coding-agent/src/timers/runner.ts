/**
 * `omp timer exec <id> <seq>`: the detached process that carries one run the
 * tick dispatched, so the tick never holds its lock across a model turn or a
 * shell command. It holds the timer's run lock (overlap) for the run's life
 * and writes the run's start and end (`run_ends`); the next tick applies the
 * end to the failure policy.
 *
 * - shell: `/bin/sh -c` in the timer's cwd.
 * - prompt → fresh: `omp -p` with the rendered fire envelope.
 * - prompt → session nobody has open: headless delivery (an RPC host on
 *   `--resume <session>` whose own mailbox watcher claims the mail).
 *
 * Every child carries `OMP_TIMER_RUN=<id>#<seq>` (recursion guard).
 */
import { tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { resolveCliEntryCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { renderTimerMail } from "./fire-message";
import { deliveryTarget } from "./mailbox";
import { deliverHeadless } from "./mailbox-headless";
import { firePayloadPath, runLockPath, TIMER_RUN_ENV, timersRoot } from "./paths";
import { firstErrorLine } from "./policy";
import { HOUR } from "./schedule";
import { openTimerDb, readTimerSpec } from "./store";
import type { TimerFirePayload, TimerSpec } from "./types";

/** Wall-clock cap per run. */
const MAX_PROMPT_RUN_MS = HOUR / 2;
const MAX_SHELL_RUN_MS = HOUR;
/** Bytes of a run's stderr kept to name its failure. */
const ERROR_TAIL_BYTES = 4096;

export interface RunResult {
	ok: boolean;
	exitCode?: number;
	detail?: string;
}

function runEnv(spec: TimerSpec, runId: string, root: string): Record<string, string> {
	return workerEnvFromParent({ OMP_TIMER_ID: spec.id, [TIMER_RUN_ENV]: runId, OMP_TIMERS_DIR: root });
}

/** Copy a child stream to ours (the run log) and keep its tail. */
async function teeTail(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream): Promise<string> {
	let tail = "";
	const decoder = new TextDecoder();
	for await (const chunk of stream) {
		sink.write(chunk);
		tail = (tail + decoder.decode(chunk, { stream: true })).slice(-ERROR_TAIL_BYTES);
	}
	return tail;
}

async function runCommand(
	argv: string[],
	spec: TimerSpec,
	env: Record<string, string>,
	timeout: number,
): Promise<RunResult> {
	const child = Bun.spawn(argv, { cwd: spec.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout });
	const [, stderr, exitCode] = await Promise.all([
		teeTail(child.stdout as ReadableStream<Uint8Array>, process.stdout),
		teeTail(child.stderr as ReadableStream<Uint8Array>, process.stderr),
		child.exited,
	]);
	if (child.signalCode)
		return { ok: false, detail: `killed by ${child.signalCode} (limit ${Math.round(timeout / 60_000)}m)` };
	if (exitCode === 0) return { ok: true, exitCode };
	const lastLine = stderr
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.at(-1);
	return { ok: false, exitCode, detail: `exit ${exitCode}${lastLine ? `: ${firstErrorLine(lastLine)}` : ""}` };
}

async function runFresh(spec: TimerSpec, payload: TimerFirePayload, env: Record<string, string>): Promise<RunResult> {
	const text = renderTimerMail(
		{ v: 1, id: payload.runId, kind: "timer-fire", sessionId: "", createdAt: payload.firedAt, fire: payload },
		"headless",
		Date.now(),
		spec.tz,
	);
	const argv = [...resolveCliEntryCmd(), "-p"];
	if (spec.model) argv.push("--model", spec.model);
	argv.push(text);
	return runCommand(argv, spec, env, MAX_PROMPT_RUN_MS);
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
		note("held", `session is open in an omp that cannot take timer mail (${target.reason})`);
		return { ok: true, detail: "held: session open elsewhere" };
	}
	const result = await deliverHeadless({
		sessionId,
		sessionRef: spec.target.sessionFile ?? sessionId,
		cwd: spec.cwd,
		mailId: runId,
		env,
		timeoutMs: MAX_PROMPT_RUN_MS,
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
			return { ok: false, detail: result.error ?? result.detail ?? "headless delivery failed" };
	}
}

export async function execTimerRun(id: string, seq: number, root = timersRoot()): Promise<RunResult> {
	const runId = `${id}#${seq}`;
	const db = openTimerDb(root);
	const started = Date.now();
	db.recordRunStart(id, runId, new Date(started).toISOString());
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
	const spec = await readTimerSpec(id, root);
	if (!spec) return finish({ ok: false, detail: "timer removed before its run started" });
	const lock = tryAcquireFileLock(runLockPath(id, root));
	if (!lock) return finish({ ok: false, detail: "overlap: the previous run still holds the run lock" });
	try {
		const env = runEnv(spec, runId, root);
		if (spec.action.kind === "shell") {
			return finish(await runCommand(["/bin/sh", "-c", spec.action.command], spec, env, MAX_SHELL_RUN_MS));
		}
		if (spec.target.kind === "session") return finish(await runHeadless(spec, runId, env, root));
		const payload = (await Bun.file(firePayloadPath(id, seq, root)).json()) as TimerFirePayload;
		return finish(await runFresh(spec, payload, env));
	} catch (err) {
		return finish({ ok: false, detail: firstErrorLine(err instanceof Error ? err.message : String(err)) });
	} finally {
		lock.release();
	}
}
