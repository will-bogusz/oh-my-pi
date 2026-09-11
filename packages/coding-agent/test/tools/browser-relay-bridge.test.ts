import { describe, expect, it } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import { EXPECTED_EXTENSION_BUILD_ID } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/instances";
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
	expect(bridge.managed.discover()).toMatchObject([{ tabId: 1, title: "Updated", url: "https://example.com/" }]);
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
	for (let i = 0; i < 16; i++) await Promise.resolve();
}

let msgSeq = 100;

it("rejects download-policy changes without acknowledging or forwarding them through browser or page sessions", async () => {
	const bridge = new RelayBridge();
	const ext = new FakeExtSocket();
	connect(bridge, ext, [tab({ tabId: 1 })]);
	const cdp = new FakeCdpSocket();
	const connection = connectCdp(bridge, cdp, 1);
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
		expect(ext.rpcs("releaseTab")).toHaveLength(0);
		expect(ext.rpcs("createTab")).toHaveLength(0);
		bridge.cdpMessage(connection, JSON.stringify({ id: 7, sessionId, method: "Page.captureScreenshot" }));
		await flush();
		expect(ext.rpcs("send").at(-1)).toMatchObject({ tabId: 1, method: "Page.captureScreenshot" });
		ack(bridge, ext, "send", { data: "pixels" });
		await flush();
		await release(bridge, ext, lease.id, "owner");
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

/** Discovery id of a physical tab. */
function discovered(bridge: RelayBridge, tabId: number): string {
	const found = bridge.managed.discover().find(candidate => candidate.tabId === tabId);
	if (!found) throw new Error(`tab ${tabId} is not discoverable`);
	return found.id;
}

/**
 * Connect a downstream client scoped to `tabId`. Every /cdp connection carries
 * a lease, so a client exists only for a tab its owner already claimed.
 */
function connectCdp(bridge: RelayBridge, cdp: FakeCdpSocket, tabId: number, owner = "owner"): number {
	const leaseId = bridge.managed.leaseForTab(tabId) ?? bridge.managed.claim(discovered(bridge, tabId), owner).id;
	return bridge.cdpConnected(cdp, leaseId);
}

/** Release a lease, answering the extension RPCs the release itself performs. */
async function release(
	bridge: RelayBridge,
	ext: FakeExtSocket,
	leaseId: string,
	owner: string,
	close = false,
): Promise<void> {
	const done = bridge.managed.releaseTab(leaseId, owner, close);
	// Enough rounds for the serialized hand-back: badge restore, cursor removal,
	// detach, then the extension's own releaseTab.
	for (let round = 0; round < 8; round++) {
		await flush();
		for (const op of ["send", "detach", "releaseTab"] as const) ack(bridge, ext, op);
	}
	await done;
}

describe("RelayBridge tab groups", () => {
	it("groups the tabs it creates under the owner label, never the user tab it claims", async () => {
		const bridge = new RelayBridge({ group: true });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		bridge.extMessage(ext, JSON.stringify({ t: "tabCreated", tab: tab({ tabId: 9 }) }));
		expect(ext.rpcs("group")).toHaveLength(0);
		// A claimed tab is one of the user's: adopted, never regrouped.
		const claimed = bridge.managed.claim(discovered(bridge, 1), "owner-a", "task-a", "Research");
		expect(ext.rpcs("group")).toHaveLength(0);
		// A tab OMP creates for the task joins the owner's group under its label.
		const creating = bridge.managed.create("https://example.com/task", "owner-a", "task-a", "Research");
		ack(bridge, ext, "createTab", { tab: tab({ tabId: 7 }) });
		await flush();
		ack(bridge, ext, "group");
		const created = await creating;
		expect(ext.rpcs("group").map(rpc => [rpc.tabId, rpc.owner, rpc.label])).toEqual([[7, "owner-a", "Research"]]);
		// Keeping a tab takes it back out of the group without closing it.
		await release(bridge, ext, created.id, "owner-a");
		expect(ext.rpcs("releaseTab")).toEqual([expect.objectContaining({ tabId: 7, close: false })]);
		expect(bridge.managed.discover("owner-a").find(candidate => candidate.tabId === 7)?.ownership).toBe("available");
		expect(bridge.managed.get(claimed.id, "owner-a").tab.tabId).toBe(1);
	});

	it("leases a tab the browser opened from a leased tab to the opener's owner and serves it to that owner", async () => {
		const bridge = new RelayBridge({ group: true });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const parent = bridge.managed.claim(discovered(bridge, 1), "owner-a", "task-a", "Research");
		// A child of a leased tab belongs to that tab's owner, in its group.
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "tabOpened", tab: tab({ tabId: 5, url: "https://example.com/child" }), openerTabId: 1 }),
		);
		await flush();
		expect(ext.rpcs("group").map(rpc => [rpc.tabId, rpc.owner, rpc.label])).toEqual([[5, "owner-a", "Research"]]);
		expect(bridge.managed.childTabs(parent.id, "owner-a")).toMatchObject([
			{ tabId: 5, url: "https://example.com/child", ownership: "this_actor", popupOf: parent.tab.id },
		]);
		// Claiming the child adopts the auto-lease instead of failing as taken.
		const child = bridge.managed.claim(bridge.managed.childTabs(parent.id, "owner-a")[0]!.id, "owner-a");
		expect(bridge.managed.tabForLease(child.id)).toBe(5);
		// A child of a tab nobody leases stays the user's.
		bridge.extMessage(ext, JSON.stringify({ t: "tabOpened", tab: tab({ tabId: 6 }), openerTabId: 2 }));
		await flush();
		expect(bridge.managed.discover("owner-a").find(candidate => candidate.tabId === 6)?.ownership).toBe("available");
		// Releasing the parent hands back its unclaimed children too.
		await release(bridge, ext, parent.id, "owner-a");
		expect(bridge.managed.discover("owner-a").find(candidate => candidate.tabId === 1)?.ownership).toBe("available");
	});

	it("adopts a popup Chrome blames on the visible tab, and leaves Chrome's selection alone", async () => {
		const bridge = new RelayBridge({ group: true });
		const ext = new FakeExtSocket();
		// Tab 3 is what the user is looking at; tab 1 is the leased background tab.
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 3, active: true })]);
		const parent = bridge.managed.claim(discovered(bridge, 1), "owner-a", "task-a", "Research");
		// The leased page reports the popup on its own debugger session…
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Page.windowOpen",
				params: { url: "https://example.com/child" },
			}),
		);
		// …while chrome.tabs blames the window's active tab for a synthesized click.
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "tabOpened",
				tab: tab({ tabId: 5, url: "https://example.com/child", active: true }),
				openerTabId: 3,
			}),
		);
		await flush();
		expect(bridge.managed.childTabs(parent.id, "owner-a")).toMatchObject([
			{ tabId: 5, ownership: "this_actor", popupOf: parent.tab.id },
		]);
		expect(ext.rpcs("group").map(rpc => rpc.tabId)).toEqual([5]);
		// Chrome raised and selected the child; putting tab 3 back would show the
		// user the page they did not just open. Adoption never selects anything.
		expect(ext.rpcs("activateTab")).toEqual([]);
		// One witness explains one popup: the next unexplained tab stays the user's.
		bridge.extMessage(ext, JSON.stringify({ t: "tabOpened", tab: tab({ tabId: 6, active: true }), openerTabId: 3 }));
		await flush();
		expect(bridge.managed.discover("owner-a").find(candidate => candidate.tabId === 6)?.ownership).toBe("available");
		expect(ext.rpcs("activateTab")).toEqual([]);
	});

	it("keeps a leased tab releasable after it navigates somewhere no debugger can attach", async () => {
		const bridge = new RelayBridge({ group: true });
		const ext = new FakeExtSocket();
		connect(bridge, ext, []);
		const creating = bridge.managed.create("https://example.com/downloads", "owner-a", "task-a", "Downloads");
		ack(bridge, ext, "createTab", { tab: tab({ tabId: 4 }) });
		await flush();
		ack(bridge, ext, "group");
		const lease = await creating;
		// The page navigates to chrome://, which Chrome refuses to debug.
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 4, url: "chrome://downloads/" }) }));
		bridge.extMessage(ext, JSON.stringify({ t: "detached", tabId: 4, reason: "target_closed" }));
		await flush();
		// Ownership survives, so the tab is still discoverable and closable…
		expect(bridge.managed.get(lease.id, "owner-a").tab).toMatchObject({ tabId: 4, url: "chrome://downloads/" });
		expect(bridge.managed.discover("owner-a").map(candidate => candidate.tabId)).toEqual([4]);
		await release(bridge, ext, lease.id, "owner-a", true);
		// …and the release still takes it out of the group before closing it.
		expect(ext.rpcs("releaseTab")).toEqual([expect.objectContaining({ tabId: 4, close: true })]);
		// With the lease gone the page leaves discovery: nobody may claim it.
		expect(bridge.managed.discover()).toEqual([]);
	});

	it("titles the group 'Oh My Pi' unless the client names it, and groups nothing when marking is off", async () => {
		for (const [marking, expected] of [
			[true, [[9, "owner", "Oh My Pi"]]],
			[false, []],
		] as Array<[boolean, Array<[number, string, string]>]>) {
			const bridge = new RelayBridge({ group: marking });
			const ext = new FakeExtSocket();
			connect(bridge, ext, []);
			const creating = bridge.managed.create("https://example.com/", "owner", "task");
			ack(bridge, ext, "createTab", { tab: tab({ tabId: 9 }) });
			await flush();
			ack(bridge, ext, "group");
			await creating;
			expect(ext.rpcs("group").map(rpc => [rpc.tabId, rpc.owner, rpc.label])).toEqual(expected);
		}
	});
});

