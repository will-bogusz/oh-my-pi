import { describe, expect, it, jest } from "bun:test";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { CURSOR_OVERLAY_INSTALL } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/lease-badge";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import { EXPECTED_EXTENSION_BUILD_ID } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/instances";
import type {
	RelayRpcRequest,
	RelayToExtMessage,
	TabSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";

/** Same derivation as the bridge: target ids embed this per-instance code. */
function instanceCode(instanceId: string): string {
	return createHash("sha256").update(instanceId).digest("base64url").slice(0, 8);
}

/** Instance id of the single browser most tests drive. */
const BROWSER = "chrome-profile";
const CODE = instanceCode(BROWSER);

/** A relay→extension RPC narrowed to one op, tabIds/title/etc. included. */
type ExtRpc<Op extends RelayRpcRequest["op"]> = { t: "rpc"; id: number } & Extract<RelayRpcRequest, { op: Op }>;

class FakeExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	readonly #acked = new Set<number>();
	closed = false;
	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}
	close(): void {
		this.closed = true;
	}
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

function connect(
	bridge: RelayBridge,
	socket: FakeExtSocket,
	tabs: TabSnapshot[],
	attachedTabIds: number[] = [],
	instanceId = BROWSER,
): void {
	bridge.extConnected(socket, instanceId);
	bridge.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			instanceId,
			userAgent: "test",
			browserVersion: instanceId === "edge" ? "Edg/151.0.0.0" : "Chrome/151.0.0.0",
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
	expect(bridge.managed(BROWSER).discover()).toMatchObject([{ tabId: 1, title: "Updated", url: "https://example.com/" }]);
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
		const lease = bridge.managed(BROWSER).claim(bridge.managed(BROWSER).discover()[0]!.id, "owner");
		const cdp = new FakeCdpSocket();
		const connection = bridge.cdpConnected(cdp, lease.id);
		bridge.cdpMessage(connection, JSON.stringify({ id: 1, method: "Target.setDiscoverTargets" }));
		await flush();
		const created = cdp.messages.filter(message => message.method === "Target.targetCreated");
		expect(
			created.map(message => (message.params as { targetInfo: { targetId: string } }).targetInfo.targetId),
		).toEqual([`TAB${CODE}.1`, `PAGE${CODE}.1`]);
		expect(ext.rpcs("attach")).toHaveLength(0);
		const sessionId = await attachPage(bridge, ext, cdp, connection, 1);
		for (const [id, method, params] of [
			[2, "Target.attachToTarget", { targetId: `PAGE${CODE}.2` }],
			[3, "Target.activateTarget", { targetId: `PAGE${CODE}.1` }],
			[4, "Target.closeTarget", { targetId: `PAGE${CODE}.1` }],
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
	instanceId = BROWSER,
): Promise<string> {
	const attachId = ++msgSeq;
	bridge.cdpMessage(
		connId,
		JSON.stringify({
			id: attachId,
			method: "Target.attachToTarget",
			params: { targetId: `PAGE${instanceCode(instanceId)}.${tabId}`, flatten: true },
		}),
	);
	ack(bridge, ext, "attach");
	await flush();
	const sessionId = cdp.sessionFor(attachId);
	if (!sessionId) throw new Error(`attachToTarget for tab ${tabId} did not produce a session`);
	return sessionId;
}

/** Discovery id of a physical tab. */
function discovered(bridge: RelayBridge, tabId: number, instanceId = BROWSER): string {
	const found = bridge
		.managed(instanceId)
		.discover()
		.find(candidate => candidate.tabId === tabId);
	if (!found) throw new Error(`tab ${tabId} is not discoverable`);
	return found.id;
}

/**
 * Connect a downstream client scoped to `tabId`. Every /cdp connection carries
 * a lease, so a client exists only for a tab its owner already claimed.
 */
function connectCdp(
	bridge: RelayBridge,
	cdp: FakeCdpSocket,
	tabId: number,
	owner = "owner",
	instanceId = BROWSER,
): number {
	const managed = bridge.managed(instanceId);
	const leaseId = managed.leaseForTab(tabId) ?? managed.claim(discovered(bridge, tabId, instanceId), owner).id;
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
	const done = bridge.managed(BROWSER).releaseTab(leaseId, owner, close);
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
		const claimed = bridge.managed(BROWSER).claim(discovered(bridge, 1), "owner-a", "Research");
		expect(ext.rpcs("group")).toHaveLength(0);
		// A tab OMP creates for the task joins the owner's group under its label.
		const creating = bridge.managed(BROWSER).create("https://example.com/task", "owner-a", "Research");
		ack(bridge, ext, "createTab", { tab: tab({ tabId: 7 }) });
		await flush();
		ack(bridge, ext, "group");
		const created = await creating;
		expect(ext.rpcs("group").map(rpc => [rpc.tabId, rpc.owner, rpc.label])).toEqual([[7, "owner-a", "Research"]]);
		// Keeping a tab takes it back out of the group without closing it.
		await release(bridge, ext, created.id, "owner-a");
		expect(ext.rpcs("releaseTab")).toEqual([expect.objectContaining({ tabId: 7, close: false })]);
		expect(bridge.managed(BROWSER).discover("owner-a").find(candidate => candidate.tabId === 7)?.ownership).toBe("available");
		expect(bridge.managed(BROWSER).get(claimed.id, "owner-a").tab.tabId).toBe(1);
	});

	it("leases a tab the browser opened from a leased tab to the opener's owner and serves it to that owner", async () => {
		const bridge = new RelayBridge({ group: true });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const parent = bridge.managed(BROWSER).claim(discovered(bridge, 1), "owner-a", "Research");
		// A child of a leased tab belongs to that tab's owner, in its group.
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "tabOpened", tab: tab({ tabId: 5, url: "https://example.com/child" }), openerTabId: 1 }),
		);
		await flush();
		expect(ext.rpcs("group").map(rpc => [rpc.tabId, rpc.owner, rpc.label])).toEqual([[5, "owner-a", "Research"]]);
		expect(bridge.managed(BROWSER).childTabs(parent.id, "owner-a")).toMatchObject([
			{ tabId: 5, url: "https://example.com/child", ownership: "this_actor", popupOf: parent.tab.id },
		]);
		// Claiming the child adopts the auto-lease instead of failing as taken.
		const child = bridge.managed(BROWSER).claim(bridge.managed(BROWSER).childTabs(parent.id, "owner-a")[0]!.id, "owner-a");
		expect(bridge.managed(BROWSER).tabForLease(child.id)).toBe(5);
		// A child of a tab nobody leases stays the user's.
		bridge.extMessage(ext, JSON.stringify({ t: "tabOpened", tab: tab({ tabId: 6 }), openerTabId: 2 }));
		await flush();
		expect(bridge.managed(BROWSER).discover("owner-a").find(candidate => candidate.tabId === 6)?.ownership).toBe("available");
		// Releasing the parent hands back its unclaimed children too.
		await release(bridge, ext, parent.id, "owner-a");
		expect(bridge.managed(BROWSER).discover("owner-a").find(candidate => candidate.tabId === 1)?.ownership).toBe("available");
	});

	it("adopts a popup Chrome blames on the visible tab, and leaves Chrome's selection alone", async () => {
		const bridge = new RelayBridge({ group: true });
		const ext = new FakeExtSocket();
		// Tab 3 is what the user is looking at; tab 1 is the leased background tab.
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 3, active: true })]);
		const parent = bridge.managed(BROWSER).claim(discovered(bridge, 1), "owner-a", "Research");
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
		expect(bridge.managed(BROWSER).childTabs(parent.id, "owner-a")).toMatchObject([
			{ tabId: 5, ownership: "this_actor", popupOf: parent.tab.id },
		]);
		expect(ext.rpcs("group").map(rpc => rpc.tabId)).toEqual([5]);
		// Chrome raised and selected the child; putting tab 3 back would show the
		// user the page they did not just open. Adoption never selects anything.
		expect(ext.rpcs("activateTab")).toEqual([]);
		// One witness explains one popup: the next unexplained tab stays the user's.
		bridge.extMessage(ext, JSON.stringify({ t: "tabOpened", tab: tab({ tabId: 6, active: true }), openerTabId: 3 }));
		await flush();
		expect(bridge.managed(BROWSER).discover("owner-a").find(candidate => candidate.tabId === 6)?.ownership).toBe("available");
		expect(ext.rpcs("activateTab")).toEqual([]);
	});

	it("keeps a leased tab releasable after it navigates somewhere no debugger can attach", async () => {
		const bridge = new RelayBridge({ group: true });
		const ext = new FakeExtSocket();
		connect(bridge, ext, []);
		const creating = bridge.managed(BROWSER).create("https://example.com/downloads", "owner-a", "Downloads");
		ack(bridge, ext, "createTab", { tab: tab({ tabId: 4 }) });
		await flush();
		ack(bridge, ext, "group");
		const lease = await creating;
		// The page navigates to chrome://, which Chrome refuses to debug.
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 4, url: "chrome://downloads/" }) }));
		bridge.extMessage(ext, JSON.stringify({ t: "detached", tabId: 4, reason: "target_closed" }));
		await flush();
		// Ownership survives, so the tab is still discoverable and closable…
		expect(bridge.managed(BROWSER).get(lease.id, "owner-a").tab).toMatchObject({ tabId: 4, url: "chrome://downloads/" });
		expect(bridge.managed(BROWSER).discover("owner-a").map(candidate => candidate.tabId)).toEqual([4]);
		await release(bridge, ext, lease.id, "owner-a", true);
		// …and the release still takes it out of the group before closing it.
		expect(ext.rpcs("releaseTab")).toEqual([expect.objectContaining({ tabId: 4, close: true })]);
		// With the lease gone the page leaves discovery: nobody may claim it.
		expect(bridge.managed(BROWSER).discover()).toEqual([]);
	});

	it("titles the group 'Oh My Pi' unless the client names it, and groups nothing when marking is off", async () => {
		for (const [marking, expected] of [
			[true, [[9, "owner", "Oh My Pi"]]],
			[false, []],
		] as Array<[boolean, Array<[number, string, string]>]>) {
			const bridge = new RelayBridge({ group: marking });
			const ext = new FakeExtSocket();
			connect(bridge, ext, []);
			const creating = bridge.managed(BROWSER).create("https://example.com/", "owner");
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
		// Set the tab up the way a page worker does: auto-attach, a root domain
		// enable, and Runtime (which the bridge owns and never re-receives).
		for (const [method, params] of [
			["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
			["Page.enable", undefined],
			["Runtime.enable", undefined],
		] as const) {
			bridge.cdpMessage(conn, JSON.stringify({ id: ++msgSeq, sessionId: session, method, params }));
			await flush();
			ack(bridge, ext, "send", {});
			await flush();
		}
		// The bridge's Runtime cycle is sequential; drain its second half.
		ack(bridge, ext, "send", {});
		await flush();
		await until(() => detachedTabs(ext).includes(1), "the idle detach");
		ack(bridge, ext, "detach");
		await flush();
		// The lease and the downstream session both survive the detach…
		expect(bridge.managed(BROWSER).tabForLease(bridge.managed(BROWSER).leaseForTab(1)!)).toBe(1);
		expect(cdp.messages.filter(message => message.method === "Target.detachedFromTarget")).toHaveLength(0);
		// …but the driver is told its object mirrors died with the attachment.
		expect(
			cdp.messages.filter(
				message => message.method === "Runtime.executionContextsCleared" && message.sessionId === session,
			),
		).toHaveLength(1);
		const evaluateId = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({ id: evaluateId, sessionId: session, method: "Runtime.evaluate", params: { expression: "1" } }),
		);
		await flush();
		// The command waits behind one attach instead of failing on a detached tab.
		expect(ext.pending("attach").map(request => request.tabId)).toEqual([1]);
		expect(ext.pending("send")).toEqual([]);
		ack(bridge, ext, "attach");
		await flush();
		// The reattach puts every root-session switch back in one parallel batch,
		// before the queued command runs.
		expect(
			ext
				.pending("send")
				.map(request => request.method)
				.sort(),
		).toEqual(["Page.enable", "Runtime.enable", "Target.setAutoAttach"]);
		ack(bridge, ext, "send", {});
		await flush();
		expect(ext.pending("send").map(request => request.method)).toEqual(["Runtime.evaluate"]);
		ack(bridge, ext, "send", { result: { value: 1 } });
		await flush();
		expect(cdp.messages.find(message => message.id === evaluateId)).not.toHaveProperty("error");
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
		expect(bridge.dialogState(BROWSER, 3).status).toBe("open");
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

		// The socket drops: the server closes the connections whose leases ended with it.
		bridge.extClosed(firstExt);
		bridge.cdpClosed(firstConn);
		const nextExt = new FakeExtSocket();
		bridge.extConnected(nextExt, BROWSER);
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
		// Chrome kept the attachment; the relay takes OMP's marks off the page and hands it back.
		await flush();
		ack(bridge, nextExt, "send");
		await flush();
		ack(bridge, nextExt, "detach");
		await flush();

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
						bridge.extConnected(ext, BROWSER);
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
					downloads: { onCreated: event(), onChanged: event() },
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
			const lease = bridge.managed(BROWSER).claim(bridge.managed(BROWSER).discover()[0]!.id, "owner");
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
					JSON.stringify({ id, method: "Target.attachToTarget", params: { targetId: `PAGE${CODE}.1` } }),
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
				expect(bridge.managed(BROWSER).get(lease.id, "owner").id).toBe(lease.id);
			}
			attached = false;
			nativeDetach({ tabId: 1 }, "canceled_by_user");
			if (cancellation === "during failed detach") detach.reject(new Error("Debugger is not attached"));
			await flush();
			// The cancellation costs the tab, not the ownership: the lease lives on
			// so its owner can still take the tab out of the group and close it.
			expect(bridge.managed(BROWSER).get(lease.id, "owner").id).toBe(lease.id);
			bridge.cdpMessage(
				connId,
				JSON.stringify({ id: 4, method: "Target.attachToTarget", params: { targetId: `PAGE${CODE}.1` } }),
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
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: `PAGE${CODE}.1` } }),
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
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: `PAGE${CODE}.1` } }),
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
		await flush();
		ack(bridge, replacement, "send");
		await flush();
		// The hello still lists the tab: the relay hands that attachment back itself.
		expect(replacement.pending("detach").map(rpc => rpc.tabId)).toEqual([1]);
		bridge.extMessage(
			replacement,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		ack(bridge, replacement, "detach");
		await flush();

		// A replacement worker drops tab ownership, so the client re-claims the
		// exact tab and reconnects before driving it again.
		const reclaimed = connectCdp(bridge, cdp, 1);
		const reattachId = ++msgSeq;
		bridge.cdpMessage(
			reclaimed,
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: `PAGE${CODE}.1` } }),
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
			JSON.stringify({ id: ++msgSeq, method: "Target.attachToTarget", params: { targetId: `PAGE${CODE}.1` } }),
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
			JSON.stringify({ id: retryId, method: "Target.attachToTarget", params: { targetId: `PAGE${CODE}.1` } }),
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
			JSON.stringify({ id: reattachId, method: "Target.attachToTarget", params: { targetId: `PAGE${CODE}.1` } }),
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
		const attached = {
			sessionId: child,
			targetInfo: { targetId: "OOPIF", type: "iframe", url: "" },
			waitingForDebugger: true,
		};
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Target.attachedToTarget", params: attached }),
		);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				sessionId: child,
				method: "Page.lifecycleEvent",
				params: { name: "load" },
			}),
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

	it("tells a connection that arms auto-attach late about the children Chrome already reported, once each", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const first = new FakeCdpSocket();
		const firstConn = connectCdp(bridge, first, 1);
		const firstPage = await attachPage(bridge, ext, first, firstConn, 1);
		const arm = (conn: number, sessionId: string) => {
			const id = ++msgSeq;
			bridge.cdpMessage(
				conn,
				JSON.stringify({
					id,
					sessionId,
					method: "Target.setAutoAttach",
					params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
				}),
			);
			return id;
		};
		arm(firstConn, firstPage);
		ack(bridge, ext, "send");
		await flush();
		// Chrome reports a cross-site frame, and a frame nested in it, once: to the first arm.
		const frame = {
			sessionId: "REAL-FRAME",
			targetInfo: { targetId: "OOPIF", type: "iframe", url: "" },
			waitingForDebugger: false,
		};
		const nested = {
			sessionId: "REAL-NESTED",
			targetInfo: { targetId: "NESTED", type: "iframe", url: "" },
			waitingForDebugger: false,
		};
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, method: "Target.attachedToTarget", params: frame }),
		);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				sessionId: frame.sessionId,
				method: "Target.attachedToTarget",
				params: nested,
			}),
		);
		const loaded = { targetId: "OOPIF", type: "iframe", url: "http://localhost:8761/frame" };
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Target.targetInfoChanged",
				params: { targetInfo: loaded },
			}),
		);
		const announced = (socket: FakeCdpSocket) =>
			socket.messages
				.filter(message => message.method === "Target.attachedToTarget")
				.map(message => ({ on: message.sessionId, params: message.params }));

		// A second driver arms after the fact: Chrome answers its arm with nothing new.
		const second = new FakeCdpSocket();
		const secondConn = connectCdp(bridge, second, 1);
		const secondPage = await attachPage(bridge, ext, second, secondConn, 1);
		const before = announced(second).length;
		const armed = arm(secondConn, secondPage);
		ack(bridge, ext, "send");
		await flush();
		expect(announced(second).slice(before)).toEqual([{ on: secondPage, params: { ...frame, targetInfo: loaded } }]);
		// …before its arm is answered, as Chrome orders them.
		const reply = second.messages.findIndex(message => message.id === armed);
		expect(reply).toBeGreaterThan(
			second.messages.findLastIndex(message => message.method === "Target.attachedToTarget"),
		);
		// The nested frame comes with the arm on the frame's own session, and arming again repeats nothing.
		arm(secondConn, frame.sessionId);
		ack(bridge, ext, "send");
		await flush();
		arm(secondConn, secondPage);
		ack(bridge, ext, "send");
		await flush();
		expect(announced(second).slice(before)).toEqual([
			{ on: secondPage, params: { ...frame, targetInfo: loaded } },
			{ on: frame.sessionId, params: nested },
		]);
		// The first driver heard each once, from Chrome, and nothing more.
		const children = [frame.sessionId, nested.sessionId];
		expect(
			announced(first).filter(
				entry =>
					typeof entry.params === "object" &&
					entry.params !== null &&
					"sessionId" in entry.params &&
					children.includes(String(entry.params.sessionId)),
			),
		).toEqual([
			{ on: firstPage, params: frame },
			{ on: frame.sessionId, params: nested },
		]);

		// Chrome drops the children with the attachment: a driver arming after a detach hears of no dead session.
		bridge.extMessage(ext, JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed" }));
		await flush();
		bridge.managed(BROWSER).claim(discovered(bridge, 1), "owner");
		const third = new FakeCdpSocket();
		const thirdConn = connectCdp(bridge, third, 1);
		const reattach = ++msgSeq;
		bridge.cdpMessage(
			thirdConn,
			JSON.stringify({
				id: reattach,
				method: "Target.attachToTarget",
				params: { targetId: `PAGE${CODE}.1`, flatten: true },
			}),
		);
		ack(bridge, ext, "attach");
		await flush();
		// The reattach puts back the root state the earlier drivers armed, auto-attach included.
		while (ext.pending("send").length > 0) {
			ack(bridge, ext, "send");
			await flush();
		}
		const thirdPage = third.sessionFor(reattach);
		if (!thirdPage) throw new Error("the reattach minted no page session");
		const thirdBefore = announced(third).length;
		arm(thirdConn, thirdPage);
		ack(bridge, ext, "send");
		await flush();
		expect(announced(third).slice(thirdBefore)).toEqual([]);
	});

	it("routes a shared child's reports only to connections that know it, and lets each let go of it alone", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const arm = (conn: number, sessionId: string) =>
			bridge.cdpMessage(
				conn,
				JSON.stringify({
					id: ++msgSeq,
					sessionId,
					method: "Target.setAutoAttach",
					params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
				}),
			);
		const report = (params: Record<string, unknown>, sessionId?: string) =>
			bridge.extMessage(ext, JSON.stringify({ t: "cdpEvent", tabId: 1, sessionId, method: "Target.attachedToTarget", params }));
		const heard = (socket: FakeCdpSocket, method: string) =>
			socket.messages
				.filter(message => message.method === method)
				.map(message => ({
					on: message.sessionId,
					child:
						typeof message.params === "object" && message.params !== null && "sessionId" in message.params
							? message.params.sessionId
							: undefined,
				}));
		const frame = { sessionId: "REAL-FRAME", targetInfo: { targetId: "OOPIF", type: "iframe", url: "" }, waitingForDebugger: false };
		const nested = { sessionId: "REAL-NESTED", targetInfo: { targetId: "NESTED", type: "iframe", url: "" }, waitingForDebugger: false };

		const first = new FakeCdpSocket();
		const firstConn = connectCdp(bridge, first, 1);
		const firstPage = await attachPage(bridge, ext, first, firstConn, 1);
		arm(firstConn, firstPage);
		ack(bridge, ext, "send");
		await flush();
		report(frame);

		// A late connection's arm is in flight when the frame reports a frame of its own:
		// the late connection cannot place a report from a frame it has not heard of yet.
		const late = new FakeCdpSocket();
		const lateConn = connectCdp(bridge, late, 1);
		const latePage = await attachPage(bridge, ext, late, lateConn, 1);
		arm(lateConn, latePage);
		await flush();
		report(nested, frame.sessionId);
		ack(bridge, ext, "send");
		await flush();
		arm(lateConn, frame.sessionId);
		ack(bridge, ext, "send");
		await flush();
		expect(heard(late, "Target.attachedToTarget").filter(entry => entry.on !== undefined)).toEqual([
			{ on: latePage, child: frame.sessionId },
			{ on: frame.sessionId, child: nested.sessionId },
		]);
		expect(heard(first, "Target.attachedToTarget").filter(entry => entry.on !== undefined)).toEqual([
			{ on: firstPage, child: frame.sessionId },
			{ on: frame.sessionId, child: nested.sessionId },
		]);

		// The first connection lets go of the frame: it hears the detach, Chrome is not asked,
		// and the late connection keeps hearing the frame.
		const sends = ext.rpcs("send").length;
		const detachId = ++msgSeq;
		bridge.cdpMessage(
			firstConn,
			JSON.stringify({ id: detachId, sessionId: firstPage, method: "Target.detachFromTarget", params: { sessionId: frame.sessionId } }),
		);
		await flush();
		expect(ext.rpcs("send")).toHaveLength(sends);
		expect(first.messages.find(message => message.id === detachId)).toHaveProperty("result");
		expect(heard(first, "Target.detachedFromTarget")).toEqual([{ on: firstPage, child: frame.sessionId }]);
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, sessionId: frame.sessionId, method: "Page.lifecycleEvent", params: { name: "load" } }),
		);
		expect(late.messages.filter(message => message.sessionId === frame.sessionId && message.method === "Page.lifecycleEvent")).toHaveLength(1);
		expect(first.messages.filter(message => message.sessionId === frame.sessionId && message.method === "Page.lifecycleEvent")).toHaveLength(0);
		// …and the frame nested in it went with it for the first connection only.
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "cdpEvent", tabId: 1, sessionId: nested.sessionId, method: "Page.lifecycleEvent", params: { name: "load" } }),
		);
		expect(late.messages.filter(message => message.sessionId === nested.sessionId && message.method === "Page.lifecycleEvent")).toHaveLength(1);
		expect(first.messages.filter(message => message.sessionId === nested.sessionId && message.method === "Page.lifecycleEvent")).toHaveLength(0);

		// Letting go twice is refused: a connection that no longer holds the frame cannot end it.
		const again = ++msgSeq;
		bridge.cdpMessage(
			firstConn,
			JSON.stringify({ id: again, sessionId: firstPage, method: "Target.detachFromTarget", params: { sessionId: frame.sessionId } }),
		);
		await flush();
		expect(ext.rpcs("send")).toHaveLength(sends);
		expect(first.messages.find(message => message.id === again)).toHaveProperty("error");

		// The last holder letting go ends the frame's session in Chrome.
		bridge.cdpMessage(
			lateConn,
			JSON.stringify({ id: ++msgSeq, sessionId: latePage, method: "Target.detachFromTarget", params: { sessionId: frame.sessionId } }),
		);
		await flush();
		expect(ext.rpcs("send").at(-1)).toMatchObject({ method: "Target.detachFromTarget", params: { sessionId: frame.sessionId } });
	});

	it("hands back an attachment Chrome kept across a lost extension socket, so a reclaiming driver hears its frames afresh", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const arm = (conn: number, sessionId: string) =>
			bridge.cdpMessage(
				conn,
				JSON.stringify({
					id: ++msgSeq,
					sessionId,
					method: "Target.setAutoAttach",
					params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
				}),
			);
		const report = (socket: FakeExtSocket, sessionId: string) =>
			bridge.extMessage(
				socket,
				JSON.stringify({
					t: "cdpEvent",
					tabId: 1,
					method: "Target.attachedToTarget",
					params: {
						sessionId,
						targetInfo: { targetId: "OOPIF", type: "iframe", url: "" },
						waitingForDebugger: false,
					},
				}),
			);
		const first = new FakeCdpSocket();
		const firstConn = connectCdp(bridge, first, 1);
		const firstPage = await attachPage(bridge, ext, first, firstConn, 1);
		arm(firstConn, firstPage);
		ack(bridge, ext, "send");
		await flush();
		report(ext, "FRAME-BEFORE");

		// The socket drops: every lease ends with it, and the server closes their connections.
		bridge.extClosed(ext);
		bridge.cdpClosed(firstConn);
		// The worker reconnects within the grace. Chrome kept the attachment, but what it
		// reported in between never arrived, so the relay hands the attachment back.
		const next = new FakeExtSocket();
		connect(bridge, next, [tab({ tabId: 1 })], [1]);
		await flush();
		ack(bridge, next, "send");
		await flush();
		expect(next.pending("detach").map(request => request.tabId)).toEqual([1]);
		bridge.extMessage(
			next,
			JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed", relayInitiated: true }),
		);
		ack(bridge, next, "detach");
		await flush();

		// A driver reclaiming the tab gets a fresh attachment; its auto-attach is armed
		// again there, and Chrome reports the frame to it under a new session.
		const second = new FakeCdpSocket();
		const secondConn = connectCdp(bridge, second, 1);
		const reattach = ++msgSeq;
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({
				id: reattach,
				method: "Target.attachToTarget",
				params: { targetId: `PAGE${CODE}.1`, flatten: true },
			}),
		);
		await flush();
		expect(next.pending("attach")).toHaveLength(1);
		ack(bridge, next, "attach");
		await flush();
		expect(next.pending("send").map(request => request.method)).toContain("Target.setAutoAttach");
		report(next, "FRAME-AFTER");
		while (next.pending("send").length > 0) {
			ack(bridge, next, "send");
			await flush();
		}
		const secondPage = second.sessionFor(reattach);
		if (!secondPage) throw new Error("the reattach minted no page session");
		arm(secondConn, secondPage);
		ack(bridge, next, "send");
		await flush();
		expect(second.attachedSessions().filter(session => session.startsWith("FRAME-"))).toEqual(["FRAME-AFTER"]);
	});

	it("sends one detach for a hand-back whose socket is replaced before Chrome answers it", async () => {
		const bridge = new RelayBridge({ autofillOptOut: true });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const conn = connectCdp(bridge, cdp, 1);
		const attachId = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({ id: attachId, method: "Target.attachToTarget", params: { targetId: `PAGE${CODE}.1` } }),
		);
		ack(bridge, ext, "attach");
		for (let round = 0; round < 4; round++) {
			await flush();
			ack(bridge, ext, "send");
		}
		await flush();
		expect(cdp.sessionFor(attachId)).toBeDefined();
		bridge.extClosed(ext);
		bridge.cdpClosed(conn);
		// The worker reconnects over the attachment Chrome kept; its hand-back waits on Chrome to clean the page.
		const next = new FakeExtSocket();
		connect(bridge, next, [tab({ tabId: 1 })], [1]);
		await flush();
		expect(next.pending("send")).not.toHaveLength(0);
		// Replaced again before Chrome answers: that hand-back ends with its socket, and the next hello's takes over.
		const last = new FakeExtSocket();
		connect(bridge, last, [tab({ tabId: 1 })], [1]);
		for (let round = 0; round < 4; round++) {
			await flush();
			ack(bridge, last, "send");
		}
		await flush();
		expect([...next.rpcs("detach"), ...last.rpcs("detach")].map(request => request.tabId)).toEqual([1]);
	});

	it("lets no arm Chrome answers after a reattach announce the new attachment's frames", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const arm = (conn: number, sessionId: string) => {
			const id = ++msgSeq;
			bridge.cdpMessage(
				conn,
				JSON.stringify({
					id,
					sessionId,
					method: "Target.setAutoAttach",
					params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
				}),
			);
			return id;
		};
		const report = (sessionId: string) =>
			bridge.extMessage(
				ext,
				JSON.stringify({
					t: "cdpEvent",
					tabId: 1,
					method: "Target.attachedToTarget",
					params: {
						sessionId,
						targetInfo: { targetId: sessionId, type: "iframe", url: "" },
						waitingForDebugger: false,
					},
				}),
			);
		const cdp = new FakeCdpSocket();
		const conn = connectCdp(bridge, cdp, 1);
		const oldPage = await attachPage(bridge, ext, cdp, conn, 1);
		arm(conn, oldPage);
		ack(bridge, ext, "send");
		await flush();
		report("OLD-FRAME");

		// A second arm is still in flight when Chrome drops the debugger; the driver reattaches.
		arm(conn, oldPage);
		await flush();
		const stale = ext.pending("send").find(request => request.method === "Target.setAutoAttach");
		if (!stale) throw new Error("the arm was not forwarded");
		bridge.extMessage(ext, JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed" }));
		bridge.managed(BROWSER).claim(discovered(bridge, 1), "owner");
		const reattach = ++msgSeq;
		bridge.cdpMessage(
			conn,
			JSON.stringify({
				id: reattach,
				method: "Target.attachToTarget",
				params: { targetId: `PAGE${CODE}.1`, flatten: true },
			}),
		);
		ack(bridge, ext, "attach");
		await flush();
		report("NEW-FRAME");

		// Only now does Chrome answer the old arm: it names nothing on the dead page session.
		ext.markAcked(stale.id);
		bridge.extMessage(ext, JSON.stringify({ t: "rpcResult", id: stale.id, ok: true, result: {} }));
		await flush();
		while (ext.pending("send").length > 0) {
			ack(bridge, ext, "send");
			await flush();
		}
		const newPage = cdp.sessionFor(reattach);
		if (!newPage) throw new Error("the reattach minted no page session");
		arm(conn, newPage);
		ack(bridge, ext, "send");
		await flush();
		const announcedNew = cdp.messages.filter(
			message =>
				message.method === "Target.attachedToTarget" &&
				typeof message.params === "object" &&
				message.params !== null &&
				"sessionId" in message.params &&
				message.params.sessionId === "NEW-FRAME",
		);
		expect(announcedNew.map(message => message.sessionId)).toEqual([newPage]);
	});

	it("replays no frame its last holder is detaching, and leaves it held when Chrome refuses the detach", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const arm = (conn: number, sessionId: string) =>
			bridge.cdpMessage(
				conn,
				JSON.stringify({
					id: ++msgSeq,
					sessionId,
					method: "Target.setAutoAttach",
					params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
				}),
			);
		const answer = (method: string, ok: boolean) => {
			const request = ext.pending("send").find(pending => pending.method === method);
			if (!request) throw new Error(`no ${method} in flight`);
			ext.markAcked(request.id);
			bridge.extMessage(
				ext,
				JSON.stringify(
					ok
						? { t: "rpcResult", id: request.id, ok, result: {} }
						: { t: "rpcResult", id: request.id, ok, error: "refused" },
				),
			);
		};
		const first = new FakeCdpSocket();
		const firstConn = connectCdp(bridge, first, 1);
		const firstPage = await attachPage(bridge, ext, first, firstConn, 1);
		arm(firstConn, firstPage);
		ack(bridge, ext, "send");
		await flush();
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Target.attachedToTarget",
				params: {
					sessionId: "REAL-FRAME",
					targetInfo: { targetId: "OOPIF", type: "iframe", url: "" },
					waitingForDebugger: false,
				},
			}),
		);

		// The frame's only holder lets go of it, and a late connection arms while Chrome works on that.
		const detachId = ++msgSeq;
		bridge.cdpMessage(
			firstConn,
			JSON.stringify({
				id: detachId,
				sessionId: firstPage,
				method: "Target.detachFromTarget",
				params: { sessionId: "REAL-FRAME" },
			}),
		);
		await flush();
		const late = new FakeCdpSocket();
		const lateConn = connectCdp(bridge, late, 1);
		const latePage = await attachPage(bridge, ext, late, lateConn, 1);
		arm(lateConn, latePage);
		await flush();
		answer("Target.setAutoAttach", true);
		await flush();
		expect(late.attachedSessions()).not.toContain("REAL-FRAME");

		// Chrome refuses: the frame lives on, still the first connection's.
		answer("Target.detachFromTarget", false);
		await flush();
		expect(first.messages.find(message => message.id === detachId)).toHaveProperty("error");
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				sessionId: "REAL-FRAME",
				method: "Page.lifecycleEvent",
				params: { name: "load" },
			}),
		);
		expect(
			first.messages.filter(
				message => message.sessionId === "REAL-FRAME" && message.method === "Page.lifecycleEvent",
			),
		).toHaveLength(1);
		// …and a later arm is told of it again.
		arm(lateConn, latePage);
		ack(bridge, ext, "send");
		await flush();
		expect(late.attachedSessions().filter(session => session === "REAL-FRAME")).toEqual(["REAL-FRAME"]);
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

	it("tries a banned tab once more on an explicit claim and re-bans it with Chrome's fresh reason", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1, url: "https://accounts.example.com/signin?continue=%2Finbox" })]);
		const cdp = new FakeCdpSocket();
		const connId = connectCdp(bridge, cdp, 1);
		await attachPage(bridge, ext, cdp, connId, 1);
		const leaseId = bridge.managed(BROWSER).leaseForTab(1)!;
		const attachToTarget = (): number => {
			const id = ++msgSeq;
			bridge.cdpMessage(
				connId,
				JSON.stringify({ id, method: "Target.attachToTarget", params: { targetId: `PAGE${CODE}.1` } }),
			);
			return id;
		};
		// A password manager's frame lands in the page: Chrome drops the debugger.
		bridge.extMessage(ext, JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed" }));
		await flush();
		expect(bridge.debuggerState(BROWSER, 1).revoked).toContain("password manager");
		// Nothing the relay does on its own reattaches a banned tab.
		const attaches = ext.rpcs("attach").length;
		attachToTarget();
		await flush();
		expect(ext.rpcs("attach")).toHaveLength(attaches);
		// The owner claiming it again gets its own lease back and one more try…
		expect(bridge.managed(BROWSER).claim(discovered(bridge, 1), "owner").id).toBe(leaseId);
		const retry = attachToTarget();
		await flush();
		expect(ext.pending("attach")).toHaveLength(1);
		nack(bridge, ext, "attach", "Cannot access a chrome-extension:// URL of different extension");
		await flush();
		// …and Chrome's new refusal is the ban's reason, said before where the tab is.
		const refusal = cdp.messages.find(message => message.id === retry) as { error?: { message: string } };
		expect(refusal.error?.message).toMatch(
			/^Chrome refused OMP's debugger on this tab: another extension .* has embedded its UI .*\(https:\/\/accounts\.example\.com\/signin\)$/,
		);
		expect(bridge.debuggerState(BROWSER, 1).revoked).toContain("has embedded its UI");
		// One try per claim.
		attachToTarget();
		await flush();
		expect(ext.rpcs("attach")).toHaveLength(attaches + 1);
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
	expect(bridge.managed(BROWSER).discover().map(tab => [tab.tabId, tab.active])).toEqual([
		[1, false],
		[2, true],
		[3, true],
	]);
	bridge.extMessage(extension, JSON.stringify({ t: "tabActivated", tabId: 99, windowId: 1 }));
	expect(bridge.managed(BROWSER).discover().map(tab => [tab.tabId, tab.active])).toEqual([
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
	const id = bridge.managed(BROWSER).discover()[0]!.id;
	const refreshing = bridge.refreshTabs(BROWSER);
	ack(bridge, extension, "queryTabs", {
		tabs: [tab({ tabId: 1, active: true }), tab({ tabId: 9, windowId: 2, active: true })],
	});
	await refreshing;
	expect(bridge.managed(BROWSER).discover().map(tab => [tab.tabId, tab.active])).toEqual([
		[1, true],
		[9, true],
	]);
	expect(bridge.managed(BROWSER).discover()[0]!.id).toBe(id);
	expect(extension.messages.map(message => (message.t === "rpc" ? message.op : message.t))).toEqual(["queryTabs"]);
});

it("answers only the observed dialog on an owned tab through its original debugger session", async () => {
	const bridge = new RelayBridge();
	const ext = new FakeExtSocket();
	connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
	const lease = bridge.managed(BROWSER).claim(
		bridge
			.managed(BROWSER)
			.discover()
			.find(row => row.tabId === 1)!.id,
		"owner",
	);
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
	// Looking at the owned tab attaches OMP's debugger to it.
	const looking = bridge.dialog(lease.id, "owner", {});
	await flush();
	ack(bridge, ext, "attach");
	expect((await looking).status).toBe("unobserved");
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

it("keeps a dialog decision channel across consecutive prompts and detaches after ownership ends", async () => {
	const bridge = new RelayBridge();
	const ext = new FakeExtSocket();
	connect(bridge, ext, [tab({ tabId: 1 })]);
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
	const lease = bridge.managed(BROWSER).claim(bridge.managed(BROWSER).discover()[0]!.id, "owner");
	const connection = bridge.cdpConnected(new FakeCdpSocket(), lease.id);
	try {
		const looking = bridge.dialog(lease.id, "owner", {});
		await flush();
		ack(bridge, ext, "attach");
		await looking;
		opening();
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
		expect(bridge.managed(BROWSER).discover()[0]!.ownership).toBe("available");
	} finally {
		bridge.cdpClosed(connection);
		bridge.extClosed(ext);
	}
});

/**
 * The built worker, driven directly: an explicit detach and a worker unload
 * must both reach `chrome.debugger.detach`, or Chrome's debugging infobar
 * outlives the task that caused it.
 */
it("gives Chrome its debugger back on explicit detach and on worker unload, in the built extension", async () => {
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
			downloads: { onCreated: event(), onChanged: event() },
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
	expect(await call(3, { op: "detach", tabId: 1 })).toMatchObject({ ok: true });
	expect(detached).toEqual([1]);
	// The remaining attachment is still tracked, so unloading releases it.
	suspend();
	await flush();
	expect(detached).toEqual([1, 2]);
});

/**
 * Build skew is the relay's to announce and the extension's to fix when a
 * reload can fix it. Chrome semantics the loop guard has to survive: a reload
 * boots the installed files afresh and clears session storage; local storage
 * persists; Chrome kills an unpacked extension after about 30 fast reloads.
 */
describe("built extension reload on build skew", () => {
	const committedWorker = Bun.file(
		new URL("../../src/tools/browser/relay/extension-assets/background.js.txt", import.meta.url),
	).text();
	const worker = async (build: string): Promise<string> =>
		(await committedWorker).replaceAll(EXPECTED_EXTENSION_BUILD_ID, build);
	const event = () => ({ addListener: () => {} });

	/**
	 * Boots `running`, then the installed files after every reload, against a
	 * relay that answers each handshake with `expectedBuildId`, until a worker
	 * says hello or Chrome would have terminated the extension.
	 */
	async function runChrome(options: {
		running: string;
		installed: { worker: string; buildId: string };
		expectedBuildId: string;
	}): Promise<{ reloads: number; hello?: string }> {
		const local: Record<string, unknown> = {};
		let reloads = 0;
		for (let boot = 0; boot <= 30; boot++) {
			const session: Record<string, unknown> = {};
			let reloaded = false;
			let hello: string | undefined;
			class ExtensionSocket {
				static OPEN = 1;
				static CONNECTING = 0;
				readyState = 1;
				onmessage?: (event: { data: string }) => void;
				onopen?: () => void;
				send(text: string): void {
					// The worker under test is the only sender; its messages are the protocol's.
					const message: { t: string; extensionBuildId?: string } = JSON.parse(text);
					if (message.t === "hello") hello = message.extensionBuildId;
					if (message.t === "authenticate")
						this.onmessage?.({ data: JSON.stringify({ t: "authenticated", expectedBuildId: options.expectedBuildId }) });
				}
				close(): void {}
				constructor() {
					queueMicrotask(() => this.onopen?.());
				}
			}
			const storageArea = (store: Record<string, unknown>) => ({
				get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...store }),
				set: async (values: Record<string, unknown>) => {
					Object.assign(store, values);
				},
				remove: async (key: string) => {
					delete store[key];
				},
			});
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
						url.endsWith("connection.json")
							? { port: 19443 }
							: url.endsWith("build-info.json")
								? { buildId: options.installed.buildId }
								: { service: "omp-browser", protocol: 2 },
					),
				chrome: {
					runtime: {
						getURL: (name: string) => `chrome-extension://fixture/${name}`,
						reload: () => {
							reloaded = true;
						},
						onInstalled: event(),
						onStartup: event(),
						onMessage: event(),
						onSuspend: event(),
					},
					storage: { local: storageArea(local), session: storageArea(session) },
					action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: event() },
					alarms: { create: () => {}, onAlarm: event() },
					debugger: { getTargets: async () => [], onEvent: event(), onDetach: event() },
					downloads: { onCreated: event(), onChanged: event() },
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
			runInContext(boot === 0 ? options.running : options.installed.worker, context);
			for (let tick = 0; tick < 200 && !reloaded && hello === undefined; tick++) await Promise.resolve();
			if (!reloaded) return { reloads, hello };
			reloads++;
		}
		return { reloads };
	}

	const foreign = "0".repeat(64);

	it("stays connected, without reloading, to a relay expecting a build the installed files are not", async () => {
		const installed = { worker: await worker(EXPECTED_EXTENSION_BUILD_ID), buildId: EXPECTED_EXTENSION_BUILD_ID };
		expect(await runChrome({ running: installed.worker, installed, expectedBuildId: foreign })).toEqual({
			reloads: 0,
			hello: EXPECTED_EXTENSION_BUILD_ID,
		});
	});

	it("reloads a stale worker once onto installed files that are the expected build", async () => {
		const installed = { worker: await worker(EXPECTED_EXTENSION_BUILD_ID), buildId: EXPECTED_EXTENSION_BUILD_ID };
		expect(
			await runChrome({ running: await worker(foreign), installed, expectedBuildId: EXPECTED_EXTENSION_BUILD_ID }),
		).toEqual({ reloads: 1, hello: EXPECTED_EXTENSION_BUILD_ID });
	});

	it("reloads at most once for an expected build even when the reload does not reach it", async () => {
		// Files that claim the expected build while the worker they load is another.
		const installed = { worker: await worker(foreign), buildId: EXPECTED_EXTENSION_BUILD_ID };
		expect(
			await runChrome({ running: installed.worker, installed, expectedBuildId: EXPECTED_EXTENSION_BUILD_ID }),
		).toEqual({ reloads: 1, hello: foreign });
	});
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

	/** A leased, attached tab with the badge and cursor overlay already installed. */
	async function leased(options: {
		active: boolean;
		log?: (message: string, data?: Record<string, unknown>) => void;
	}) {
		const bridge = new RelayBridge({ group: true, log: options.log });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1, active: options.active })]);
		const lease = bridge.managed(BROWSER).claim(discovered(bridge, 1), "owner");
		const cdp = new FakeCdpSocket();
		const connection = bridge.cdpConnected(cdp, lease.id);
		const attachId = ++msgSeq;
		bridge.cdpMessage(
			connection,
			JSON.stringify({
				id: attachId,
				method: "Target.attachToTarget",
				params: { targetId: `PAGE${CODE}.1`, flatten: true },
			}),
		);
		ack(bridge, ext, "attach");
		// The attach answers only after the install's four serialized round trips
		// (add + evaluate, twice): a first command may never outrun the per-document script.
		for (let round = 0; round < 4; round++) {
			await flush();
			expect(cdp.sessionFor(attachId)).toBeUndefined();
			ackSends(bridge, ext);
		}
		await flush();
		const sessionId = cdp.sessionFor(attachId);
		if (!sessionId) throw new Error("attachToTarget did not answer after the lease presentation install");
		return { bridge, cdp, connection, ext, lease, sessionId };
	}

	function mouse(
		bridge: RelayBridge,
		connection: number,
		sessionId: string,
		type: "mouseMoved" | "mousePressed" | "mouseReleased",
		x = 120,
		y = 48,
	): void {
		bridge.cdpMessage(
			connection,
			JSON.stringify({
				id: ++msgSeq,
				sessionId,
				method: "Input.dispatchMouseEvent",
				params: { type, x, y, button: "left" },
			}),
		);
	}

	it("installs the badge and cursor overlay on a leased tab, holds a click until the pointer arrives, and takes both back", async () => {
		const { bridge, connection, ext, lease, sessionId } = await leased({ active: true });
		const installs = ext.rpcs("send").filter(rpc => rpc.method === "Page.addScriptToEvaluateOnNewDocument");
		expect(installs).toHaveLength(2);
		expect(String(installs[1]?.params?.source)).toContain("data-omp-cursor");
		const before = ext.rpcs("send").length;
		mouse(bridge, connection, sessionId, "mousePressed");
		await flush();
		// The click is not in Chrome yet: only the move is, and it is awaited.
		expect(ext.rpcs("send").slice(before)).toMatchObject([
			{
				method: "Runtime.evaluate",
				params: {
					awaitPromise: true,
					expression: "window.__ompCursor?.move(120,48).then(() => window.__ompCursor?.press())",
				},
			},
		]);
		ackSends(bridge, ext);
		await flush();
		expect(ext.rpcs("send").slice(before + 1)).toMatchObject([
			{ method: "Input.dispatchMouseEvent", params: { type: "mousePressed" } },
		]);
		ackSends(bridge, ext);
		await flush();
		const afterPress = ext.rpcs("send").length;
		mouse(bridge, connection, sessionId, "mouseReleased");
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

	it("keeps a click's press ahead of the release puppeteer issued alongside it", async () => {
		const { bridge, connection, ext, sessionId } = await leased({ active: true });
		const before = ext.rpcs("send").length;
		// Puppeteer fires a click's three events together and awaits all of them.
		for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
			mouse(bridge, connection, sessionId, type);
		}
		for (let round = 0; round < 8; round++) {
			await flush();
			ackSends(bridge, ext);
		}
		await flush();
		expect(
			ext
				.rpcs("send")
				.slice(before)
				.map(
					rpc => `${rpc.method}:${rpc.params?.type ?? (rpc.params?.awaitPromise === true ? "awaited" : "loose")}`,
				),
		).toEqual([
			"Runtime.evaluate:loose",
			"Input.dispatchMouseEvent:mouseMoved",
			"Runtime.evaluate:awaited",
			"Input.dispatchMouseEvent:mousePressed",
			"Input.dispatchMouseEvent:mouseReleased",
		]);
	});

	it("paints hover motion without waiting for it", async () => {
		const { bridge, connection, ext, sessionId } = await leased({ active: true });
		const before = ext.rpcs("send").length;
		mouse(bridge, connection, sessionId, "mouseMoved", 200, 300);
		await flush();
		// Both out at once: the move is fired and forgotten, so the input never queued behind it.
		expect(ext.rpcs("send").slice(before)).toMatchObject([
			{ method: "Runtime.evaluate", params: { expression: "window.__ompCursor?.move(200,300)" } },
			{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved" } },
		]);
		expect(ext.rpcs("send").at(before)?.params?.awaitPromise).toBeUndefined();
	});

	it("neither paints nor waits on a tab that is not the visible one in its window", async () => {
		const { bridge, connection, ext, sessionId } = await leased({ active: false });
		const before = ext.rpcs("send").length;
		mouse(bridge, connection, sessionId, "mousePressed");
		mouse(bridge, connection, sessionId, "mouseMoved", 200, 300);
		for (let round = 0; round < 4; round++) {
			await flush();
			ackSends(bridge, ext);
		}
		await flush();
		expect(
			ext
				.rpcs("send")
				.slice(before)
				.map(rpc => rpc.method),
		).toEqual(["Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]);
	});

	it("forwards the click when the pointer fails or never arrives, and says so once per tab", async () => {
		const logged: string[] = [];
		const { bridge, connection, ext, sessionId } = await leased({
			active: true,
			log: message => logged.push(message),
		});
		const firstMove = ext.rpcs("send").length;
		mouse(bridge, connection, sessionId, "mousePressed");
		await flush();
		nack(bridge, ext, "send", "overlay is gone");
		await flush();
		expect(ext.rpcs("send").slice(firstMove + 1)).toMatchObject([{ method: "Input.dispatchMouseEvent" }]);
		expect(logged.filter(message => message === "cursor paint failed")).toHaveLength(1);
		ackSends(bridge, ext);
		await flush();
		// A move that resolves never, not with an error: the click has to leave on
		// the arrival deadline rather than sit out the whole RPC timeout.
		const stalledMove = ext.rpcs("send").length;
		jest.useFakeTimers();
		try {
			mouse(bridge, connection, sessionId, "mousePressed", 640, 480);
			await flush();
			expect(ext.rpcs("send").slice(stalledMove)).toHaveLength(1);
			jest.advanceTimersByTime(1_499);
			await flush();
			expect(ext.rpcs("send").slice(stalledMove)).toHaveLength(1);
			jest.advanceTimersByTime(2);
			await flush();
			expect(ext.rpcs("send").slice(stalledMove + 1)).toMatchObject([{ method: "Input.dispatchMouseEvent" }]);
		} finally {
			jest.useRealTimers();
		}
		// Still one line: a cosmetic path that keeps failing must not keep talking.
		expect(logged.filter(message => message === "cursor paint failed")).toHaveLength(1);
	});
});

/** Style properties the overlay writes; everything else it sets is ignored. */
interface StubStyle {
	cssText: string;
	transform: string;
	opacity: string;
	setProperty(key: string, value: string): void;
}

interface StubNode {
	style: StubStyle;
	children: StubNode[];
	isConnected: boolean;
	shadow: StubNode | undefined;
	alt: string;
	src: string;
	width: number;
	height: number;
	draggable: boolean;
	append(...kids: StubNode[]): void;
	setAttribute(key: string, value: string): void;
	attachShadow(): StubNode;
	remove(): void;
}

interface CursorApi {
	move(x: number, y: number): Promise<void>;
	press(): void;
	hide(): void;
	remove(): void;
}

describe("cursor overlay page script", () => {
	function stubNode(): StubNode {
		const style: StubStyle = { cssText: "", transform: "", opacity: "", setProperty: () => {} };
		const node: StubNode = {
			style,
			children: [],
			isConnected: true,
			shadow: undefined,
			alt: "",
			src: "",
			width: 0,
			height: 0,
			draggable: true,
			append: (...kids) => node.children.push(...kids),
			setAttribute: () => {},
			attachShadow: () => {
				node.shadow = stubNode();
				return node.shadow;
			},
			remove: () => {
				node.isConnected = false;
			},
		};
		return node;
	}

	/** Enough of a document for the overlay to mount into and be stepped frame by frame. */
	function installOverlay(): {
		api: CursorApi;
		hosts: StubNode[];
		style: () => StubStyle;
		conceal: () => void;
		drive: (settled: () => boolean) => Promise<number>;
	} {
		const hosts: StubNode[] = [];
		let clock = 0;
		let queued: ((ts: number) => void) | null = null;
		const root = stubNode();
		root.append = (...kids) => hosts.push(...kids);
		const document = {
			documentElement: root,
			visibilityState: "visible",
			createElement: () => stubNode(),
			addEventListener: () => {},
			removeEventListener: () => {},
			querySelectorAll: () => hosts,
		};
		const context = createContext({}) as Record<string, unknown>;
		Object.assign(context, {
			addEventListener: () => {},
			cancelAnimationFrame: () => {
				queued = null;
			},
			document,
			innerHeight: 800,
			innerWidth: 1280,
			performance: { now: () => clock },
			removeEventListener: () => {},
			requestAnimationFrame: (callback: (ts: number) => void) => {
				queued = callback;
				return 1;
			},
			self: context,
			top: context,
			visualViewport: { width: 1280, height: 800, addEventListener: () => {}, removeEventListener: () => {} },
			window: context,
		});
		runInContext(CURSOR_OVERLAY_INSTALL, context);
		const api = context.__ompCursor as CursorApi | undefined;
		if (!api) throw new Error("the overlay did not install");
		return {
			api,
			hosts,
			conceal: () => {
				document.visibilityState = "hidden";
			},
			// The host's shadow root holds the clipping layer, which holds the glyph box.
			style: () => hosts[0]!.shadow!.children[0]!.children[0]!.style,
			drive: async (settled: () => boolean) => {
				let frames = 0;
				while (frames < 900 && !settled()) {
					const callback = queued;
					if (!callback) break;
					queued = null;
					clock += 1000 / 60;
					callback(clock);
					await flush();
					frames++;
				}
				return frames;
			},
		};
	}

	it("travels to the point and only then resolves, leaving the glyph on it", async () => {
		const overlay = installOverlay();
		let arrived = false;
		void overlay.api.move(1100, 700).then(() => {
			arrived = true;
		});
		await flush();
		// Still in the air: nothing resolves until the glyph is on the target.
		expect(arrived).toBe(false);
		expect(overlay.style().transform).not.toStartWith("translate3d(1088px, 688px, 0)");
		const frames = await overlay.drive(() => arrived);
		expect(arrived).toBe(true);
		expect(frames).toBeGreaterThan(10);
		// The pivot is the centre of the 24px glyph box, so the box lands 12px up-left.
		expect(overlay.style().transform).toStartWith("translate3d(1088px, 688px, 0)");
		expect(overlay.style().opacity).toBe("1");
	});

	it("resolves without animating while the tab is hidden, and cleans itself off the page", async () => {
		const overlay = installOverlay();
		overlay.conceal();
		await overlay.api.move(400, 400);
		expect(overlay.style().transform).toStartWith("translate3d(388px, 388px, 0)");
		expect(overlay.style().opacity).toBe("0");
		overlay.api.remove();
		expect(overlay.hosts.every(host => !host.isConnected)).toBe(true);
	});
});

describe("RelayBridge target discovery", () => {
	it("enumerates the leased page without attaching to it or reaching other tabs", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 }), tab({ tabId: 3, url: "chrome://extensions/" })]);
		const cdp = new FakeCdpSocket();
		const connId = connectCdp(bridge, cdp, 1);
		bridge.cdpMessage(connId, JSON.stringify({ id: 1, method: "Target.getTargets" }));
		await flush();
		const result = cdp.messages.find(message => message.id === 1)?.result as
			| { targetInfos: Array<{ targetId: string; type: string }> }
			| undefined;
		expect(result?.targetInfos.map(info => [info.targetId, info.type])).toEqual([[`PAGE${CODE}.1`, "page"]]);
		expect(ext.messages.filter(message => message.t === "rpc")).toEqual([]);
	});
});

