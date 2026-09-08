import { describe, expect, it } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import type {
	RelayRpcRequest,
	RelayToExtMessage,
	TabSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";

/** A relay→extension RPC narrowed to one op, tabIds/title/etc. included. */
type ExtRpc<Op extends RelayRpcRequest["op"]> = { t: "rpc"; id: number } & Extract<RelayRpcRequest, { op: Op }>;

class FakeExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	readonly #acked = new Set<number>();
	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}
	close(): void {}
	rpcs<Op extends RelayRpcRequest["op"]>(op: Op): Array<ExtRpc<Op>> {
		return this.messages.filter((msg): msg is ExtRpc<Op> => msg.t === "rpc" && msg.op === op);
	}
	/** RPC requests of `op` not yet answered through {@link ack}. */
	pending<Op extends RelayRpcRequest["op"]>(op: Op): Array<ExtRpc<Op>> {
		return this.rpcs(op).filter(msg => !this.#acked.has(msg.id));
	}
	markAcked(id: number): void {
		this.#acked.add(id);
	}
}

/** Downstream puppeteer-side socket capturing bridge emissions. */
class FakeCdpSocket implements RelaySocket {
	readonly messages: Array<Record<string, unknown>> = [];
	send(text: string): void {
		this.messages.push(JSON.parse(text) as Record<string, unknown>);
	}
	close(): void {}
	sessionFor(commandId: number): string | undefined {
		const msg = this.messages.find(m => m.id === commandId);
		const result = msg && "result" in msg && msg.result && typeof msg.result === "object" ? msg.result : undefined;
		return result && "sessionId" in result && typeof result.sessionId === "string" ? result.sessionId : undefined;
	}
	/** Session ids the bridge announced through `Target.attachedToTarget`. */
	attachedSessions(): string[] {
		const out: string[] = [];
		for (const msg of this.messages) {
			if (msg.method !== "Target.attachedToTarget") continue;
			const params = msg.params;
			if (params && typeof params === "object" && "sessionId" in params && typeof params.sessionId === "string") {
				out.push(params.sessionId);
			}
		}
		return out;
	}
}

function tab(overrides: Partial<TabSnapshot> & { tabId: number }): TabSnapshot {
	return {
		url: "https://example.com/",
		title: "Example",
		active: false,
		windowId: 1,
		pinned: false,
		groupId: -1,
		...overrides,
	};
}

function connect(bridge: RelayBridge, socket: FakeExtSocket, tabs: TabSnapshot[], attachedTabIds: number[] = []): void {
	bridge.extConnected(socket);
	bridge.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			userAgent: "test",
			browserVersion: "Chrome/151.0.0.0",
			tabs,
			attachedTabIds,
		}),
	);
}

it("preserves page identity through tab updates with unavailable URL metadata", () => {
	const bridge = new RelayBridge();
	const extension = new FakeExtSocket();
	connect(bridge, extension, [tab({ tabId: 1 })]);
	bridge.extMessage(extension, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, url: "", title: "Updated" }) }));
	expect(bridge.listTargets()).toContainEqual({
		id: "PAGE1",
		type: "page",
		title: "Updated",
		url: "https://example.com/",
	});
});

/** Answer every unanswered extension RPC of `op` with `ok: true` and `result`. */
function ack(bridge: RelayBridge, socket: FakeExtSocket, op: RelayRpcRequest["op"], result: unknown = {}): void {
	for (const rpc of socket.pending(op)) {
		socket.markAcked(rpc.id);
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: true, result }));
	}
}

/** Fail every unanswered extension RPC of `op` with `ok: false`. */
function nack(bridge: RelayBridge, socket: FakeExtSocket, op: RelayRpcRequest["op"], error = "rpc failed"): void {
	for (const rpc of socket.pending(op)) {
		socket.markAcked(rpc.id);
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: false, error }));
	}
}

/** Flush the rpc .then() microtask chains (no timers involved). */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

let msgSeq = 100;

it("rejects download-policy changes without acknowledging or forwarding them through browser or page sessions", async () => {
	const bridge = new RelayBridge();
	const ext = new FakeExtSocket();
	connect(bridge, ext, [tab({ tabId: 1 })]);
	const cdp = new FakeCdpSocket();
	const connection = bridge.cdpConnected(cdp);
	const sessionId = await attachPage(bridge, ext, cdp, connection, 1);
	for (const command of [
		{ method: "Browser.setDownloadBehavior" },
		{ method: "Browser.setDownloadBehavior", sessionId },
		{ method: "Page.setDownloadBehavior", sessionId },
	]) {
		const id = ++msgSeq;
		bridge.cdpMessage(
			connection,
			JSON.stringify({ id, ...command, params: { behavior: "allow", downloadPath: "/wrongly-promised-path" } }),
		);
		await flush();
		const response = cdp.messages.find(message => message.id === id);
		expect(response).toHaveProperty("error.message", expect.stringContaining("has not been applied"));
		expect(response).not.toHaveProperty("result");
	}
	expect(ext.rpcs("send")).toEqual([]);
	bridge.cdpClosed(connection);
});