/**
 * The idle detach is a real timer, so these await the detach RPC itself rather
 * than a duration, and prove a hold by racing it against an unheld tab whose
 * detach shows the window has elapsed.
 */
describe("RelayBridge debugger lifetime", () => {
	const detachedTabs = (ext: FakeExtSocket): number[] => ext.rpcs("detach").map(rpc => rpc.tabId);
	const until = async (predicate: () => boolean, what: string): Promise<void> => {
		for (let i = 0; i < 2000 && !predicate(); i++) await Bun.sleep(1);
		if (!predicate()) throw new Error(`timed out waiting for ${what}`);
	};

	it("hands the debugger back when the tab goes idle and reattaches transparently on the next command", async () => {
		const bridge = new RelayBridge({ debuggerIdleMs: 1 });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = connectCdp(bridge, cdp, 1);
		const session = await attachPage(bridge, ext, cdp, conn, 1);
		bridge.cdpMessage(conn, JSON.stringify({ id: 1, sessionId: session, method: "Page.enable" }));
		ack(bridge, ext, "send");
		await flush();
		await until(() => detachedTabs(ext).includes(1), "the idle detach");
		ack(bridge, ext, "detach");
		await flush();
		// The lease and the downstream session both survive the detach…
		expect(bridge.managed.tabForLease(bridge.managed.leaseForTab(1)!)).toBe(1);
		expect(cdp.messages.filter(message => message.method === "Target.detachedFromTarget")).toHaveLength(0);
		// …but the driver is told its object mirrors died with the attachment.
		expect(
			cdp.messages.filter(
				message => message.method === "Runtime.executionContextsCleared" && message.sessionId === session,
			),
		).toHaveLength(1);
		const before = ext.rpcs("send").length;
		bridge.cdpMessage(
			conn,
			JSON.stringify({ id: 2, sessionId: session, method: "Runtime.evaluate", params: { expression: "1" } }),
		);
		for (let round = 0; round < 4; round++) {
			await flush();
			ack(bridge, ext, "attach");
			ack(bridge, ext, "send", { result: { value: 1 } });
		}
		await flush();
		// The reattach puts the driver's domains back before its command runs.
		expect(
			ext
				.rpcs("send")
				.slice(before)
				.map(rpc => rpc.method),
		).toEqual(["Page.enable", "Runtime.evaluate"]);
		expect(cdp.messages.find(message => message.id === 2)).not.toHaveProperty("error");
	});

	it("keeps the debugger while a command is in flight and while a dialog is open", async () => {
		const bridge = new RelayBridge({ debuggerIdleMs: 1 });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 }), tab({ tabId: 3 })]);
		const cdp = new FakeCdpSocket();
		const busyConn = connectCdp(bridge, cdp, 1, "owner-a");
		const busySession = await attachPage(bridge, ext, cdp, busyConn, 1);
		await attachPage(bridge, ext, cdp, connectCdp(bridge, cdp, 3, "owner-c"), 3);
		// A puppeteer wait blocks inside its own command, which never acks here.
		bridge.cdpMessage(
			busyConn,
			JSON.stringify({
				id: 1,
				sessionId: busySession,
				method: "Runtime.callFunctionOn",
				params: { awaitPromise: true },
			}),
		);
		// The page raises a dialog on the other tab.
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 3,
				method: "Page.javascriptDialogOpening",
				params: { type: "alert", message: "wait", url: "https://example.com/" },
			}),
		);
		await flush();
		// Tab 2 has nothing to hold it: its detach proves the window elapsed.
		await attachPage(bridge, ext, cdp, connectCdp(bridge, cdp, 2, "owner-b"), 2);
		await until(() => detachedTabs(ext).includes(2), "the unheld tab's idle detach");
		expect(detachedTabs(ext)).not.toContain(1);
		expect(detachedTabs(ext)).not.toContain(3);
		expect(bridge.dialogState(3).status).toBe("open");
		// Both holds end: the command answers, the dialog closes.
		ack(bridge, ext, "send", {});
		bridge.extMessage(ext, JSON.stringify({ t: "cdpEvent", tabId: 3, method: "Page.javascriptDialogClosed" }));
		await flush();
		await until(() => detachedTabs(ext).includes(1) && detachedTabs(ext).includes(3), "both held tabs to expire");
	});
});

