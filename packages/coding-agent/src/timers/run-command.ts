/**
 * One child process of a timer run (shell action, `before`/`after` hook):
 * its output goes to the runner's stdout/stderr (the run log) and the tail of
 * stderr names its failure.
 *
 * The command runs as its own process group. At its limit the group gets
 * SIGTERM, then SIGKILL after a grace; members that outlive the leader and
 * keep its pipes open get the same bounded end, so a run never waits on a
 * command past its limit plus the grace.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { firstErrorLine } from "./policy";

/** Bytes of a run's stderr kept to name its failure. */
const ERROR_TAIL_BYTES = 4096;
/** SIGTERM → SIGKILL, and leader exit → pipes closed. */
const KILL_GRACE_MS = 5000;

export interface RunResult {
	ok: boolean;
	exitCode?: number;
	detail?: string;
	/** Killed at its limit. */
	timedOut?: boolean;
}

/** Copy a child stream to ours (the run log) and keep its tail. */
async function teeTail(
	stream: ReadableStream<Uint8Array>,
	sink: NodeJS.WriteStream,
	readers: Set<{ cancel(): Promise<void> }>,
): Promise<string> {
	let tail = "";
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	readers.add(reader);
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			sink.write(chunk.value);
			tail = (tail + decoder.decode(chunk.value, { stream: true })).slice(-ERROR_TAIL_BYTES);
		}
	} catch {
		// Cancelled after the grace: keep what was read.
	}
	return tail;
}

export async function runCommand(
	argv: string[],
	cwd: string,
	env: Record<string, string>,
	timeout: number,
): Promise<RunResult> {
	const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
	const signalGroup = (signal: NodeJS.Signals): void => {
		try {
			process.kill(-child.pid, signal);
		} catch (err) {
			logger.debug("timer command group already gone", { pid: child.pid, signal, error: String(err) });
		}
	};
	let timedOut = false;
	let hardKill: NodeJS.Timeout | undefined;
	const limit = setTimeout(
		() => {
			timedOut = true;
			signalGroup("SIGTERM");
			hardKill = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
		},
		Math.max(0, timeout),
	);
	const readers = new Set<{ cancel(): Promise<void> }>();
	const drained = Promise.all([
		teeTail(child.stdout as ReadableStream<Uint8Array>, process.stdout, readers),
		teeTail(child.stderr as ReadableStream<Uint8Array>, process.stderr, readers),
	]);
	const exitCode = await child.exited;
	clearTimeout(limit);
	clearTimeout(hardKill);
	if (!(await Promise.race([drained.then(() => true), Bun.sleep(KILL_GRACE_MS).then(() => false)]))) {
		signalGroup("SIGKILL");
		for (const reader of readers) reader.cancel().catch(() => {});
	}
	const [, stderr] = await drained;
	if (timedOut || child.signalCode) {
		return {
			ok: false,
			timedOut,
			detail: `killed by ${child.signalCode ?? "SIGTERM"}${timedOut ? ` (limit ${Math.round(timeout / 1000)}s)` : ""}`,
		};
	}
	if (exitCode === 0) return { ok: true, exitCode };
	const lastLine = stderr
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.at(-1);
	return { ok: false, exitCode, detail: `exit ${exitCode}${lastLine ? `: ${firstErrorLine(lastLine)}` : ""}` };
}
