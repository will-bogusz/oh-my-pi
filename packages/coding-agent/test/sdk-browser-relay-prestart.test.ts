import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as brokerClients from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonOperation, DaemonRpcResult } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import * as relayDaemon from "@oh-my-pi/pi-coding-agent/tools/browser/relay/daemon";
import { RELAY_PROTOCOL_VERSION, RELAY_SERVICE_NAME } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * A global browser-relay broker whose "start" brings up a relay answering
 * `/health` on the requested port, so one issued start satisfies the ensure.
 * `ping` can be held to prove session creation does not wait on the broker.
 */
class FakeRelayBroker implements DaemonBrokerClient {
	readonly projectDir = "/fake/global/browser-relay";
	readonly operations: DaemonOperation[] = [];
	readonly servers: Bun.Server<undefined>[] = [];
	pingGate: Promise<void> = Promise.resolve();

	onCompletion(): () => void {
		return () => {};
	}

	async request(operation: DaemonOperation): Promise<DaemonRpcResult> {
		this.operations.push(operation);
		switch (operation.op) {
			case "ping":
				await this.pingGate;
				return { op: "ping", projectDir: this.projectDir };
			case "start":
				this.servers.push(
					Bun.serve({
						port: Number(operation.spec.args[operation.spec.args.indexOf("--port") + 1]),
						hostname: "127.0.0.1",
						fetch: () => Response.json({ service: RELAY_SERVICE_NAME, protocol: RELAY_PROTOCOL_VERSION }),
					}),
				);
				return { op: "start", daemon: { name: operation.spec.name, state: "ready" } } as DaemonRpcResult;
			default:
				throw new Error(`Unknown daemon ${"name" in operation ? operation.name : operation.op}`);
		}
	}

	close(): void {
		for (const server of this.servers) server.stop(true);
	}
}

describe("browser relay prestart at session start", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	const brokers: FakeRelayBroker[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-relay-prestart-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const broker of brokers.splice(0)) broker.close();
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	const openSession = async (overrides: Record<string, unknown>) => {
		const broker = new FakeRelayBroker();
		brokers.push(broker);
		vi.spyOn(brokerClients, "daemonClientForGlobal").mockResolvedValue(broker);
		// Calls through: the real ensure runs against the fake broker.
		const ensure = vi.spyOn(relayDaemon, "ensureRelayDaemon");
		const pingHeld = Promise.withResolvers<void>();
		broker.pingGate = pingHeld.promise;
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(overrides),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		return { session, broker, ensure, releasePing: pingHeld.resolve };
	};

	it("starts the loopback relay once, without holding up session creation", async () => {
		const relayUrl = `http://127.0.0.1:${await findFreeCdpPort()}`;
		const { session, broker, ensure, releasePing } = await openSession({
			"browser.enabled": true,
			"browser.relay": true,
			"browser.relayUrl": relayUrl,
		});
		// The session exists while the broker has not answered the prestart's ping.
		expect(ensure).toHaveBeenCalledTimes(1);
		expect(ensure.mock.calls[0]?.[0]).toEqual({ cdpUrl: relayUrl });
		expect(broker.operations.map(operation => operation.op)).toEqual(["ping"]);

		releasePing();
		expect(await ensure.mock.results[0]?.value).toEqual({
			service: RELAY_SERVICE_NAME,
			protocol: RELAY_PROTOCOL_VERSION,
		});
		const starts = broker.operations.filter(operation => operation.op === "start");
		expect(starts).toHaveLength(1);
		expect(starts[0]?.spec.args.slice(-2)).toEqual(["--port", new URL(relayUrl).port]);

		// Later prelude reads and prompt rebuilds within the session do not ensure again.
		session.getEvalPreludes();
		await session.runToolRegistryMutation(async () => undefined);
		expect(ensure).toHaveBeenCalledTimes(1);
	}, 30_000);

	for (const [label, overrides] of [
		["relay mode is off", { "browser.enabled": true, "browser.relay": false }],
		["the browser prelude is disabled", { "browser.enabled": false, "browser.relay": true }],
		[
			"the relay URL is not loopback",
			{ "browser.enabled": true, "browser.relay": true, "browser.relayUrl": "http://relay.example:9224" },
		],
	] as const) {
		it(`starts nothing when ${label}`, async () => {
			const { session, broker, ensure } = await openSession(overrides);
			session.getEvalPreludes();
			await session.runToolRegistryMutation(async () => undefined);
			expect(ensure).not.toHaveBeenCalled();
			expect(broker.operations).toEqual([]);
		}, 30_000);
	}
});