describe("managed Chrome CDP scope", () => {
	it("discovers and attaches only the granted tab and rejects raw lifecycle escapes", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const lease = bridge.managed.claim(bridge.managed.discover()[0]!.id, "owner");
		const cdp = new FakeCdpSocket();
		const connection = bridge.cdpConnected(cdp, lease.id);
		bridge.cdpMessage(connection, JSON.stringify({ id: 1, method: "Target.setDiscoverTargets" }));
		await flush();
		const created = cdp.messages.filter(message => message.method === "Target.targetCreated");
		expect(
			created.map(message => (message.params as { targetInfo: { targetId: string } }).targetInfo.targetId),
		).toEqual(["TAB1", "PAGE1"]);
		expect(ext.rpcs("attach")).toHaveLength(0);
		const sessionId = await attachPage(bridge, ext, cdp, connection, 1);
		for (const [id, method, params] of [
			[2, "Target.attachToTarget", { targetId: "PAGE2" }],
			[3, "Target.activateTarget", { targetId: "PAGE1" }],
			[4, "Target.closeTarget", { targetId: "PAGE1" }],
			[5, "Target.createTarget", { url: "about:blank" }],
		] as const)
			bridge.cdpMessage(connection, JSON.stringify({ id, method, params }));
		bridge.cdpMessage(connection, JSON.stringify({ id: 6, sessionId, method: "Page.bringToFront" }));
		await flush();
		expect(
			cdp.messages
				.filter(message => [2, 3, 4, 5, 6].includes(Number(message.id)))
				.every(message => "error" in message),
		).toBe(true);
		expect(ext.rpcs("attach").map(rpc => rpc.tabId)).toEqual([1]);
		expect(ext.rpcs("activateTab")).toHaveLength(0);
		expect(ext.rpcs("removeTab")).toHaveLength(0);
		expect(ext.rpcs("createTab")).toHaveLength(0);
		bridge.cdpMessage(connection, JSON.stringify({ id: 7, sessionId, method: "Page.captureScreenshot" }));
		await flush();
		expect(ext.rpcs("send").at(-1)).toMatchObject({ tabId: 1, method: "Page.captureScreenshot" });
		ack(bridge, ext, "send", { data: "pixels" });
		await flush();
		await bridge.managed.release(lease.id, "owner");
		bridge.cdpMessage(connection, JSON.stringify({ id: 8, sessionId, method: "Page.captureScreenshot" }));
		await flush();
		expect(cdp.messages.find(message => message.id === 8)).toHaveProperty("error");
	});
});

/** Attach to a tab's page target and return the minted page session id. */
async function attachPage(
	bridge: RelayBridge,
	ext: FakeExtSocket,
	cdp: FakeCdpSocket,
	connId: number,
	tabId: number,
): Promise<string> {
	const attachId = ++msgSeq;
	bridge.cdpMessage(
		connId,
		JSON.stringify({
			id: attachId,
			method: "Target.attachToTarget",
			params: { targetId: `PAGE${tabId}`, flatten: true },
		}),
	);
	ack(bridge, ext, "attach");
	await flush();
	const sessionId = cdp.sessionFor(attachId);
	if (!sessionId) throw new Error(`attachToTarget for tab ${tabId} did not produce a session`);
	return sessionId;
}

/**
 * Emulate the omp tab worker adopting a tab: attach to its page target, then
 * claim it as this connection's drive target.
 */
async function claimTab(
	bridge: RelayBridge,
	ext: FakeExtSocket,
	cdp: FakeCdpSocket,
	connId: number,
	tabId: number,
): Promise<void> {
	const sessionId = await attachPage(bridge, ext, cdp, connId, tabId);
	bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "OMP.claimTarget" }));
	await flush();
}

