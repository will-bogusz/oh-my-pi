/**
 * External estate adapters replayed against outputs recorded on a Mac and a
 * Linux server (2026-10-22, trimmed to a subset of units, environment blocks
 * removed, names and paths anonymized).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CommandResult,
	type CommandRunner,
	type Estate,
	type ExternalJob,
	parseCrontab,
	renderEstate,
	scanHost,
	scanRemoteHost,
} from "@oh-my-pi/pi-coding-agent/timers/external/index";

interface Recording {
	now: number;
	commands: Record<string, CommandResult>;
	readlink: Record<string, string>;
	stat?: Record<string, number>;
}

const FIXTURES = path.join(import.meta.dir, "fixtures", "timer-estate");

async function load(name: string): Promise<Recording> {
	return (await Bun.file(path.join(FIXTURES, `${name}.json`)).json()) as Recording;
}

/** Unit/label lists vary with what the previous call returned, so replay keys stop before them. */
function replayKey(argv: string[]): string {
	if (argv.includes("--")) return argv.slice(0, argv.indexOf("--")).join(" ");
	if (argv[0] === "sh") {
		return `sh -c ${argv[2].includes("launchctl print") ? "state" : argv[2].includes("plutil") ? "dump" : argv[2]}`;
	}
	return argv.join(" ");
}

function replay(recording: Recording, overrides: Record<string, CommandResult> = {}): CommandRunner {
	return async argv => {
		if (argv[0] === "readlink") {
			const paths = argv.slice(1).filter(arg => arg !== "-f" && arg !== "--");
			return { code: 0, stdout: paths.map(p => recording.readlink[p] ?? p).join("\n"), stderr: "" };
		}
		if (argv[0] === "stat") {
			const stat = recording.stat ?? {};
			const lines = argv.slice(3).flatMap(p => (p in stat ? [`${stat[p]} ${p}`] : []));
			return { code: 0, stdout: lines.join("\n"), stderr: "" };
		}
		const key = argv.join(" ");
		if (key in overrides) return overrides[key];
		const recorded = recording.commands[replayKey(argv)];
		if (!recorded) return { code: 127, stdout: "", stderr: `not recorded: ${key}` };
		return recorded;
	};
}

function byId(jobs: ExternalJob[]): Map<string, ExternalJob> {
	return new Map(jobs.map(job => [job.id, job]));
}

describe("systemd adapter (server recording)", () => {
	it("lists custom timers and long-running services with health computed from unit state", async () => {
		const recording = await load("server");
		const scan = await scanHost(replay(recording), "linux", "server", recording.now);
		expect(scan.errors).toEqual([]);
		const jobs = byId(scan.jobs);

		// Distribution units are not anyone's standing work.
		for (const vendor of ["launchpadlib-cache-clean.timer", "apt-daily.timer", "dbus.service"]) {
			expect(jobs.has(vendor)).toBe(false);
		}

		const macro = jobs.get("feed-import.timer")!;
		expect(macro.lastResult).toBe("exit 1");
		expect(macro.flags).toContain("failed");
		expect(macro.log).toBe("journalctl --user -u feed-import.service");

		// Mid-run, a calendar timer has no next elapse; that is not "unarmed".
		const nightly = jobs.get("nightly-build.timer")!;
		expect(nightly.lastResult).toBe("running");
		expect(nightly.next).toBeNull();
		expect(nightly.flags).not.toContain("unarmed");

		const poll = jobs.get("chat-bot-poll.timer")!;
		expect(poll.flags).toEqual(["no-failure-alert", "interval-only"]);
		expect(poll.schedule).toContain("OnUnitActiveSec=10min");
		// Linked units show the repo file they come from.
		expect(poll.sourcePath).toBe("/home/dev/src/dotfiles/units/server/chat-bot-poll.timer");

		expect(jobs.get("cpu-priority-revert.timer")!.flags).toEqual(["never-ran", "no-failure-alert"]);

		expect(jobs.get("mail-triage.timer")!.flags).toEqual([]);

		const collector = jobs.get("chat-collector.service")!;
		expect(collector.kind).toBe("service");
		expect(collector.schedule).toBe("always (Restart=on-failure)");
		expect(collector.flags).toEqual([]);
		expect(jobs.get("nightly-build-rerun-1021.service")!.flags).toContain("failed");

		const backup = jobs.get("server-backup.timer")!;
		expect(backup.source).toBe("systemd-system");
		// System units log to the system journal, and OnFailure= on the service counts as an alert.
		expect(backup.log).toBe("journalctl -u server-backup.service");
		expect(backup.flags).toEqual([]);
		expect(jobs.get("lab-env-sync.timer")!.flags).toContain("interval-only");
		expect(jobs.get("broker-gateway.service")!.kind).toBe("service");
	});
});

