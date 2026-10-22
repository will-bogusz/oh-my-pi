import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createTimerHost,
	type DoctorInput,
	doctorTicker,
	type HostCommandResult,
	installTicker,
	type PlistValue,
	parsePlist,
	planTickerInstall,
	splitSystemdWords,
	type TickerUnitInput,
	type TimerHost,
	tickerUnitEnv,
	uninstallTicker,
} from "@oh-my-pi/pi-coding-agent/timers/install/index";
import { describeTicker } from "@oh-my-pi/pi-coding-agent/timers/render";
import { __resetDirsFromEnvForTests, getAgentDir, setAgentDir, setProfile, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const HOME = "/home/tester";
const BIN = "/opt/omp & co/bin/omp";

class FakeHost implements TimerHost {
	files = new Map<string, string>();
	dirs = new Set<string>();
	commands: string[][] = [];
	/** Scripted results keyed by argv joined with spaces; unscripted commands succeed. */
	script = new Map<string, Partial<HostCommandResult>>();
	home = HOME;
	uid = 501;
	user = "tester";

	constructor(public platform: NodeJS.Platform) {}

	async run(argv: string[]): Promise<HostCommandResult> {
		this.commands.push(argv);
		return { exitCode: 0, stdout: "", stderr: "", ...this.script.get(argv.join(" ")) };
	}
	async readFile(file: string) {
		return this.files.get(file);
	}
	async writeFile(file: string, content: string) {
		this.files.set(file, content);
	}
	async removeFile(file: string) {
		return this.files.delete(file);
	}
	async exists(file: string) {
		return this.files.has(file);
	}
	async makeDir(dir: string) {
		this.dirs.add(dir);
	}
	/** Files that exist but lack the execute bit. */
	notExecutable = new Set<string>();
	async isExecutable(file: string) {
		return this.files.has(file) && !this.notExecutable.has(file);
	}
}

const UNIT_ENV = {
	PATH: "/usr/bin:/bin",
	OMP_TIMERS_DIR: "/home/tester/.omp/timers",
	PI_CODING_AGENT_DIR: "/home/tester/.omp/agent",
};
const LAUNCHCTL_PRINT = "launchctl print gui/501/sh.omp.timer-tick";

function unitInput(overrides: Partial<TickerUnitInput> = {}): TickerUnitInput {
	return {
		ompCommand: [BIN],
		env: UNIT_ENV,
		logPath: "/home/tester/.omp/timers/tick.log",
		lastTickAt: () => new Date().toISOString(),
		...overrides,
	};
}

const tempDirs: TempDir[] = [];
afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

/** Parses with macOS `plutil` when present, so the plist is checked by launchd's own parser family. */
async function parseWithSystemTool(xml: string): Promise<PlistValue> {
	if (!Bun.which("plutil")) return parsePlist(xml);
	const dir = await TempDir.create("omp-plist-");
	tempDirs.push(dir);
	const file = path.join(dir.path(), "unit.plist");
	await Bun.write(file, xml);
	return JSON.parse(await $`plutil -convert json -o - ${file}`.quiet().text());
}

describe("launchd ticker unit", () => {
	it("bakes the omp command, every-minute calendar, env and log path into a valid plist", async () => {
		const host = new FakeHost("darwin");
		const plan = planTickerInstall(host, unitInput({ ompCommand: ["/usr/local/bin/bun", BIN] }));
		expect(plan.files.map(file => file.path)).toEqual([`${HOME}/Library/LaunchAgents/sh.omp.timer-tick.plist`]);
		const parsed = await parseWithSystemTool(plan.files[0].content);
		expect(parsed).toEqual({
			Label: "sh.omp.timer-tick",
			ProgramArguments: ["/usr/local/bin/bun", BIN, "timer", "tick"],
			StartCalendarInterval: {},
			RunAtLoad: true,
			AbandonProcessGroup: true,
			ProcessType: "Standard",
			EnvironmentVariables: UNIT_ENV,
			StandardOutPath: "/home/tester/.omp/timers/tick.log",
			StandardErrorPath: "/home/tester/.omp/timers/tick.log",
		});
	});

	it("tolerates bootout failing on first install and bootstraps the written plist", async () => {
		const host = new FakeHost("darwin");
		host.script.set("launchctl bootout gui/501/sh.omp.timer-tick", { exitCode: 3, stderr: "No such process" });
		const result = await installTicker(host, unitInput());
		const plist = `${HOME}/Library/LaunchAgents/sh.omp.timer-tick.plist`;
		expect(result.ok).toBe(true);
		expect(host.files.has(plist)).toBe(true);
		expect(host.commands).toEqual([
			["launchctl", "bootout", "gui/501/sh.omp.timer-tick"],
			["launchctl", "bootstrap", "gui/501", plist],
		]);
	});

	it("reports install failure when bootstrap fails", async () => {
		const host = new FakeHost("darwin");
		host.script.set("launchctl bootout gui/501/sh.omp.timer-tick", { exitCode: 3 });
		host.script.set(`launchctl bootstrap gui/501 ${HOME}/Library/LaunchAgents/sh.omp.timer-tick.plist`, {
			exitCode: 5,
			stderr: "Bootstrap failed: 5: Input/output error",
		});
		const result = await installTicker(host, unitInput());
		expect(result.ok).toBe(false);
		expect(result.results.at(-1)).toMatchObject({ exitCode: 5, stderr: "Bootstrap failed: 5: Input/output error" });
	});

	it("fails the install with the exit code of launchd's first tick", async () => {
		const host = new FakeHost("darwin");
		host.script.set(LAUNCHCTL_PRINT, { stdout: "gui/501/sh.omp.timer-tick = {\n\tlast exit code = 78\n}\n" });
		const stale = new Date(Date.now() - 60_000).toISOString();
		const result = await installTicker(host, unitInput({ lastTickAt: () => stale }));
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("exited 78");
		expect(result.detail).toContain("/home/tester/.omp/timers/tick.log");
	});

	it("installs once launchd's first tick writes a heartbeat newer than the load", async () => {
		const host = new FakeHost("darwin");
		host.script.set(LAUNCHCTL_PRINT, { stdout: "\tlast exit code = (never exited)\n" });
		// The first poll sees the previous install's heartbeat; the RunAtLoad tick lands before the second.
		let heartbeat = new Date(Date.now() - 60_000).toISOString();
		const lastTickAt = () => {
			const seen = heartbeat;
			heartbeat = new Date().toISOString();
			return seen;
		};
		const result = await installTicker(host, unitInput({ lastTickAt }));
		expect(result.ok).toBe(true);
		expect(result.detail).toBeUndefined();
		expect(host.commands.filter(argv => argv.join(" ") === LAUNCHCTL_PRINT)).toHaveLength(1);
	});

	it("uninstall boots the job out and removes the plist", async () => {
		const host = new FakeHost("darwin");
		await installTicker(host, unitInput());
		host.commands = [];
		const result = await uninstallTicker(host);
		expect(result.removed).toEqual([`${HOME}/Library/LaunchAgents/sh.omp.timer-tick.plist`]);
		expect(host.files.size).toBe(0);
		expect(host.commands).toEqual([["launchctl", "bootout", "gui/501/sh.omp.timer-tick"]]);
	});
});

describe("systemd ticker unit", () => {
	const service = `${HOME}/.config/systemd/user/omp-timer-tick.service`;
	const timer = `${HOME}/.config/systemd/user/omp-timer-tick.timer`;

	it("quotes ExecStart words so paths with spaces, $ and % survive systemd parsing", () => {
		const host = new FakeHost("linux");
		const odd = "/opt/my omp/100%/$HOME/omp";
		const plan = planTickerInstall(host, unitInput({ ompCommand: [odd] }));
		const unit = plan.files.find(file => file.path === service)!.content;
		const execStart = unit.split("\n").find(line => line.startsWith("ExecStart="))!;
		expect(execStart).toBe('ExecStart="/opt/my omp/100%%/$$HOME/omp" "timer" "tick"');
		expect(splitSystemdWords(execStart.slice("ExecStart=".length), true)).toEqual([odd, "timer", "tick"]);
		expect(unit).toContain('Environment="OMP_TIMERS_DIR=/home/tester/.omp/timers"');
		expect(unit).toContain("KillMode=process");
		expect(unit).toContain("StandardOutput=append:/home/tester/.omp/timers/tick.log");
		const timerUnit = plan.files.find(file => file.path === timer)!.content;
		expect(timerUnit).toContain("OnCalendar=minutely");
		expect(timerUnit).toContain("Persistent=true");
		expect(timerUnit).toContain("Unit=omp-timer-tick.service");
		expect(timerUnit).toContain("WantedBy=timers.target");
	});

	it("installs by creating the log directory, reloading, enabling the timer, then ticking once", async () => {
		const host = new FakeHost("linux");
		const result = await installTicker(host, unitInput());
		expect(result.ok).toBe(true);
		expect([...host.files.keys()].sort()).toEqual([service, timer]);
		expect([...host.dirs]).toEqual(["/home/tester/.omp/timers"]);
		expect(host.commands).toEqual([
			["systemctl", "--user", "daemon-reload"],
			["systemctl", "--user", "enable", "--now", "omp-timer-tick.timer"],
			["systemctl", "--user", "start", "omp-timer-tick.service"],
		]);
	});

	it("reports install failure when the first tick fails", async () => {
		const host = new FakeHost("linux");
		host.script.set("systemctl --user start omp-timer-tick.service", {
			exitCode: 1,
			stderr: "Job for omp-timer-tick.service failed because the control process exited with error code.",
		});
		const result = await installTicker(host, unitInput());
		expect(result.ok).toBe(false);
		expect(result.results.at(-1)?.argv).toEqual(["systemctl", "--user", "start", "omp-timer-tick.service"]);
	});

	it("uninstall disables the timer, removes both units and reloads", async () => {
		const host = new FakeHost("linux");
		await installTicker(host, unitInput());
		host.commands = [];
		const result = await uninstallTicker(host);
		expect(result.removed.sort()).toEqual([service, timer]);
		expect(host.files.size).toBe(0);
		expect(host.commands).toEqual([
			["systemctl", "--user", "disable", "--now", "omp-timer-tick.timer"],
			["systemctl", "--user", "daemon-reload"],
		]);
	});
});

it("rejects unsupported platforms with a clear error", async () => {
	const host = new FakeHost("win32");
	expect(() => planTickerInstall(host, unitInput())).toThrow(/unsupported platform "win32"/);
	await expect(uninstallTicker(host)).rejects.toThrow(/unsupported platform/);
});

it("dry-run host writes, creates and runs nothing", async () => {
	if (process.platform !== "darwin" && process.platform !== "linux") return;
	const dir = await TempDir.create("omp-ticker-home-");
	tempDirs.push(dir);
	const host = createTimerHost({ dryRun: true, home: dir.path() });
	const store = path.join(dir.path(), "fresh", "timers");
	const result = await installTicker(host, unitInput({ logPath: path.join(store, "tick.log") }));
	expect(result.ok).toBe(true);
	expect(fs.readdirSync(dir.path())).toEqual([]);
	expect(host.commands).toEqual(result.plan.commands);
	expect(result.results.every(r => r.stderr === "(dry run)")).toBe(true);
});

it("dry-run uninstall reports the unit files without removing them", async () => {
	if (process.platform !== "darwin" && process.platform !== "linux") return;
	const dir = await TempDir.create("omp-ticker-home-");
	tempDirs.push(dir);
	const real = createTimerHost({ home: dir.path() });
	const plan = planTickerInstall(real, unitInput());
	for (const file of plan.files) await real.writeFile(file.path, file.content);
	const result = await uninstallTicker(createTimerHost({ dryRun: true, home: dir.path() }));
	expect(result.removed.sort()).toEqual(plan.files.map(file => file.path).sort());
	for (const file of plan.files) expect(fs.existsSync(file.path)).toBe(true);
});

it("real host isExecutable needs an executable regular file", async () => {
	if (process.platform !== "darwin" && process.platform !== "linux") return;
	const dir = await TempDir.create("omp-ticker-exec-");
	tempDirs.push(dir);
	const host = createTimerHost();
	const script = path.join(dir.path(), "omp");
	await Bun.write(script, "#!/bin/sh\n");
	expect(await host.isExecutable(script)).toBe(false);
	fs.chmodSync(script, 0o755);
	expect(await host.isExecutable(script)).toBe(true);
	expect(await host.isExecutable(dir.path())).toBe(false);
	expect(await host.isExecutable(path.join(dir.path(), "missing"))).toBe(false);
});

describe("doctorTicker", () => {
	const NOW = Date.parse("2026-10-22T12:00:00Z");

	function doctorInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
		return {
			now: NOW,
			timersRoot: "/home/tester/.omp/timers",
			currentVersion: "15.0.0",
			ompCommand: [BIN],
			unitEnv: UNIT_ENV,
			ticker: { lastTickAt: new Date(NOW - 30_000).toISOString(), version: "15.0.0", pid: 42 },
			store: { writable: true, schemaVersion: 1, expectedSchemaVersion: 1 },
			...overrides,
		};
	}

	const SYSTEMD_SHOW =
		"systemctl --user show omp-timer-tick.service -p Result -p ExecMainCode -p ExecMainStatus -p ExecMainExitTimestamp";

	async function healthyHost(platform: "darwin" | "linux"): Promise<FakeHost> {
		const host = new FakeHost(platform);
		await installTicker(host, unitInput());
		host.files.set(BIN, "binary");
		host.script.set("systemctl --user is-active omp-timer-tick.timer", { stdout: "active\n" });
		host.script.set("loginctl show-user tester -p Linger", { stdout: "Linger=yes\n" });
		return host;
	}

	function statuses(checks: { name: string; status: string }[]): Record<string, string> {
		return Object.fromEntries(checks.map(check => [check.name, check.status]));
	}

	it.each(["darwin", "linux"] as const)("passes every check for a healthy %s install", async platform => {
		const report = await doctorTicker(await healthyHost(platform), doctorInput());
		expect(report.ok).toBe(true);
		expect(report.checks.filter(check => check.status !== "ok")).toEqual([]);
	});

	it("fails when no unit is installed", async () => {
		const report = await doctorTicker(new FakeHost("darwin"), doctorInput());
		expect(report.ok).toBe(false);
		const installed = report.checks.find(check => check.name === "unit installed")!;
		expect(installed.status).toBe("fail");
		expect(installed.detail).toContain("omp timer install");
	});

	it("maps each unhealthy input to its status", async () => {
		const cases: { name: string; check: string; status: string; mutate: (host: FakeHost) => DoctorInput }[] = [
			{
				name: "stale tick",
				check: "last tick",
				status: "fail",
				mutate: () => doctorInput({ ticker: { lastTickAt: new Date(NOW - 4 * 60_000).toISOString() } }),
			},
			{ name: "never ticked", check: "last tick", status: "fail", mutate: () => doctorInput({ ticker: {} }) },
			{
				name: "newer schema",
				check: "store schema",
				status: "fail",
				mutate: () => doctorInput({ store: { writable: true, schemaVersion: 2, expectedSchemaVersion: 1 } }),
			},
			{
				name: "missing schema",
				check: "store schema",
				status: "warn",
				mutate: () => doctorInput({ store: { writable: true, expectedSchemaVersion: 1 } }),
			},
			{
				name: "store not writable",
				check: "store writable",
				status: "fail",
				mutate: () =>
					doctorInput({ store: { writable: false, error: "EACCES", schemaVersion: 1, expectedSchemaVersion: 1 } }),
			},
			{
				name: "version skew",
				check: "ticker version",
				status: "warn",
				mutate: () =>
					doctorInput({ ticker: { lastTickAt: new Date(NOW - 30_000).toISOString(), version: "14.9.0" } }),
			},
			{
				name: "unit command mismatch",
				check: "unit command",
				status: "warn",
				mutate: () => doctorInput({ ompCommand: ["/usr/local/bin/omp"] }),
			},
			{
				name: "missing binary",
				check: "unit binary",
				status: "fail",
				mutate: host => {
					host.files.delete(BIN);
					return doctorInput();
				},
			},
			{
				name: "different store",
				check: "unit store",
				status: "warn",
				mutate: () => doctorInput({ timersRoot: "/elsewhere/timers" }),
			},
			{
				name: "different profile",
				check: "unit config",
				status: "warn",
				mutate: () => doctorInput({ unitEnv: { ...UNIT_ENV, OMP_PROFILE: "work" } }),
			},
			{
				name: "not loaded",
				check: "unit loaded",
				status: "fail",
				mutate: host => {
					host.script.set("systemctl --user is-active omp-timer-tick.timer", {
						stdout: "inactive\n",
						exitCode: 3,
					});
					return doctorInput();
				},
			},
			{
				name: "linger off",
				check: "linger",
				status: "warn",
				mutate: host => {
					host.script.set("loginctl show-user tester -p Linger", { stdout: "Linger=no\n" });
					return doctorInput();
				},
			},
		];
		for (const testCase of cases) {
			const host = await healthyHost("linux");
			const report = await doctorTicker(host, testCase.mutate(host));
			const others = report.checks.filter(check => check.name !== testCase.check && check.status !== "ok");
			expect({ case: testCase.name, status: statuses(report.checks)[testCase.check], others }).toEqual({
				case: testCase.name,
				status: testCase.status,
				others: [],
			});
			expect(report.ok).toBe(testCase.status !== "fail");
		}
	});

	it("states the same heartbeat age as `omp timer ls`", async () => {
		const ticker = { lastTickAt: new Date(NOW - 4 * 60_000 - 30_000).toISOString() };
		const report = await doctorTicker(await healthyHost("linux"), doctorInput({ ticker }));
		const lastTick = report.checks.find(check => check.name === "last tick");
		expect(lastTick?.status).toBe("fail");
		expect(lastTick?.detail).toContain("last tick 4m ago");
		expect(describeTicker(ticker, NOW)).toStartWith("⚠ last tick 4m ago:");
	});

	it("fails the loaded check when launchctl cannot print the job", async () => {
		const host = await healthyHost("darwin");
		host.script.set(LAUNCHCTL_PRINT, { exitCode: 113 });
		const report = await doctorTicker(host, doctorInput());
		expect(statuses(report.checks)["unit loaded"]).toBe("fail");
		expect(statuses(report.checks).linger).toBeUndefined();
	});

	it("shows launchd's last exit code and the tail of the tick log", async () => {
		const host = await healthyHost("darwin");
		host.script.set("launchctl print gui/501/sh.omp.timer-tick", {
			stdout: "gui/501/sh.omp.timer-tick = {\n\truns = 4\n\tlast exit code = 1\n}\n",
		});
		host.files.set(
			"/home/tester/.omp/timers/tick.log",
			["one", "two", "three", "four", "five", "error: Cannot find module './cli.ts'", ""].join("\n"),
		);
		const report = await doctorTicker(host, doctorInput());
		const lastRun = report.checks.find(check => check.name === "last run")!;
		expect(lastRun).toMatchObject({
			status: "fail",
			detail: "last exit code 1 (log /home/tester/.omp/timers/tick.log)",
		});
		expect(lastRun.log).toEqual(["two", "three", "four", "five", "error: Cannot find module './cli.ts'"]);
		expect(report.ok).toBe(false);
	});

	it("passes launchd's last run when it exited 0 and skips it before the first exit", async () => {
		const host = await healthyHost("darwin");
		host.script.set("launchctl print gui/501/sh.omp.timer-tick", { stdout: "\tlast exit code = 0\n" });
		expect(statuses((await doctorTicker(host, doctorInput())).checks)["last run"]).toBe("ok");
		host.script.set("launchctl print gui/501/sh.omp.timer-tick", { stdout: "\tlast exit code = (never exited)\n" });
		expect(statuses((await doctorTicker(host, doctorInput())).checks)["last run"]).toBeUndefined();
	});

	it("shows a failed systemd run's result, exit status and journal tail", async () => {
		const host = await healthyHost("linux");
		host.script.set(SYSTEMD_SHOW, {
			stdout:
				"Result=exit-code\nExecMainCode=1\nExecMainStatus=209\nExecMainExitTimestamp=Thu 2026-10-22 04:51:00 EDT\n",
		});
		host.script.set("journalctl --user -u omp-timer-tick.service -n 5 --no-pager -o cat", {
			stdout:
				"Starting omp-timer-tick.service…\nomp-timer-tick.service: Failed to set up standard output: No such file or directory\nomp-timer-tick.service: Main process exited, code=exited, status=209/STDOUT\n",
		});
		const report = await doctorTicker(host, doctorInput());
		const lastRun = report.checks.find(check => check.name === "last run")!;
		expect(lastRun.status).toBe("fail");
		expect(lastRun.detail).toContain("Result=exit-code");
		expect(lastRun.detail).toContain("status 209");
		expect(lastRun.detail).toContain("journalctl --user -u omp-timer-tick.service");
		expect(lastRun.log?.at(-1)).toBe("omp-timer-tick.service: Main process exited, code=exited, status=209/STDOUT");
	});

	it("passes a successful systemd run and skips a service that has not run", async () => {
		const host = await healthyHost("linux");
		host.script.set(SYSTEMD_SHOW, {
			stdout:
				"Result=success\nExecMainCode=1\nExecMainStatus=0\nExecMainExitTimestamp=Thu 2026-10-22 04:52:00 EDT\n",
		});
		expect(statuses((await doctorTicker(host, doctorInput())).checks)["last run"]).toBe("ok");
		host.script.set(SYSTEMD_SHOW, {
			stdout: "Result=success\nExecMainCode=0\nExecMainStatus=0\nExecMainExitTimestamp=\n",
		});
		expect(statuses((await doctorTicker(host, doctorInput())).checks)["last run"]).toBeUndefined();
	});

	it("warns when the unit was installed for another profile or agent dir", async () => {
		const report = await doctorTicker(
			await healthyHost("darwin"),
			doctorInput({ unitEnv: { ...UNIT_ENV, PI_CODING_AGENT_DIR: "/home/tester/other-agent" } }),
		);
		const config = report.checks.find(check => check.name === "unit config")!;
		expect(config.status).toBe("warn");
		expect(config.detail).toContain("/home/tester/.omp/agent");
		expect(config.detail).toContain("/home/tester/other-agent");
		expect(config.detail).toContain("omp timer install");
	});

	it("fails loudly when a source install's entry script or binary is gone or not executable", async () => {
		const entry = "/home/tester/wt/packages/coding-agent/src/cli.ts";
		const bun = "/home/tester/.bun/bin/bun";
		const sourceInstall = async () => {
			const host = new FakeHost("darwin");
			await installTicker(host, unitInput({ ompCommand: [bun, entry] }));
			host.files.set(bun, "binary");
			host.files.set(entry, "source");
			return host;
		};
		const input = doctorInput({ ompCommand: [bun, entry] });

		const healthy = await doctorTicker(await sourceInstall(), input);
		expect(healthy.checks.filter(check => check.name.startsWith("unit "))).toContainEqual({
			name: "unit entry",
			status: "ok",
			detail: entry,
		});
		expect(healthy.ok).toBe(true);

		const deleted = await sourceInstall();
		deleted.files.delete(entry);
		const report = await doctorTicker(deleted, input);
		expect(report.ok).toBe(false);
		expect(report.checks.find(check => check.name === "unit entry")).toMatchObject({
			status: "fail",
			detail: `${entry} does not exist; every tick fails; re-run omp timer install from a working omp`,
		});

		const notExecutable = await sourceInstall();
		notExecutable.notExecutable.add(bun);
		const binary = (await doctorTicker(notExecutable, input)).checks.find(check => check.name === "unit binary")!;
		expect(binary.status).toBe("fail");
		expect(binary.detail).toContain("is missing or not executable");
	});
});

