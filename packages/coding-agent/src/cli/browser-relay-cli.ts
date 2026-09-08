/**
 * `omp browser-relay` implementation: serve the local CDP relay and install
 * its Chrome extension. Standalone CLI command — console output here is
 * intentional user-facing output.
 */
import * as path from "node:path";
import { getBrowserRelayDir, isEnoent } from "@oh-my-pi/pi-utils";
import { closeDaemonClients } from "../launch/client";
import { RelayAccess, readRelayControlToken, relayAccessPath } from "../tools/browser/relay/access";
import { ensureRelayDaemon, probeRelayServer, RelayPairingLease } from "../tools/browser/relay/daemon";
import backgroundJs from "../tools/browser/relay/extension-assets/background.js.txt" with { type: "text" };
import buildInfo from "../tools/browser/relay/extension-assets/build-info.json.txt" with { type: "text" };
import licenseText from "../tools/browser/relay/extension-assets/LICENSE.txt" with { type: "text" };
import manifestJson from "../tools/browser/relay/extension-assets/manifest.json.txt" with { type: "text" };
import optionsHtml from "../tools/browser/relay/extension-assets/options.html.txt" with { type: "text" };
import optionsJs from "../tools/browser/relay/extension-assets/options.js.txt" with { type: "text" };
import thirdPartyNotices from "../tools/browser/relay/extension-assets/THIRD-PARTY-NOTICES.txt" with { type: "text" };
import { localBrowserRequest } from "../tools/browser/relay/local-http";
import { DEFAULT_RELAY_URL } from "../tools/browser/relay/kind";
import { type RelayServer, startRelayServer } from "../tools/browser/relay/server";

export const BROWSER_RELAY_ACTIONS = ["serve", "install", "pair", "list", "unpair"] as const;
export type BrowserRelayAction = (typeof BROWSER_RELAY_ACTIONS)[number];

export interface BrowserRelayCommandArgs {
	action: BrowserRelayAction;
	port: number;
	id?: string;
	/** Install target directory; defaults to ~/.omp/browser-relay/extension. */
	dir?: string;
	/** Installed extension display name; independent of paired browser identity. */
	name?: string;
	/** Gather tabs the agent actively drives into an 'omp' Chrome tab group (default true). */
	group?: boolean;
	verbose?: boolean;
}

const EXTENSION_FILES: Record<string, string> = {
	"background.js": backgroundJs,
	"build-info.json": buildInfo,
	LICENSE: licenseText,
	"manifest.json": manifestJson,
	"options.html": optionsHtml,
	"options.js": optionsJs,
	"THIRD-PARTY-NOTICES.txt": thirdPartyNotices,
};

/** Default port of the relay endpoint (kept in sync with DEFAULT_RELAY_URL). */
export const DEFAULT_RELAY_PORT = Number(new URL(DEFAULT_RELAY_URL).port);

export async function runBrowserRelayCommand(args: BrowserRelayCommandArgs): Promise<void> {
	if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535)
		throw new Error("Port must be between 1 and 65535");
	if (args.action === "install") {
		await runInstall(args.dir, args.port, args.name);
		return;
	}
	if (args.action === "serve") await runServe(args);
	else {
		try {
			await runControl(args);
		} finally {
			// Finite CLI commands must release their broker lease on success and
			// failure. The persistent socket otherwise prevents natural process exit.
			await closeDaemonClients();
		}
	}
}

