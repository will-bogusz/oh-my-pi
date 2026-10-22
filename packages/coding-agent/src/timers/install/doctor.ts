import * as path from "node:path";
import { tickAge } from "../render";
import type { TimerHost } from "./host";
import { launchdLastExitCode, launchdPlistPath, launchdTarget, readTickerPlist } from "./launchd";
import { tickerKind } from "./plan";
import { readTickerService, systemdServicePath, systemdTimerPath, TICKER_SYSTEMD_UNIT } from "./systemd";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
	name: string;
	status: DoctorStatus;
	detail: string;
	/** Tail of the unit's log or journal, newest last. */
	log?: string[];
}

export interface DoctorInput {
	now: number;
	timersRoot: string;
	/** `VERSION` from @oh-my-pi/pi-utils. */
	currentVersion: string;
	/** What install would bake in now. */
	ompCommand: string[];
	/** Env install would bake in now (`tickerUnitEnv()`); its profile or agent dir is compared. */
	unitEnv: Record<string, string>;
	/** Heartbeat from the store. */
	ticker: { lastTickAt?: string; version?: string; pid?: number };
	store: { writable: boolean; schemaVersion?: number; expectedSchemaVersion: number; error?: string };
}

export interface DoctorReport {
	kind: "launchd" | "systemd" | "unsupported";
	checks: DoctorCheck[];
	/** No check failed. */
	ok: boolean;
}

/** Lines of unit log or journal shown with a failed last run. */
const LOG_TAIL_LINES = 5;

function tail(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trimEnd())
		.filter(Boolean)
		.slice(-LOG_TAIL_LINES);
}

/**
 * The recorded invocation must still run: the binary is executable and, for a source install,
 * the entry script (`…/src/cli.ts`) still exists. A deleted worktree or moved install fails every tick.
 */
async function invocationChecks(host: TimerHost, argv: string[]): Promise<DoctorCheck[]> {
	const prefix = argv.slice(0, -2); // drop "timer tick"
	const [binary, ...rest] = prefix;
	const rerun = "every tick fails; re-run omp timer install from a working omp";
	const checks: DoctorCheck[] = [
		binary && path.isAbsolute(binary) && (await host.isExecutable(binary))
			? { name: "unit binary", status: "ok", detail: binary }
			: {
					name: "unit binary",
					status: "fail",
					detail: `${binary || "(empty command)"} is missing or not executable; ${rerun}`,
				},
	];
	for (const arg of rest) {
		if (!path.isAbsolute(arg)) continue;
		checks.push(
			(await host.exists(arg))
				? { name: "unit entry", status: "ok", detail: arg }
				: { name: "unit entry", status: "fail", detail: `${arg} does not exist; ${rerun}` },
		);
	}
	return checks;
}

/** Parses `systemctl show -p …` output (`Key=value` lines). */
function parseShow(stdout: string): Record<string, string> {
	const props: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1).trim();
	}
	return props;
}

/** `ExecMainCode` is a `CLD_*` code from waitid(2). */
const CLD_CODES: Record<string, string> = { "1": "exited", "2": "killed", "3": "dumped core" };

async function systemdLastRun(host: TimerHost): Promise<DoctorCheck | undefined> {
	const service = `${TICKER_SYSTEMD_UNIT}.service`;
	const shown = await host.run([
		"systemctl",
		"--user",
		"show",
		service,
		"-p",
		"Result",
		"-p",
		"ExecMainCode",
		"-p",
		"ExecMainStatus",
		"-p",
		"ExecMainExitTimestamp",
	]);
	if (shown.exitCode !== 0) return undefined;
	const props = parseShow(shown.stdout);
	if (!props.ExecMainExitTimestamp) return undefined; // has not run since it was loaded
	const code = props.ExecMainCode ?? "";
	const status = props.ExecMainStatus ?? "";
	const result = props.Result ?? "";
	if (result === "success" && (code !== "1" || status === "0")) {
		return { name: "last run", status: "ok", detail: `${service} exited 0` };
	}
	const how = CLD_CODES[code] ?? `code ${code || "?"}`;
	const journal = await host.run([
		"journalctl",
		"--user",
		"-u",
		service,
		"-n",
		String(LOG_TAIL_LINES),
		"--no-pager",
		"-o",
		"cat",
	]);
	return {
		name: "last run",
		status: "fail",
		detail: `${service} failed: Result=${result || "?"}, ${how} with status ${status || "?"} (journalctl --user -u ${service})`,
		log: journal.exitCode === 0 ? tail(journal.stdout) : undefined,
	};
}

