/**
 * Set, inspect and drive timers from outside a session; `tick` is what the
 * per-host OS unit (`omp timer install`) runs once a minute.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { timerHelp as commandHelp } from "../cli/command-help";
import { runTimerCommand, TIMER_ACTIONS, type TimerAction } from "../cli/timer-cli";

export default class Timer extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description:
				"set, edit, ls (default), show, runs, logs, fire, pause, resume, rm, tick, install, uninstall, doctor",
			required: false,
			options: [...TIMER_ACTIONS],
		}),
		id: Args.string({
			description: "Timer id (every action except ls, tick, install, uninstall, doctor)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON" }),
		reason: Flags.string({ description: "set: why this timer exists (required)" }),
		when: Flags.string({
			description:
				"set/edit: Tern-style schedule: 'in 20m', 'at 15:00', 'every 30m', 'daily 09:00', 'mon,thu 18:30'",
		}),
		at: Flags.string({ description: "set/edit: one-shot: now, 'in 2m', HH:MM, 'tomorrow 09:30', 'mon 09:00', ISO" }),
		every: Flags.string({
			description: "set/edit: recurring: 30m, 2h, 'daily 09:00', 'weekdays 09:00', 'mon,thu 18:30', 5-field cron",
		}),
		until: Flags.string({ description: "set/edit: shell gate checked each minute; exit 0 fires once, 1 = not yet" }),
		ci: Flags.string({
			description: "set/edit: fire once CI on a PR (owner/repo#123) or commit (owner/repo@sha) finished",
		}),
		pid: Flags.integer({ description: "set/edit: fire once this process exits" }),
		prompt: Flags.string({ description: "set/edit: instruction delivered when it fires" }),
		shell: Flags.string({ description: "set/edit: command to run instead of a prompt" }),
		session: Flags.string({ description: "set: target session id or file, or 'fresh' (default for the CLI)" }),
		"when-closed": Flags.string({ description: "set/edit: resume (default) or hold", options: ["resume", "hold"] }),
		tz: Flags.string({ description: "set/edit: IANA zone for clock times" }),
		cwd: Flags.string({ description: "set/edit: working directory (default: current)" }),
		expires: Flags.string({ description: "set/edit: '7d', a date, or never" }),
		"max-runs": Flags.integer({ description: "set/edit: retire after this many runs" }),
		model: Flags.string({ description: "set/edit: model for fresh runs" }),
		title: Flags.string({ description: "set/edit: display title" }),
		overlap: Flags.string({
			description: "set/edit: a fire while the last run is in flight: skip (default) or queue one",
			options: ["skip", "queue"],
		}),
		grace: Flags.string({
			description: "set/edit: how late a run may still start (default 12h once; recurring: always the newest slot)",
		}),
		catchup: Flags.string({
			description: "set/edit: a slot reached late (asleep, no ticker): run it once (default) or skip it as missed",
			options: ["run", "skip"],
		}),
		"pause-after": Flags.integer({ description: "set/edit: consecutive failures that pause it (default 3)" }),
		"allow-timers": Flags.boolean({ description: "set/edit: let its runs manage other timers" }),
		"wake-machine": Flags.boolean({
			description: "set/edit: macOS one-shot: wake the Mac 2m before (sudo -n pmset)",
		}),
		rev: Flags.integer({ description: "set/edit/pause/resume: fail unless the timer is at this rev" }),
		data: Flags.string({ description: "fire: untrusted data handed to the run" }),
		limit: Flags.integer({ description: "runs: newest N runs only" }),
		"dry-run": Flags.boolean({
			description: "install/uninstall/doctor: write unit files but run no launchctl/systemctl",
		}),
		all: Flags.boolean({
			description: "ls: also list systemd/launchd/cron jobs omp did not create, with health flags",
		}),
		host: Flags.string({
			description: "ls: also list another host's timers over ssh (name from `omp ssh`, comma-separated, or 'all')",
		}),
	};

	static examples = [
		"omp timer ls",
		"omp timer ls --all --host goliath",
		"omp timer set nightly --every 'daily 03:00' --shell 'make backup' --reason 'nightly backup'",
		"omp timer set ci-done --ci owner/repo#123 --session <id> --prompt 'CI finished; report' --reason 'watch CI'",
		"omp timer edit nightly --every 'daily 04:00'",
		"omp timer runs nightly",
		"omp timer install",
		"omp timer doctor",
	];

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(Timer);
		await runTimerCommand({
			action: (args.action ?? "ls") as TimerAction,
			id: args.id,
			extra: argv.slice(2),
			json: flags.json ?? false,
			data: flags.data,
			limit: flags.limit,
			dryRun: flags["dry-run"] ?? false,
			all: flags.all ?? false,
			hosts: flags.host
				?.split(",")
				.map(host => host.trim())
				.filter(Boolean),
			fields: {
				reason: flags.reason,
				title: flags.title,
				when: flags.when,
				at: flags.at,
				every: flags.every,
				until: flags.until,
				ci: flags.ci,
				pid: flags.pid,
				prompt: flags.prompt,
				shell: flags.shell,
				session: flags.session,
				whenClosed: flags["when-closed"] as "resume" | "hold" | undefined,
				tz: flags.tz,
				cwd: flags.cwd,
				expires: flags.expires,
				maxRuns: flags["max-runs"],
				model: flags.model,
				overlap: flags.overlap as "skip" | "queue" | undefined,
				grace: flags.grace,
				catchup: flags.catchup as "run" | "skip" | undefined,
				pauseAfter: flags["pause-after"],
				allowTimers: flags["allow-timers"],
				wakeMachine: flags["wake-machine"],
				rev: flags.rev,
			},
		});
	}
}
