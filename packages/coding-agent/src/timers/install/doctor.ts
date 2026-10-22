import * as path from "node:path";
import type { TimerHost } from "./host";
import { launchdPlistPath, launchdTarget, readTickerPlist } from "./launchd";
import { tickerKind } from "./plan";
import { readTickerService, systemdServicePath, systemdTimerPath, TICKER_SYSTEMD_UNIT } from "./systemd";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
	name: string;
	status: DoctorStatus;
	detail: string;
}

export interface DoctorInput {
	now: number;
	timersRoot: string;
	/** `VERSION` from @oh-my-pi/pi-utils. */
	currentVersion: string;
	/** What install would bake in now. */
	ompCommand: string[];
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

/** The ticker fires every minute; three missed minutes means it is not running. */
const STALE_TICK_MS = 3 * 60_000;

function formatAge(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 120) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 120) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
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
	}

	const baked = kind === "launchd" ? readTickerPlist(content) : readTickerService(content);
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
	const binary = baked.argv[0];
	checks.push(
		binary && (await host.exists(binary))
			? { name: "unit binary", status: "ok", detail: binary }
			: {
					name: "unit binary",
					status: "fail",
					detail: `${binary || "(empty command)"} does not exist (stale binary path); re-run omp timer install`,
				},
	);
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
}

function heartbeatCheck(input: DoctorInput): DoctorCheck {
	const { lastTickAt } = input.ticker;
	if (!lastTickAt) return { name: "last tick", status: "fail", detail: "the ticker has never run" };
	const at = Date.parse(lastTickAt);
	if (Number.isNaN(at)) return { name: "last tick", status: "fail", detail: `unreadable heartbeat "${lastTickAt}"` };
	const age = input.now - at;
	return age > STALE_TICK_MS
		? { name: "last tick", status: "fail", detail: `last tick ${formatAge(age)} ago; the ticker is not running` }
		: { name: "last tick", status: "ok", detail: `last tick ${formatAge(age)} ago` };
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
