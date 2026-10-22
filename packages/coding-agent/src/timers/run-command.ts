/**
 * Child processes of the timer engine: a run's shell action and hooks, and a
 * condition's gate check.
 *
 * The command runs as its own process group. At its limit the group gets
 * SIGTERM, then SIGKILL after a grace; members that outlive the leader and
 * keep its pipes open get the same bounded end, so a caller never waits on a
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

export interface GroupExit {
	exitCode: number;
	signalCode: NodeJS.Signals | null;
	/** Killed at its limit. */
	timedOut: boolean;
}

export interface GroupRunOptions {
	cwd: string;
	/** Defaults to this process's environment. */
	env?: Record<string, string>;
	timeout: number;
	/**
	 * Group members still running when the leader exits: `linger` gives them
	 * the grace to finish writing (a shell action's background jobs), `kill`
	 * ends them at once (a check leaves nothing behind).
	 */
	afterLeaderExit: "linger" | "kill";
	onStdout(chunk: Uint8Array): void;
	onStderr(chunk: Uint8Array): void;
}

async function drain(
	stream: ReadableStream<Uint8Array>,
	onChunk: (chunk: Uint8Array) => void,
	readers: Set<{ cancel(): Promise<void> }>,
): Promise<void> {
	const reader = stream.getReader();
	readers.add(reader);
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			onChunk(chunk.value);
		}
	} catch {
		// Cancelled after the grace: keep what was read.
	}
}

function groupExists(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Run `argv` as its own process group, streaming its output to the callbacks. Throws if it cannot start. */
export async function runInProcessGroup(argv: string[], options: GroupRunOptions): Promise<GroupExit> {
	const child = Bun.spawn(argv, {
		cwd: options.cwd,
		env: options.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
	const signalGroup = (signal: NodeJS.Signals): void => {
		try {
			process.kill(-child.pid, signal);
		} catch (err) {
			logger.debug("timer command group already gone", { pid: child.pid, signal, error: String(err) });
		}
	};
	let timedOut = false;
	let hardKill: NodeJS.Timeout | undefined;
	const groupKilled = Promise.withResolvers<void>();
	const limit = setTimeout(
		() => {
			timedOut = true;
			signalGroup("SIGTERM");
			hardKill = setTimeout(() => {
				signalGroup("SIGKILL");
				groupKilled.resolve();
			}, KILL_GRACE_MS);
		},
		Math.max(0, options.timeout),
	);
	const readers = new Set<{ cancel(): Promise<void> }>();
	const drained = Promise.all([
		drain(child.stdout as ReadableStream<Uint8Array>, options.onStdout, readers),
		drain(child.stderr as ReadableStream<Uint8Array>, options.onStderr, readers),
	]);
	const exitCode = await child.exited;
	clearTimeout(limit);
	if (options.afterLeaderExit === "kill") {
		clearTimeout(hardKill);
		signalGroup("SIGKILL");
	} else if (timedOut && groupExists(child.pid)) {
		// Past the limit the leader's exit says nothing about its group: a member that ignores SIGTERM
		// and closed its pipes ends only at the scheduled SIGKILL.
		await groupKilled.promise;
	} else clearTimeout(hardKill);
	if (!(await Promise.race([drained.then(() => true), Bun.sleep(KILL_GRACE_MS).then(() => false)]))) {
		signalGroup("SIGKILL");
		for (const reader of readers) reader.cancel().catch(() => {});
	}
	await drained;
	return { exitCode, signalCode: child.signalCode, timedOut };
}

export async function runCommand(
	argv: string[],
	cwd: string,
	env: Record<string, string>,
	timeout: number,
): Promise<RunResult> {
	let stderr = "";
	const decoder = new TextDecoder();
	const exit = await runInProcessGroup(argv, {
		cwd,
		env,
		timeout,
		afterLeaderExit: "linger",
		onStdout: chunk => process.stdout.write(chunk),
		onStderr: chunk => {
			process.stderr.write(chunk);
			stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-ERROR_TAIL_BYTES);
		},
	});
	if (exit.timedOut || exit.signalCode) {
		return {
			ok: false,
			timedOut: exit.timedOut,
			detail: `killed by ${exit.signalCode ?? "SIGTERM"}${exit.timedOut ? ` (limit ${Math.round(timeout / 1000)}s)` : ""}`,
		};
	}
	if (exit.exitCode === 0) return { ok: true, exitCode: 0 };
	const lastLine = stderr
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.at(-1);
	return {
		ok: false,
		exitCode: exit.exitCode,
		detail: `exit ${exit.exitCode}${lastLine ? `: ${firstErrorLine(lastLine)}` : ""}`,
	};
}
