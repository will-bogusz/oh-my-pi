/**
 * External estate adapters replayed against outputs recorded on Will's Mac and
 * goliath (2026-10-22, trimmed to a subset of units, environment blocks removed).
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	type CommandResult,
	type CommandRunner,
	type ExternalJob,
	parseCrontab,
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
	if (argv[0] === "sh") return `sh -c ${argv[2].includes("launchctl print") ? "state" : "dump"}`;
	return argv.join(" ");
}

function replay(recording: Recording, overrides: Record<string, CommandResult> = {}): CommandRunner {
	return async argv => {
		if (argv[0] === "readlink") {
			const paths = argv.slice(argv.indexOf("-f") + 1).filter(arg => arg !== "--");
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

describe("systemd adapter (goliath recording)", () => {
	it("lists custom timers and long-running services with health computed from unit state", async () => {
		const recording = await load("goliath");
		const scan = await scanHost(replay(recording), "linux", "goliath", recording.now);
		expect(scan.errors).toEqual([]);
		const jobs = byId(scan.jobs);

		// Distribution units are not anyone's standing work.
		for (const vendor of ["launchpadlib-cache-clean.timer", "apt-daily.timer", "dbus.service"]) {
			expect(jobs.has(vendor)).toBe(false);
		}

		const macro = jobs.get("x-scraping-market-macro.timer")!;
		expect(macro.lastResult).toBe("exit 1");
		expect(macro.flags).toContain("failed");
		expect(macro.log).toBe("journalctl --user -u x-scraping-market-macro.service");

		// Mid-run, a calendar timer has no next elapse; that is not "unarmed".
		const nightly = jobs.get("x-scraping-nightly.timer")!;
		expect(nightly.lastResult).toBe("running");
		expect(nightly.next).toBeNull();
		expect(nightly.flags).not.toContain("unarmed");

		const poll = jobs.get("hermes-bot-poll.timer")!;
		expect(poll.flags).toEqual(["no-failure-alert", "interval-only"]);
		expect(poll.schedule).toContain("OnUnitActiveSec=10min");
		// Linked units show the repo file they come from.
		expect(poll.sourcePath).toBe("/home/will/codebases/workstation-ops/units/goliath/hermes-bot-poll.timer");

		// `sh -c 'python3 $$HOME/tmp/…'` runs from scratch; `fleet stash ~/tmp/…` only operates on it.
		expect(jobs.get("mmslickpc-priority-revert.timer")!.flags).toEqual([
			"never-ran",
			"no-failure-alert",
			"source-in-scratch",
		]);
		expect(jobs.get("scratch-expiry.timer")!.flags).not.toContain("source-in-scratch");

		expect(jobs.get("gmail-triage.timer")!.flags).toEqual([]);

		const collector = jobs.get("discord-collector.service")!;
		expect(collector.kind).toBe("service");
		expect(collector.schedule).toBe("always (Restart=on-failure)");
		expect(collector.flags).toEqual([]);
		expect(jobs.get("x-scraping-nightly-rerun-1021.service")!.flags).toContain("failed");

		const backup = jobs.get("goliath-backup.timer")!;
		expect(backup.source).toBe("systemd-system");
		// System units log to the system journal, and OnFailure= on the service counts as an alert.
		expect(backup.log).toBe("journalctl -u goliath-backup.service");
		expect(backup.flags).toEqual([]);
		expect(jobs.get("lab-gateway-envs.timer")!.flags).toContain("interval-only");
		expect(jobs.get("ibc-gateway.service")!.kind).toBe("service");
	});
});

describe("launchd adapter (Mac recording)", () => {
	it("flags failed exits, disabled and unloaded agents, sleep-lossy intervals and scratch logs", async () => {
		const recording = await load("mac");
		const scan = await scanHost(replay(recording), "macos", "mac", recording.now);
		expect(scan.errors).toEqual([]);
		const jobs = byId(scan.jobs);

		// An empty `{}` plist has no Label; launchd ignores it and so do we.
		expect([...jobs.keys()].some(id => id.includes("keystone"))).toBe(false);

		const push = jobs.get("com.viathebrink.weekly-review-push")!;
		expect(push.lastResult).toBe("exit 1");
		expect(push.flags).toEqual(["failed", "no-failure-alert"]);
		expect(jobs.get("com.viathebrink.trading-book-backup")!.lastResult).toBe("exit 255");

		const bridge = jobs.get("com.bogusz.seb-bridge")!;
		expect(bridge.kind).toBe("service");
		expect(bridge.state).toBe("running pid 54274");

		const backup = jobs.get("com.viathebrink.backup")!;
		expect(backup.lastResult).toBe("success");
		expect(backup.flags).toEqual(["no-failure-alert"]);
		expect(backup.schedule).toBe("daily 12:30");
		const next = new Date(backup.next!);
		expect(next.getTime()).toBeGreaterThan(recording.now);
		expect(next.getTime() - recording.now).toBeLessThanOrEqual(86_400_000);
		expect([next.getHours(), next.getMinutes()]).toEqual([12, 30]);
		// launchd records no start time; the log's mtime stands in and says so.
		expect(backup.lastApprox).toBe(true);
		expect(backup.log).toBe("/Users/viathebrink/Library/Logs/backup.log");

		const discord = jobs.get("com.viathebrink.discord-desktop-export")!;
		expect(discord.schedule).toBe("every 15m + at load");
		expect(discord.flags).toContain("sleep-lossy");
		expect(discord.next).toBeNull();

		const router = jobs.get("com.will.router-fw-update")!;
		expect(router.state).toBe("disabled");
		expect(router.flags).toEqual(["unarmed", "no-failure-alert", "source-in-scratch"]);

		expect(jobs.get("com.hex-rays.idapython-venv-executable")!.state).toBe("not loaded");
		expect(jobs.get("com.will.mmslickpc-priority-revert")!.flags).toContain("source-in-scratch");

		// `>/dev/null 2>&1` discards the output cron would otherwise mail.
		const cron = jobs.get("crontab:2")!;
		expect(cron.schedule).toBe("0 0 * * *");
		expect(cron.flags).toEqual(["no-failure-alert"]);
	});
});

describe("crontab parsing", () => {
	it("honours MAILTO and nicknames", () => {
		const now = Date.parse("2026-10-22T04:00:00Z");
		const jobs = parseCrontab(
			[
				"0 3 * * * /usr/local/bin/nightly >> /var/log/nightly.log 2>&1",
				'MAILTO=""',
				"@reboot /Users/will/tmp/adhoc/x/start.sh",
				"*/5 * * * * /usr/bin/true",
			].join("\n"),
			"mac",
			now,
		);
		expect(jobs.map(job => [job.id, job.next !== null, job.log, job.flags])).toEqual([
			["crontab:1", true, "/var/log/nightly.log", []],
			["crontab:3", false, null, ["no-failure-alert", "source-in-scratch"]],
			["crontab:4", true, null, ["no-failure-alert"]],
		]);
	});
});