describe("RelayBridge tab grouping", () => {
	it("groups nothing on hello or tab lifecycle events — only claimed tabs join the omp group", () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const socket = new FakeExtSocket();
		connect(bridge, socket, [tab({ tabId: 1 }), tab({ tabId: 2 }), tab({ tabId: 3, url: "about:blank" })]);
		bridge.extMessage(socket, JSON.stringify({ t: "tabCreated", tab: tab({ tabId: 9 }) }));
		expect(socket.rpcs("group")).toHaveLength(0);
	});

	it("never groups from command traffic: a discovery scan sending page commands to every tab is not driving", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// pickElectronTarget materializes every discovered page, which makes
		// puppeteer send Page.enable/Page.getFrameTree to all of them.
		for (const tabId of [1, 2]) {
			const sessionId = await attachPage(bridge, ext, cdp, connId, tabId);
			bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Page.enable" }));
			bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Page.getFrameTree" }));
		}
		await flush();
		expect(ext.rpcs("group")).toHaveLength(0);
	});

	it("groups exactly the tab a client claims", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		const groups = ext.rpcs("group");
		expect(groups).toHaveLength(1);
		expect(groups[0]!.tabIds).toEqual([1]);
		expect(groups[0]!.title).toBe("omp");
		expect(groups[0]!.color).toBe("cyan");
	});

	it("never groups pinned tabs or tabs in a user group, even when claimed", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 3, pinned: true }), tab({ tabId: 4, groupId: 77 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 3);
		await claimTab(bridge, ext, cdp, connId, 4);
		expect(ext.rpcs("group")).toHaveLength(0);
	});

	it("does not issue group RPCs when grouping is disabled", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		expect(ext.rpcs("group")).toHaveLength(0);
	});

	it("auto-claims a tab created through Target.createTarget", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, []);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.createTarget", params: { url: "https://example.com/" } }),
		);
		ack(bridge, ext, "createTab", { tab: tab({ tabId: 9 }) });
		await flush();
		const groups = ext.rpcs("group");
		expect(groups).toHaveLength(1);
		expect(groups[0]!.tabIds).toEqual([9]);
	});

	it("never re-groups a tab the user pulled out of the omp group", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();
		// Chrome reports the grouping we just made — no opt-out.
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, groupId: 42 }) }));
		// The user drags the tab out of the group.
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, groupId: -1 }) }));
		// A later navigation on the still-claimed tab must not re-group it.
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, groupId: -1, url: "https://example.com/other" }) }),
		);
		expect(ext.rpcs("group")).toHaveLength(1);
	});

	it("ungroups when the claiming client disconnects, even while another connection still holds sessions", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		// Long-lived registry connection: holds a session on the tab, never claims it.
		const registry = new FakeCdpSocket();
		const registryConn = bridge.cdpConnected(registry);
		await attachPage(bridge, ext, registry, registryConn, 1);
		// Worker connection: claims the tab.
		const worker = new FakeCdpSocket();
		const workerConn = bridge.cdpConnected(worker);
		await claimTab(bridge, ext, worker, workerConn, 1);
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();
		bridge.cdpClosed(workerConn);
		const ungroups = ext.rpcs("ungroup");
		expect(ungroups).toHaveLength(1);
		expect(ungroups[0]!.tabIds).toEqual([1]);
	});

	it("never overlaps group RPCs: a tab claimed mid-flight waits for the pending group", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		expect(ext.rpcs("group")).toHaveLength(1);
		// Concurrent group RPCs race Chrome's non-atomic query→create→set-title
		// and mint duplicate "omp" groups; the second request must queue.
		await claimTab(bridge, ext, cdp, connId, 2);
		expect(ext.rpcs("group")).toHaveLength(1);
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();
		const groups = ext.rpcs("group");
		expect(groups).toHaveLength(2);
		expect(groups[1]!.tabIds).toEqual([2]);
	});

	it("regroups claimed tabs after an extension reconnect instead of treating the dissolve as user opt-out", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();
		// Relay/extension link drops: the extension dissolves the omp group on
		// disconnect, so the next hello reports groupId -1 for every tab.
		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })]);
		const groups = ext2.rpcs("group");
		expect(groups).toHaveLength(1);
		expect(groups[0]!.tabIds).toEqual([1]);
	});
});

