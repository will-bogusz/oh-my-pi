import * as path from "node:path";
import { $env, getAgentDir } from "@oh-my-pi/pi-utils";

/** Overrides the timer store root (tests, smoke runs). */
export const TIMERS_DIR_ENV = "OMP_TIMERS_DIR";

/** Set on every process a fire starts (shell, headless resume): `<timer>#<seq>`. */
export const TIMER_RUN_ENV = "OMP_TIMER_RUN";

export const TIMER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;

/** A requested timer id as every reader takes it (approval, set, control): trimmed, blank as absent. */
export function normalizeTimerId(id: string | undefined): string | undefined {
	return id?.trim() || undefined;
}

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

/** Directory of one agent run: `result.json`, the fresh session (`session/`), the per-run cwd (`work/`). */
export function runDirPath(id: string, seq: number, root = timersRoot()): string {
	return path.join(timerStateDir(id, root), "runs", String(seq));
}

/** `result.json` of one agent run. */
export function runResultPath(id: string, seq: number, root = timersRoot()): string {
	return path.join(runDirPath(id, seq, root), "result.json");
}

/** Session directory of an `own` timer: the one session it resumes on every run. */
export function ownSessionDir(id: string, root = timersRoot()): string {
	return path.join(timerStateDir(id, root), "session");
}

/** Where the OS ticker unit appends `omp timer tick` output. */
export function tickLogPath(root = timersRoot()): string {
	return path.join(root, "tick.log");
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

/** Held by the tick checking a timer's gate, from the check's start until its verdict is decided. */
export function gateLockPath(id: string, root = timersRoot()): string {
	return path.join(timerStateDir(id, root), "gate");
}