async function runInstall(
	dirOverride: string | undefined,
	port: number,
	nameOverride: string | undefined,
): Promise<void> {
	let displayName = nameOverride?.trim();
	if (displayName === "") throw new Error("Extension name must not be empty");
	const dir = dirOverride ? path.resolve(dirOverride) : path.join(getBrowserRelayDir(), "extension");
	let previousName: string | undefined;
	try {
		const previous: unknown = await Bun.file(path.join(dir, "manifest.json")).json();
		if (previous && typeof previous === "object" && "name" in previous && typeof previous.name === "string")
			previousName = previous.name.trim() || undefined;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	// The name distinguishes debugger warnings for independently installed
	// profiles/extensions. Refreshing files must not collapse that identity.
	displayName ??= previousName;
	let installedManifest = manifestJson;
	if (displayName !== undefined) {
		const manifest = JSON.parse(manifestJson);
		manifest.name = displayName;
		manifest.action.default_title = `${displayName} (click for settings)`;
		installedManifest = `${JSON.stringify(manifest, null, "\t")}\n`;
	}
	for (const name in EXTENSION_FILES) {
		await Bun.write(path.join(dir, name), name === "manifest.json" ? installedManifest : EXTENSION_FILES[name]!);
	}
	await Bun.write(path.join(dir, "connection.json"), `${JSON.stringify({ port })}\n`);
	console.log(
		`${previousName ? "Updated" : "Installed"} the ${displayName ?? "OMP Browser Relay"} extension files at ${dir}`,
	);
	console.log("");
	if (previousName) {
		console.log(
			`If this directory is already loaded in Chrome, open chrome://extensions and click Reload on "${displayName}".`,
		);
		console.log(
			"Your saved browser name, pairing and connection settings remain in Chrome. No new pairing code is needed.",
		);
		console.log("The files on disk are updated; the running extension changes only after Chrome reloads it.");
		console.log("");
		console.log("If this directory has not been loaded in this Chrome profile, finish first-time setup:");
	} else {
		console.log("Finish setup in Chrome:");
	}
	console.log("  1. Open chrome://extensions and enable Developer mode.");
	console.log(`  2. Click "Load unpacked" and select: ${dir}`);
	console.log(`  3. Run: omp browser-relay pair${port === DEFAULT_RELAY_PORT ? "" : ` --port ${port}`}`);
	console.log("  4. Click the extension toolbar button, name this browser, and enter the pairing code.");
	console.log("  5. Enable the mode: omp config set browser.relay true");
	if (port !== DEFAULT_RELAY_PORT)
		console.log(`     Set its endpoint: omp config set browser.relayUrl http://127.0.0.1:${port}`);
	console.log("");
	console.log(`New installations connect to port ${port}. Existing saved connection settings are preserved.`);
	console.log("omp starts the relay automatically when the browser prelude needs it;");
	console.log("Pair each Chrome profile separately; choose a name such as Work Chrome.");
	console.log("The extension badge shows 'on' once it reaches a relay.");
}

async function runControl(args: BrowserRelayCommandArgs): Promise<void> {
	const url = `http://127.0.0.1:${args.port}`;
	await ensureRelayDaemon({ cdpUrl: url });
	const health = await localBrowserRequest(`${url}/health`);
	if (!health.ok || ((await health.json()) as { protocol?: number }).protocol !== 2)
		throw new Error(
			"This endpoint has an older service. Preserve active tasks and use another --port, or update when they finish.",
		);
	if (args.action === "unpair" && !args.id) throw new Error("Unpair requires --id from omp browser-relay list");
	const response = await localBrowserRequest(`${url}/managed`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${readRelayControlToken(url)}` },
		body: JSON.stringify({ action: args.action === "list" ? "instances" : args.action, id: args.id }),
	});
	if (!response.ok) throw new Error(`Browser setup failed (${response.status}): ${await response.text()}`);
	const result: unknown = await response.json();
	if (args.action === "pair") {
		const pair = result as { code: string; expiresAt: number };
		console.log(`Pairing code: ${pair.code}`);
		console.log("Open OMP Browser extension options, name this browser, and paste the code (expires in 10 minutes).");
		if (args.port !== DEFAULT_RELAY_PORT) console.log(`Set the extension’s advanced port to ${args.port}.`);
		console.log("Repeat for each browser profile. Re-pairing a lost credential requires unpair --id first.");
	} else if (args.action === "list") console.log(JSON.stringify(result, null, 2));
	else console.log("Browser unpaired; its tabs were preserved. Pair it again with a fresh code if needed.");
}

async function runServe(args: BrowserRelayCommandArgs): Promise<void> {
	const log = args.verbose
		? (message: string, data?: Record<string, unknown>) => {
				console.error(`[relay] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
			}
		: undefined;
	const pairingLease = new RelayPairingLease();
	let relay: RelayServer;
	try {
		relay = startRelayServer({
			port: args.port,
			access: new RelayAccess(relayAccessPath(args.port)),
			group: args.group !== false,
			log,
			onPairingCode: expiresAt => pairingLease.holdUntil(expiresAt),
		});
	} catch (err) {
		// The port is machine-global while relays can be started by any project's
		// broker (or by hand): losing the bind to a live relay is success.
		if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
			if (await probeRelayServer(`http://127.0.0.1:${args.port}`)) {
				console.log(`omp browser relay already running on http://127.0.0.1:${args.port}; nothing to do.`);
				return;
			}
			console.error(`Port ${args.port} is in use by something that is not an omp browser relay.`);
			process.exit(1);
		}
		throw err;
	}

	console.log(`omp browser relay listening on http://127.0.0.1:${args.port}`);
	console.log(`  extension endpoint  ws://127.0.0.1:${args.port}/ext`);
	if (args.port === DEFAULT_RELAY_PORT) {
		console.log("  enable with         omp config set browser.relay true");
	} else {
		console.log(
			`  enable with         omp config set browser.relay true && omp config set browser.relayUrl http://127.0.0.1:${args.port}`,
		);
	}
	console.log("Waiting for a paired browser (omp browser-relay pair)...");

	let announced = false;
	const readiness = setInterval(() => {
		if (relay.instances.ready && !announced) {
			announced = true;
			console.log("Extension connected. The omp browser prelude can now drive your tabs.");
		} else if (!relay.instances.ready && announced) {
			announced = false;
			console.log("Extension disconnected; waiting for it to reconnect...");
		}
	}, 500);

	const shutdown = async () => {
		clearInterval(readiness);
		relay.stop();
		await pairingLease.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Serve runs until SIGINT/SIGTERM; keep the process alive.
	await new Promise<never>(() => {});
}