describe("launchd adapter (Mac recording)", () => {
	it("flags failed exits, disabled and unloaded agents, and sleep-lossy intervals", async () => {
		const recording = await load("mac");
		const scan = await scanHost(replay(recording), "macos", "mac", recording.now);
		expect(scan.errors).toEqual([]);
		const jobs = byId(scan.jobs);

		// An empty `{}` plist has no Label; launchd ignores it and so do we.
		expect([...jobs.keys()].some(id => id.includes("keystone"))).toBe(false);

		const push = jobs.get("com.example.weekly-notes-push")!;
		expect(push.lastResult).toBe("exit 1");
		expect(push.flags).toEqual(["failed", "no-failure-alert"]);
		expect(jobs.get("com.example.ledger-backup")!.lastResult).toBe("exit 255");

		const bridge = jobs.get("org.example.sync-bridge")!;
		expect(bridge.kind).toBe("service");
		expect(bridge.state).toBe("running pid 54274");

		const backup = jobs.get("com.example.backup")!;
		expect(backup.lastResult).toBe("success");
		expect(backup.flags).toEqual(["no-failure-alert"]);
		expect(backup.schedule).toBe("daily 12:30");
		// Calendar fires are computed in the host's zone (Europe/Berlin, CEST), not this process's.
		expect(backup.next).toBe("2026-10-22T10:30:00.000Z");
		// launchd records no start time; the log's mtime stands in and says so.
		expect(backup.lastApprox).toBe(true);
		expect(backup.log).toBe("/Users/dev/Library/Logs/backup.log");

		const chat = jobs.get("com.example.chat-export")!;
		expect(chat.schedule).toBe("every 15m + at load");
		expect(chat.flags).toContain("sleep-lossy");
		expect(chat.next).toBeNull();

		const router = jobs.get("com.example.router-fw-update")!;
		expect(router.state).toBe("disabled");
		expect(router.flags).toEqual(["unarmed", "no-failure-alert"]);

		expect(jobs.get("com.vendor.updater")!.state).toBe("not loaded");

		// `>/dev/null 2>&1` discards the output cron would otherwise mail.
		const cron = jobs.get("crontab:2")!;
		expect(cron.schedule).toBe("0 0 * * *");
		expect(cron.flags).toEqual(["no-failure-alert"]);
	});
});

