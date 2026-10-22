import * as os from "node:os";
import { Cron } from "croner";
import type { HealthFlag } from "./types";

/** omp's own per-host ticker units; they are omp's, not external work. */
const OMP_TICKER = /omp-timer-tick|sh\.omp\.timer-tick/;

export function isOmpTicker(id: string): boolean {
	return OMP_TICKER.test(id);
}

/**
 * `~/tmp/…` on any host: `/Users/<u>/tmp/`, `/home/<u>/tmp/`, `/root/tmp/`, `~/tmp/`, or `$HOME/tmp/`
 * (`$$HOME` is systemd's escaped form inside `ExecStart=`).
 */
const SCRATCH = /(?:^|[\s"'=:;&|(])(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/root|~|\$\$?HOME|\$\{HOME\})\/tmp\//;

export function inScratch(...values: Array<string | null | undefined>): boolean {
	return values.some(value => !!value && SCRATCH.test(value));
}

/**
 * What actually runs: the executable plus its script (`sh x.sh`, `python3 x.py`), or the whole inline
 * script for `sh -c …`. Paths a job merely operates on (`fleet stash ~/tmp/…`) do not make it
 * scratch-sourced.
 */
export function programPaths(argv: string[]): string[] {
	if (argv.length >= 3 && /^-[a-z]*c$/.test(argv[1])) return [argv[0], argv.slice(2).join(" ")];
	return argv.slice(0, 2);
}

export function isoFromMs(ms: number | null | undefined): string | null {
	return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** Next run of a 5-field cron expression in host-local time, or null when it never fires again or is invalid. */
export function nextCron(expression: string, now: number): number | null {
	try {
		const next = new Cron(expression).nextRun(new Date(now));
		return next ? next.getTime() : null;
	} catch {
		return null;
	}
}

const SIGNAL_NAMES = new Map<number, string>(
	Object.entries(os.constants.signals).map(([name, num]) => [num, name.replace(/^SIG/, "")]),
);

export function signalName(signal: number): string {
	return SIGNAL_NAMES.get(signal) ?? String(signal);
}

/** Pushes `flag` when `condition` holds; keeps flag order stable across adapters. */
export function flagsFrom(entries: Array<[HealthFlag, boolean]>): HealthFlag[] {
	return entries.filter(([, on]) => on).map(([flag]) => flag);
}

/** Compact duration for intervals given in seconds: 90 → `90s`, 3600 → `1h`, 5400 → `90m`. */
export function formatSeconds(seconds: number): string {
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}