describe("RelayBridge Runtime sessions", () => {
	it("virtualizes Runtime enable state for each pseudo-session", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);

		const first = new FakeCdpSocket();
		const firstConn = bridge.cdpConnected(first);
		const firstSession = await attachPage(bridge, ext, first, firstConn, 1);
		bridge.cdpMessage(firstConn, JSON.stringify({ id: ++msgSeq, sessionId: firstSession, method: "Runtime.enable" }));
		await flush();
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, ext, "send");
		await flush();
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);

		const context = {
			context: {
				id: 17,
				origin: "https://example.com",
				name: "",
				uniqueId: "context-17",
				auxData: { isDefault: true, type: "default", frameId: "frame-1" },
			},
		};
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		ack(bridge, ext, "send");
		await flush();

		const second = new FakeCdpSocket();
		const secondConn = bridge.cdpConnected(second);
		const secondSession = await attachPage(bridge, ext, second, secondConn, 1);
		const runtimeSendCount = ext.rpcs("send").length;
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({ id: ++msgSeq, sessionId: secondSession, method: "Runtime.enable" }),
		);
		await flush();
		expect(ext.rpcs("send")).toHaveLength(runtimeSendCount);

		const contexts = second.messages.filter(
			message => message.sessionId === secondSession && message.method === "Runtime.executionContextCreated",
		);
		expect(contexts.map(message => message.params)).toEqual([context]);

		bridge.cdpMessage(
			secondConn,
			JSON.stringify({ id: ++msgSeq, sessionId: secondSession, method: "Runtime.disable" }),
		);
		await flush();
		expect(ext.rpcs("send")).toHaveLength(runtimeSendCount);

		const nextContext = {
			context: { ...context.context, id: 18, uniqueId: "context-18" },
		};
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: nextContext }),
		);
		const firstContexts = first.messages.filter(
			message => message.sessionId === firstSession && message.method === "Runtime.executionContextCreated",
		);
		expect(firstContexts.map(message => message.params)).toEqual([context, nextContext]);
		expect(
			second.messages.filter(
				message => message.sessionId === secondSession && message.method === "Runtime.executionContextCreated",
			),
		).toEqual(contexts);
	});

	it("keeps a pipelined Runtime.disable authoritative while root enable completes", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);

		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.enable" }));
		await flush();

		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.disable" }));
		ack(bridge, ext, "send");
		await flush();
		expect(ext.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);

		const context = { context: { id: 19 } };
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		ack(bridge, ext, "send");
		await flush();

		expect(
			cdp.messages.filter(
				message => message.sessionId === sessionId && message.method === "Runtime.executionContextCreated",
			),
		).toEqual([]);
	});
	it("refreshes Runtime contexts after the extension reconnects", async () => {
		const bridge = new RelayBridge({});
		const firstExt = new FakeExtSocket();
		connect(bridge, firstExt, [tab({ tabId: 1 })]);

		const first = new FakeCdpSocket();
		const firstConn = bridge.cdpConnected(first);
		const firstSession = await attachPage(bridge, firstExt, first, firstConn, 1);
		bridge.cdpMessage(firstConn, JSON.stringify({ id: ++msgSeq, sessionId: firstSession, method: "Runtime.enable" }));
		await flush();
		ack(bridge, firstExt, "send");
		await flush();
		const staleContext = { context: { id: 17 } };
		bridge.extMessage(
			firstExt,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: staleContext,
			}),
		);
		ack(bridge, firstExt, "send");
		await flush();

		bridge.extClosed(firstExt);
		const nextExt = new FakeExtSocket();
		bridge.extConnected(nextExt);
		bridge.extMessage(
			nextExt,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [tab({ tabId: 1 })],
				attachedTabIds: [1],
			}),
		);

		const second = new FakeCdpSocket();
		const secondConn = bridge.cdpConnected(second);
		const secondSession = await attachPage(bridge, nextExt, second, secondConn, 1);
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({ id: ++msgSeq, sessionId: secondSession, method: "Runtime.enable" }),
		);
		await flush();
		expect(nextExt.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.disable"]);
		ack(bridge, nextExt, "send");
		await flush();
		expect(nextExt.pending("send").map(rpc => rpc.method)).toEqual(["Runtime.enable"]);

		const currentContext = { context: { id: 18 } };
		bridge.extMessage(
			nextExt,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: currentContext,
			}),
		);
		ack(bridge, nextExt, "send");
		await flush();

		const contexts = second.messages.filter(
			message => message.sessionId === secondSession && message.method === "Runtime.executionContextCreated",
		);
		expect(contexts.map(message => message.params)).toEqual([currentContext]);
	});
});

