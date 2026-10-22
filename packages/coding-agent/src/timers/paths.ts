import * as path from "node:path";
import { $env, getAgentDir } from "@oh-my-pi/pi-utils";

/** Overrides the timer store root (tests, smoke runs). */
export const TIMERS_DIR_ENV = "OMP_TIMERS_DIR";

/** Set on an RPC host spawned to resume a session headless for one run: `<timer>#<seq>`. */
export const TIMER_HEADLESS_RUN_ENV = "OMP_TIMER_HEADLESS_RUN";

/** Set on every process a fire starts (shell, fresh agent, headless resume): `<timer>#<seq>`. */
export const TIMER_RUN_ENV = "OMP_TIMER_RUN";

/** Disable the session mailbox watcher in this process (`0`). */
export const TIMER_MAILBOX_ENV = "OMP_TIMER_MAILBOX";

export const TIMER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export function timersRoot(): string {
	return $env[TIMERS_DIR_ENV] || path.join(getAgentDir(), "timers");
}

export function specsDir(root = timersRoot()): string {
	return path.join(root, "specs");
}

export function specPath(id: string, root = timersRoot()): string {
	return path.join(specsDir(root), `${id}.md`);
}

/** Earlier revisions of a re-set or edited spec: `<root>/history/<id>/<rev>.md`. */
export function specHistoryPath(id: string, rev: number, root = timersRoot()): string {
	return path.join(root, "history", id, `${rev}.md`);
}

/** Runtime state: slots, runs, run ends, deliveries, incidents, ticker heartbeat. */
export function timersDbPath(root = timersRoot()): string {
	return path.join(root, "timers.db");
}

export function timerStateDir(id: string, root = timersRoot()): string {
	return path.join(root, "state", id);
}

/** stdout/stderr of one run's runner process. */
export function runLogPath(id: string, seq: number, root = timersRoot()): string {
	return path.join(timerStateDir(id, root), "runs", `${seq}.log`);
}

/** Fire payload the tick hands to a detached runner. */
export function firePayloadPath(id: string, seq: number, root = timersRoot()): string {
	return path.join(timerStateDir(id, root), "runs", `${seq}.json`);
}

/** Where the OS ticker unit appends `omp timer tick` output. */
export function tickLogPath(root = timersRoot()): string {
	return path.join(root, "tick.log");
}

/** Session ids come from files and argv: anything but a plain token is hashed so it cannot name a path. */
export function safeSessionKey(sessionId: string): string {
	return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
		? sessionId
		: `h-${Bun.hash.wyhash(sessionId).toString(16).padStart(16, "0")}`;
}

export function mailDir(sessionId: string): string {
	return path.join(timersRoot(), "mail", safeSessionKey(sessionId));
}

/** Held for the duration of one tick (evaluation + dispatch, never a model turn). */
export function tickLockPath(root = timersRoot()): string {
	return path.join(root, "tick");
}

/** Held while one spec is read-modified-written, so concurrent mutators serialize instead of losing updates. */
export function specLockPath(id: string, root = timersRoot()): string {
	return path.join(specsDir(root), `.${id}`);
}

/** Held by the runner process while a timer's action is in flight (overlap policy). */
export function runLockPath(id: string, root = timersRoot()): string {
	return path.join(timerStateDir(id, root), "run");
}