describe("launchd adapter failures and overrides", () => {
	it("reports a failed plist listing instead of an empty launchd scan, keeping crontab rows", async () => {
		const recording = await load("mac");
		const base = replay(recording);
		const run: CommandRunner = argv =>
			replayKey(argv) === "sh -c dump"
				? Promise.resolve({ code: 127, stdout: "", stderr: "sh: not found" })
				: base(argv);
		const scan = await scanHost(run, "macos", "mac", recording.now);
		expect(scan.errors).toEqual(["launchd: listing ~/Library/LaunchAgents failed: sh: not found"]);
		expect(scan.jobs.map(job => job.id)).toEqual(["crontab:2"]);
	});

	function launchdHost(state: string, plists: Array<{ Label: string; [key: string]: unknown }>): CommandRunner {
		const dump = plists
			.map(plist => `==> /Users/dev/Library/LaunchAgents/${plist.Label}.plist\n${JSON.stringify(plist)}\n`)
			.join("");
		return async argv => {
			if (argv.join(" ") === "readlink /etc/localtime") {
				return { code: 0, stdout: "/var/db/timezone/zoneinfo/Asia/Kolkata\n", stderr: "" };
			}
			if (argv[0] === "readlink") return { code: 0, stdout: argv.slice(2).join("\n"), stderr: "" };
			if (argv[0] === "crontab") return { code: 1, stdout: "", stderr: "crontab: no crontab for dev" };
			if (replayKey(argv) === "sh -c dump") return { code: 0, stdout: dump, stderr: "" };
			if (replayKey(argv) === "sh -c state") return { code: 0, stdout: state, stderr: "" };
			throw new Error(`unexpected ${argv.join(" ")}`);
		};
	}

	it("lets launchctl's enable/disable override win over the plist's Disabled default", async () => {
		const calendar = { StartCalendarInterval: { Hour: 12, Minute: 30 }, ProgramArguments: ["/bin/true"] };
		const run = launchdHost(
			[
				"==> disabled",
				'\t\t"com.example.enabled" => enabled',
				'\t\t"com.example.disabled" => disabled',
				"==> print com.example.enabled",
				"\tstate = not running",
				"\truns = 3",
				"\tlast exit code = 0",
				"==> print com.example.disabled",
				"\tstate = not running",
				"\truns = 3",
				"\tlast exit code = 0",
				"",
			].join("\n"),
			[
				{ Label: "com.example.enabled", Disabled: true, ...calendar },
				{ Label: "com.example.disabled", Disabled: false, ...calendar },
			],
		);
		const scan = await scanHost(run, "macos", "mac", Date.parse("2026-10-22T04:00:00Z"));
		expect(scan.errors).toEqual([]);
		const jobs = byId(scan.jobs);
		const enabled = jobs.get("com.example.enabled")!;
		// 12:30 in the host's Asia/Kolkata (+05:30), whatever zone this process runs in.
		expect(enabled.next).toBe("2026-10-22T07:00:00.000Z");
		expect(enabled.flags).not.toContain("unarmed");
		const disabled = jobs.get("com.example.disabled")!;
		expect(disabled.state).toBe("disabled");
		expect(disabled.next).toBeNull();
		expect(disabled.flags).toContain("unarmed");
	});

	it("reports a failed launchctl probe rather than calling the agent not loaded", async () => {
		const run = launchdHost(
			"==> disabled\n==> print com.example.job\n!failed 125 Domain does not support specified action\n",
			[{ Label: "com.example.job", ProgramArguments: ["/bin/true"], RunAtLoad: true }],
		);
		const scan = await scanHost(run, "macos", "mac", Date.now());
		expect(scan.jobs).toEqual([]);
		expect(scan.errors).toEqual([
			"launchd: launchctl print failed for 1 of 1 agents: com.example.job: exit 125 (Domain does not support specified action)",
		]);
	});

	// Runs the adapter's real shell scripts against stand-in `launchctl` and `plutil` commands.
	it.skipIf(process.platform === "win32")(
		"tells an unloaded label (launchctl exit 113) from a failed print and keeps environments out",
		async () => {
			const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-estate-"));
			try {
				await fs.mkdir(path.join(home, "Library", "LaunchAgents"), { recursive: true });
				await fs.mkdir(path.join(home, "bin"));
				for (const label of ["com.example.up", "com.example.gone", "com.example.denied"]) {
					await Bun.write(
						path.join(home, "Library", "LaunchAgents", `${label}.plist`),
						JSON.stringify({ Label: label, ProgramArguments: ["/bin/true"], RunAtLoad: true }),
					);
				}
				await Bun.write(path.join(home, "bin", "plutil"), '#!/bin/sh\ncat "$5"\n');
				await Bun.write(
					path.join(home, "bin", "launchctl"),
					[
						"#!/bin/sh",
						'case "$1 $2" in',
						"'print-disabled '*) printf '\\tdisabled services = {\\n\\t}\\n' ;;",
						"'print '*/com.example.gone) echo 'Could not find service' >&2; exit 113 ;;",
						"'print '*/com.example.denied) [ -e \"$HOME/deny\" ] && { echo 'Bad request.' >&2; exit 5; }; exit 113 ;;",
						"'print '*) printf 'x = {\\n\\tstate = running\\n\\tpid = 42\\n\\truns = 1\\n\\tenvironment = {\\n\\t\\tTOKEN => secret\\n\\t}\\n}\\n' ;;",
						"esac",
						"",
					].join("\n"),
				);
				await fs.chmod(path.join(home, "bin", "plutil"), 0o755);
				await fs.chmod(path.join(home, "bin", "launchctl"), 0o755);
				const env = { ...process.env, HOME: home, PATH: `${path.join(home, "bin")}:${process.env.PATH}` };
				const run: CommandRunner = async argv => {
					if (argv[0] === "crontab") return { code: 1, stdout: "", stderr: "no crontab for dev" };
					const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
					const [stdout, stderr, code] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					return { code, stdout, stderr };
				};

				const scan = await scanHost(run, "macos", "mac", Date.now());
				expect(scan.errors.filter(error => error.startsWith("launchd"))).toEqual([]);
				const jobs = byId(scan.jobs);
				expect(jobs.get("com.example.up")!.state).toBe("running pid 42");
				expect(jobs.get("com.example.gone")!.state).toBe("not loaded");
				expect(JSON.stringify(scan.jobs)).not.toContain("secret");

				await Bun.write(path.join(home, "deny"), "");
				const denied = await scanHost(run, "macos", "mac", Date.now());
				expect(denied.errors.filter(error => error.startsWith("launchd"))).toEqual([
					"launchd: launchctl print failed for 1 of 3 agents: com.example.denied: exit 5 (Bad request.)",
				]);
			} finally {
				await fs.rm(home, { recursive: true, force: true });
			}
		},
	);
});

