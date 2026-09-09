/**
 * OMP Browser Relay — MV3 service worker.
 *
 * Dumb pipe by design: all CDP orchestration lives in the relay server. This
 * worker (1) keeps a websocket to the relay, (2) executes its RPCs against
 * `chrome.debugger`/`chrome.tabs`, and (3) streams tab + debugger events back.
 *
 * Service-worker lifetime: the open websocket plus a periodic ping keeps the
 * worker alive while connected (Chrome 116+); a chrome.alarms tick revives it
 * and re-dials after Chrome reaps it while disconnected.
 */
import type { ExtToRelayMessage, RelayToExtMessage, TabSnapshot } from "../../coding-agent/src/tools/browser/relay/protocol";
import { DebuggerAttachments, ownedDebuggerTabs } from "./debugger-ownership";
import { groupTab, releaseOwnerGroups } from "./tab-groups";
import { LEASE_BADGE_RESTORE } from "../../coding-agent/src/tools/browser/relay/lease-badge";

// The distribution build embeds this into the worker, so a reconnect reports
// executing code rather than whichever files happen to be on disk now.
declare const __OMP_EXTENSION_BUILD_ID__: string;

const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
/** Reconnect window a dropped relay socket gets before its attachments are released. */
const DETACH_GRACE_MS = 2_000;

let ws: WebSocket | null = null;
let connecting = false;
let relayReady = false;
let pendingEvents: ExtToRelayMessage[] = [];
let reconnectDelay = RECONNECT_MIN_MS;
let pingTimer: NodeJS.Timeout | null = null;
/**
 * Chrome holds a `chrome.debugger` attachment (and shows its debugging
 * infobar) until this extension detaches or unloads, so every end of relay
 * authority has to give the attachments back explicitly.
 */
const attachments = new DebuggerAttachments({
	detach: tabId => chrome.debugger.detach({ tabId }),
	graceMs: DETACH_GRACE_MS,
	surrender: async held => {
		// Relay authority is gone for good: nothing else will ever release
		// these leases, so hand the tabs back here. The favicon first — only
		// this still-live attachment can reach the page — then the groups.
		for (const tabId of held) {
			await chrome.debugger
				.sendCommand({ tabId }, "Runtime.evaluate", { expression: LEASE_BADGE_RESTORE })
				.catch(() => undefined);
		}
		await releaseOwnerGroups();
	},
});

interface RelaySettings {
	port: number;
	browserId: string;
	browserLabel: string;
	credential: string;
	pairingCode: string;
}

async function loadSettings(): Promise<RelaySettings> {
	// Install-time defaults are data, so custom installs never need to rewrite
	// bundled code. Saved pairing settings survive an extension update.
	const response = await fetch(chrome.runtime.getURL("connection.json"));
	const defaults: unknown = await response.json();
	const defaultPort = defaults && typeof defaults === "object" && "port" in defaults ? defaults.port : undefined;
	if (!response.ok || typeof defaultPort !== "number" || !Number.isInteger(defaultPort) || defaultPort < 1 || defaultPort > 65535)
		throw new Error("Invalid extension connection configuration; reinstall the extension.");
	const stored = await chrome.storage.local.get({ port: defaultPort, browserId: "", browserLabel: "", credential: "", pairingCode: "" });
	const port = Number(stored.port);
	const browserId = typeof stored.browserId === "string" && stored.browserId ? stored.browserId : crypto.randomUUID();
	if (browserId !== stored.browserId) await chrome.storage.local.set({ browserId });
	return {
		port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : defaultPort,
		browserId,
		browserLabel: typeof stored.browserLabel === "string" ? stored.browserLabel : "",
		credential: typeof stored.credential === "string" ? stored.credential : "",
		pairingCode: typeof stored.pairingCode === "string" ? stored.pairingCode : "",
	};
}

function snapshot(tab: ChromeTab): TabSnapshot | null {
	if (tab.id === undefined) return null;
	return {
		tabId: tab.id,
		url: tab.url || tab.pendingUrl || "",
		title: tab.title ?? "",
		active: tab.active,
		windowId: tab.windowId,
		pinned: tab.pinned,
		groupId: tab.groupId,
	};
}

/**
 * Serialize group mutations. Chrome's query→group→set-title sequence is not
 * atomic: two concurrent runs both miss the not-yet-titled group and mint
 * duplicate "omp" groups in the same window.
 */
let groupOps: Promise<unknown> = Promise.resolve();
function enqueueGroupOp<T>(fn: () => Promise<T>): Promise<T> {
	const result = groupOps.then(fn, fn);
	groupOps = result.catch(() => {});
	return result;
}


function post(msg: ExtToRelayMessage): void {
	if (ws?.readyState !== WebSocket.OPEN) return;
	if (!relayReady) {
		if (pendingEvents.length >= 20000) { ws.close(); return; }
		pendingEvents.push(msg);
		return;
	}
	ws.send(JSON.stringify(msg));
}

