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

export type ExternalSource = "systemd-user" | "systemd-system" | "launchd" | "cron";

/** `timer`: clock/interval driven; `service`: long-running; `agent`: launchd job started by load/paths. */
export type ExternalKind = "timer" | "service" | "agent" | "cron";

/**
 * Health findings, each computed from OS state:
 * - `failed`: the last run did not succeed (non-zero exit, signal, unit failed).
 * - `never-ran`: scheduled but no run is recorded.
 * - `unarmed`: nothing will start it (timer has no next elapse, plist not loaded or disabled).
 * - `no-failure-alert`: a failure reaches nobody (no systemd `OnFailure=`; launchd and cron have no hook).
 * - `interval-only`: systemd timer with only monotonic triggers; it loses its schedule across manager restarts.
 * - `source-in-scratch`: unit file, program or working directory lives under `~/tmp`.
 * - `sleep-lossy`: launchd `StartInterval`, whose missed intervals during sleep are dropped.
 */
export type HealthFlag =
	| "failed"
	| "never-ran"
	| "unarmed"
	| "no-failure-alert"
	| "interval-only"
	| "source-in-scratch"
	| "sleep-lossy";

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