describe("crontab parsing", () => {
	const now = Date.parse("2026-10-22T04:00:00Z");
	const utc = { timeZone: "Etc/UTC", cronTz: false };

	it("honours MAILTO and nicknames", () => {
		const jobs = parseCrontab(
			[
				"0 3 * * * /usr/local/bin/nightly >> /var/log/nightly.log",
				'MAILTO=""',
				"@reboot /Users/dev/tmp/adhoc/x/start.sh",
				"*/5 * * * * /usr/bin/true",
			].join("\n"),
			"mac",
			now,
			utc,
		);
		expect(jobs.map(job => [job.id, job.next !== null, job.log, job.flags])).toEqual([
			["crontab:1", true, "/var/log/nightly.log", []],
			["crontab:3", false, null, ["no-failure-alert"]],
			["crontab:4", true, null, ["no-failure-alert"]],
		]);
	});

	it.each([
		["all output to a log", "/usr/bin/job >>/var/log/job 2>&1", "/var/log/job", true],
		["all output discarded", "/usr/bin/job >/dev/null 2>&1", null, true],
		["stdout to a log, stderr still mailed", "/usr/bin/job >/var/log/job", "/var/log/job", false],
		["stderr kept by 2>&1 before >/dev/null", "/usr/bin/job 2>&1 >/dev/null", null, false],
		["a quoted > is an argument", "/usr/bin/echo 'a > b'", null, false],
		["a pipeline cron cannot follow", "/usr/bin/job 2>&1 | logger -t job", null, true],
	])("%s", (_name, command, log, flagged) => {
		const [job] = parseCrontab(`0 3 * * * ${command}`, "box", now, utc);
		expect(job.log).toBe(log);
		expect(job.flags.includes("no-failure-alert")).toBe(flagged);
	});
});