async function setBadge(connected: boolean): Promise<void> {
	try {
		await chrome.action.setBadgeText({ text: connected ? "on" : "off" });
		await chrome.action.setBadgeBackgroundColor({ color: connected ? "#1a7f37" : "#8b8b8b" });
	} catch {
		// Badge is cosmetic; never let it break the relay loop.
	}
}

async function buildHello(): Promise<ExtToRelayMessage> {
	const [tabs, targets] = await Promise.all([chrome.tabs.query({}), chrome.debugger.getTargets()]);
	const snapshots: TabSnapshot[] = [];
	for (const tab of tabs) {
		const snap = snapshot(tab);
		if (snap) snapshots.push(snap);
	}
	const attachedTabIds = await ownedDebuggerTabs(targets, tabId =>
		chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo"),
	);
	// A worker restart loses the tracking set while Chrome keeps the
	// attachments; the probe is the only authority on what we still hold.
	for (const tabId of attachedTabIds) attachments.attached(tabId);
	const versionMatch = /Chrome\/[\d.]+/.exec(navigator.userAgent);
	return {
		t: "hello",
		userAgent: navigator.userAgent,
		browserVersion: versionMatch?.[0] ?? "Chrome/unknown",
		extensionBuildId: typeof __OMP_EXTENSION_BUILD_ID__ === "string" ? __OMP_EXTENSION_BUILD_ID__ : undefined,
		tabs: snapshots,
		attachedTabIds,
	};
}

async function runRpc(msg: Extract<RelayToExtMessage, { t: "rpc" }>): Promise<unknown> {
	switch (msg.op) {
		case "queryTabs":
			return { tabs: (await chrome.tabs.query({})).map(snapshot).filter(tab => tab !== null) };
		case "attach":
			await chrome.debugger.attach({ tabId: msg.tabId }, "1.3");
			attachments.attached(msg.tabId);
			return {};
		case "detach":
			attachments.detached(msg.tabId);
			await chrome.debugger.detach({ tabId: msg.tabId });
			// Chrome's explicit detach does not emit onDetach. Acknowledge it
			// before the RPC result so the relay can safely serialize reattachment.
			post({ t: "detached", tabId: msg.tabId, reason: "target_closed", relayInitiated: true });
			return {};
		case "detachAll":
			// The host ended a task or turn. Give the tabs back so Chrome takes
			// its debugging infobar down; the relay reattaches lazily on next use.
			return { detached: await attachments.detachAll(msg.tabIds) };
		case "send":
			return await chrome.debugger.sendCommand(
				msg.sessionId ? { tabId: msg.tabId, sessionId: msg.sessionId } : { tabId: msg.tabId },
				msg.method,
				msg.params,
			);
		case "createTab": {
			const tab = await chrome.tabs.create({ url: msg.url, active: false });
			const snap = snapshot(tab);
			if (!snap) throw new Error("created tab has no id");
			return { tab: snap };
		}
		case "activateTab": {
			// Selecting a tab is not the same as raising its window: an adopted
			// popup only needs the user's own tab selected again.
			if (msg.focusWindow) {
				const tab = await chrome.tabs.get(msg.tabId);
				await chrome.windows.update(tab.windowId, { focused: true });
			}
			await chrome.tabs.update(msg.tabId, { active: true });
			return {};
		}
		case "group":
			return await enqueueGroupOp(() => groupTab(msg.tabId, msg.owner, msg.label));
		case "releaseTab":
			// Leaving the group BEFORE the tab closes is what keeps Chrome from
			// saving the emptied group as a chip in the bookmarks bar.
			return await enqueueGroupOp(async () => {
				await chrome.tabs.ungroup([msg.tabId]).catch(() => {});
				if (msg.close) await chrome.tabs.remove(msg.tabId);
				return {};
			});
	}
}