describe("RelayBridge Runtime sessions", () => {
	it("virtualizes Runtime enable state for each pseudo-session", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);

		const first = new FakeCdpSocket();
		const firstConn = connectCdp(bridge, first, 1);
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
		const secondConn = connectCdp(bridge, second, 1);
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
		const connId = connectCdp(bridge, cdp, 1);
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
		const firstConn = connectCdp(bridge, first, 1);
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
		const secondConn = connectCdp(bridge, second, 1);
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
						onSuspend: event(),
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
			// The cancellation costs the tab, not the ownership: the lease lives on
			// so its owner can still take the tab out of the group and close it.
			expect(bridge.managed.get(lease.id, "owner").id).toBe(lease.id);
			bridge.cdpMessage(
				connId,
				JSON.stringify({ id: 4, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
			);
			await flush();
			expect(cdp.messages.find(message => message.id === 4)).toHaveProperty("error");
		},
	);

	it("detaches cleanly on explicit last-session release and permits reattachment", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = connectCdp(bridge, cdp, 1);
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
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = connectCdp(bridge, cdp, 1);
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
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		// Long-lived registry connection: holds a session on the tab throughout.
		const registry = new FakeCdpSocket();
		const registryConn = connectCdp(bridge, registry, 1);
		await attachPage(bridge, ext, registry, registryConn, 1);
		const worker = new FakeCdpSocket();
		const workerConn = connectCdp(bridge, worker, 1);
		const sessionId = await attachPage(bridge, ext, worker, workerConn, 1);
		bridge.cdpMessage(
			workerConn,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();
		expect(ext.rpcs("detach")).toHaveLength(0);
	});

	it("detaches once the tab session released alongside the page session leaves no holder", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = connectCdp(bridge, cdp, 1);
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
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = connectCdp(bridge, cdp, 1);
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
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = connectCdp(bridge, cdp, 1);
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

		// A replacement worker drops tab ownership, so the client re-claims the
		// exact tab and reconnects before driving it again.
		const reclaimed = connectCdp(bridge, cdp, 1);
		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			reclaimed,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
		);
		await flush();
		expect(replacement.pending("attach")).toHaveLength(1);
		ack(bridge, replacement, "attach");
		await flush();
		expect(cdp.sessionFor(reattachId)).toBeDefined();
	});

	it("does not ban a tab when its in-flight attach is interrupted by extension replacement", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = connectCdp(bridge, cdp, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
		);
		expect(ext.pending("attach")).toHaveLength(1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		await flush();

		// A replacement worker drops tab ownership, so the client re-claims the
		// exact tab and reconnects before driving it again.
		const reclaimed = connectCdp(bridge, cdp, 1);
		const retryId = ++msgSeq;
		bridge.cdpMessage(
			reclaimed,
			JSON.stringify({ id: retryId, method: "Target.attachToTarget", params: { targetId: "PAGE1" } }),
		);
		await flush();
		expect(replacement.pending("attach")).toHaveLength(1);
		ack(bridge, replacement, "attach");
		await flush();
		expect(cdp.sessionFor(retryId)).toBeDefined();
	});

	it("clears an in-flight detach immediately when the extension socket is replaced", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = connectCdp(bridge, cdp, 1);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.detachFromTarget", params: { sessionId } }),
		);
		await flush();
		expect(ext.pending("detach")).toHaveLength(1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 1 })]);
		// A replacement worker drops tab ownership, so the client re-claims the
		// exact tab and reconnects before driving it again.
		const reclaimed = connectCdp(bridge, cdp, 1);
		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			reclaimed,
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
		const connId = connectCdp(bridge, cdp, 1);
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

	it("reports a real child target once, on the page session that armed auto-attach", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = connectCdp(bridge, cdp, 1);
		// Puppeteer's page session arms auto-attach; a transient
		// `page.createCDPSession()` on the same page never does.
		const manager = await attachPage(bridge, ext, cdp, conn, 1);
		const transient = await attachPage(bridge, ext, cdp, conn, 1);
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: ++msgSeq,
				sessionId: manager,
				method: "Target.setAutoAttach",
				params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
			}),
		);
		ack(bridge, ext, "send");
		await flush();
		const child = "REAL-CHILD-SESSION";
		const attached = { sessionId: child, targetInfo: { targetId: "OOPIF", type: "iframe", url: "" }, waitingForDebugger: true };
		bridge.extMessage(ext, JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Target.attachedToTarget", params: attached }));
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, sessionId: child, method: "Page.lifecycleEvent", params: { name: "load" } }),
		);
		const announcements = cdp.messages.filter(
			message =>
				message.method === "Target.attachedToTarget" &&
				typeof message.params === "object" &&
				message.params !== null &&
				"sessionId" in message.params &&
				message.params.sessionId === child,
		);
		expect(announcements.map(message => message.sessionId)).toEqual([manager]);
		expect(cdp.messages.filter(message => message.sessionId === child).map(message => message.method)).toEqual([
			"Page.lifecycleEvent",
		]);
		expect(transient).not.toBe(manager);
		// Commands on the child route to Chrome under the real session and answer the caller.
		const commandId = ++msgSeq;
		bridge.cdpMessage(conn, JSON.stringify({ id: commandId, sessionId: child, method: "Target.getTargetInfo" }));
		await flush();
		expect(ext.rpcs("send").at(-1)).toMatchObject({ tabId: 1, sessionId: child, method: "Target.getTargetInfo" });
		ack(bridge, ext, "send", { targetInfo: attached.targetInfo });
		await flush();
		expect(cdp.messages.find(message => message.id === commandId)).toMatchObject({ sessionId: child });
	});

	it("holds a pipelined duplicate Runtime.enable until the in-flight enable settles", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = connectCdp(bridge, cdp, 1);
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
		const connId = connectCdp(bridge, cdp, 1);
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
		const connId = connectCdp(bridge, cdp, 1);
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
	await release(bridge, ext, lease.id, "owner");
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
		await release(bridge, ext, lease.id, "owner");
		bridge.cdpClosed(connection);
		await flush();
		expect(ext.rpcs("detach").map(request => request.tabId)).toEqual([1]);
		ack(bridge, ext, "detach", {});
		expect(bridge.managed.discover()[0]!.ownership).toBe("available");
	} finally {
		bridge.cdpClosed(connection);
		bridge.extClosed(ext);
	}
});

