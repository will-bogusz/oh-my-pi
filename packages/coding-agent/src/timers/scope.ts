/**
 * Recursion guard. Every process a fire starts carries `OMP_TIMER_RUN=<id>#<seq>`.
 * Such a run may change only its own timer (re-arm, edit, pause, remove, fire)
 * unless that timer was set with `allowTimers: true`; reading stays open.
 * Without this, one fired run can arm timers that arm timers.
 */
import { $env } from "@oh-my-pi/pi-utils";
import { TIMER_RUN_ENV, timersRoot } from "./paths";
import { readTimerSpec } from "./store";

export class TimerScopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimerScopeError";
	}
}

/** The timer run this process belongs to, if a fire started it. */
export function currentTimerRun(
	env: Record<string, string | undefined> = $env,
): { timerId: string; runId: string } | undefined {
	const runId = env[TIMER_RUN_ENV]?.trim();
	if (!runId) return undefined;
	const hash = runId.lastIndexOf("#");
	return { timerId: hash > 0 ? runId.slice(0, hash) : runId, runId };
}

/** Throws {@link TimerScopeError} when a fired run tries to change another timer without `allowTimers`. */
export async function assertTimerMutationAllowed(
	targetId: string | undefined,
	verb: string,
	root = timersRoot(),
	env: Record<string, string | undefined> = $env,
): Promise<void> {
	const run = currentTimerRun(env);
	if (!run || targetId === run.timerId) return;
	const own = await readTimerSpec(run.timerId, root).catch(() => undefined);
	if (own?.allowTimers) return;
	const target = targetId ? `timer ${targetId}` : "a new timer";
	throw new TimerScopeError(
		`this run was started by timer ${run.timerId} (${TIMER_RUN_ENV}=${run.runId}); it may ${verb} only timer ${run.timerId}, not ${target}. Set allowTimers: true on ${run.timerId} to let its runs manage other timers.`,
	);
}
