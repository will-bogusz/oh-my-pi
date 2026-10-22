/**
 * `omp timer ls --all [--host H]`: merge the external estate of this host and
 * any remote hosts. A remote host is asked for `omp timer ls --json --all`
 * first; when its omp predates that, the same read-only adapters run over ssh
 * and parse here.
 */
import * as os from "node:os";
import { type } from "@oh-my-pi/omptype";
import { getSSHConfigPath } from "@oh-my-pi/pi-utils";
import type { SSHConnectionTarget, SSHHostOs } from "../../ssh/connection-manager";
import { readSSHConfigFile } from "../../ssh/config-writer";
import { hostTimeZone, stdoutOf } from "./common";
import { scanCrontab } from "./crontab";
import { scanLaunchd } from "./launchd";
import { connectRemoteRunner, localRunner } from "./runner";
import { scanSystemd } from "./systemd";
import {
	type CommandRunner,
	EXTERNAL_KINDS,
	EXTERNAL_SOURCES,
	type EstateScan,
	type ExternalJob,
	HEALTH_FLAGS,
} from "./types";

const timeOrNull = type("string")
	.narrow((value, ctx) => Number.isFinite(Date.parse(value)) || ctx.mustBe("an ISO time"))
	.or("null");

/** One `external` row of a remote listing; `host` is replaced by the `--host` name, so it is not required. */
const remoteJobSchema = type({
	"+": "delete",
	source: type.enumerated(...EXTERNAL_SOURCES),
	kind: type.enumerated(...EXTERNAL_KINDS),
	id: "string",
	description: "string | null",
	schedule: "string",
	next: timeOrNull,
	last: timeOrNull,
	"lastApprox?": "boolean",
	lastResult: "string | null",
	state: "string",
	command: "string | null",
	sourcePath: "string | null",
	log: "string | null",
	flags: type.enumerated(...HEALTH_FLAGS).array(),
});

/** One of a remote omp's own timers: the fields the listing shows, plus whatever else its `ls --json` printed. */
const remoteTimerSchema = type({ id: "string", status: "string", "next?": timeOrNull });
export type RemoteTimer = typeof remoteTimerSchema.infer;

const remoteReportSchema = type({ errors: "string[]" });

export interface HostReport {
	host: string;
	/**
	 * `local`: this process; `omp`: the remote's own `omp timer ls --json --all`; `ssh`: adapters run over ssh;
	 * `none`: the host could not be reached or set up (see `errors`).
	 */
	via: "local" | "omp" | "ssh" | "none";
	/** `via: "ssh"` only: why the remote's own omp listing was not used. */
	fallback?: string;
	/** The remote omp's own timers (`via: "omp"` only). */
	timers?: RemoteTimer[];
	errors: string[];
}

export interface Estate {
	jobs: ExternalJob[];
	hosts: HostReport[];
}

/** Every adapter for `platform`; one failing adapter reports an error and leaves the others' rows. */
export async function scanHost(
	run: CommandRunner,
	platform: SSHHostOs,
	host: string,
	now: number,
): Promise<EstateScan> {
	if (platform !== "macos" && platform !== "linux") {
		return { host, jobs: [], errors: [`unsupported host OS: ${platform}`] };
	}
	const timeZone = await hostTimeZone(run);
	const adapters: Array<[string, () => Promise<ExternalJob[]>]> =
		platform === "macos"
			? [
					["launchd", () => scanLaunchd(run, host, now, timeZone)],
					["crontab", () => scanCrontab(run, host, now, timeZone)],
				]
			: [
					["systemd --user", () => scanSystemd(run, "user", host)],
					["systemd system", () => scanSystemd(run, "system", host)],
					["crontab", () => scanCrontab(run, host, now, timeZone)],
				];
	const settled = await Promise.allSettled(adapters.map(([, scan]) => scan()));
	const jobs: ExternalJob[] = [];
	const errors: string[] = timeZone
		? []
		: [
				`time zone unknown (neither /etc/localtime nor /etc/timezone names a zone): next runs of ${platform === "macos" ? "launchd and cron" : "cron"} jobs are not shown`,
			];
	settled.forEach((result, index) => {
		if (result.status === "fulfilled") jobs.push(...result.value);
		else errors.push(`${adapters[index][0]}: ${messageOf(result.reason)}`);
	});
	return { host, jobs, errors };
}

function localPlatform(): SSHHostOs {
	if (process.platform === "darwin") return "macos";
	if (process.platform === "linux") return "linux";
	return process.platform === "win32" ? "windows" : "unknown";
}

/** Short hostname used to label this host's rows. */
export function localHostName(): string {
	return os
		.hostname()
		.replace(/\.local$/, "")
		.split(".")[0];
}

const remoteListingSchema = type({ external: "unknown[]", "timers?": "unknown[]", "hosts?": "unknown[]" });