describe("tickerUnitEnv", () => {
	const IDENTITY_KEYS = ["OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR"] as const;
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const key of IDENTITY_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		__resetDirsFromEnvForTests();
	});
	afterEach(() => {
		for (const key of IDENTITY_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		__resetDirsFromEnvForTests();
	});

	/** `getAgentDir()` of a process that has only the unit's env (and HOME), like the tick and its runners. */
	async function agentDirUnder(env: Record<string, string>): Promise<string> {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				'import { getAgentDir } from "@oh-my-pi/pi-utils"; process.stdout.write(getAgentDir());',
			],
			{ cwd: import.meta.dir, env: { ...env, HOME: os.homedir() }, stdout: "pipe", stderr: "inherit" },
		);
		const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		return out;
	}

	it("bakes a custom agent dir, so the unit resolves the installing agent dir", async () => {
		const dir = await TempDir.create("omp-ticker-agent-");
		tempDirs.push(dir);
		const agentDir = path.resolve(dir.path(), "agent");
		setAgentDir(agentDir);
		const env = tickerUnitEnv();
		expect(await agentDirUnder(env)).toBe(agentDir);
		expect(Object.keys(env).sort()).toEqual(["OMP_MAILBOX_DIR", "OMP_TIMERS_DIR", "PATH", "PI_CODING_AGENT_DIR"]);
	});

	it("bakes a named profile, so the unit resolves that profile's agent dir", async () => {
		setProfile("timer-unit-test");
		const env = tickerUnitEnv();
		expect(await agentDirUnder(env)).toBe(getAgentDir());
		expect(Object.keys(env).sort()).toEqual(["OMP_MAILBOX_DIR", "OMP_PROFILE", "OMP_TIMERS_DIR", "PATH"]);
		expect(env.OMP_PROFILE).toBe("timer-unit-test");
	});
});