async function handleRelayMessage(socket: WebSocket, raw: string): Promise<void> {
	let msg: RelayToExtMessage;
	try {
		msg = JSON.parse(raw) as RelayToExtMessage;
	} catch {
		return;
	}
	if (msg.t === "pong") return;
	if (msg.t === "authenticationError") {
		await chrome.storage.local.set({ connectionError: msg.error });
		socket.close();
		return;
	}
	if (msg.t === "authenticated") {
		if (msg.credential) await chrome.storage.local.set({ credential: msg.credential, pairingCode: "", connectionError: "" });
		const hello = await buildHello();
		if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
		socket.send(JSON.stringify(hello));
		relayReady = true;
		// Authority restored: whatever the previous socket's close armed stays ours.
		attachments.hold();
		for (const event of pendingEvents) socket.send(JSON.stringify(event));
		pendingEvents = [];
		await chrome.storage.local.set({ connectionError: "" });
		await setBadge(true);
		return;
	}
	const reply = (response: ExtToRelayMessage): void => {
		if (ws === socket && socket.readyState === WebSocket.OPEN && relayReady) socket.send(JSON.stringify(response));
	};
	void runRpc(msg)
		.then(result => reply({ t: "rpcResult", id: msg.id, ok: true, result }))
		.catch((err: unknown) => {
			reply({ t: "rpcResult", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
		});
}

function scheduleReconnect(): void {
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	setTimeout(() => void connect(), delay);
}

async function connect(): Promise<void> {
	if (connecting || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
	connecting = true;
	try {
		const settings = await loadSettings();
		// Older brokers replace their singleton on socket-open. Check compatibility
		// before dialing /ext so an upgrade cannot evict another task's connection.
		const healthResponse = await fetch(`http://127.0.0.1:${settings.port}/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
		const health = healthResponse.ok ? await healthResponse.json() as {service?: string; protocol?: number} : undefined;
		if (health?.service !== "omp-browser" || health.protocol !== 2)
			throw new Error("This endpoint uses an older browser service. Use another port or update it after active tasks finish.");
		const url = `ws://127.0.0.1:${settings.port}/ext`;
		const socket = new WebSocket(url);
		ws = socket;
		relayReady = false;
		pendingEvents = [];
		socket.onopen = () => {
			reconnectDelay = RECONNECT_MIN_MS;
			socket.send(JSON.stringify({ t: "authenticate", auth: { id: settings.browserId, label: settings.browserLabel, credential: settings.credential || undefined, pairingCode: settings.pairingCode || undefined } }));
			clearInterval(pingTimer ?? undefined);
			pingTimer = setInterval(() => post({ t: "ping" }), PING_INTERVAL_MS);
		};
		socket.onmessage = event => {
			if (typeof event.data === "string" && ws === socket) void handleRelayMessage(socket, event.data);
		};
		socket.onclose = () => {
			if (ws !== socket) return;
			ws = null;
			relayReady = false;
			pendingEvents = [];
			if (pingTimer !== null) {
				clearInterval(pingTimer);
				pingTimer = null;
			}
			void setBadge(false);
			// The relay is gone. A reconnect within the grace keeps the debugger
			// attachments (and the tabs' state); otherwise they go back to Chrome so
			// its debugging infobar disappears instead of outliving the task.
			void attachments.scheduleRelease();
			scheduleReconnect();
		};
		socket.onerror = () => {
			socket.close();
		};
	} catch (error) {
		await chrome.storage.local.set({ connectionError: error instanceof Error ? error.message : String(error) });
		void setBadge(false);
		void attachments.scheduleRelease();
		scheduleReconnect();
	} finally {
		connecting = false;
	}
}

// ---- event streaming ---------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
	if (source.tabId === undefined) return;
	post({ t: "cdpEvent", tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
	if (source.tabId === undefined) return;
	attachments.detached(source.tabId);
	// Native onDetach always represents user/browser termination, even while
	// an explicit detach RPC is pending.
	post({ t: "detached", tabId: source.tabId, reason });
});

chrome.tabs.onActivated.addListener(info => {
	post({ t: "tabActivated", tabId: info.tabId, windowId: info.windowId });
});

chrome.tabs.onCreated.addListener(tab => {
	const snap = snapshot(tab);
	if (!snap) return;
	// A tab the browser opened from another tab. The relay decides whether the
	// opener is one of its own; page script never gets to claim anything.
	if (tab.openerTabId !== undefined) post({ t: "tabOpened", tab: snap, openerTabId: tab.openerTabId });
	else post({ t: "tabCreated", tab: snap });
});

chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabUpdated", tab: snap });
});

chrome.tabs.onRemoved.addListener(tabId => {
	attachments.detached(tabId);
	post({ t: "tabRemoved", tabId });
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
	post({ t: "tabRemoved", tabId: removedTabId });
	void chrome.tabs.get(addedTabId).then(tab => {
		const snap = snapshot(tab);
		if (snap) post({ t: "tabCreated", tab: snap });
	}).catch(() => undefined);
});

// ---- lifecycle ----------------------------------------------------------------

chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });

chrome.alarms.create("omp-relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
	if (alarm.name === "omp-relay-keepalive") void connect();
});

chrome.runtime.onMessage.addListener(message => {
	if (!message || typeof message !== "object" || !("type" in message) || message.type !== "reconnect") return;
	if (ws) { const previous = ws; ws = null; previous.close(); }
	clearInterval(pingTimer ?? undefined);
	void setBadge(false);
	void connect();
});

chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
// Chrome keeps this extension's debugger attachments after it reaps the
// worker, infobar included. Unloading is the last chance to hand them back.
chrome.runtime.onSuspend.addListener(() => attachments.releaseNow());

void connect();