/** The members `parse` accepts; the others are counted, with the first one's fault, in `errors`. */
function validMembers<T>(
	members: unknown[],
	parse: (member: unknown) => T | type.errors,
	what: string,
	errors: string[],
): T[] {
	const valid: T[] = [];
	let firstFault: string | undefined;
	for (const member of members) {
		const parsed = parse(member);
		if (parsed instanceof type.errors) firstFault ??= parsed.summary;
		else valid.push(parsed);
	}
	const skipped = members.length - valid.length;
	if (skipped) errors.push(`remote omp listing: skipped ${skipped} malformed ${what} (${firstFault})`);
	return valid;
}

/**
 * Narrows a remote omp's `timer ls --json --all` output. Throws when it is not such a listing at all; malformed
 * rows, timers and host reports are skipped and counted in `errors`, keeping the rest.
 */
function parseRemoteListing(stdout: string, host: string): { jobs: ExternalJob[]; report: HostReport } {
	const listing = remoteListingSchema(JSON.parse(stdout));
	if (listing instanceof type.errors) throw new Error(listing.summary);
	const errors: string[] = [];
	const jobs = validMembers(listing.external, remoteJobSchema, "external row(s)", errors).map((job): ExternalJob => ({
		host,
		...job,
	}));
	const timers = validMembers(listing.timers ?? [], remoteTimerSchema, "timer(s)", errors);
	const reports = validMembers(listing.hosts ?? [], remoteReportSchema, "host report(s)", errors);
	errors.push(...reports.flatMap(report => report.errors));
	return { jobs, report: { host, via: "omp", timers, errors } };
}

/** The remote's own estate listing; throws, saying why, when its omp cannot give one. */
async function remoteOmpListing(
	run: CommandRunner,
	host: string,
): Promise<{ jobs: ExternalJob[]; report: HostReport }> {
	// An omp without the `timer` command treats `timer ls …` as a prompt and starts an agent; only
	// call `ls` once its help proves it knows `--host` (shipped together with `--all`).
	const help = stdoutOf(await run(["omp", "timer", "--help"]), "`omp timer --help`");
	if (!/--host\b/.test(help)) throw new Error("its omp has no `timer ls --all`");
	const listing = stdoutOf(await run(["omp", "timer", "ls", "--json", "--all"]), "`omp timer ls --json --all`");
	try {
		return parseRemoteListing(listing, host);
	} catch (error) {
		throw new Error(`\`omp timer ls --json --all\` printed an unusable listing: ${messageOf(error)}`);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Scans one remote host: its own omp when it knows `ls --all`, else the adapters over ssh. */
export async function scanRemoteHost(
	name: string,
	run: CommandRunner,
	platform: SSHHostOs,
	now: number,
): Promise<{ jobs: ExternalJob[]; report: HostReport }> {
	try {
		return await remoteOmpListing(run, name);
	} catch (error) {
		const scan = await scanHost(run, platform, name, now);
		return { jobs: scan.jobs, report: { host: name, via: "ssh", fallback: messageOf(error), errors: scan.errors } };
	}
}

/**
 * Resolves `--host` values: `all` expands to every host in omp's ssh config
 * (project, then user; `omp ssh add`), other names look up that config and
 * otherwise go to ssh as-is (so `~/.ssh/config` aliases work).
 */
export async function resolveHosts(names: string[]): Promise<SSHConnectionTarget[]> {
	const [project, user] = await Promise.all([
		readSSHConfigFile(getSSHConfigPath("project")),
		readSSHConfigFile(getSSHConfigPath("user")),
	]);
	const configured = new Map<string, SSHConnectionTarget>();
	for (const hosts of [user.hosts ?? {}, project.hosts ?? {}]) {
		for (const [name, config] of Object.entries(hosts)) {
			configured.set(name, {
				name,
				host: config.host,
				username: config.username,
				port: config.port,
				keyPath: config.keyPath,
				compat: config.compat,
			});
		}
	}
	const targets = new Map<string, SSHConnectionTarget>();
	for (const name of names) {
		if (name === "all") {
			for (const target of configured.values()) targets.set(target.name, target);
		} else {
			targets.set(name, configured.get(name) ?? { name, host: name });
		}
	}
	return [...targets.values()];
}

export interface ScanEstateOptions {
	/** `--host` values (`all` or names); empty scans this host only. */
	hosts: string[];
	now: number;
}

/** Local external estate plus every requested remote host, scanned in parallel. */
export async function scanEstate(options: ScanEstateOptions): Promise<Estate> {
	const local = scanHost(localRunner, localPlatform(), localHostName(), options.now);
	const targets = await resolveHosts(options.hosts);
	const remotes = targets.map(async (target): Promise<{ jobs: ExternalJob[]; report: HostReport }> => {
		try {
			const remote = await connectRemoteRunner(target);
			return await scanRemoteHost(target.name, remote.run, remote.os, options.now);
		} catch (error) {
			return { jobs: [], report: { host: target.name, via: "none", errors: [messageOf(error)] } };
		}
	});
	const localScan = await local;
	const remoteScans = await Promise.all(remotes);
	return {
		jobs: [...localScan.jobs, ...remoteScans.flatMap(scan => scan.jobs)],
		hosts: [
			{ host: localScan.host, via: "local", errors: localScan.errors },
			...remoteScans.map(scan => scan.report),
		],
	};
}