async function launchdLastRun(
	host: TimerHost,
	printed: string,
	logPath: string | undefined,
): Promise<DoctorCheck | undefined> {
	const code = launchdLastExitCode(printed);
	if (code === undefined) return undefined;
	if (code === 0) return { name: "last run", status: "ok", detail: "exited 0" };
	const log = logPath ? await host.readFile(logPath) : undefined;
	return {
		name: "last run",
		status: "fail",
		detail: `last exit code ${code}${logPath ? ` (log ${logPath})` : ""}`,
		log: log === undefined ? undefined : tail(log),
	};
}

/** The profile or agent dir (and config dir) a unit env selects for settings, auth and the alert command. */
function configIdentity(env: Record<string, string>): string {
	const selected = env.OMP_PROFILE
		? `profile ${env.OMP_PROFILE}`
		: env.PI_CODING_AGENT_DIR
			? `agent dir ${env.PI_CODING_AGENT_DIR}`
			: "no profile or agent dir";
	return env.PI_CONFIG_DIR ? `${selected} in config dir ${env.PI_CONFIG_DIR}` : selected;
}

async function unitChecks(
	host: TimerHost,
	kind: "launchd" | "systemd",
	input: DoctorInput,
	checks: DoctorCheck[],
): Promise<void> {
	const unitPath = kind === "launchd" ? launchdPlistPath(host) : systemdServicePath(host);
	const content = await host.readFile(unitPath);
	const timerMissing = kind === "systemd" && !(await host.exists(systemdTimerPath(host)));
	if (content === undefined || timerMissing) {
		checks.push({
			name: "unit installed",
			status: "fail",
			detail: `${timerMissing && content !== undefined ? systemdTimerPath(host) : unitPath} is missing; run omp timer install`,
		});
		return;
	}
	checks.push({ name: "unit installed", status: "ok", detail: unitPath });
	const baked = kind === "launchd" ? readTickerPlist(content) : readTickerService(content);

	let lastRun: DoctorCheck | undefined;
	if (host.dryRun) {
		checks.push({ name: "unit loaded", status: "warn", detail: "not checked (dry run: no launchctl/systemctl ran)" });
	} else if (kind === "launchd") {
		const target = launchdTarget(host);
		const printed = await host.run(["launchctl", "print", target]);
		checks.push(
			printed.exitCode === 0
				? { name: "unit loaded", status: "ok", detail: `${target} is loaded` }
				: { name: "unit loaded", status: "fail", detail: `${target} is not loaded; run omp timer install` },
		);
		if (printed.exitCode === 0)
			lastRun = await launchdLastRun(host, printed.stdout, readTickerPlist(content)?.logPath);
	} else {
		const timer = `${TICKER_SYSTEMD_UNIT}.timer`;
		const active = (await host.run(["systemctl", "--user", "is-active", timer])).stdout.trim();
		checks.push(
			active === "active"
				? { name: "unit loaded", status: "ok", detail: `${timer} is active` }
				: {
						name: "unit loaded",
						status: "fail",
						detail: `${timer} is ${active || "not active"}; run omp timer install`,
					},
		);
		lastRun = await systemdLastRun(host);
	}
	if (lastRun) checks.push(lastRun);

	if (!baked) {
		checks.push({ name: "unit command", status: "fail", detail: `cannot parse ${unitPath}; run omp timer install` });
		return;
	}
	const expected = [...input.ompCommand, "timer", "tick"];
	const matches = baked.argv.length === expected.length && baked.argv.every((arg, i) => arg === expected[i]);
	checks.push(
		matches
			? { name: "unit command", status: "ok", detail: baked.argv.join(" ") }
			: {
					name: "unit command",
					status: "warn",
					detail: `unit runs \`${baked.argv.join(" ")}\`, this omp is \`${expected.join(" ")}\`; re-run omp timer install`,
				},
	);
	checks.push(...(await invocationChecks(host, baked.argv)));
	const unitRoot = baked.env.OMP_TIMERS_DIR;
	checks.push(
		unitRoot && path.resolve(unitRoot) === path.resolve(input.timersRoot)
			? { name: "unit store", status: "ok", detail: unitRoot }
			: {
					name: "unit store",
					status: "warn",
					detail: `unit ticks ${unitRoot ?? "(no OMP_TIMERS_DIR)"}, not ${input.timersRoot}; re-run omp timer install`,
				},
	);
	const unitConfig = configIdentity(baked.env);
	const config = configIdentity(input.unitEnv);
	checks.push(
		unitConfig === config
			? { name: "unit config", status: "ok", detail: unitConfig }
			: {
					name: "unit config",
					status: "warn",
					detail: `unit uses ${unitConfig}, this omp uses ${config}; re-run omp timer install`,
				},
	);
}

