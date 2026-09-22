/**
 * Broker-owned browser relay daemon.
 *
 * The MV3 extension can only dial OUT (service workers cannot listen on
 * sockets), so a native process must own the relay port. Instead of making
 * the user run `omp browser-relay` by hand, the relay kind lazily starts one
 * under a profile-independent, machine-global daemon broker. Every relay
 * consumer holds a connection to that broker, so one project exiting cannot
 * tear down the fixed-port singleton while another project still uses it.
 *
 * A manually started relay may already own the port. Consumers still acquire
 * the global broker lease before probing, then adopt that external server
 * without attempting another bind.
 */
import { getGlobalDaemonRuntimeDir, logger } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient, daemonClientForGlobal, type DaemonBrokerClient } from "../../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../../launch/ensure";
import { resolveWorkerSpawnCmd } from "../../../subprocess/worker-client";
import { throwIfAborted } from "../../tool-errors";
import { probeCdpStatus } from "../attach";
import { DEFAULT_RELAY_URL } from "./kind";
import { localBrowserRequest } from "./local-http";
import { isCurrentRelayHealth, type RelayHealth } from "./protocol";

/** Stable broker daemon name for the relay server. */
export const RELAY_DAEMON_NAME = "omp.browser.relay";
const RELAY_BROKER_SCOPE = "browser-relay";
/** Matches the serve banner (`omp browser relay listening on http://…`). */
const READY_LOG_PATTERN = String.raw`browser relay listening on http://\S+`;
const READY_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 1_500;
/** probe→describe→start rounds; bounds cross-process races and wedged-relay replacement. */
const ENSURE_ATTEMPTS = 3;
/** Port of {@link DEFAULT_RELAY_URL}; the daemon record for it carries no port suffix. */
const DEFAULT_RELAY_PORT = new URL(DEFAULT_RELAY_URL).port;

/** A code-entry window leases the broker independently of the finite pairing CLI. */
export class RelayPairingLease {
	readonly #runtimeDir: string;
	#client: Promise<DaemonBrokerClient> | undefined;
	#timer: NodeJS.Timeout | undefined;
	#expiresAt = 0;
	#closed = false;

	constructor(runtimeDir = getGlobalDaemonRuntimeDir(RELAY_BROKER_SCOPE)) {
		this.#runtimeDir = runtimeDir;
	}

	async holdUntil(expiresAt: number): Promise<void> {
		if (this.#closed) throw new Error("Browser pairing setup has closed");
		if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
			throw new Error("Browser pairing code has already expired");
		this.#expiresAt = Math.max(this.#expiresAt, expiresAt);
		clearTimeout(this.#timer);
		const pending = (this.#client ??= createDaemonBrokerClient(this.#runtimeDir, {
			runtimeDir: this.#runtimeDir,
		}));
		try {
			const client = await pending;
			await client.request({ op: "ping" });
			if (this.#closed || this.#client !== pending) throw new Error("Browser pairing setup has closed");
			clearTimeout(this.#timer);
			this.#timer = setTimeout(
				() => {
					this.#timer = undefined;
					this.#client = undefined;
					this.#expiresAt = 0;
					client.close();
				},
				Math.max(0, this.#expiresAt - Date.now()),
			);
		} catch (error) {
			if (this.#client === pending) {
				this.#client = undefined;
				this.#expiresAt = 0;
				clearTimeout(this.#timer);
			}
			await pending.then(
				client => client.close(),
				() => {},
			);
			throw error;
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		clearTimeout(this.#timer);
		const pending = this.#client;
		this.#client = undefined;
		await pending?.then(
			client => client.close(),
			() => {},
		);
	}
}

/**
 * What is answering at `cdpUrl`: the `/health` body of a relay this build can
 * drive, `"legacy"` for a healthy older service (preserved, never replaced —
 * the acquisition layer reports the mismatch), or `null` when nothing is
 * listening. The body is returned rather than a flag so callers do not have to
 * fetch `/health` a second time to learn the protocol.
 */
export async function probeRelayServer(cdpUrl: string): Promise<RelayHealth | "legacy" | null> {
	const response = await localBrowserRequest(`${cdpUrl}/health`, {
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
	}).catch(() => undefined);
	if (response?.ok) {
		const body: unknown = await response.json().catch(() => undefined);
		if (isCurrentRelayHealth(body)) return body;
	}
	const status = await probeCdpStatus(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS });
	return status === 503 || (status !== null && status >= 200 && status < 300) ? "legacy" : null;
}

/** Auto-start is only safe for endpoints this machine can own. */
export function isLoopbackRelayUrl(cdpUrl: string): boolean {
	try {
		const { hostname } = new URL(cdpUrl);
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}

/**
 * Ensure a relay server answers at `cdpUrl`, starting the broker-owned daemon
 * when nothing is serving. Resolves with what answered — the `/health` body of
 * a usable relay, or `"legacy"` for an older service this build must not
 * replace — so the caller needs no second probe; the extension handshake
 * (503 → 200) is still the caller's wait. `null` when nothing could be
 * reached or started (broker unavailable or start rounds exhausted).
 */
export async function ensureRelayDaemon(opts: {
	cdpUrl: string;
	signal?: AbortSignal;
}): Promise<RelayHealth | "legacy" | null> {
	let port: string;
	try {
		port = String(new URL(opts.cdpUrl).port || 80);
	} catch {
		return null;
	}
	// Broker records must identify the listening endpoint. A failed custom-port
	// probe must never be treated as proof that another port's daemon is wedged.
	const daemonName = port === DEFAULT_RELAY_PORT ? RELAY_DAEMON_NAME : `${RELAY_DAEMON_NAME}.${port}`;
	// Open the lazy client before probing. Merely caching SocketDaemonClient
	// would not create the broker connection (and therefore would hold no lease).
	const client = await daemonClientForGlobal(RELAY_BROKER_SCOPE);
	throwIfAborted(opts.signal);
	await client.request({ op: "ping" }, opts.signal);
	const serving = await probeRelayServer(opts.cdpUrl);
	if (serving) return serving;
	const spawn = resolveWorkerSpawnCmd("browser-relay");
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		throwIfAborted(opts.signal);
		// A manual serve or concurrent global-broker start may have won the
		// port since the last round; adopt it instead of fighting the bind.
		const adopted = await probeRelayServer(opts.cdpUrl);
		if (adopted) return adopted;
		const existing = await describeQuietly(client, daemonName, "Browser relay", opts.signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined) await waitReady(client, daemonName, "Browser relay", opts.signal);
			const ready = await probeRelayServer(opts.cdpUrl);
			if (ready) return ready;
			// Live record but nothing listening: replace the wedged daemon.
			await stopQuietly(client, daemonName, "Browser relay", opts.signal);
			continue;
		}
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name: daemonName,
						application: spawn.cmd[0]!,
						args: [...spawn.cmd.slice(1), "--port", port],
						env: {},
						cwd: spawn.cwd ?? client.projectDir,
						pty: false,
						ready: { log: READY_LOG_PATTERN, timeoutMs: READY_TIMEOUT_MS },
						restart: "no",
						persist: false,
						detached: false,
					},
				},
				opts.signal,
			);
			if (started.op !== "start") continue;
			const fresh = await probeRelayServer(opts.cdpUrl);
			if (fresh) return fresh;
			await stopQuietly(client, daemonName, "Browser relay", opts.signal);
		} catch (error) {
			throwIfAborted(opts.signal);
			// Lost a cross-process start race; the next round adopts the winner.
			logger.debug("Browser relay start contention", {
				name: daemonName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return null;
}