describe("next runs on another host's clock", () => {
	// 23:30Z on 2026-10-24 is 01:30 CEST in Berlin, where DST ends at 03:00 that night, and 05:00 the 25th in Kolkata.
	const now = Date.parse("2026-10-24T23:30:00Z");
	const crontab = "0 3 * * * /usr/bin/true\nCRON_TZ=Asia/Kolkata\n0 3 * * * /usr/bin/true\n";

	function cronHost(version: CommandResult): CommandRunner {
		return async argv => {
			const key = argv.join(" ");
			if (key === "omp timer --help") return { code: 127, stdout: "", stderr: "sh: omp: not found" };
			if (key === "readlink /etc/localtime")
				return { code: 0, stdout: "/usr/share/zoneinfo/Europe/Berlin\n", stderr: "" };
			if (key === "crontab -l") return { code: 0, stdout: crontab, stderr: "" };
			if (key === "crontab -V") return version;
			return { code: 127, stdout: "", stderr: `${argv[0]}: not found` };
		};
	}

	it("computes cron next runs in the remote host's zone across its DST change, honouring cronie's CRON_TZ", async () => {
		const { jobs, report } = await scanRemoteHost(
			"box",
			cronHost({ code: 0, stdout: "cronie 1.7.0\n", stderr: "" }),
			"linux",
			now,
		);
		expect(report.fallback).toBe("`omp timer --help` failed: sh: omp: not found");
		// 03:00 CET (after the 03:00 CEST → 02:00 CET switch) is 02:00Z; 03:00 IST on the 26th is 21:30Z the 25th.
		expect(jobs.map(job => [job.id, job.next])).toEqual([
			["crontab:1", "2026-10-25T02:00:00.000Z"],
			["crontab:3", "2026-10-25T21:30:00.000Z"],
		]);
	});

	it("leaves next unknown after CRON_TZ on a cron that does not schedule by it", async () => {
		const { jobs } = await scanRemoteHost(
			"box",
			cronHost({ code: 1, stdout: "", stderr: "crontab: invalid option -- 'V'" }),
			"linux",
			now,
		);
		const row = jobs.find(job => job.id === "crontab:3")!;
		expect(row.next).toBeNull();
		expect(row.flags).not.toContain("unarmed");
	});

	it("reports an unknown host zone and shows no cron next run rather than one in this process's zone", async () => {
		const run: CommandRunner = async argv =>
			argv[0] === "crontab"
				? { code: 0, stdout: "0 3 * * * /usr/bin/true\n", stderr: "" }
				: { code: 1, stdout: "", stderr: `${argv[0]}: failed` };
		const scan = await scanHost(run, "linux", "box", now);
		expect(scan.errors[0]).toStartWith("time zone unknown");
		expect(scan.jobs.map(job => [job.next, job.flags.includes("unarmed")])).toEqual([[null, false]]);
	});
});