describe("RelayBridge attachment release", () => {
	it.each(["after reacquisition", "during failed detach"] as const)(
		"invalidates ownership on native cancellation %s through the actual extension",
		async cancellation => {
			const bridge = new RelayBridge();
			const ready = Promise.withResolvers<void>();
			const detach = Promise.withResolvers<void>();
			let nativeDetach: (source: { tabId: number }, reason: string) => void = () => {};
			const event = () => ({ addListener: () => {} });
			let attached = false;
			let socket: ExtensionSocket;
			const ext: RelaySocket = {
				send: text => socket.onmessage?.({ data: text }),
				close: () => {},
			};
			class ExtensionSocket {
				static OPEN = 1;
				static CONNECTING = 0;
				readyState = 1;
				onmessage?: (event: { data: string }) => void;
				send(text: string): void {
					const message = JSON.parse(text);
					bridge.extMessage(ext, text);
					if (message.t === "hello") ready.resolve();
				}
				close(): void {}
				constructor() {
					socket = this;
					queueMicrotask(() => {
						bridge.extConnected(ext);
						this.onmessage?.({ data: JSON.stringify({ t: "authenticated" }) });
					});
				}
			}
			const context = createContext({
				AbortSignal,
				Response,
				crypto,
				navigator: { userAgent: "Chrome/151.0.0.0" },
				WebSocket: ExtensionSocket,
				setTimeout: () => 0,
				clearTimeout: () => {},
				setInterval: () => 0,
				clearInterval: () => {},
				fetch: async (url: string) =>
					Response.json(
						url.endsWith("connection.json") ? { port: 19443 } : { service: "omp-browser", protocol: 2 },
					),
				chrome: {
					runtime: {
						getURL: (name: string) => `chrome-extension://fixture/${name}`,
						onInstalled: event(),
						onStartup: event(),
						onMessage: event(),
					},
					storage: { local: { get: async (defaults: object) => defaults, set: async () => {} } },
					action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: event() },
					alarms: { create: () => {}, onAlarm: event() },
					debugger: {
						getTargets: async () => [],
						attach: async () => {
							attached = true;
						},
						// Chromium explicit detach closes the client without emitting onDetach.
						detach: async () => {
							await detach.promise;
							attached = false;
						},
						onEvent: event(),
						onDetach: {
							addListener: (listener: typeof nativeDetach) => {
								nativeDetach = listener;
							},
						},
					},
					tabs: {
						query: async () => [{ id: 1, ...tab({ tabId: 1 }) }],
						onCreated: event(),
						onUpdated: event(),
						onRemoved: event(),
						onReplaced: event(),
						onActivated: event(),
					},
				},
			});
			runInContext(
				await Bun.file(
					new URL("../../src/tools/browser/relay/extension-assets/background.js.txt", import.meta.url),
				).text(),
				context,
			);
			await ready.promise;
			const lease = bridge.managed.claim(bridge.managed.discover()[0]!.id, "owner");
			const cdp = new FakeCdpSocket();
			const replies = new Map<number, () => void>();
			const capture = cdp.send.bind(cdp);
			cdp.send = text => {
				capture(text);
				replies.get(JSON.parse(text).id)?.();
			};
			const connId = bridge.cdpConnected(cdp, lease.id);
			const attach = async (id: number) => {
				const replied = Promise.withResolvers<void>();
				replies.set(id, replied.resolve);
				bridge.cdpMessage(
					connId,
					JSON.stringify({ id, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
				);
				await replied.promise;
				expect(cdp.sessionFor(id)).toBeDefined();
				expect(attached).toBe(true);
				return cdp.sessionFor(id)!;
			};
			const sessionId = await attach(1);
			bridge.cdpMessage(connId, JSON.stringify({ id: 2, method: "Target.detachFromTarget", params: { sessionId } }));
			await flush();
			if (cancellation === "after reacquisition") {
				// Queue reacquisition while native detach is unresolved.
				const reacquired = attach(3);
				detach.resolve();
				await reacquired;
				expect(bridge.managed.get(lease.id, "owner").id).toBe(lease.id);
			}
			attached = false;
			nativeDetach({ tabId: 1 }, "canceled_by_user");
			if (cancellation === "during failed detach") detach.reject(new Error("Debugger is not attached"));
			await flush();
			expect(() => bridge.managed.get(lease.id, "owner")).toThrow("stale");
			bridge.cdpMessage(
				connId,
				JSON.stringify({ id: 4, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
			);
			await flush();
			expect(cdp.messages.find(message => message.id === 4)).toHaveProperty("error");
		},
	);

	it("detaches cleanly on explicit last-session release and permits reattachment", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();
		expect(ext.rpcs("detach").map(rpc => rpc.tabId)).toEqual([1]);

		// The extension explicitly acknowledges detach before its RPC result.
		// Chrome does not emit native onDetach for this operation.
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		ack(bridge, ext, "detach");
		await flush();

		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
		);
		ack(bridge, ext, "attach");
		await flush();
		expect(cdp.sessionFor(reattachId)).toBeDefined();
		expect(cdp.messages.some(message => message.method === "Target.targetDestroyed")).toBe(false);
	});

	it("serializes immediate reattachment behind the detach RPC and its acknowledgement", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();

		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
		);
		await flush();
		// Only the initial attach has reached the extension while detach is pending.
		expect(ext.rpcs("attach")).toHaveLength(1);

		bridge.extMessage(
			ext,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		ack(bridge, ext, "detach");
		await flush();
		expect(ext.rpcs("attach")).toHaveLength(2);
		ack(bridge, ext, "attach");
		await flush();
		expect(cdp.sessionFor(reattachId)).toBeDefined();
	});

	it("keeps the attachment while another connection still holds a session on the tab", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		// Long-lived registry connection: holds a session on the tab throughout.
		const registry = new FakeCdpSocket();
		const registryConn = bridge.cdpConnected(registry);
		await attachPage(bridge, ext, registry, registryConn, 1);
		const worker = new FakeCdpSocket();
		const workerConn = bridge.cdpConnected(worker);
		const sessionId = await attachPage(bridge, ext, worker, workerConn, 1);
		bridge.cdpMessage(
			workerConn,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();
		expect(ext.rpcs("detach")).toHaveLength(0);
	});

	it("detaches once the tab session released alongside the page session leaves no holder", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// setAutoAttach mints a tab session; attachToTarget adds a page session.
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: "Target.setAutoAttach" }));
		ack(bridge, ext, "attach");
		await flush();
		const pageSession = await attachPage(bridge, ext, cdp, connId, 1);
		const tabSession = cdp.attachedSessions().find(id => id !== pageSession);
		if (!tabSession) throw new Error("setAutoAttach did not mint a tab session");
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId: pageSession } }),
		);
		await flush();
		// The tab session still holds the attachment.
		expect(ext.rpcs("detach")).toHaveLength(0);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId: tabSession } }),
		);
		await flush();
		expect(ext.rpcs("detach").map(rpc => rpc.tabId)).toEqual([1]);
	});

	it("retracts held sessions when reconnect reattachment fails", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		expect(replacement.pending("attach")).toHaveLength(1);
		nack(bridge, replacement, "attach", "debugger unavailable");
		await flush();

		const detached = cdp.messages.find(
			message =>
				message.method === "Target.detachedFromTarget" &&
				message.params !== null &&
				typeof message.params === "object" &&
				"sessionId" in message.params &&
				message.params.sessionId === sessionId,
		);
		expect(detached).toBeDefined();
	});

	it("reconciles a delayed detach after replacement hello still reports the old attachment", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })], [1]);
		bridge.extMessage(
			replacement,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		await flush();

		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
		);
		await flush();
		expect(replacement.pending("attach")).toHaveLength(1);
		ack(bridge, replacement, "attach");
		await flush();
		expect(cdp.sessionFor(reattachId)).toBeDefined();
	});

	it("does not ban a tab when its in-flight attach is interrupted by extension replacement", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
		);
		expect(ext.pending("attach")).toHaveLength(1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		await flush();

		const retryId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: retryId, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
		);
		await flush();
		expect(replacement.pending("attach")).toHaveLength(1);
		ack(bridge, replacement, "attach");
		await flush();
		expect(cdp.sessionFor(retryId)).toBeDefined();
	});

	it("clears an in-flight detach immediately when the extension socket is replaced", async () => {
		const bridge = new RelayBridge({ group: { title: "omp", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();
		expect(ext.pending("detach")).toHaveLength(1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
		);
		await flush();

		// Reattachment reaches the replacement immediately; it does not wait
		// for the old socket's unreachable detach result or its 20s timeout.
		expect(replacement.pending("attach")).toHaveLength(1);
		ack(bridge, replacement, "attach");
		await flush();
		const replacementSession = cdp.sessionFor(reattachId);
		expect(replacementSession).toBeDefined();

		// The old chrome.debugger.detach finishes after replacement attach and
		// sends its callback through the new global extension socket. Correlation
		// must survive the rejected RPC so this cannot retract the new session.
		bridge.extMessage(
			replacement,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		await flush();
		const replacementDetach = cdp.messages.find(
			message =>
				message.method === "Target.detachedFromTarget" &&
				message.params !== null &&
				typeof message.params === "object" &&
				"sessionId" in message.params &&
				message.params.sessionId === replacementSession,
		);
		expect(replacementDetach).toBeUndefined();

		// A later genuine user cancellation has no relay attribution and must
		// still retract the replacement session.
		bridge.extMessage(replacement, JSON.stringify({ t: "detached", tabId: 1, reason: "canceled_by_user" }));
		await flush();
		const userDetach = cdp.messages.find(
			message =>
				message.method === "Target.detachedFromTarget" &&
				message.params !== null &&
				typeof message.params === "object" &&
				"sessionId" in message.params &&
				message.params.sessionId === replacementSession,
		);
		expect(userDetach).toBeDefined();
	});

	it("still fans root Runtime events out to a session that never enabled the domain", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);

		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// omp's own patched-puppeteer client pull-acquires contexts and never
		// sends Runtime.enable, yet still waits on executionContextCreated.
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		const context = { context: { id: 42, uniqueId: "context-42" } };
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);

		const received = cdp.messages.filter(
			message => message.sessionId === sessionId && message.method === "Runtime.executionContextCreated",
		);
		expect(received.map(message => message.params)).toEqual([context]);

		// An explicit disable silences the same session — a later re-emit is dropped.
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.disable" }));
		await flush();
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		expect(
			cdp.messages.filter(
				message => message.sessionId === sessionId && message.method === "Runtime.executionContextCreated",
			),
		).toEqual(received);
	});

	it("holds a pipelined duplicate Runtime.enable until the in-flight enable settles", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		const enable1 = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enable1, sessionId, method: "Runtime.enable" }));
		await flush();
		const enable2 = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enable2, sessionId, method: "Runtime.enable" }));
		await flush();

		// Root disable/enable cycle still pending: neither caller may be acked.
		expect(cdp.messages.filter(message => message.id === enable1 || message.id === enable2)).toEqual([]);

		ack(bridge, ext, "send"); // Runtime.disable leg
		await flush();
		ack(bridge, ext, "send"); // Runtime.enable leg
		await flush();

		expect(cdp.messages.filter(message => message.id === enable1 && "result" in message)).toHaveLength(1);
		expect(cdp.messages.filter(message => message.id === enable2 && "result" in message)).toHaveLength(1);
	});

	it("fails a pipelined duplicate Runtime.enable when the root enable fails", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		const enable1 = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enable1, sessionId, method: "Runtime.enable" }));
		await flush();
		const enable2 = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: enable2, sessionId, method: "Runtime.enable" }));
		await flush();

		// The first leg of the root cycle fails: both callers must observe it.
		nack(bridge, ext, "send");
		await flush();

		expect(cdp.messages.filter(message => message.id === enable1 && "error" in message)).toHaveLength(1);
		expect(cdp.messages.filter(message => message.id === enable2 && "error" in message)).toHaveLength(1);
		expect(
			cdp.messages.filter(message => (message.id === enable1 || message.id === enable2) && "result" in message),
		).toEqual([]);
	});

	it("preserves the latest disable when an older and newer enable both fail", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.enable" }));
		await flush();
		bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Runtime.disable" }));
		const latestEnable = ++msgSeq;
		bridge.cdpMessage(connId, JSON.stringify({ id: latestEnable, sessionId, method: "Runtime.enable" }));
		await flush();

		nack(bridge, ext, "send");
		await flush();
		expect(cdp.messages.filter(message => message.id === latestEnable && "error" in message)).toHaveLength(1);

		const context = { context: { id: 91, uniqueId: "context-91" } };
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Runtime.executionContextCreated", params: context }),
		);
		expect(
			cdp.messages.filter(
				message => message.sessionId === sessionId && message.method === "Runtime.executionContextCreated",
			),
		).toEqual([]);
	});
});

