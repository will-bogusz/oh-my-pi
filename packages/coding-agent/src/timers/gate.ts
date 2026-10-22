/**
 * Condition gate: a shell command run by the ticker without model tokens.
 * Same exit contract as `/loop --until` (`modes/loop-condition.ts`): exit 0 =
 * condition met, fire; exit 1 = not yet; anything else (127 not found, 2
 * syntax error, a signal, a timeout, a shell that cannot start) = the gate
 * itself is broken. The verdict is the shell's exit: whatever it leaves
 * running is killed when it exits.
 */
import { type GroupExit, runInProcessGroup } from "./run-command";

/** Gate output handed to the fired run as untrusted data (or naming its failure) is capped at this many bytes. */
export const GATE_OUTPUT_LIMIT = 16 * 1024;
export const GATE_TIMEOUT_MS = 60_000;

export type GateVerdict =
	| { kind: "met"; output: string }
	| { kind: "not-yet" }
	/** `error` is one line: `exit 2`, `timed out`, `could not start: …`. */
	| { kind: "broken"; exitCode?: number; output: string; error: string };

/** Map a finished gate process onto a verdict. */
export function gateVerdict(exitCode: number | null, output: string, timedOut: boolean): GateVerdict {
	if (!timedOut && exitCode === 0) return { kind: "met", output };
	if (!timedOut && exitCode === 1) return { kind: "not-yet" };
	const error = timedOut ? "timed out" : exitCode === null ? "killed by a signal" : `exit ${exitCode}`;
	return { kind: "broken", exitCode: exitCode ?? undefined, output, error };
}

/** UTF-8 sequences are at most this long: a stream's head keeps this much past the limit to find a character boundary. */
const UTF8_MAX_BYTES = 4;

/** Keeps the first `limit` bytes of a stream as they arrive and drops the rest unbuffered. */
class StreamHead {
	readonly #chunks: Uint8Array[] = [];
	#size = 0;
	constructor(readonly limit: number) {}

	push(chunk: Uint8Array): void {
		if (this.#size >= this.limit) return;
		const part = chunk.subarray(0, this.limit - this.#size);
		this.#chunks.push(part);
		this.#size += part.length;
	}

	get bytes(): Uint8Array {
		return Buffer.concat(this.#chunks);
	}
}

/** The first `limit` bytes as text, cut before a character the limit would split. */
function headText(bytes: Uint8Array, limit: number): string {
	let end = Math.min(bytes.length, limit);
	while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	return new TextDecoder().decode(bytes.subarray(0, end));
}

export async function runGate(command: string, cwd: string, timeoutMs = GATE_TIMEOUT_MS): Promise<GateVerdict> {
	const stdout = new StreamHead(GATE_OUTPUT_LIMIT + UTF8_MAX_BYTES);
	const stderr = new StreamHead(GATE_OUTPUT_LIMIT + UTF8_MAX_BYTES);
	let exit: GroupExit;
	try {
		exit = await runInProcessGroup(["/bin/sh", "-c", command], {
			cwd,
			timeout: timeoutMs,
			afterLeaderExit: "kill",
			onStdout: chunk => stdout.push(chunk),
			onStderr: chunk => stderr.push(chunk),
		});
	} catch (err) {
		return {
			kind: "broken",
			output: "",
			error: `could not start: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const exitCode = exit.signalCode ? null : exit.exitCode;
	const bytes = exitCode === 0 ? stdout.bytes : Buffer.concat([stdout.bytes, stderr.bytes]);
	return gateVerdict(exitCode, headText(bytes, GATE_OUTPUT_LIMIT).trimEnd(), exit.timedOut);
}
