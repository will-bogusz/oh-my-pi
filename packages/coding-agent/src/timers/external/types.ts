/**
 * Read-only view of scheduled work omp did not create: systemd timers and
 * services, launchd agents and crontab lines. Adapters only ever run listing
 * commands through an injected {@link CommandRunner}, so the same parsers serve
 * the local host, a remote host over ssh, and recorded fixtures.
 */

export interface CommandResult {
	/** Exit code; `null` when the command was killed or timed out. */
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Runs one argv (no shell) and captures its output; never throws on non-zero exit. */
export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

export const EXTERNAL_SOURCES = ["systemd-user", "systemd-system", "launchd", "cron"] as const;
export type ExternalSource = (typeof EXTERNAL_SOURCES)[number];

/** `timer`: clock/interval driven; `service`: long-running; `agent`: launchd job started by load/paths. */
export const EXTERNAL_KINDS = ["timer", "service", "agent", "cron"] as const;
export type ExternalKind = (typeof EXTERNAL_KINDS)[number];

/**
 * Health findings, each computed from OS state:
 * - `failed`: the last run did not succeed, as the scheduler judges it (systemd `Result=`, non-zero exit, signal).
 * - `never-ran`: scheduled but no run is recorded.
 * - `unarmed`: nothing will start it (timer has no next elapse, plist not loaded or disabled).
 * - `no-failure-alert`: the scheduler has no failure hook for it (no systemd `OnFailure=`; launchd has none; cron
 *   output that cannot be shown to reach cron's mail). Its absence does not prove anyone is notified.
 * - `interval-only`: systemd timer with only monotonic triggers: no calendar time and no `Persistent=` catch-up.
 * - `sleep-lossy`: launchd `StartInterval`, whose missed intervals during sleep are dropped.
 */
export const HEALTH_FLAGS = [
	"failed",
	"never-ran",
	"unarmed",
	"no-failure-alert",
	"interval-only",
	"sleep-lossy",
] as const;
export type HealthFlag = (typeof HEALTH_FLAGS)[number];

export interface ExternalJob {
	/** Host label: the local hostname or the `--host` name. */
	host: string;
	source: ExternalSource;
	kind: ExternalKind;
	/** Unit name, launchd label, or `crontab:<line>`. */
	id: string;
	description: string | null;
	/** Human-readable trigger, e.g. `OnCalendar=*-*-* 02:30:00` or `every 1h`. */
	schedule: string;
	/** ISO time of the next scheduled start, when the OS knows one. */
	next: string | null;
	/** ISO time of the last start. */
	last: string | null;
	/** True when `last` is inferred (launchd: log file mtime) rather than recorded by the OS. */
	lastApprox?: boolean;
	/** `success`, `running`, `exit 11`, `signal TERM`, … ; null when it never ran. */
	lastResult: string | null;
	/** OS state, e.g. `active/waiting`, `running`, `not loaded`, `disabled`. */
	state: string;
	command: string | null;
	/** Resolved path of the unit file / plist / crontab. */
	sourcePath: string | null;
	/** Log file path or the command that shows the log (`journalctl --user -u x.service`). */
	log: string | null;
	flags: HealthFlag[];
}

/** Result of scanning one host; adapters that fail report an error instead of rows. */
export interface EstateScan {
	host: string;
	jobs: ExternalJob[];
	errors: string[];
}