it("tracks selected tabs per window even when selection moves outside the known eligible set", () => {
	const bridge = new RelayBridge();
	const extension = new FakeExtSocket();
	connect(bridge, extension, [
		tab({ tabId: 1, active: true }),
		tab({ tabId: 2, active: false }),
		tab({ tabId: 3, windowId: 2, active: true }),
	]);
	bridge.extMessage(extension, JSON.stringify({ t: "tabActivated", tabId: 2, windowId: 1 }));
	expect(bridge.managed.discover().map(tab => [tab.tabId, tab.active])).toEqual([
		[1, false],
		[2, true],
		[3, true],
	]);
	bridge.extMessage(extension, JSON.stringify({ t: "tabActivated", tabId: 99, windowId: 1 }));
	expect(bridge.managed.discover().map(tab => [tab.tabId, tab.active])).toEqual([
		[1, false],
		[2, false],
		[3, true],
	]);
	expect(extension.messages).toEqual([]);
});

it("refreshes inventory from a read-only Chrome query without attaching and preserves exact identity", async () => {
	const bridge = new RelayBridge();
	const extension = new FakeExtSocket();
	connect(bridge, extension, [tab({ tabId: 1, active: false }), tab({ tabId: 2, active: true })]);
	const id = bridge.managed.discover()[0]!.id;
	const refreshing = bridge.refreshTabs();
	ack(bridge, extension, "queryTabs", {
		tabs: [tab({ tabId: 1, active: true }), tab({ tabId: 9, windowId: 2, active: true })],
	});
	await refreshing;
	expect(bridge.managed.discover().map(tab => [tab.tabId, tab.active])).toEqual([
		[1, true],
		[9, true],
	]);
	expect(bridge.managed.discover()[0]!.id).toBe(id);
	expect(extension.messages.map(message => (message.t === "rpc" ? message.op : message.t))).toEqual(["queryTabs"]);
});

