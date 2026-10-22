/**
 * Set, inspect and drive timers from outside a session; `tick` is what the
 * per-host OS unit runs once a minute.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { timerHelp as commandHelp } from "../cli/command-help";
import { runTimerCommand, TIMER_ACTIONS, type TimerAction } from "../cli/timer-cli";

export default class Timer extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "set, ls (default), show, runs, rm, pause, resume, fire, tick",
			required: false,
			options: [...TIMER_ACTIONS],
		}),
		id: Args.string({ description: "Timer id (required for every action except ls and tick)", required: false }),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON" }),
		all: Flags.boolean({
			description: "ls: also list systemd/launchd/cron jobs omp did not create, with health flags",
		}),
		host: Flags.string({
			description: "ls: also list another host's timers over ssh (name from `omp ssh`, comma-separated, or 'all')",
		}),
		reason: Flags.string({ description: "set: why this timer exists (required)" }),
		at: Flags.string({ description: "set: one-shot time: now, 'in 2m', HH:MM, 'YYYY-MM-DD HH:MM', ISO" }),
		every: Flags.string({ description: "set: recurring: 5m, 2h, 'daily 09:00', or 5-field cron" }),
		until: Flags.string({ description: "set: shell gate checked each minute; exit 0 fires once, 1 = not yet" }),
		ci: Flags.string({
			description: "set: fire once CI on a PR (owner/repo#123) or commit (owner/repo@sha) finished",
		}),
		pid: Flags.integer({ description: "set: fire once this process exits" }),
		prompt: Flags.string({ description: "set: instruction delivered when it fires" }),
		shell: Flags.string({ description: "set: command to run instead of a prompt" }),
		session: Flags.string({ description: "set: target session id, or 'fresh' (default for the CLI)" }),
		"when-closed": Flags.string({ description: "set: resume (default) or hold", options: ["resume", "hold"] }),
		tz: Flags.string({ description: "set: IANA zone for clock times" }),
		cwd: Flags.string({ description: "set: working directory (default: current)" }),
		expires: Flags.string({ description: "set: '7d', a date, or never" }),
		"max-runs": Flags.integer({ description: "set: retire after this many runs" }),
		model: Flags.string({ description: "set: model for fresh runs" }),
		title: Flags.string({ description: "set: display title" }),
	};

	static examples = [
		"omp timer ls",
		"omp timer ls --all --host goliath",
		"omp timer set nightly --every 'daily 03:00' --shell 'make backup' --reason 'nightly backup'",
		"omp timer set ci-done --until 'test -f /tmp/ci.ok' --session <id> --prompt 'CI finished; report' --reason 'watch CI'",
		"omp timer runs nightly",
		"omp timer tick",
	];

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(Timer);
		await runTimerCommand({
			action: (args.action ?? "ls") as TimerAction,
			id: args.id,
			extra: argv.slice(2),
			json: flags.json ?? false,
			all: flags.all ?? false,
			hosts: flags.host
				?.split(",")
				.map(host => host.trim())
				.filter(Boolean),
			set: {
				reason: flags.reason,
				at: flags.at,
				every: flags.every,
				when:
					flags.until || flags.ci || flags.pid !== undefined
						? { cmd: flags.until, ci: flags.ci, pid: flags.pid }
						: undefined,
				prompt: flags.prompt,
				shell: flags.shell,
				session: flags.session,
				whenClosed: flags["when-closed"] as "resume" | "hold" | undefined,
				tz: flags.tz,
				cwd: flags.cwd,
				expires: flags.expires,
				maxRuns: flags["max-runs"],
				model: flags.model,
				title: flags.title,
			},
		});
	}
}
