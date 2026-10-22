/**
 * Condition gate: a shell command run by the ticker without model tokens.
 * Same exit contract as `/loop --until` (`modes/loop-condition.ts`): exit 0 =
 * condition met, fire; exit 1 = not yet; anything else (127 not found, 2
 * syntax error, a signal, a timeout) = the gate itself is broken.
 */

/** Gate stdout handed to the fired run as untrusted data is capped at this many bytes. */
export const GATE_OUTPUT_LIMIT = 16 * 1024;
export const GATE_TIMEOUT_MS = 60_000;

export type GateVerdict =
	| { kind: "met"; output: string }
	| { kind: "not-yet" }
	| { kind: "broken"; exitCode?: number; output: string; timedOut: boolean };

/** Map a finished gate process onto a verdict. */
export function gateVerdict(exitCode: number | null, output: string, timedOut: boolean): GateVerdict {
	if (!timedOut && exitCode === 0) return { kind: "met", output };
	if (!timedOut && exitCode === 1) return { kind: "not-yet" };
	return { kind: "broken", exitCode: exitCode ?? undefined, output, timedOut };
}

export async function runGate(command: string, cwd: string, timeoutMs = GATE_TIMEOUT_MS): Promise<GateVerdict> {
	const child = Bun.spawn(["/bin/sh", "-c", command], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: timeoutMs,
		killSignal: "SIGKILL",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const output = (exitCode === 0 ? stdout : `${stdout}${stderr}`).slice(0, GATE_OUTPUT_LIMIT).trimEnd();
	return gateVerdict(child.signalCode ? null : exitCode, output, child.signalCode === "SIGKILL");
}