describe("remote hosts", () => {
	it("never sends `timer ls` to an omp whose help lacks the estate flags, and parses the host locally", async () => {
		const recording = await load("server");
		const calls: string[] = [];
		const base = replay(recording, {
			// omp 18.12 has no `timer` command: help falls through to `omp launch`.
			"omp timer --help": {
				code: 0,
				stdout: "AI coding assistant\n\nUSAGE\n  $ omp launch [MESSAGES...] [FLAGS]\n",
				stderr: "",
			},
		});
		const run: CommandRunner = argv => {
			calls.push(argv.join(" "));
			return base(argv);
		};
		const { jobs, report } = await scanRemoteHost("server", run, "linux", recording.now);
		expect(calls).not.toContain("omp timer ls --json --all");
		expect(report).toMatchObject({ host: "server", via: "ssh", errors: [] });
		expect(jobs.find(job => job.id === "feed-import.timer")?.host).toBe("server");
	});

	it("uses the remote omp's own listing when it supports --all", async () => {
		const remoteJob: ExternalJob = {
			host: "server.lan",
			source: "systemd-user",
			kind: "timer",
			id: "weekly-notes.timer",
			description: null,
			schedule: "OnCalendar=Sun *-*-* 21:30:00",
			next: null,
			last: null,
			lastResult: "success",
			state: "active/waiting",
			command: null,
			sourcePath: null,
			log: null,
			flags: [],
		};
		const run: CommandRunner = async argv => {
			const key = argv.join(" ");
			if (key === "omp timer --help") return { code: 0, stdout: "  --all\n  --host=<value>\n", stderr: "" };
			if (key === "omp timer ls --json --all") {
				return {
					code: 0,
					stdout: JSON.stringify({
						timers: [{ id: "nightly", status: "armed" }],
						external: [remoteJob],
						hosts: [{ host: "server.lan", via: "local", errors: ["systemd system: denied"] }],
					}),
					stderr: "",
				};
			}
			throw new Error(`unexpected ${key}`);
		};
		const { jobs, report } = await scanRemoteHost("server", run, "linux", Date.now());
		expect(jobs.map(job => [job.host, job.id])).toEqual([["server", "weekly-notes.timer"]]);
		expect(report).toEqual({
			host: "server",
			via: "omp",
			timers: [{ id: "nightly", status: "armed" }],
			errors: ["systemd system: denied"],
		});
	});

	it("keeps the other adapters' rows when one adapter fails", async () => {
		const run: CommandRunner = async argv =>
			argv[0] === "crontab"
				? { code: 0, stdout: "0 1 * * * /usr/bin/true\n", stderr: "" }
				: argv[0] === "readlink"
					? { code: 0, stdout: "/usr/share/zoneinfo/Etc/UTC\n", stderr: "" }
					: { code: 127, stdout: "", stderr: "systemctl: command not found" };
		const scan = await scanHost(run, "linux", "box", Date.now());
		expect(scan.jobs.map(job => job.id)).toEqual(["crontab:1"]);
		expect(scan.errors).toEqual([
			"systemd --user: systemctl --user list-timers failed: systemctl: command not found",
			"systemd system: systemctl list-timers failed: systemctl: command not found",
		]);
	});

	const remoteJob: ExternalJob = {
		host: "server.lan",
		source: "systemd-user",
		kind: "timer",
		id: "weekly-notes.timer",
		description: null,
		schedule: "OnCalendar=Sun *-*-* 21:30:00",
		next: null,
		last: "2026-10-18T21:30:00.000Z",
		lastResult: "success",
		state: "active/waiting",
		command: null,
		sourcePath: null,
		log: null,
		flags: [],
	};

	function ompHost(listing: CommandResult): CommandRunner {
		return async argv => {
			const key = argv.join(" ");
			if (key === "omp timer --help") return { code: 0, stdout: "  --all\n  --host=<value>\n", stderr: "" };
			if (key === "omp timer ls --json --all") return listing;
			if (key === "readlink /etc/localtime") return { code: 0, stdout: "/usr/share/zoneinfo/Etc/UTC\n", stderr: "" };
			if (key === "crontab -l") return { code: 0, stdout: "0 1 * * * /usr/bin/true\n", stderr: "" };
			return { code: 127, stdout: "", stderr: `${argv[0]}: not found` };
		};
	}

	it("skips and counts malformed rows, timers and host reports of a remote listing, keeping the valid ones", async () => {
		const listing = {
			external: [{ id: "bad" }, remoteJob, { ...remoteJob, id: "bad-time.timer", next: "soon" }],
			timers: [{ id: "nightly", status: "armed", next: null }, { id: 5 }],
			hosts: [{ errors: "denied" }, { host: "server.lan", via: "local", errors: ["systemd system: denied"] }],
		};
		const { jobs, report } = await scanRemoteHost(
			"server",
			ompHost({ code: 0, stdout: JSON.stringify(listing), stderr: "" }),
			"linux",
			Date.now(),
		);
		expect(jobs).toEqual([{ ...remoteJob, host: "server" }]);
		expect(report.via).toBe("omp");
		expect(report.timers).toEqual([{ id: "nightly", status: "armed", next: null }]);
		expect(report.errors).toHaveLength(4);
		expect(report.errors[0]).toStartWith("remote omp listing: skipped 2 malformed external row(s)");
		expect(report.errors[1]).toStartWith("remote omp listing: skipped 1 malformed timer(s)");
		expect(report.errors[2]).toStartWith("remote omp listing: skipped 1 malformed host report(s)");
		expect(report.errors[3]).toBe("systemd system: denied");
		const text = renderEstate({ jobs, hosts: [report] }, Date.now());
		expect(text).toContain("weekly-notes.timer");
		expect(text).toContain("server: 1 omp timer(s)");
	});

	it.each([
		[
			"an unusable listing",
			{ code: 0, stdout: JSON.stringify({ external: "none" }), stderr: "" },
			"`omp timer ls --json --all` printed an unusable listing",
		],
		["a failed listing", { code: 1, stdout: "", stderr: "boom" }, "`omp timer ls --json --all` failed: boom"],
	])("falls back to ssh commands after %s from an omp that knows --all, saying so", async (_name, listing, why) => {
		const { jobs, report } = await scanRemoteHost("server", ompHost(listing), "linux", Date.now());
		expect(report.via).toBe("ssh");
		expect(report.fallback).toStartWith(why);
		expect(jobs.map(job => job.id)).toEqual(["crontab:1"]);
		const text = renderEstate({ jobs, hosts: [report] }, Date.now());
		expect(text).toContain(`server: listed with ssh commands (${why}`);
		expect(text).not.toContain("has no");
	});
});

