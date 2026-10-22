/**
 * Post a message into a session's timer mailbox: a live omp holding the
 * session starts a turn on it; otherwise it waits until the session is opened.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { pokeHelp as commandHelp } from "../cli/command-help";
import { runPokeCommand } from "../cli/timer-cli";

export default class Poke extends Command {
	static description = commandHelp.description;

	static args = {
		session: Args.string({ description: "Session id, id prefix, or session file", required: true }),
		message: Args.string({ description: "Message text (remaining arguments are joined)", required: true }),
	};

	static flags = {
		from: Flags.string({ description: "Sender label shown to the agent (default: user@host)" }),
	};

	static examples = ['omp poke 01a14cac "the nightly build finished; check dist/report.txt"'];

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(Poke);
		await runPokeCommand(args.session ?? "", argv.slice(1).join(" "), flags.from);
	}
}