describe("remote hosts", () => {
	it("never sends `timer ls` to an omp whose help lacks the estate flags, and parses the host locally", async () => {
		const recording = await load("goliath");
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
		const { jobs, report } = await scanRemoteHost("goliath", run, "linux", recording.now);
		expect(calls).not.toContain("omp timer ls --json --all");
		expect(report).toMatchObject({ host: "goliath", via: "ssh", errors: [] });
		expect(jobs.find(job => job.id === "x-scraping-market-macro.timer")?.host).toBe("goliath");
	});

	it("uses the remote omp's own listing when it supports --all", async () => {
		const remoteJob: ExternalJob = {
			host: "goliath.lan",
			source: "systemd-user",
			kind: "timer",
			id: "weekly-review.timer",
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
						hosts: [{ host: "goliath.lan", via: "local", errors: ["systemd system: denied"] }],
					}),
					stderr: "",
				};
			}
			throw new Error(`unexpected ${key}`);
		};
		const { jobs, report } = await scanRemoteHost("goliath", run, "linux", Date.now());
		expect(jobs.map(job => [job.host, job.id])).toEqual([["goliath", "weekly-review.timer"]]);
		expect(report).toEqual({
			host: "goliath",
			via: "omp",
			timers: [{ id: "nightly", status: "armed" }],
			errors: ["systemd system: denied"],
		});
	});

	it("keeps the other adapters' rows when one adapter fails", async () => {
		const run: CommandRunner = async argv =>
			argv[0] === "crontab"
				? { code: 0, stdout: "0 1 * * * /usr/bin/true\n", stderr: "" }
				: { code: 127, stdout: "", stderr: "systemctl: command not found" };
		const scan = await scanHost(run, "linux", "box", Date.now());
		expect(scan.jobs.map(job => job.id)).toEqual(["crontab:1"]);
		expect(scan.errors).toEqual([
			"systemd --user: systemctl --user list-timers failed: systemctl: command not found",
			"systemd system: systemctl list-timers failed: systemctl: command not found",
		]);
	});
});