describe("systemd failures", () => {
	it.each([
		["systemctl --user list-units", "list-units"],
		["systemctl --user list-unit-files", "list-unit-files"],
		["systemctl --user show -p Id,FragmentPath,Unit", "show"],
		["systemctl --user show -p Id,Description", "show"],
	])("reports a failed `%s` instead of a short listing, keeping other scopes' rows", async (prefix, operation) => {
		const recording = await load("server");
		const base = replay(recording);
		const run: CommandRunner = argv =>
			argv.join(" ").startsWith(prefix)
				? Promise.resolve({ code: 1, stdout: "", stderr: "Access denied" })
				: base(argv);
		const scan = await scanHost(run, "linux", "server", recording.now);
		expect(scan.errors).toEqual([`systemd --user: systemctl --user ${operation} failed: Access denied`]);
		expect(scan.jobs.some(job => job.source === "systemd-user")).toBe(false);
		expect(scan.jobs.some(job => job.id === "server-backup.timer")).toBe(true);
	});

	function systemdHost(service: string, kill: CommandResult): CommandRunner {
		const fragment = "/home/dev/.config/systemd/user";
		return async argv => {
			const key = argv.join(" ");
			if (key === "readlink /etc/localtime") return { code: 0, stdout: "/usr/share/zoneinfo/Etc/UTC\n", stderr: "" };
			if (argv[0] === "readlink") return { code: 0, stdout: argv.slice(3).join("\n"), stderr: "" };
			if (argv[0] === "crontab") return { code: 1, stdout: "", stderr: "no crontab for dev" };
			if (argv[0] === "sh" && argv[2].includes("kill -l")) return kill;
			if (argv[1] !== "--user") return { code: 0, stdout: "[]", stderr: "" };
			if (key.startsWith("systemctl --user list-timers")) {
				const timer = {
					unit: "job.timer",
					activates: "job.service",
					next: 1_792_700_000_000_000,
					last: 1_792_600_000_000_000,
				};
				return { code: 0, stdout: JSON.stringify([timer]), stderr: "" };
			}
			if (key.startsWith("systemctl --user list-")) return { code: 0, stdout: "[]", stderr: "" };
			if (key.startsWith("systemctl --user show -p Id,FragmentPath,Unit")) {
				return {
					code: 0,
					stdout: `Id=job.timer\nFragmentPath=${fragment}/job.timer\nUnit=job.service\n`,
					stderr: "",
				};
			}
			if (key.startsWith("systemctl --user show")) {
				const timer = `Id=job.timer\nActiveState=active\nSubState=waiting\nFragmentPath=${fragment}/job.timer\nUnit=job.service\nTimersCalendar={ OnCalendar=*-*-* 03:00:00 ; next_elapse=0 }\n`;
				const block = `Id=job.service\nType=oneshot\nSubState=dead\nExecMainStartTimestamp=@1792600000\nFragmentPath=${fragment}/job.service\n${service}`;
				return { code: 0, stdout: `${timer}\n${block}`, stderr: "" };
			}
			throw new Error(`unexpected ${key}`);
		};
	}

	const named = (name: string): CommandResult => ({ code: 0, stdout: `${name}\n`, stderr: "" });
	const noKill: CommandResult = { code: 127, stdout: "", stderr: "kill: not found" };

	it.each([
		["a SuccessExitStatus= exit code", "inactive", "success", 1, 42, noKill, "success (exit 42)", false],
		["a SuccessExitStatus= signal", "inactive", "success", 2, 10, named("USR1"), "success (signal USR1)", false],
		["a non-zero exit", "failed", "exit-code", 1, 1, noKill, "exit 1", true],
		["a timeout", "failed", "timeout", 2, 9, named("KILL"), "timeout (signal KILL)", true],
		// Signal numbers are the host's: 10 is BUS on MIPS Linux and on macOS, USR1 on x86 and ARM Linux.
		["a signal named by the host's kill -l", "failed", "signal", 2, 10, named("BUS"), "signal BUS", true],
		["a signal the host cannot name", "failed", "signal", 2, 10, noKill, "signal 10", true],
	])("judges %s by systemd's Result=", async (_name, active, result, code, status, kill, text, failed) => {
		const service = `ActiveState=${active}\nResult=${result}\nExecMainCode=${code}\nExecMainStatus=${status}\n`;
		const scan = await scanHost(systemdHost(service, kill), "linux", "box", Date.parse("2026-10-22T04:00:00Z"));
		expect(scan.errors).toEqual([]);
		const [job] = scan.jobs;
		expect(job.lastResult).toBe(text);
		expect(job.flags.includes("failed")).toBe(failed);
	});
});

