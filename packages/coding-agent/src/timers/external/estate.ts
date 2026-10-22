/**
 * `omp timer ls --all [--host H]`: merge the external estate of this host and
 * any remote hosts. A remote host is asked for `omp timer ls --json --all`
 * first; when its omp predates that, the same read-only adapters run over ssh
 * and parse here.
 */
import * as os from "node:os";
import { getSSHConfigPath } from "@oh-my-pi/pi-utils";
import type { SSHConnectionTarget, SSHHostOs } from "../../ssh/connection-manager";
import { readSSHConfigFile } from "../../ssh/config-writer";
import { scanCrontab } from "./crontab";
import { scanLaunchd } from "./launchd";
import { connectRemoteRunner, localRunner } from "./runner";
import { scanSystemd } from "./systemd";
import type { CommandRunner, EstateScan, ExternalJob } from "./types";

export interface HostReport {
	host: string;
	/** `local`: this process; `omp`: the remote's own `omp timer ls --json --all`; `ssh`: adapters run over ssh. */
	via: "local" | "omp" | "ssh";
	/** The remote omp's own timers (`via: "omp"` only), as its `ls --json` printed them. */
	timers?: unknown[];
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
	const adapters: Array<[string, () => Promise<ExternalJob[]>]> =
		platform === "macos"
			? [
					["launchd", () => scanLaunchd(run, host, now)],
					["crontab", () => scanCrontab(run, host, now)],
				]
			: platform === "linux"
				? [
						["systemd --user", () => scanSystemd(run, "user", host)],
						["systemd system", () => scanSystemd(run, "system", host)],
						["crontab", () => scanCrontab(run, host, now)],
					]
				: [];
	if (adapters.length === 0) return { host, jobs: [], errors: [`unsupported host OS: ${platform}`] };
	const settled = await Promise.allSettled(adapters.map(([, scan]) => scan()));
	const jobs: ExternalJob[] = [];
	const errors: string[] = [];
	settled.forEach((result, index) => {
		if (result.status === "fulfilled") jobs.push(...result.value);
		else
			errors.push(
				`${adapters[index][0]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
			);
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

interface RemoteLs {
	timers?: unknown[];
	external?: ExternalJob[];
	hosts?: HostReport[];
}

/** Scans one remote host: its own omp when it knows `ls --all`, else the adapters over ssh. */
export async function scanRemoteHost(
	name: string,
	run: CommandRunner,
	platform: SSHHostOs,
	now: number,
): Promise<{ jobs: ExternalJob[]; report: HostReport }> {
	// An omp without the `timer` command treats `timer ls …` as a prompt and starts an agent; only
	// call `ls` once its help proves it knows `--host` (shipped together with `--all`).
	const help = await run(["omp", "timer", "--help"]);
	const knowsEstate = help.code === 0 && /--host\b/.test(help.stdout);
	const viaOmp = knowsEstate ? await run(["omp", "timer", "ls", "--json", "--all"]) : undefined;
	if (viaOmp?.code === 0) {
		try {
			const parsed = JSON.parse(viaOmp.stdout) as RemoteLs;
			if (Array.isArray(parsed.external)) {
				return {
					jobs: parsed.external.map(job => ({ ...job, host: name })),
					report: {
						host: name,
						via: "omp",
						timers: parsed.timers ?? [],
						errors: (parsed.hosts ?? []).flatMap(report => report.errors),
					},
				};
			}
		} catch {
			// An older omp printed something else; fall through to the adapters.
		}
	}
	const scan = await scanHost(run, platform, name, now);
	return { jobs: scan.jobs, report: { host: name, via: "ssh", errors: scan.errors } };
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
	const remotes = targets.map(async target => {
		try {
			const remote = await connectRemoteRunner(target);
			return await scanRemoteHost(target.name, remote.run, remote.os, options.now);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { jobs: [], report: { host: target.name, via: "ssh", errors: [message] } as HostReport };
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
