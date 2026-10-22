import * as path from "node:path";
import { $env, getActiveProfile, getAgentDir } from "@oh-my-pi/pi-utils";
import { mailboxRoot } from "../../mailbox/paths";
import { timersRoot } from "../paths";
import type { TimerHost } from "./host";
import { launchdLastExitCode, launchdPlistPath, launchdTarget, renderTickerPlist } from "./launchd";
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
	/**
	 * Env baked into the unit: PATH, OMP_TIMERS_DIR, OMP_MAILBOX_DIR (absolute roots) and the
	 * installing config identity: OMP_PROFILE or PI_CODING_AGENT_DIR, plus PI_CONFIG_DIR when set
	 * ({@link tickerUnitEnv}).
	 */
	env: Record<string, string>;
	/** Tick stdout/stderr append target. */
	logPath: string;
	/** `lastTickAt` of the store the unit ticks; launchd install waits for one newer than its start. */
	lastTickAt(): string | undefined;
}

/**
 * The unit runs outside any login shell, so it gets this shell's PATH (deduped), the store it ticks,
 * the mailbox its prompt timers post to, and the profile or agent dir whose settings, auth and
 * alert command the tick, runners and headless resumes must use. Nothing credential-bearing.
 */
export function tickerUnitEnv(): Record<string, string> {
	const profile = getActiveProfile();
	const configDir = $env.PI_CONFIG_DIR;
	return {
		PATH: [...new Set(($env.PATH ?? "/usr/bin:/bin").split(path.delimiter).filter(Boolean))].join(path.delimiter),
		OMP_TIMERS_DIR: path.resolve(timersRoot()),
		OMP_MAILBOX_DIR: path.resolve(mailboxRoot()),
		...(configDir ? { PI_CONFIG_DIR: configDir } : {}),
		// The default agent dir resolves the same whether baked or not (XDG still applies), so it is
		// baked too: the unit never falls back to whatever the service manager's env selects.
		...(profile ? { OMP_PROFILE: profile } : { PI_CODING_AGENT_DIR: getAgentDir() }),
	};
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
	/** Why install failed after every command succeeded: launchd's first tick failed or never came. */
	detail?: string;
}

export interface TickerUninstallResult {
	kind: "launchd" | "systemd";
	removed: string[];
	results: TickerCommandResult[];
}

const SYSTEMD_TIMER = `${TICKER_SYSTEMD_UNIT}.timer`;
/** launchd can still be tearing the old job down when bootstrap runs right after bootout. */
const BOOTSTRAP_RETRY_DELAY_MS = 1000;
/** How long install waits for launchd's RunAtLoad tick. */
const FIRST_TICK_TIMEOUT_MS = 30_000;
const FIRST_TICK_POLL_MS = 500;

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
			// Tick once now, like launchd's RunAtLoad: the heartbeat is fresh right after install, and a unit
			// that cannot run fails the install instead of failing silently every minute.
			["systemctl", "--user", "start", `${TICKER_SYSTEMD_UNIT}.service`],
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
	let loadedAt = Date.now();
	for (const argv of plan.commands) {
		let exitCode = await runRecorded(host, argv, results);
		// `launchctl bootout` fails whenever the job is not loaded yet; that is the normal first install.
		if (argv[0] === "launchctl" && argv[1] === "bootout") {
			bootedOut = exitCode === 0;
			loadedAt = Date.now();
			continue;
		}
		if (exitCode !== 0 && bootedOut && argv[1] === "bootstrap") {
			await Bun.sleep(BOOTSTRAP_RETRY_DELAY_MS);
			exitCode = await runRecorded(host, argv, results);
		}
		if (exitCode !== 0) return { plan, results, ok: false };
	}
	if (plan.kind === "launchd" && !host.dryRun) {
		const detail = await awaitFirstLaunchdTick(host, input, loadedAt);
		if (detail) return { plan, results, ok: false, detail };
	}
	return { plan, results, ok: true };
}

/**
 * `launchctl bootstrap` only registers the job; its RunAtLoad tick shows the unit runs. Done at a
 * heartbeat newer than `loadedAt` or a zero exit; failed at a nonzero exit or no exit by the deadline.
 */
async function awaitFirstLaunchdTick(
	host: TimerHost,
	input: TickerUnitInput,
	loadedAt: number,
): Promise<string | undefined> {
	const target = launchdTarget(host);
	for (;;) {
		const lastTickAt = input.lastTickAt();
		if (lastTickAt && Date.parse(lastTickAt) >= loadedAt) return undefined;
		const printed = await host.run(["launchctl", "print", target]);
		const code = printed.exitCode === 0 ? launchdLastExitCode(printed.stdout) : undefined;
		if (code === 0) return undefined;
		if (code !== undefined) return `the first tick exited ${code} (log ${input.logPath})`;
		if (Date.now() - loadedAt >= FIRST_TICK_TIMEOUT_MS) {
			return `${target} did not tick within ${FIRST_TICK_TIMEOUT_MS / 1000}s of loading (log ${input.logPath})`;
		}
		await Bun.sleep(FIRST_TICK_POLL_MS);
	}
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