describe("rendering untrusted text", () => {
	const job: ExternalJob = {
		host: "box",
		source: "launchd",
		kind: "timer",
		id: "evil\x1b]52;c;ZXZpbA==\x07\nforged-row\tx\r",
		description: null,
		schedule: "\x1b[2J\x1b[Hevery 1h",
		next: null,
		last: null,
		lastResult: "exit 1\x9b31m",
		state: "not loaded\nforged-state",
		command: null,
		sourcePath: "/Users/dev/Library/LaunchAgents/x.plist\x1b[1A",
		log: "/tmp/x.log\r\nforged-log",
		flags: ["failed", "unarmed"],
	};
	const wide: ExternalJob = { ...job, id: "界".repeat(40), flags: [] };
	const estate: Estate = {
		jobs: [job, wide],
		hosts: [
			{
				host: "far\x1b]0;title\x07",
				via: "omp",
				timers: [{ id: "t\x1b[31m", status: "armed\nforged-timer", next: null }],
				errors: ["denied\r\nforged-error"],
			},
			{ host: "old", via: "ssh", fallback: "its omp\x1b[5m has no `timer ls --all`", errors: [] },
		],
	};

	it("strips control sequences and line breaks from every row, attention line, timer, footer and error", () => {
		const text = renderEstate(estate, Date.now());
		expect(text).not.toMatch(/\x1b\]|\x07|\r|\x9b/);
		// Only styling (SGR) escapes survive, and they come from the renderer.
		expect(text).not.toMatch(/\x1b\[(?![0-9;]*m)/);
		// Injected styling is stripped too; only the renderer's own may remain.
		expect(text).not.toContain("omp\x1b[5m");
		expect(text).not.toContain("t\x1b[31m");
		const lines = Bun.stripANSI(text).split("\n");
		expect(lines.filter(line => line.trimStart().startsWith("forged"))).toEqual([]);
		expect(lines.filter(line => line.includes("forged-row")).length).toBe(2);
	});

	it("clips wide ids to the column width", () => {
		const row = Bun.stripANSI(renderEstate(estate, Date.now()))
			.split("\n")
			.find(line => line.includes("界"))!;
		expect(Bun.stringWidth(row.split("  ")[2])).toBeLessThanOrEqual(44);
	});
});
