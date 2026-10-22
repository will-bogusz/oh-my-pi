import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	createTimerHost,
	type DoctorInput,
	doctorTicker,
	type HostCommandResult,
	installTicker,
	machineWakeArgv,
	type PlistValue,
	parsePlist,
	planTickerInstall,
	scheduleMachineWake,
	splitSystemdWords,
	type TickerUnitInput,
	type TimerHost,
	uninstallTicker,
} from "@oh-my-pi/pi-coding-agent/timers/install/index";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const HOME = "/home/tester";
const BIN = "/opt/omp & co/bin/omp";

class FakeHost implements TimerHost {
	files = new Map<string, string>();
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
}

function unitInput(overrides: Partial<TickerUnitInput> = {}): TickerUnitInput {
	return {
		ompCommand: [BIN],
		env: { PATH: "/usr/bin:/bin", OMP_TIMERS_DIR: "/home/tester/.omp/timers" },
		logPath: "/home/tester/.omp/timers/tick.log",
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
			EnvironmentVariables: { PATH: "/usr/bin:/bin", OMP_TIMERS_DIR: "/home/tester/.omp/timers" },
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

	it("installs by reloading then enabling the timer", async () => {
		const host = new FakeHost("linux");
		const result = await installTicker(host, unitInput());
		expect(result.ok).toBe(true);
		expect([...host.files.keys()].sort()).toEqual([service, timer]);
		expect(host.commands).toEqual([
			["systemctl", "--user", "daemon-reload"],
			["systemctl", "--user", "enable", "--now", "omp-timer-tick.timer"],
		]);
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

it("dry-run host writes units under the given HOME and runs no commands", async () => {
	if (process.platform !== "darwin" && process.platform !== "linux") return;
	const dir = await TempDir.create("omp-ticker-home-");
	tempDirs.push(dir);
	const host = createTimerHost({ dryRun: true, home: dir.path() });
	const result = await installTicker(host, unitInput());
	expect(result.ok).toBe(true);
	for (const file of result.plan.files) {
		expect(file.path.startsWith(dir.path())).toBe(true);
		expect(await Bun.file(file.path).text()).toBe(file.content);
	}
	expect(host.commands).toEqual(result.plan.commands);
	expect(result.results.every(r => r.stderr === "(dry run)")).toBe(true);
});

describe("doctorTicker", () => {
	const NOW = Date.parse("2026-10-22T12:00:00Z");

	function doctorInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
		return {
			now: NOW,
			timersRoot: "/home/tester/.omp/timers",
			currentVersion: "15.0.0",
			ompCommand: [BIN],
			ticker: { lastTickAt: new Date(NOW - 30_000).toISOString(), version: "15.0.0", pid: 42 },
			store: { writable: true, schemaVersion: 1, expectedSchemaVersion: 1 },
			...overrides,
		};
	}

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

	it("fails the loaded check when launchctl cannot print the job", async () => {
		const host = await healthyHost("darwin");
		host.script.set("launchctl print gui/501/sh.omp.timer-tick", { exitCode: 113 });
		const report = await doctorTicker(host, doctorInput());
		expect(statuses(report.checks)["unit loaded"]).toBe("fail");
		expect(statuses(report.checks).linger).toBeUndefined();
	});
});

describe("machine wake", () => {
	it("formats pmset's local MM/dd/yyyy HH:mm:ss two minutes before the timer", () => {
		expect(machineWakeArgv(new Date(2026, 9, 22, 9, 5, 30).getTime())).toEqual([
			"sudo",
			"-n",
			"pmset",
			"schedule",
			"wake",
			"10/22/2026 09:03:30",
		]);
		expect(machineWakeArgv(new Date(2027, 0, 1, 0, 1, 0).getTime()).at(-1)).toBe("12/31/2026 23:59:00");
	});

	it("returns a pmset failure instead of throwing, and is a no-op off macOS", async () => {
		const at = new Date(2026, 9, 22, 9, 5, 30).getTime();
		const mac = new FakeHost("darwin");
		mac.script.set(machineWakeArgv(at).join(" "), { exitCode: 1, stderr: "sudo: a password is required" });
		const failed = await scheduleMachineWake(mac, at);
		expect(failed.scheduled).toBe(false);
		expect(failed.detail).toContain("sudo: a password is required");

		const linux = new FakeHost("linux");
		expect((await scheduleMachineWake(linux, at)).scheduled).toBe(false);
		expect(linux.commands).toEqual([]);
	});
});