it("looks up files only for downloads observed on the exact leased page, using the relay's timestamp", async () => {
	const bridge = new RelayBridge();
	const ext = new FakeExtSocket();
	connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
	const lease = bridge.managed.claim(bridge.managed.discover().find(row => row.tabId === 1)!.id, "owner");
	const cdp = new FakeCdpSocket();
	const connection = bridge.cdpConnected(cdp, lease.id);
	const sessionId = await attachPage(bridge, ext, cdp, connection, 1);
	const url = "https://example.com/receipt";
	const before = Date.now();
	bridge.extMessage(
		ext,
		JSON.stringify({
			t: "cdpEvent",
			tabId: 2,
			method: "Page.downloadWillBegin",
			params: { guid: "other-guid", url },
		}),
	);
	bridge.extMessage(
		ext,
		JSON.stringify({
			t: "cdpEvent",
			tabId: 1,
			method: "Page.downloadWillBegin",
			params: { guid: "owned-guid", url },
		}),
	);
	bridge.cdpMessage(
		connection,
		JSON.stringify({
			id: 1,
			sessionId,
			method: "OMP.downloadFiles",
			params: { queries: [{ id: "other-guid", url, startedAt: 1 }] },
		}),
	);
	await flush();
	expect(cdp.messages.find(message => message.id === 1)).toHaveProperty("error");
	expect(ext.rpcs("downloadFiles")).toEqual([]);
	bridge.cdpMessage(
		connection,
		JSON.stringify({
			id: 2,
			sessionId,
			method: "OMP.downloadFiles",
			params: { queries: [{ id: "owned-guid", url, startedAt: 1 }] },
		}),
	);
	await flush();
	const request = ext.rpcs("downloadFiles")[0]!;
	expect(request.queries[0]!.startedAt).toBeGreaterThanOrEqual(before);
	expect(request.queries[0]!.startedAt).toBeLessThanOrEqual(Date.now());
	ack(bridge, ext, "downloadFiles", { available: false, reason: "permission missing" });
	await flush();
	expect(cdp.messages.find(message => message.id === 2)).toHaveProperty("result.lookup", {
		available: false,
		reason: "permission missing",
	});
	bridge.cdpClosed(connection);
});