describe("turn-end debugger release", () => {
	it("releases only the named actor's attachments and leaves a sibling actor driving", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const discovered = bridge.managed.discover();
		const mine = bridge.managed.claim(discovered.find(entry => entry.tabId === 1)!.id, "actor-a");
		const theirs = bridge.managed.claim(discovered.find(entry => entry.tabId === 2)!.id, "actor-b");
		const myCdp = new FakeCdpSocket();
		const theirCdp = new FakeCdpSocket();
		const myConn = bridge.cdpConnected(myCdp, mine.id);
		const theirConn = bridge.cdpConnected(theirCdp, theirs.id);
		await attachPage(bridge, ext, myCdp, myConn, 1);
		await attachPage(bridge, ext, theirCdp, theirConn, 2);
		const released = bridge.detachDebuggers({ owner: "actor-a" });
		await flush();
		expect(ext.pending("detachAll").map(request => request.tabIds)).toEqual([[1]]);
		ack(bridge, ext, "detachAll", { detached: [1] });
		expect(await released).toEqual([1]);
		// The sibling actor never lost its debugger, so no reattach is needed.
		expect(ext.rpcs("attach").map(request => request.tabId)).toEqual([1, 2]);
		bridge.cdpClosed(myConn);
		bridge.cdpClosed(theirConn);
	});

	it("keeps the debugger on a tab whose JavaScript dialog is still open", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const lease = bridge.managed.claim(bridge.managed.discover()[0]!.id, "owner");
		const cdp = new FakeCdpSocket();
		const connection = bridge.cdpConnected(cdp, lease.id);
		await attachPage(bridge, ext, cdp, connection, 1);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Page.javascriptDialogOpening",
				params: { type: "confirm", message: "Leave?" },
			}),
		);
		expect(await bridge.detachDebuggers({ owner: "owner" })).toEqual([]);
		expect(ext.rpcs("detachAll")).toEqual([]);
		bridge.cdpClosed(connection);
	});

	it("reattaches lazily on the next command and restores the tab's root debugger state", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const lease = bridge.managed.claim(bridge.managed.discover()[0]!.id, "owner");
		const cdp = new FakeCdpSocket();
		const connection = bridge.cdpConnected(cdp, lease.id);
		const sessionId = await attachPage(bridge, ext, cdp, connection, 1);
		// Set the tab up the way a page worker does: auto-attach, a root domain
		// enable, and Runtime (which the bridge owns and never re-receives).
		for (const [method, params] of [
			["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
			["Page.enable", undefined],
			["Runtime.enable", undefined],
		] as const) {
			bridge.cdpMessage(connection, JSON.stringify({ id: ++msgSeq, sessionId, method, params }));
			await flush();
			ack(bridge, ext, "send", {});
			await flush();
		}
		// The bridge's Runtime cycle is sequential; drain its second half.
		ack(bridge, ext, "send", {});
		await flush();
		expect(ext.rpcs("send").map(request => request.method)).toEqual([
			"Target.setAutoAttach",
			"Page.enable",
			"Runtime.disable",
			"Runtime.enable",
		]);
		const detached = bridge.detachDebuggers({ owner: "owner" });
		await flush();
		ack(bridge, ext, "detachAll", { detached: [1] });
		expect(await detached).toEqual([1]);
		const shot = ++msgSeq;
		bridge.cdpMessage(connection, JSON.stringify({ id: shot, sessionId, method: "Page.captureScreenshot" }));
		await flush();
		// The command waits behind one attach instead of failing on a detached tab.
		expect(ext.pending("attach").map(request => request.tabId)).toEqual([1]);
		expect(ext.pending("send")).toEqual([]);
		ack(bridge, ext, "attach", {});
		await flush();
		// Root state is restored in one parallel batch before the queued command.
		expect(
			ext
				.pending("send")
				.map(request => request.method)
				.sort(),
		).toEqual(["Page.enable", "Runtime.enable", "Target.setAutoAttach"]);
		ack(bridge, ext, "send", {});
		await flush();
		expect(ext.pending("send").map(request => request.method)).toEqual(["Page.captureScreenshot"]);
		ack(bridge, ext, "send", { data: "pixels" });
		await flush();
		expect(cdp.messages.find(message => message.id === shot)).toHaveProperty("result.data", "pixels");
		bridge.cdpClosed(connection);
	});

	it("releases every attachment when no actor is named", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		// Two actors, one tab each: every connection is scoped to its own lease.
		const first = new FakeCdpSocket();
		const second = new FakeCdpSocket();
		const firstConn = connectCdp(bridge, first, 1, "owner-a");
		const secondConn = connectCdp(bridge, second, 2, "owner-b");
		await attachPage(bridge, ext, first, firstConn, 1);
		await attachPage(bridge, ext, second, secondConn, 2);
		const released = bridge.detachDebuggers();
		await flush();
		expect(ext.pending("detachAll").map(request => request.tabIds)).toEqual([[1, 2]]);
		ack(bridge, ext, "detachAll", { detached: [1, 2] });
		expect(await released).toEqual([1, 2]);
		bridge.cdpClosed(firstConn);
		bridge.cdpClosed(secondConn);
	});
});

