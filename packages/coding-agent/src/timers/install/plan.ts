import * as path from "node:path";
import type { TimerHost } from "./host";
import { launchdPlistPath, launchdTarget, renderTickerPlist } from "./launchd";
import {
	renderTickerService,
	renderTickerTimer,
	systemdServicePath,
	systemdTimerPath,
	TICKER_SYSTEMD_UNIT,
} from "./systemd";

export interface TickerUnitInput {
	/** Absolute argv prefix that re-enters omp (`resolveCliEntryCmd()`). */
	ompCommand: string[];
	/** Env baked into the unit: always PATH and OMP_TIMERS_DIR (absolute store root). */
	env: Record<string, string>;
	/** Tick stdout/stderr append target. */
	logPath: string;
}

export interface TickerUnitFile {
	path: string;
	content: string;
}

export interface TickerPlan {
	kind: "launchd" | "systemd";
	files: TickerUnitFile[];
	/** OS commands install runs, in order. */
	commands: string[][];
}

export interface TickerCommandResult {
	argv: string[];
	exitCode: number;
	stderr: string;
}

export interface TickerInstallResult {
	plan: TickerPlan;
	results: TickerCommandResult[];
	ok: boolean;
}

export interface TickerUninstallResult {
	kind: "launchd" | "systemd";
	removed: string[];
	results: TickerCommandResult[];
}

const SYSTEMD_TIMER = `${TICKER_SYSTEMD_UNIT}.timer`;
/** launchd can still be tearing the old job down when bootstrap runs right after bootout. */
const BOOTSTRAP_RETRY_DELAY_MS = 1000;

export function tickerKind(host: TimerHost): "launchd" | "systemd" {
	if (host.platform === "darwin") return "launchd";
	if (host.platform === "linux") return "systemd";
	throw new Error(
		`omp timer ticker: unsupported platform "${host.platform}" (supported: macOS launchd, Linux systemd --user)`,
	);
}

/** Pure: what install would write/run for this host. Throws on unsupported platforms. */
export function planTickerInstall(host: TimerHost, input: TickerUnitInput): TickerPlan {
	if (input.ompCommand.length === 0) throw new Error("omp timer ticker: ompCommand must not be empty");
	if (tickerKind(host) === "launchd") {
		const plist = launchdPlistPath(host);
		return {
			kind: "launchd",
			files: [{ path: plist, content: renderTickerPlist(input) }],
			commands: [
				["launchctl", "bootout", launchdTarget(host)],
				["launchctl", "bootstrap", `gui/${host.uid}`, plist],
			],
		};
	}
	return {
		kind: "systemd",
		files: [
			{ path: systemdServicePath(host), content: renderTickerService(input) },
			{ path: systemdTimerPath(host), content: renderTickerTimer() },
		],
		commands: [
			["systemctl", "--user", "daemon-reload"],
			["systemctl", "--user", "enable", "--now", SYSTEMD_TIMER],
		],
	};
}

async function runRecorded(host: TimerHost, argv: string[], results: TickerCommandResult[]) {
	const { exitCode, stderr } = await host.run(argv);
	results.push({ argv, exitCode, stderr });
	return exitCode;
}

/** Writes the unit files and (re)loads the ticker. Stops at the first command failure that matters. */
export async function installTicker(host: TimerHost, input: TickerUnitInput): Promise<TickerInstallResult> {
	const plan = planTickerInstall(host, input);
	for (const file of plan.files) await host.writeFile(file.path, file.content);
	// systemd's `append:` does not create the log's directory: on a host with no timer store yet, every tick fails with 209/STDOUT.
	await host.makeDir(path.dirname(input.logPath));
	const results: TickerCommandResult[] = [];
	let bootedOut = false;
	for (const argv of plan.commands) {
		let exitCode = await runRecorded(host, argv, results);
		// `launchctl bootout` fails whenever the job is not loaded yet; that is the normal first install.
		if (argv[0] === "launchctl" && argv[1] === "bootout") {
			bootedOut = exitCode === 0;
			continue;
		}
		if (exitCode !== 0 && bootedOut && argv[1] === "bootstrap") {
			await Bun.sleep(BOOTSTRAP_RETRY_DELAY_MS);
			exitCode = await runRecorded(host, argv, results);
		}
		if (exitCode !== 0) return { plan, results, ok: false };
	}
	return { plan, results, ok: true };
}

/** Unloads the ticker and removes its unit files. Command failures are reported, not thrown. */
export async function uninstallTicker(host: TimerHost): Promise<TickerUninstallResult> {
	const kind = tickerKind(host);
	const results: TickerCommandResult[] = [];
	const removed: string[] = [];
	if (kind === "launchd") {
		await runRecorded(host, ["launchctl", "bootout", launchdTarget(host)], results);
		const plist = launchdPlistPath(host);
		if (await host.removeFile(plist)) removed.push(plist);
		return { kind, removed, results };
	}
	await runRecorded(host, ["systemctl", "--user", "disable", "--now", SYSTEMD_TIMER], results);
	for (const file of [systemdServicePath(host), systemdTimerPath(host)]) {
		if (await host.removeFile(file)) removed.push(file);
	}
	await runRecorded(host, ["systemctl", "--user", "daemon-reload"], results);
	return { kind, removed, results };
}
