import * as path from "node:path";
import { $env, getAgentDir } from "@oh-my-pi/pi-utils";

/** Overrides the timer store root (tests, smoke runs). */
export const TIMERS_DIR_ENV = "OMP_TIMERS_DIR";

/** Set on an RPC host spawned to resume a session headless for one run: `<timer>#<seq>`. */
export const TIMER_HEADLESS_RUN_ENV = "OMP_TIMER_HEADLESS_RUN";

/** Disable the session mailbox watcher in this process (`0`). */
export const TIMER_MAILBOX_ENV = "OMP_TIMER_MAILBOX";

export const TIMER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export function timersRoot(): string {
	return $env[TIMERS_DIR_ENV] || path.join(getAgentDir(), "timers");
}

export function specsDir(): string {
	return path.join(timersRoot(), "specs");
}

export function specPath(id: string): string {
	return path.join(specsDir(), `${id}.md`);
}

export function timerStateDir(id: string): string {
	return path.join(timersRoot(), "state", id);
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
export function tickLockPath(): string {
	return path.join(timersRoot(), "tick");
}

/** Held by the runner process while a timer's action is in flight (overlap policy). */
export function runLockPath(id: string): string {
	return path.join(timerStateDir(id), "run");
}
