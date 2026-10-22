/**
 * One child process of a timer run (shell action, `before`/`after` hook):
 * its output goes to the runner's stdout/stderr (the run log) and the tail of
 * stderr names its failure.
 */
import { firstErrorLine } from "./policy";

/** Bytes of a run's stderr kept to name its failure. */
const ERROR_TAIL_BYTES = 4096;

export interface RunResult {
	ok: boolean;
	exitCode?: number;
	detail?: string;
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

export async function runCommand(
	argv: string[],
	cwd: string,
	env: Record<string, string>,
	timeout: number,
): Promise<RunResult> {
	const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout });
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
