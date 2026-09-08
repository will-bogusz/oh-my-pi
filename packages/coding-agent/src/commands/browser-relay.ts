/**
 * `omp browser-relay` — drive the user's own Chrome tabs.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import {
	BROWSER_RELAY_ACTIONS,
	type BrowserRelayAction,
	DEFAULT_RELAY_PORT,
	runBrowserRelayCommand,
} from "../cli/browser-relay-cli";

export default class BrowserRelay extends Command {
	static description = "Run the local CDP relay that lets the browser prelude drive your own Chrome tabs";

	static args = {
		action: Args.string({
			description: `Action: ${BROWSER_RELAY_ACTIONS.join(" | ")} (default serve)`,
			options: [...BROWSER_RELAY_ACTIONS],
			required: false,
		}),
	};

	static flags = {
		port: Flags.integer({
			char: "p",
			description: "Service port (install sets the extension default)",
			default: DEFAULT_RELAY_PORT,
		}),
		id: Flags.string({ description: "Exact browser id to unpair (from list)" }),
		dir: Flags.string({
			description: "Extension install directory (install; default ~/.omp/browser-relay/extension)",
		}),
		name: Flags.string({
			description: "Extension display name (install; default OMP Browser Relay)",
		}),
		"no-group": Flags.boolean({
			description: "Don't gather controllable tabs into an 'omp' tab group",
			default: false,
		}),
		verbose: Flags.boolean({ char: "v", description: "Log relay traffic summaries to stderr", default: false }),
	};

	static examples = [
		"omp browser-relay install    # write the Chrome extension to disk + setup steps",
		"omp browser-relay            # serve the relay on the default port",
		"omp browser-relay pair -p 9333",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(BrowserRelay);
		await runBrowserRelayCommand({
			action: (args.action as BrowserRelayAction | undefined) ?? "serve",
			port: flags.port,
			id: flags.id,
			dir: flags.dir,
			name: flags.name,
			group: !flags["no-group"],
			verbose: flags.verbose,
		});
	}
}