describe("RelayBridge multiple browser instances", () => {
	it("keeps equal tab numbers of two browsers apart in discovery, lease target ids and version", () => {
		const bridge = new RelayBridge();
		connect(bridge, new FakeExtSocket(), [tab({ tabId: 1, title: "Chrome tab" })], [], "chrome");
		connect(bridge, new FakeExtSocket(), [tab({ tabId: 1, title: "Edge tab" })], [], "edge");
		expect(bridge.managed("chrome").discover().map(found => found.title)).toEqual(["Chrome tab"]);
		expect(bridge.managed("edge").discover().map(found => found.title)).toEqual(["Edge tab"]);
		const chromeLease = bridge.managed("chrome").claim(discovered(bridge, 1, "chrome"), "owner");
		const edgeLease = bridge.managed("edge").claim(discovered(bridge, 1, "edge"), "owner");
		expect([chromeLease.targetId, edgeLease.targetId]).toEqual([
			`PAGE${instanceCode("chrome")}.1`,
			`PAGE${instanceCode("edge")}.1`,
		]);
		expect(bridge.instanceForLease(edgeLease.id)).toBe("edge");
		expect(bridge.versionInfo("edge", "ws://relay").Browser).toBe("Edg/151.0.0.0");
	});

	it("scopes the hello GC to the reconnecting instance", () => {
		const bridge = new RelayBridge();
		connect(bridge, new FakeExtSocket(), [tab({ tabId: 1, title: "Chrome tab" })], [], "chrome");
		const edge = new FakeExtSocket();
		connect(bridge, edge, [tab({ tabId: 1, title: "Edge tab" })], [], "edge");
		bridge.extClosed(edge);
		// Edge comes back without its tab: only Edge's registry loses it.
		connect(bridge, new FakeExtSocket(), [], [], "edge");
		expect(bridge.managed("chrome").discover().map(found => found.title)).toEqual(["Chrome tab"]);
		expect(bridge.managed("edge").discover()).toEqual([]);
	});

	it("retires only the reconnecting instance's socket and leases", () => {
		const bridge = new RelayBridge();
		const chrome = new FakeExtSocket();
		connect(bridge, chrome, [tab({ tabId: 1 })], [], "chrome");
		const edge = new FakeExtSocket();
		connect(bridge, edge, [tab({ tabId: 1 })], [], "edge");
		const chromeLease = bridge.managed("chrome").claim(discovered(bridge, 1, "chrome"), "owner");
		const edgeLease = bridge.managed("edge").claim(discovered(bridge, 1, "edge"), "owner");
		// Service-worker restart: a new socket hellos for the same instance.
		connect(bridge, new FakeExtSocket(), [tab({ tabId: 1 })], [], "chrome");
		expect(chrome.closed).toBe(true);
		expect(edge.closed).toBe(false);
		expect(bridge.instanceForLease(chromeLease.id)).toBeUndefined();
		expect(bridge.instanceForLease(edgeLease.id)).toBe("edge");
		// One registry entry per physical tab, not one per socket.
		expect(bridge.managed("chrome").discover()).toHaveLength(1);
	});

	it("routes each browser's RPCs to its own socket and ignores results another browser sends", async () => {
		const bridge = new RelayBridge();
		const chrome = new FakeExtSocket();
		connect(bridge, chrome, [tab({ tabId: 1 })], [], "chrome");
		const edge = new FakeExtSocket();
		connect(bridge, edge, [tab({ tabId: 1 })], [], "edge");
		const chromeCdp = new FakeCdpSocket();
		const chromeConn = connectCdp(bridge, chromeCdp, 1, "owner", "chrome");
		const edgeCdp = new FakeCdpSocket();
		const edgeConn = connectCdp(bridge, edgeCdp, 1, "owner", "edge");
		const chromeSession = await attachPage(bridge, chrome, chromeCdp, chromeConn, 1, "chrome");
		await attachPage(bridge, edge, edgeCdp, edgeConn, 1, "edge");
		const commandId = ++msgSeq;
		bridge.cdpMessage(chromeConn, JSON.stringify({ id: commandId, sessionId: chromeSession, method: "Page.reload" }));
		await flush();
		const [sent] = chrome.pending("send");
		expect(sent).toMatchObject({ tabId: 1, method: "Page.reload" });
		expect(edge.rpcs("send")).toEqual([]);
		bridge.extMessage(edge, JSON.stringify({ t: "rpcResult", id: sent!.id, ok: true, result: { from: "edge" } }));
		await flush();
		expect(chromeCdp.messages.find(message => message.id === commandId)).toBeUndefined();
		ack(bridge, chrome, "send", { from: "chrome" });
		await flush();
		expect(chromeCdp.messages.find(message => message.id === commandId)).toMatchObject({ result: { from: "chrome" } });
	});

	it("hides an offline browser until it reconnects and leaves the other browser drivable", () => {
		const bridge = new RelayBridge();
		connect(bridge, new FakeExtSocket(), [tab({ tabId: 1, title: "Chrome tab" })], [], "chrome");
		const edge = new FakeExtSocket();
		connect(bridge, edge, [tab({ tabId: 1, title: "Edge tab" })], [], "edge");
		bridge.extClosed(edge);
		expect(bridge.connected("edge")).toBe(false);
		expect(bridge.managed("edge").discover()).toEqual([]);
		expect(bridge.connected("chrome")).toBe(true);
		expect(bridge.managed("chrome").discover().map(found => found.title)).toEqual(["Chrome tab"]);
		connect(bridge, new FakeExtSocket(), [tab({ tabId: 1, title: "Edge tab" })], [], "edge");
		expect(bridge.managed("edge").discover().map(found => found.title)).toEqual(["Edge tab"]);
	});
});