it("answers only the observed dialog on an owned tab through its original debugger session", async () => {
	const bridge = new RelayBridge();
	const ext = new FakeExtSocket();
	connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })], [1, 2]);
	const lease = bridge.managed.claim(bridge.managed.discover().find(row => row.tabId === 1)!.id, "owner");
	const opened = (tabId: number) =>
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId,
				method: "Page.javascriptDialogOpening",
				params: { type: "prompt", message: "Name", defaultPrompt: "Original" },
			}),
		);
	opened(2);
	expect((await bridge.dialog(lease.id, "owner", {})).status).toBe("unobserved");
	opened(1);
	const state = await bridge.dialog(lease.id, "owner", {});
	await expect(bridge.dialog(lease.id, "other", {})).rejects.toThrow();
	await expect(bridge.dialog(lease.id, "owner", { action: "accept", id: "stale" })).rejects.toThrow("stale");
	const reply = bridge.dialog(lease.id, "owner", {
		action: "accept",
		id: state.dialog!.id,
		promptText: "Exact café Ω",
	});
	await flush();
	expect(ext.pending("send")).toHaveLength(1);
	expect(ext.pending("send")[0]).toMatchObject({
		tabId: 1,
		method: "Page.handleJavaScriptDialog",
		params: { accept: true, promptText: "Exact café Ω" },
	});
	ack(bridge, ext, "send", {});
	expect((await reply).status).toBe("closed");
	await bridge.managed.release(lease.id, "owner");
	bridge.extClosed(ext);
});

it("keeps a recovered dialog decision channel across consecutive prompts and detaches after ownership ends", async () => {
	const bridge = new RelayBridge();
	const ext = new FakeExtSocket();
	connect(bridge, ext, [tab({ tabId: 1 })], [1]);
	const opening = () =>
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Page.javascriptDialogOpening",
				params: { type: "prompt", message: "Name" },
			}),
		);
	const closing = () =>
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Page.javascriptDialogClosed", params: { result: true } }),
		);
	opening();
	const lease = bridge.managed.claim(bridge.managed.discover()[0]!.id, "owner");
	const connection = bridge.cdpConnected(new FakeCdpSocket(), lease.id);
	try {
		const first = await bridge.dialog(lease.id, "owner", {});
		const reply = bridge.dialog(lease.id, "owner", { action: "accept", id: first.dialog!.id, promptText: "Saved" });
		await flush();
		closing();
		await flush();
		expect(ext.pending("detach")).toHaveLength(0);
		opening();
		ack(bridge, ext, "send", {});
		const next = await reply;
		expect(next.status).toBe("open");
		expect(next.dialog!.id).not.toBe(first.dialog!.id);
		const final = bridge.dialog(lease.id, "owner", { action: "dismiss", id: next.dialog!.id });
		await flush();
		closing();
		await flush();
		ack(bridge, ext, "send", {});
		expect((await final).status).toBe("closed");
		expect(ext.pending("detach")).toHaveLength(0);
		await bridge.managed.release(lease.id, "owner");
		bridge.cdpClosed(connection);
		await flush();
		expect(ext.pending("detach").map(request => request.tabId)).toEqual([1]);
		ack(bridge, ext, "detach", {});
		expect(bridge.managed.discover()[0]!.ownership).toBe("available");
	} finally {
		bridge.cdpClosed(connection);
		bridge.extClosed(ext);
	}
});
