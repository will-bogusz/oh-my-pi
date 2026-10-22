/**
 * Recursion guard. Every process a fire starts carries `OMP_TIMER_RUN=<id>#<seq>`.
 * Such a run may change only its own timer (re-arm, edit, pause, remove, fire)
 * unless that timer was set with `allowTimers: true`; reading stays open.
 * A turn a prompt timer wakes in its session may also set, edit, pause, resume
 * or remove prompt timers that wake that same session: whatever they start
 * lands in that one conversation, one turn at a time.
 * Without this, one fired run can arm timers that arm timers.
 */
import { $env } from "@oh-my-pi/pi-utils";
import { TIMER_RUN_ENV, timersRoot } from "./paths";
import { readTimerSpec } from "./store";
import type { TimerTarget } from "./types";

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

export interface TimerMutationScope {
	env?: Record<string, string | undefined>;
	/** The target the timer has after this set or edit; absent when the change keeps the current one. */
	target?: TimerTarget;
}

const wokenSession = (target: TimerTarget): string | undefined =>
	target.kind === "session" ? target.sessionId : undefined;

/** Throws {@link TimerScopeError} when a fired run tries to change a timer outside its scope without `allowTimers`. */
export async function assertTimerMutationAllowed(
	targetId: string | undefined,
	verb: string,
	root = timersRoot(),
	{ env = $env, target }: TimerMutationScope = {},
): Promise<void> {
	const run = currentTimerRun(env);
	if (!run || targetId === run.timerId) return;
	const own = await readTimerSpec(run.timerId, root).catch(() => undefined);
	if (own?.allowTimers) return;
	const subject = `timer ${run.timerId} (${TIMER_RUN_ENV}=${run.runId})`;
	const what = targetId ? `timer ${targetId}` : "a new timer";
	const hint = `To let its runs manage other timers, set ${run.timerId} with allowTimers: true (timer tool), or set or edit it with --allow-timers (omp timer).`;
	const wakes = own ? wokenSession(own.target) : undefined;
	if (wakes === undefined) {
		throw new TimerScopeError(
			`this run was started by ${subject}; it may ${verb} only timer ${run.timerId}, not ${what}. ${hint}`,
		);
	}
	// `fire` delivers at once, so two timers firing each other would loop with no schedule between turns.
	if (verb !== "fire") {
		const current = targetId ? await readTimerSpec(targetId, root) : undefined;
		const after = target ?? current?.target;
		const stays = !current || wokenSession(current.target) === wakes;
		if (after && stays && wokenSession(after) === wakes) return;
	}
	const scope = verb === "fire" ? "" : " or prompt timers that wake this session";
	throw new TimerScopeError(
		`this turn was started by ${subject}, which wakes this session; it may ${verb} only timer ${run.timerId}${scope}, not ${what}. ${hint}`,
	);
}