/**
 * The built worker, driven directly: a host `detachAll` and a worker unload
 * must both reach `chrome.debugger.detach`, or Chrome's debugging infobar
 * outlives the task that caused it.
 */
it("gives Chrome its debugger back on host request and on worker unload, in the built extension", async () => {
	const detached: number[] = [];
	const attachedTabs: number[] = [];
	let suspend: () => void = () => {};
	let relay: { send: (text: string) => void; onmessage?: (event: { data: string }) => void } | undefined;
	const inbound: Array<Record<string, unknown>> = [];
	const hello = Promise.withResolvers<void>();
	const event = () => ({ addListener: () => {} });
	class ExtensionSocket {
		static OPEN = 1;
		static CONNECTING = 0;
		readyState = 1;
		onmessage?: (event: { data: string }) => void;
		onopen?: () => void;
		send(text: string): void {
			const message = JSON.parse(text) as Record<string, unknown>;
			inbound.push(message);
			if (message.t === "authenticate") this.onmessage?.({ data: JSON.stringify({ t: "authenticated" }) });
			if (message.t === "hello") hello.resolve();
		}
		close(): void {}
		constructor() {
			relay = this;
			queueMicrotask(() => this.onopen?.());
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
			Response.json(url.endsWith("connection.json") ? { port: 19443 } : { service: "omp-browser", protocol: 2 }),
		chrome: {
			runtime: {
				getURL: (name: string) => `chrome-extension://fixture/${name}`,
				onInstalled: event(),
				onStartup: event(),
				onMessage: event(),
				onSuspend: {
					addListener: (listener: () => void) => {
						suspend = listener;
					},
				},
			},
			storage: { local: { get: async (defaults: object) => defaults, set: async () => {} } },
			action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: event() },
			alarms: { create: () => {}, onAlarm: event() },
			debugger: {
				getTargets: async () => [],
				attach: async ({ tabId }: { tabId: number }) => {
					attachedTabs.push(tabId);
				},
				detach: async ({ tabId }: { tabId: number }) => {
					if (!attachedTabs.includes(tabId)) throw new Error(`not attached to ${tabId}`);
					detached.push(tabId);
				},
				onEvent: event(),
				onDetach: event(),
			},
			tabs: {
				query: async () => [
					{ id: 1, ...tab({ tabId: 1 }) },
					{ id: 2, ...tab({ tabId: 2 }) },
				],
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
	await hello.promise;
	const call = async (id: number, request: RelayRpcRequest): Promise<Record<string, unknown>> => {
		relay!.onmessage?.({ data: JSON.stringify({ t: "rpc", id, ...request }) });
		for (let i = 0; i < 20 && !inbound.some(message => message.t === "rpcResult" && message.id === id); i++)
			await Promise.resolve();
		return inbound.find(message => message.t === "rpcResult" && message.id === id)!;
	};
	await call(1, { op: "attach", tabId: 1 });
	await call(2, { op: "attach", tabId: 2 });
	expect(await call(3, { op: "detachAll", tabIds: [1] })).toMatchObject({ ok: true, result: { detached: [1] } });
	expect(detached).toEqual([1]);
	// The remaining attachment is still tracked, so unloading releases it.
	suspend();
	await flush();
	expect(detached).toEqual([1, 2]);
});

/**
 * Build skew is the relay's to announce and the extension's to fix: a worker
 * whose RPC contract no longer matches the relay is worse than no worker, and
 * the files on disk are usually already the new ones.
 */
it("reloads the built extension worker once for an expected build it is not running", async () => {
	const session: Record<string, unknown> = {};
	const event = () => ({ addListener: () => {} });
	const boot = async (expectedBuildId: string): Promise<{ sent: string[]; reloads: number }> => {
		const sent: string[] = [];
		let reloads = 0;
		class ExtensionSocket {
			static OPEN = 1;
			static CONNECTING = 0;
			readyState = 1;
			onmessage?: (event: { data: string }) => void;
			onopen?: () => void;
			send(text: string): void {
				const message = JSON.parse(text) as { t: string };
				sent.push(message.t);
				if (message.t === "authenticate")
					this.onmessage?.({ data: JSON.stringify({ t: "authenticated", expectedBuildId }) });
			}
			close(): void {}
			constructor() {
				queueMicrotask(() => this.onopen?.());
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
				Response.json(url.endsWith("connection.json") ? { port: 19443 } : { service: "omp-browser", protocol: 2 }),
			chrome: {
				runtime: {
					getURL: (name: string) => `chrome-extension://fixture/${name}`,
					reload: () => {
						reloads++;
					},
					onInstalled: event(),
					onStartup: event(),
					onMessage: event(),
					onSuspend: event(),
				},
				storage: {
					local: { get: async (defaults: object) => defaults, set: async () => {} },
					session: {
						get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...session }),
						set: async (values: Record<string, unknown>) => {
							Object.assign(session, values);
						},
						remove: async (key: string) => {
							delete session[key];
						},
					},
				},
				action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: event() },
				alarms: { create: () => {}, onAlarm: event() },
				debugger: { getTargets: async () => [], onEvent: event(), onDetach: event() },
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
		for (let tick = 0; tick < 200 && reloads === 0 && !sent.includes("hello"); tick++) await Promise.resolve();
		return { sent, reloads };
	};
	const stale = "0".repeat(64);
	const skewed = await boot(stale);
	// Nothing is reported to a relay this worker cannot serve correctly.
	expect(skewed).toEqual({ reloads: 1, sent: ["authenticate"] });
	expect(session).toEqual({ reloadedFor: stale });
	// A stale install directory reloads to the same build; reloading again loops.
	expect(await boot(stale)).toMatchObject({ reloads: 0, sent: ["authenticate", "hello"] });
	// The committed worker is the build the relay ships, so parity clears the guard.
	expect(await boot(EXPECTED_EXTENSION_BUILD_ID)).toMatchObject({ reloads: 0 });
	expect(session).toEqual({});
});

describe("RelayBridge lease presentation", () => {
	/** Answer pending `send` RPCs, giving each injected script its own identifier. */
	function ackSends(bridge: RelayBridge, ext: FakeExtSocket): void {
		for (const rpc of ext.pending("send")) {
			ext.markAcked(rpc.id);
			bridge.extMessage(
				ext,
				JSON.stringify({ t: "rpcResult", id: rpc.id, ok: true, result: { identifier: `script-${rpc.id}` } }),
			);
		}
	}

	it("installs the badge and cursor overlay on a leased tab, paints the pointer ahead of the input, and takes both back", async () => {
		const bridge = new RelayBridge({ group: true });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const lease = bridge.managed.claim(discovered(bridge, 1), "owner");
		const cdp = new FakeCdpSocket();
		const connection = bridge.cdpConnected(cdp, lease.id);
		const sessionId = await attachPage(bridge, ext, cdp, connection, 1);
		// The install is four serialized round trips: add + evaluate, twice.
		for (let round = 0; round < 4; round++) {
			ackSends(bridge, ext);
			await flush();
		}
		const installs = ext.rpcs("send").filter(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
		expect(installs).toHaveLength(2);
		expect(String(installs[1]?.params?.source)).toContain("data-omp-cursor");
		const before = ext.rpcs("send").length;
		bridge.cdpMessage(
			connection,
			JSON.stringify({
				id: ++msgSeq,
				sessionId,
				method: "Input.dispatchMouseEvent",
				params: { type: "mousePressed", x: 120, y: 48, button: "left" },
			}),
		);
		await flush();
		// The arrow is placed before the click it mirrors, and never awaited.
		expect(ext.rpcs("send").slice(before)).toMatchObject([
			{
				method: "Runtime.evaluate",
				params: { expression: "window.__ompCursor?.move(120,48);window.__ompCursor?.press()" },
			},
			{ method: "Input.dispatchMouseEvent" },
		]);
		ackSends(bridge, ext);
		await flush();
		const afterPress = ext.rpcs("send").length;
		bridge.cdpMessage(
			connection,
			JSON.stringify({
				id: ++msgSeq,
				sessionId,
				method: "Input.dispatchMouseEvent",
				params: { type: "mouseReleased", x: 120, y: 48, button: "left" },
			}),
		);
		await flush();
		// Releasing the button moves nothing, so it costs no extra round trip.
		expect(ext.rpcs("send").slice(afterPress)).toMatchObject([{ method: "Input.dispatchMouseEvent" }]);
		ackSends(bridge, ext);
		await flush();
		await release(bridge, ext, lease.id, "owner");
		const removals = ext.rpcs("send").filter(rpc => rpc.method === "Page.removeScriptToEvaluateOnNewDocument");
		expect(removals.map(rpc => rpc.params?.identifier)).toEqual(installs.map(rpc => `script-${rpc.id}`));
		expect(ext.rpcs("send").map(rpc => rpc.params?.expression)).toContain("window.__ompCursor?.remove()");
	});
});
