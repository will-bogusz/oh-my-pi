import { Cron } from "croner";
import type { CommandResult, CommandRunner, HealthFlag } from "./types";

/** omp's own per-host ticker units; they are omp's, not external work. */
const OMP_TICKER = /omp-timer-tick|sh\.omp\.timer-tick/;

export function isOmpTicker(id: string): boolean {
	return OMP_TICKER.test(id);
}

export function isoFromMs(ms: number | null | undefined): string | null {
	return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** A required listing command's stdout; a failed or timed-out command throws so the adapter reports it. */
export function stdoutOf(result: CommandResult, what: string): string {
	if (result.code === 0) return result.stdout;
	const reason = result.stderr.trim().split("\n")[0] || (result.code === null ? "timed out" : `exit ${result.code}`);
	throw new Error(`${what} failed: ${reason}`);
}

export function isTimeZone(name: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: name });
		return true;
	} catch {
		return false;
	}
}

/**
 * The scanned host's time zone, which cron and launchd calendars run in: the zoneinfo name `/etc/localtime`
 * links to (macOS, most Linux), else Debian's `/etc/timezone`; null when neither names a known zone.
 */
export async function hostTimeZone(run: CommandRunner): Promise<string | null> {
	const link = await run(["readlink", "/etc/localtime"]);
	const linked = link.code === 0 ? /\/zoneinfo\/(.+)$/.exec(link.stdout.trim())?.[1] : undefined;
	if (linked && isTimeZone(linked)) return linked;
	const file = await run(["cat", "/etc/timezone"]);
	const named = file.code === 0 ? file.stdout.trim() : "";
	return named && isTimeZone(named) ? named : null;
}

/** Next run of a 5-field cron expression in `timeZone`, or null when it never fires again or is invalid. */
export function nextCron(expression: string, now: number, timeZone: string): number | null {
	try {
		const next = new Cron(expression, { timezone: timeZone }).nextRun(new Date(now));
		return next ? next.getTime() : null;
	} catch {
		return null;
	}
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