function heartbeatCheck(input: DoctorInput): DoctorCheck {
	const { lastTickAt } = input.ticker;
	if (!lastTickAt) return { name: "last tick", status: "fail", detail: "the ticker has never run" };
	const age = tickAge(lastTickAt, input.now);
	if (!age) return { name: "last tick", status: "fail", detail: `unreadable heartbeat "${lastTickAt}"` };
	return age.stale
		? { name: "last tick", status: "fail", detail: `${age.text}; the ticker is not running` }
		: { name: "last tick", status: "ok", detail: age.text };
}

function storeChecks(input: DoctorInput): DoctorCheck[] {
	const { store } = input;
	const checks: DoctorCheck[] = [
		store.writable
			? { name: "store writable", status: "ok", detail: input.timersRoot }
			: {
					name: "store writable",
					status: "fail",
					detail: `${input.timersRoot} is not writable: ${store.error ?? "unknown error"}`,
				},
	];
	const expected = store.expectedSchemaVersion;
	if (store.schemaVersion === undefined) {
		checks.push({
			name: "store schema",
			status: "warn",
			detail: `no schema version recorded (expected v${expected})`,
		});
	} else if (store.schemaVersion > expected) {
		checks.push({
			name: "store schema",
			status: "fail",
			detail: `store schema v${store.schemaVersion} was written by a newer omp (this omp reads v${expected}); upgrade omp`,
		});
	} else if (store.schemaVersion < expected) {
		checks.push({
			name: "store schema",
			status: "warn",
			detail: `store schema v${store.schemaVersion} is older than v${expected}`,
		});
	} else {
		checks.push({ name: "store schema", status: "ok", detail: `v${expected}` });
	}
	const tickerVersion = input.ticker.version;
	if (tickerVersion !== undefined) {
		checks.push(
			tickerVersion === input.currentVersion
				? { name: "ticker version", status: "ok", detail: tickerVersion }
				: {
						name: "ticker version",
						status: "warn",
						detail: `the unit runs omp ${tickerVersion}, this is omp ${input.currentVersion}; re-run omp timer install`,
					},
		);
	}
	return checks;
}

/** Diagnoses the installed ticker unit plus the store heartbeat/schema it reports. Never throws on host failures. */
export async function doctorTicker(host: TimerHost, input: DoctorInput): Promise<DoctorReport> {
	const checks: DoctorCheck[] = [];
	let kind: DoctorReport["kind"];
	try {
		kind = tickerKind(host);
	} catch (err) {
		kind = "unsupported";
		checks.push({ name: "platform", status: "fail", detail: err instanceof Error ? err.message : String(err) });
	}
	if (kind !== "unsupported") await unitChecks(host, kind, input, checks);
	checks.push(heartbeatCheck(input), ...storeChecks(input));
	if (kind === "systemd" && !host.dryRun) {
		const linger = (await host.run(["loginctl", "show-user", host.user, "-p", "Linger"])).stdout.trim();
		checks.push(
			linger === "Linger=yes"
				? { name: "linger", status: "ok", detail: "user timers keep running after logout" }
				: {
						name: "linger",
						status: "warn",
						detail: `linger is off: timers stop at logout; run loginctl enable-linger ${host.user}`,
					},
		);
	}
	return { kind, checks, ok: checks.every(check => check.status !== "fail") };
}
