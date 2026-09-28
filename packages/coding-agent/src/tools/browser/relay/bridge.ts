/**
 * CDP façade over `chrome.debugger`.
 *
 * Puppeteer clients (the omp browser tool: one supervisor connection plus one
 * per tab worker) connect to this bridge as if it were Chrome's browser
 * debugging endpoint. Chrome only allows a single debugger attachment per tab,
 * so the bridge owns ONE `chrome.debugger` attachment per tab (via the
 * extension) and multiplexes every downstream connection over it with minted
 * per-connection session ids.
 *
 * Emulated surface (everything else is forwarded to `chrome.debugger`):
 * - the browser target (`/json/version` handshake, `Browser.getVersion`)
 * - the `Target.*` domain, including puppeteer's tab → page auto-attach
 *   hierarchy (see puppeteer-core `cdp/ExtensionTransport.ts`, the reference
 *   implementation for this emulation)
 *
 * Several browsers (paired extension instances) share one bridge. Each tab is
 * keyed by `<instance code>:<chrome tabId>`, and target ids carry the same
 * namespace (`TAB<code>.<tabId>` / `PAGE<code>.<tabId>`), so equal Chrome tab
 * numbers in two browsers never collide.
 *
 * Session id namespaces seen by a downstream connection:
 * - minted tab pseudo-sessions (`ST<tab>.<conn>.<n>`) — Target emulation only
 * - minted page pseudo-sessions (`SP<tab>.<conn>.<n>`) — forwarded to the
 *   tab's root debugger session
 * - real child session ids (OOPIFs, workers) — created by Chrome under the
 *   shared root session and passed through verbatim
 */
import { createHash } from "node:crypto";
import { DialogJournal, type DialogJournalState, parseDialogRequest } from "../dialog-journal";
import { DownloadAttribution } from "./downloads";
import {
	type ExtToRelayMessage,
	isTabSnapshot,
	mergeTabSnapshot,
	type RelayRpcRequest,
	type RelayToExtMessage,
	type TabSnapshot,
} from "./protocol";
import { type ChromeTabGoneError, ManagedChromeTabs, shortUrl, unknownChromeTab } from "./managed-tabs";
import { AUTOFILL_OPT_OUT_INSTALL, AUTOFILL_OPT_OUT_REMOVE } from "./autofill-opt-out";
import { CURSOR_OVERLAY_INSTALL, CURSOR_OVERLAY_REMOVE, LEASE_BADGE_INSTALL, LEASE_BADGE_RESTORE } from "./lease-badge";

/** Transport-agnostic websocket surface the bridge writes to. */
export interface RelaySocket {
	send(text: string): void;
	close(): void;
}

interface CdpCommand {
	id: number;
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

/**
 * Per-pseudo-session Runtime domain state.
 * - `default`: never toggled Runtime — still receives the relay's legacy
 *   root-event fan-out, so omp's own patched-puppeteer client (which
 *   pull-acquires contexts and never sends `Runtime.enable`) keeps getting
 *   `Runtime.executionContextCreated`.
 * - `enabled`: ran `Runtime.enable`; gets the existing-context replay.
 * - `disabled`: explicitly ran `Runtime.disable`; silenced until it re-enables.
 */
type RuntimeState = "default" | "enabled" | "disabled";

interface SessionRef {
	kind: "tab" | "page";
	/** Registry key of the owning tab (`<instance code>:<chrome tabId>`). */
	tabKey: string;
	tabId: number;
	runtimeState: RuntimeState;
	/** Context ids already announced to this pseudo-session. */
	readonly runtimeContexts: Set<number>;
	/** In-flight `Runtime.enable` for this session; duplicates await it. */
	runtimeEnabling: Promise<void> | null;
	/** Monotonic ownership token for enable rollback and replay. */
	runtimeEpoch: number;
	/**
	 * This session armed `Target.setAutoAttach`. Chrome reports a real child
	 * target (OOPIF, worker) only on the session that asked; fanning it to
	 * every page session would announce one child id twice and puppeteer
	 * silently replaces the first session object, losing its replies.
	 */
	autoAttach: boolean;
}

interface TargetInfo {
	targetId: string;
	type: "tab" | "page" | "browser";
	title: string;
	url: string;
	attached: boolean;
	canAccessOpener: boolean;
}

class CdpConnection {
	discover = false;
	autoAttach = false;
	/** Minted pseudo-sessions owned by this connection. */
	readonly sessions = new Map<string, SessionRef>();
	/** Real child sessions (OOPIF, worker) this connection has been told about: each is announced once. */
	readonly announced = new Set<string>();

	constructor(
		readonly id: number,
		readonly socket: RelaySocket,
		readonly leaseId: string,
		/** Browser instance that owns the lease; the only one this connection can see. */
		readonly instanceId: string,
		readonly leasedTab?: TabState,
	) {}

	sessionsForTab(tabKey: string, kind?: "tab" | "page"): string[] {
		const out: string[] = [];
		for (const [sessionId, ref] of this.sessions) {
			if (ref.tabKey === tabKey && (!kind || ref.kind === kind)) out.push(sessionId);
		}
		return out;
	}

	/** Page sessions that armed `Target.setAutoAttach`: the only ones Chrome would report children on. */
	autoAttachSessionsForTab(tabKey: string): string[] {
		const out: string[] = [];
		for (const [sessionId, ref] of this.sessions) {
			if (ref.tabKey === tabKey && ref.kind === "page" && ref.autoAttach) out.push(sessionId);
		}
		return out;
	}
}

/** Transport replacement is retryable and must not permanently ban a tab. */
class ExtensionReplacedError extends Error {}

/** A paired browser instance; one per browser/profile, kept across reconnects. */
interface ExtInstance {
	instanceId: string;
	/** Stable short code derived from the instance id; names target ids (`TAB<code>.<tabId>`). */
	code: string;
	socket: RelaySocket | null;
	/** Set by the hello on the current socket; null while disconnected. */
	info: { userAgent: string; browserVersion: string } | null;
	/** Task-owned leases over this browser's tabs. */
	readonly managed: ManagedChromeTabs;
	/** Pairs this browser's `chrome.downloads` items with the leased tabs that started them. */
	readonly downloads: DownloadAttribution;
}

/** Deterministic per-instance code for target ids: stable across relay restarts. */
function instanceCode(instanceId: string): string {
	return createHash("sha256").update(instanceId).digest("base64url").slice(0, 8);
}

function tabKeyOf(extCode: string, tabId: number): string {
	return `${extCode}:${tabId}`;
}

function tabTargetIdFromKey(key: string): string {
	return `TAB${key.replace(":", ".")}`;
}

function pageTargetIdFromKey(key: string): string {
	return `PAGE${key.replace(":", ".")}`;
}

function parseTargetId(targetId: string): { key: string; kind: "tab" | "page" } | null {
	const match = /^(TAB|PAGE)([^.]+)\.(\d+)$/.exec(targetId);
	if (!match) return null;
	const kind: "tab" | "page" = match[1] === "TAB" ? "tab" : "page";
	return { key: `${match[2]}:${match[3]}`, kind };
}

/** Debugger attachment of one tab as the lease's owner sees it. */
export interface DebuggerState {
	attached: boolean;
	/** Present while Chrome will not let OMP drive the tab even though it is open. */
	revoked?: string;
	/**
	 * The user pressed Cancel on Chrome's debugging infobar. Unlike every other
	 * revocation this is a decision, not an obstacle: the work stops there
	 * instead of being retried or handed to the user to finish.
	 */
	canceledByUser?: boolean;
}

/**
 * Chrome ends an extension's debugger session with `target_closed` for more
 * than a closed tab: it also force-detaches when a frame the extension may
 * not debug commits in the page — most often another extension's
 * `chrome-extension://` UI, which is what password managers inject into
 * sign-in forms. The tab stays open; only OMP's control ends.
 */
function describeDetach(reason: string): string {
	if (reason === "canceled_by_user") return "the user cancelled debugging from Chrome's infobar";
	return (
		"Chrome dropped OMP's debugger with the tab still open, usually because another " +
		"extension (a password manager, for example) put its own frame in the page"
	);
}

function describeAttachFailure(message: string): string {
	if (/chrome-extension:\/\/ URL of different extension/i.test(message))
		return (
			"another extension (a password manager, for example) has embedded its UI in this page, and Chrome " +
			"does not let OMP debug a page containing another extension's frame"
		);
	return message;
}

class TabState {
	readonly dialogs = new DialogJournal();
	/** Registry key: `<instance code>:<chrome tabId>`. */
	readonly tabKey: string;
	url: string;
	title: string;
	active: boolean;
	windowId: number;
	pinned: boolean;
	/** Chrome tab group id from the last snapshot; -1 when ungrouped. */
	groupId: number;
	/** Whether `chrome.debugger` is currently attached to this tab. */
	attached = false;
	/** Set when Chrome refused or revoked the debugger; cleared on navigation and by an explicit claim. */
	banned = false;
	/** Why the debugger cannot be (re)attached while `banned`, in the model's terms. */
	banReason: string | undefined;
	/** The ban is the user cancelling OMP's debugger from Chrome's infobar; set only while `banned`. */
	canceledByUser = false;
	/** Whether targets for this tab were announced to discovering connections. */
	announced = false;
	attaching: Promise<boolean> | null = null;
	/** Relay-initiated detach in flight; reattach serializes behind it. */
	detaching: Promise<void> | null = null;
	/** Badge script installed for the lease, removed when the lease ends. */
	badgeScriptId: string | undefined;
	/** Cursor-overlay script installed alongside the badge; drives the in-page arrow. */
	cursorScriptId: string | undefined;
	/** A cursor paint already failed on this tab; the next ones stay silent. */
	cursorPaintFailed = false;
	/** The current attachment put the autofill opt-out on the page; a relay detach takes it back off. */
	autofillOptedOut = false;
	/** Tail of this tab's forwarded mouse events; keeps them in the order the driver sent them. */
	mouseTail: Promise<void> = Promise.resolve();
	/** A successful attach completed after the most recently requested relay detach. */
	reattachedAfterDetach = false;
	/** Root CDP commands in flight; a puppeteer wait blocks inside one, so an idle detach must not fire. */
	inflight = 0;
	/** Armed while attached: hands the debugger back after {@link DEBUGGER_IDLE_MS} of CDP silence. */
	idleTimer: NodeJS.Timeout | undefined;
	/** Last `Page.windowOpen` this tab reported, for opener attribution Chrome gets wrong. */
	windowOpenedAt = 0;
	/**
	 * Last root-session `Target.setAutoAttach` params, replayed after a
	 * reattach: Chrome drops the tab's child sessions on detach and only
	 * rediscovers OOPIFs/workers once auto-attach is armed again.
	 */
	rootAutoAttach: Record<string, unknown> | undefined;
	/**
	 * Root-session state the drivers asked for: domain enables (`"Page.enable"` →
	 * its params) minus any later `disable`, plus init-time `*.set*Enabled`
	 * switches (`Page.setLifecycleEventsEnabled`) keyed by method, in the order
	 * they arrived. Chrome resets every domain on the client it detaches and
	 * puppeteer never sends them again, so a reattach has to put these back or
	 * dialog/download/lifecycle events stop silently.
	 */
	readonly rootEnabled = new Map<string, Record<string, unknown> | undefined>();
	/**
	 * Real Chrome child sessions (OOPIF/worker) under this tab's attachment,
	 * keyed by session id: the session that reported each (none = the root),
	 * and its `Target.attachedToTarget` params with the latest target info.
	 * Chrome reports a child once, to the first auto-attach armed over it; a
	 * second driver arming later gets it from here. `releasing` marks a child
	 * its last holder asked Chrome to detach: it is never replayed again.
	 */
	readonly realSessions = new Map<
		string,
		{ parent: string | undefined; targetId: unknown; event: Record<string, unknown>; releasing?: boolean }
	>();
	/**
	 * Bumped whenever the recorded children are dropped: an auto-attach arm
	 * issued before that replays nothing, since the children it would name
	 * belong to a later report its connection hears of live.
	 */
	childEpoch = 0;
	/** Live execution contexts from the shared root debugger session. */
	readonly runtimeContexts = new Map<number, Record<string, unknown>>();
	/** Whether the shared root Runtime domain has been enabled by the bridge. */
	rootRuntimeEnabled = false;
	rootRuntimeEnabling: Promise<void> | null = null;
	/** Invalidates an in-flight Runtime enable when the debugger detaches. */
	runtimeGeneration = 0;

	constructor(
		readonly instanceId: string,
		extCode: string,
		readonly tabId: number,
		snap: TabSnapshot,
	) {
		this.tabKey = tabKeyOf(extCode, tabId);
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
		this.windowId = snap.windowId;
		this.pinned = snap.pinned;
		this.groupId = snap.groupId;
	}

	update(snap: TabSnapshot): void {
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
		this.windowId = snap.windowId;
		this.pinned = snap.pinned;
		this.groupId = snap.groupId;
	}
}

/** URLs `chrome.debugger` cannot attach to; hidden from downstream discovery entirely. */
const INELIGIBLE_URL = /^(chrome|devtools|edge|view-source|chrome-extension|chrome-untrusted|chrome-search):/i;
/** Completes "Chrome tab X …" for a page on one of those URLs. */
const UNDEBUGGABLE = "is on a page Chrome lets no extension debug";

const RPC_TIMEOUT_MS = 20_000;
const CDP_ERROR_METHOD_NOT_FOUND = -32601;
const CDP_ERROR_SERVER = -32000;
/**
 * How long an attached tab may sit without CDP traffic before its
 * `chrome.debugger` attachment — and with it Chrome's "being debugged" infobar
 * — goes back. The bar then tracks the work (last step + ~10 s), not the turn.
 *
 * Detaching does not widen what a password manager can take: Chrome refuses
 * an extension's debugger on any page holding another extension's frame, so
 * the frame that fails a reattach ({@link RelayBridge.#ensureAttached}) would
 * have force-detached a kept attachment the moment it appeared
 * ({@link RelayBridge.#onTabDetached}). Kept attached, every transient frame
 * bans the tab; detached, only one the extension cannot empty at the next
 * attach does. The idle detach also lifts the autofill opt-out, so a user
 * who takes the tab over gets their password manager back.
 */
const DEBUGGER_IDLE_MS = 10_000;
/** How stale a `Page.windowOpen` may be and still explain a new tab. */
const WINDOW_OPEN_MATCH_MS = 3_000;
/**
 * How long a click waits for the in-page cursor to reach it before going
 * anyway — Codex's own arrival timeout (`Vf` in their service worker). The
 * wait is what makes the pointer readable: without it the click lands while
 * the glyph is still in the air.
 */
const CURSOR_ARRIVAL_TIMEOUT_MS = 1_500;

/**
 * Multiplexing CDP bridge between downstream puppeteer connections and the
 * relay extensions of every paired browser. All state lives here so an
 * extension service-worker restart only has to re-handshake.
 */
export class RelayBridge {
	/** Tab registries keyed by `<instance code>:<chrome tabId>`; one namespace per browser instance. */
	#tabs = new Map<string, TabState>();
	#conns = new Map<number, CdpConnection>();
	#connSeq = 0;
	#sessionSeq = 0;
	#rpcSeq = 0;
	/** Browser instances that ever connected, keyed by stable instance id. */
	#instances = new Map<string, ExtInstance>();
	#socketInstance = new Map<RelaySocket, string>();
	#pendingRpc = new Map<
		number,
		{
			instanceId: string;
			resolve: (value: unknown) => void;
			reject: (err: Error) => void;
			timer: NodeJS.Timeout;
		}
	>();
	/** Real child session id → owning tab key, learned from `Target.attachedToTarget` events. */
	#realSessionTabs = new Map<string, string>();
	#log: (message: string, data?: Record<string, unknown>) => void;
	/** Mark the tabs OMP drives (owner tab group + favicon glyph); off leaves the strip untouched. */
	#markTabs: boolean;
	/** Idle window after which an attached tab's debugger goes back; 0 keeps it for the whole lease. */
	#idleMs: number;
	/** Keep password managers' inline menus out of leased tabs while attached (the relay server always does). */
	#autofillOptOut: boolean;

	constructor(
		opts: {
			log?: (message: string, data?: Record<string, unknown>) => void;
			/** Mark tabs the agent drives: one Chrome tab group per owner, plus a favicon glyph. */
			group?: boolean;
			/** Hand a tab's debugger back after this long without CDP traffic; 0 keeps it for the lease. */
			debuggerIdleMs?: number;
			/** Put the vendors' autofill opt-outs on leased tabs while the debugger is attached. */
			autofillOptOut?: boolean;
		} = {},
	) {
		this.#log = opts.log ?? (() => {});
		this.#markTabs = opts.group ?? false;
		this.#idleMs = opts.debuggerIdleMs ?? DEBUGGER_IDLE_MS;
		this.#autofillOptOut = opts.autofillOptOut ?? false;
	}

	#createInstance(instanceId: string): ExtInstance {
		const code = instanceCode(instanceId);
		const inst: ExtInstance = {
			instanceId,
			code,
			socket: null,
			info: null,
			managed: new ManagedChromeTabs({
				targetId: tabId => pageTargetIdFromKey(tabKeyOf(code, tabId)),
				create: async url => {
					const result = (await this.#rpc({ op: "createTab", url }, inst)) as { tab: TabSnapshot };
					this.#onTabUpsert(result.tab, inst);
					return result.tab;
				},
				group: async (tabId, owner, label) => {
					if (!this.#markTabs) return;
					await this.#rpc({ op: "group", tabId, owner, label }, inst);
				},
				reveal: async tabId => {
					await this.#rpc({ op: "activateTab", tabId }, inst);
				},
				release: (tabId, close) => this.#releaseTab(inst, tabId, close),
				invalidate: leaseId => {
					for (const conn of this.#conns.values()) if (conn.leaseId === leaseId) conn.socket.close();
				},
				// A ban protects the user from an attach loop the relay starts on its
				// own; a claim is someone asking again. One try, re-banned with
				// Chrome's fresh reason when it fails.
				allowAttach: tabId => {
					const tab = this.#tabs.get(tabKeyOf(code, tabId));
					if (!tab) return;
					tab.banned = false;
					tab.banReason = undefined;
					tab.canceledByUser = false;
				},
			}),
			downloads: new DownloadAttribution((tabKey, method, params) => {
				for (const conn of this.#conns.values()) {
					for (const pageSession of conn.sessionsForTab(tabKey, "page"))
						conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }));
				}
			}),
		};
		return inst;
	}

	#instance(instanceId: string): ExtInstance {
		const inst = this.#instances.get(instanceId);
		if (!inst) throw new Error(`Browser instance ${JSON.stringify(instanceId)} has not connected to this relay`);
		return inst;
	}

	/** Task-owned leases over one browser instance's tabs. */
	managed(instanceId: string): ManagedChromeTabs {
		return this.#instance(instanceId).managed;
	}

	/** The browser instance whose tab a lease owns. */
	instanceForLease(leaseId: string): string | undefined {
		for (const inst of this.#instances.values()) {
			if (inst.managed.tabForLease(leaseId) !== undefined) return inst.instanceId;
		}
		return undefined;
	}

	/** Why a lease or discovered tab id no longer resolves: the browser that remembers it says why. */
	stale(id: string): ChromeTabGoneError {
		for (const inst of this.#instances.values()) {
			const ended = inst.managed.unavailable(id);
			if (ended) return ended;
		}
		return unknownChromeTab(id);
	}

	/** True once the instance has completed its hello on its current socket. */
	connected(instanceId: string): boolean {
		const inst = this.#instances.get(instanceId);
		return inst?.socket != null && inst.info !== null;
	}

	/** A connection only ever sees the one tab its lease owns. */
	#visibleTo(conn: CdpConnection, tab: TabState): boolean {
		return (
			tab.instanceId === conn.instanceId &&
			this.#eligible(tab) &&
			this.#instances.get(conn.instanceId)?.managed.tabForLease(conn.leaseId) === tab.tabId
		);
	}

	/** Payload for `GET /json/version` of one browser instance. */
	versionInfo(instanceId: string, wsUrl: string): Record<string, string> {
		const info = this.#instances.get(instanceId)?.info;
		return {
			Browser: info?.browserVersion ?? "Chrome/unknown",
			"Protocol-Version": "1.3",
			"User-Agent": info?.userAgent ?? "",
			"V8-Version": "",
			"WebKit-Version": "",
			webSocketDebuggerUrl: wsUrl,
		};
	}

	// ---- extension lifecycle -------------------------------------------------

	#rejectPendingExtensionRpcs(instanceId: string, error: Error): void {
		for (const [id, pending] of this.#pendingRpc) {
			if (pending.instanceId !== instanceId) continue;
			clearTimeout(pending.timer);
			pending.reject(error);
			this.#pendingRpc.delete(id);
		}
	}

	/**
	 * Bind an authenticated extension socket to its browser instance. A second
	 * socket for the same instance (service-worker restart) retires the first;
	 * every other browser's connection, tabs and leases are untouched.
	 */
	extConnected(socket: RelaySocket, instanceId: string): void {
		let inst = this.#instances.get(instanceId);
		if (!inst) {
			inst = this.#createInstance(instanceId);
			this.#instances.set(instanceId, inst);
		} else if (inst.socket && inst.socket !== socket) {
			this.#log("replacing extension socket", { instanceId });
			const previous = inst.socket;
			this.#retire(inst, new ExtensionReplacedError());
			previous.close();
		}
		inst.socket = socket;
		this.#socketInstance.set(socket, instanceId);
	}

	extClosed(socket: RelaySocket): void {
		const instanceId = this.#socketInstance.get(socket);
		const inst = instanceId === undefined ? undefined : this.#instances.get(instanceId);
		if (!inst || inst.socket !== socket) return;
		this.#retire(inst, new Error("relay extension disconnected"));
	}

	/**
	 * Detach an instance from its socket: its leases end and its in-flight RPCs
	 * fail. Its tabs stay registered (the browser may reconnect), but the bridge
	 * holds no debugger over them until the next hello says what Chrome kept —
	 * marked first, so connections closing with their leases send no detach
	 * down a socket that is gone.
	 */
	#retire(inst: ExtInstance, error: Error): void {
		for (const tab of this.#tabs.values()) {
			if (tab.instanceId !== inst.instanceId) continue;
			tab.attached = false;
			tab.attaching = null;
			this.#resetRuntime(tab);
		}
		if (inst.socket) this.#socketInstance.delete(inst.socket);
		inst.socket = null;
		inst.info = null;
		inst.managed.reset();
		this.#rejectPendingExtensionRpcs(inst.instanceId, error);
	}

	/** Drop an unpaired browser: its socket closes and its tabs leave the registry. */
	forget(instanceId: string): void {
		const inst = this.#instances.get(instanceId);
		if (!inst) return;
		const socket = inst.socket;
		if (socket) {
			this.extClosed(socket);
			socket.close();
		}
		for (const [key, tab] of this.#tabs) if (tab.instanceId === instanceId) this.#onTabRemoved(key);
		this.#instances.delete(instanceId);
	}

	extMessage(socket: RelaySocket, raw: string): void {
		const instanceId = this.#socketInstance.get(socket);
		const inst = instanceId === undefined ? undefined : this.#instances.get(instanceId);
		if (!inst || inst.socket !== socket) return;
		let msg: ExtToRelayMessage;
		try {
			msg = JSON.parse(raw) as ExtToRelayMessage;
		} catch {
			this.#log("dropping malformed extension message");
			return;
		}
		switch (msg.t) {
			case "hello":
				this.#onHello(inst, msg);
				return;
			case "rpcResult": {
				const pending = this.#pendingRpc.get(msg.id);
				if (!pending || pending.instanceId !== inst.instanceId) return;
				this.#pendingRpc.delete(msg.id);
				clearTimeout(pending.timer);
				if (msg.ok) pending.resolve(msg.result);
				else pending.reject(new Error(msg.error ?? "extension rpc failed"));
				return;
			}
			case "cdpEvent":
				this.#onCdpEvent(tabKeyOf(inst.code, msg.tabId), msg.sessionId, msg.method, msg.params);
				return;
			case "detached":
				this.#onTabDetached(tabKeyOf(inst.code, msg.tabId), msg.reason, msg.relayInitiated === true);
				return;
			case "tabCreated":
				this.#onTabUpsert(msg.tab, inst);
				return;
			case "tabOpened":
				this.#onTabUpsert(msg.tab, inst);
				void this.#adoptChild(inst, msg.tab, msg.openerTabId);
				return;
			case "tabUpdated":
				this.#onTabUpsert(msg.tab, inst);
				return;
			case "tabActivated":
				this.#onTabActivated(inst, msg.tabId, msg.windowId);
				return;
			case "download":
				inst.downloads.item(msg.download);
				return;
			case "tabRemoved":
				this.#onTabRemoved(tabKeyOf(inst.code, msg.tabId));
				return;
			case "ping":
				socket.send(JSON.stringify({ t: "pong" } satisfies RelayToExtMessage));
				return;
		}
	}

	/** Fresh metadata only: no debugger attach, navigation, grouping or activation. */
	async refreshTabs(instanceId: string): Promise<void> {
		const inst = this.#instance(instanceId);
		const socket = inst.socket;
		const result = await this.#rpc({ op: "queryTabs" }, inst);
		if (inst.socket !== socket) throw new Error("Browser connection changed during discovery");
		if (
			!result ||
			typeof result !== "object" ||
			!("tabs" in result) ||
			!Array.isArray(result.tabs) ||
			!result.tabs.every(isTabSnapshot)
		)
			throw new Error("Extension does not provide fresh tab metadata. Reload the current OMP extension");
		const seen = new Set<number>();
		for (const tab of result.tabs) {
			seen.add(tab.tabId);
			this.#onTabUpsert(tab, inst, { silent: true });
		}
		for (const [key, tab] of this.#tabs) {
			if (tab.instanceId === instanceId && !seen.has(tab.tabId)) this.#onTabRemoved(key);
		}
	}

	#onTabActivated(inst: ExtInstance, tabId: number, windowId: number): void {
		// Even an ineligible/unknown selected tab deactivates every known peer.
		for (const tab of this.#tabs.values()) {
			if (tab.instanceId !== inst.instanceId || tab.windowId !== windowId) continue;
			this.#onTabUpsert(
				{
					tabId: tab.tabId,
					windowId: tab.windowId,
					url: tab.url,
					title: tab.title,
					pinned: tab.pinned,
					groupId: tab.groupId,
					active: tab.tabId === tabId,
				},
				inst,
				{ silent: true },
			);
		}
	}

	/**
	 * A tab the browser opened from another tab. Chrome's `openerTabId` is not
	 * trustworthy for a CDP-synthesized click — it attributes the child to the
	 * window's active tab — so an opener that holds no lease falls back to the
	 * leased tab that just reported `Page.windowOpen` on its own debugger
	 * session, which only the real opener can have done.
	 *
	 * Whatever Chrome did with the selection stands. Chrome opens a
	 * `target=_blank` child active and raises its window, and a raised window
	 * showing the page the click asked for is what a new tab is supposed to
	 * look like; putting the previously active tab back only makes OMP look
	 * like it opened a tab and then showed the wrong one. A child Chrome
	 * created inactive needs nothing either way.
	 */
	async #adoptChild(inst: ExtInstance, snap: TabSnapshot, openerTabId: number): Promise<void> {
		const opener = this.#resolveOpener(inst, openerTabId);
		this.#log("tab opened", {
			instanceId: inst.instanceId,
			tabId: snap.tabId,
			reportedOpener: openerTabId,
			opener,
			active: snap.active,
		});
		if (opener === undefined) return;
		await inst.managed.adoptChild(snap, opener);
	}

	/** Which leased tab opened a child: Chrome's answer when it is one of ours, else the `Page.windowOpen` witness. */
	#resolveOpener(inst: ExtInstance, openerTabId: number): number | undefined {
		if (inst.managed.leaseForTab(openerTabId) !== undefined) return openerTabId;
		const cutoff = Date.now() - WINDOW_OPEN_MATCH_MS;
		let best: TabState | undefined;
		for (const tab of this.#tabs.values()) {
			if (tab.instanceId !== inst.instanceId || tab.windowOpenedAt < cutoff) continue;
			if (inst.managed.leaseForTab(tab.tabId) === undefined) continue;
			if (!best || tab.windowOpenedAt > best.windowOpenedAt) best = tab;
		}
		if (!best) return undefined;
		// One witness explains one child; a second popup needs its own event.
		best.windowOpenedAt = 0;
		return best.tabId;
	}

	#onHello(inst: ExtInstance, msg: Extract<ExtToRelayMessage, { t: "hello" }>): void {
		inst.info = { userAgent: msg.userAgent, browserVersion: msg.browserVersion };
		// The hello GC is scoped to this instance: another browser's tabs are
		// untouched, which is what lets several browsers share one relay.
		const seen = new Set<number>();
		const attachedNow = new Set(msg.attachedTabIds);
		for (const snap of msg.tabs) {
			seen.add(snap.tabId);
			this.#onTabUpsert(snap, inst, { silent: true });
		}
		for (const [key, tab] of this.#tabs) {
			if (tab.instanceId === inst.instanceId && !seen.has(tab.tabId)) this.#onTabRemoved(key);
		}
		for (const tab of this.#tabs.values()) {
			if (tab.instanceId !== inst.instanceId) continue;
			tab.attaching = null;
			// Every lease ended with the last socket, and what Chrome reported while
			// none was open never arrived: an attachment Chrome kept is handed back,
			// OMP's marks taken off its page first, so the next claim starts a fresh
			// one whose child frames Chrome reports anew, instead of a driver arming
			// over children nobody recorded.
			tab.attached = attachedNow.has(tab.tabId);
			if (tab.attached) void this.#detachTab(tab, true);
			else this.#forgetChildren(tab);
		}
		this.#log("extension connected", {
			instanceId: inst.instanceId,
			tabs: msg.tabs.length,
			version: msg.browserVersion,
		});
	}

	// ---- downstream (puppeteer) lifecycle -------------------------------------

	/** Register a downstream CDP websocket for one lease; returns the connection id. */
	cdpConnected(socket: RelaySocket, leaseId: string): number {
		const instanceId = this.instanceForLease(leaseId);
		if (instanceId === undefined) throw this.stale(leaseId);
		const inst = this.#instance(instanceId);
		const tabId = inst.managed.tabForLease(leaseId);
		const conn = new CdpConnection(
			++this.#connSeq,
			socket,
			leaseId,
			instanceId,
			tabId === undefined ? undefined : this.#tabs.get(tabKeyOf(inst.code, tabId)),
		);
		inst.managed.connected(leaseId, conn.id);
		this.#conns.set(conn.id, conn);
		this.#log("cdp client connected", { conn: conn.id, instanceId });
		return conn.id;
	}

	cdpClosed(connId: number): void {
		const conn = this.#conns.get(connId);
		if (!conn) return;
		this.#conns.delete(connId);
		this.#instances.get(conn.instanceId)?.managed.disconnected(conn.leaseId, connId);
		const touched = new Set<string>();
		const leased = conn.leasedTab;
		if (leased && this.#tabs.get(leased.tabKey) === leased) touched.add(leased.tabKey);
		for (const ref of conn.sessions.values()) touched.add(ref.tabKey);
		conn.sessions.clear();
		// Drop the debugger (and its infobar) from tabs nobody drives anymore.
		for (const tabKey of touched) this.#detachIfUnheld(tabKey);
		this.#log("cdp client closed", { conn: connId });
	}

	cdpMessage(connId: number, raw: string): void {
		const conn = this.#conns.get(connId);
		if (!conn) return;
		let msg: CdpCommand;
		try {
			msg = JSON.parse(raw) as CdpCommand;
		} catch {
			return;
		}
		if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
		void (async () => {
			const managed = this.#instances.get(conn.instanceId)?.managed;
			if (!managed) throw this.stale(conn.leaseId);
			const finish = managed.beginOperation(conn.leaseId);
			try {
				await this.#handleCdpCommand(conn, msg);
			} finally {
				finish();
			}
		})().catch(err => {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		});
	}

	// ---- command routing -------------------------------------------------------

	async #handleCdpCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
		if (msg.method === "Browser.setDownloadBehavior" || msg.method === "Page.setDownloadBehavior") {
			throw new Error(
				"Changing download behavior is not supported in existing Chrome. Downloads use this profile's settings; a requested download path has not been applied.",
			);
		}
		const sessionId = msg.sessionId;
		if (!sessionId) {
			await this.#handleBrowserCommand(conn, msg);
			return;
		}
		const ref = conn.sessions.get(sessionId);
		if (ref?.kind === "tab") {
			this.#handleTabSessionCommand(conn, msg, ref);
			return;
		}
		if (ref?.kind === "page") {
			await this.#handlePageSessionCommand(conn, msg, sessionId, ref);
			return;
		}
		const realTabKey = this.#realSessionTabs.get(sessionId);
		if (realTabKey !== undefined) {
			await this.#forwardToTab(conn, msg, realTabKey, sessionId);
			return;
		}
		this.#replyError(conn, msg, `Unknown session id ${sessionId}`);
	}

	async #handlePageSessionCommand(
		conn: CdpConnection,
		msg: CdpCommand,
		sessionId: string,
		ref: SessionRef,
	): Promise<void> {
		const tab = this.#tabs.get(ref.tabKey);
		if (!tab || !this.#visibleTo(conn, tab)) throw new Error("Chrome tab is outside this connection's ownership");
		if (msg.method === "Runtime.disable") {
			ref.runtimeState = "disabled";
			ref.runtimeEpoch++;
			ref.runtimeContexts.clear();
			// Abandon any in-flight enable's ownership: a later enable starts fresh
			// rather than joining a cycle that predates this disable.
			ref.runtimeEnabling = null;
			this.#reply(conn, msg, {});
			return;
		}
		if (msg.method !== "Runtime.enable") {
			if (msg.method === "Target.setAutoAttach") ref.autoAttach = msg.params?.autoAttach === true;
			await this.#forwardToTab(conn, msg, ref.tabKey, undefined);
			return;
		}
		// A pipelined duplicate must await the in-flight enable, never ack early:
		// the root cycle may still fail, and success must trail the context replay.
		if (ref.runtimeEnabling) {
			await this.#awaitEnable(conn, msg, ref.runtimeEnabling);
			return;
		}
		if (ref.runtimeState === "enabled") {
			this.#reply(conn, msg, {});
			return;
		}
		const enabling = this.#enableSessionRuntime(conn, sessionId, ref);
		ref.runtimeEnabling = enabling;
		try {
			await this.#awaitEnable(conn, msg, enabling);
		} finally {
			if (ref.runtimeEnabling === enabling) ref.runtimeEnabling = null;
		}
	}

	/** Reply to one `Runtime.enable` command with the shared enable's outcome. */
	async #awaitEnable(conn: CdpConnection, msg: CdpCommand, enabling: Promise<void>): Promise<void> {
		try {
			await enabling;
			this.#reply(conn, msg, {});
		} catch (err) {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Drive the shared root `Runtime.enable` for a session and replay the live
	 * contexts to it. Rejects if the root cycle fails so every joined caller
	 * observes the failure instead of a spurious success.
	 */
	async #enableSessionRuntime(conn: CdpConnection, sessionId: string, ref: SessionRef): Promise<void> {
		const prev = ref.runtimeState;
		const epoch = ++ref.runtimeEpoch;
		ref.runtimeState = "enabled";
		const tab = this.#tabs.get(ref.tabKey);
		if (!tab) {
			ref.runtimeState = prev;
			throw new Error(`No tab ${ref.tabKey}`);
		}
		try {
			await this.#ensureRuntimeEnabled(tab);
			// A disable or newer enable may have taken ownership while the root
			// RPC was in flight; only the latest enable may replay or roll back.
			if (conn.sessions.get(sessionId) === ref && ref.runtimeEpoch === epoch && ref.runtimeState === "enabled") {
				this.#replayRuntimeContexts(conn, sessionId, ref, tab);
			}
		} catch (err) {
			if (ref.runtimeEpoch === epoch) {
				ref.runtimeState = prev;
				ref.runtimeContexts.clear();
			}
			throw err;
		}
	}

	async #ensureRuntimeEnabled(tab: TabState): Promise<void> {
		if (tab.rootRuntimeEnabled) return;
		if (tab.rootRuntimeEnabling) return await tab.rootRuntimeEnabling;

		const enabling = this.#cycleRuntime(tab);
		tab.rootRuntimeEnabling = enabling;
		const generation = tab.runtimeGeneration;
		try {
			await enabling;
			if (tab.runtimeGeneration === generation) tab.rootRuntimeEnabled = true;
		} finally {
			if (tab.rootRuntimeEnabling === enabling) tab.rootRuntimeEnabling = null;
		}
	}

	/**
	 * Remember root-session state Chrome throws away when it detaches a
	 * debugger, so the idle detach — and the reattach that follows it — stay
	 * invisible to the connections that set it up. `Runtime.enable` never
	 * reaches here: the bridge owns root Runtime itself.
	 */
	#recordRootState(tab: TabState, msg: CdpCommand): void {
		if (msg.method === "Target.setAutoAttach") {
			tab.rootAutoAttach = msg.params;
			return;
		}
		const toggle = /^(\w+)\.(enable|disable)$/.exec(msg.method);
		if (toggle) {
			if (toggle[2] === "enable") tab.rootEnabled.set(`${toggle[1]!}.enable`, msg.params);
			else tab.rootEnabled.delete(`${toggle[1]!}.enable`);
			return;
		}
		// Init-time switches are lost with the debugger just like a domain enable, and
		// drivers send them once: puppeteer's FrameManager issues
		// `Page.setLifecycleEventsEnabled` at attach and never again, so without the
		// replay every navigation wait after an idle detach waits for lifecycle events
		// Chrome stopped emitting. Insertion order is kept so a switch still follows
		// the `enable` its domain needs.
		if (/^\w+\.set\w*Enabled$/.test(msg.method)) tab.rootEnabled.set(msg.method, msg.params);
	}

	/**
	 * Put a freshly reattached tab back the way its drivers left it. Issued in
	 * parallel: the reattach should cost one round trip, not one per domain. A
	 * single failed restore costs that domain's events, never the attach.
	 */
	async #restoreRoot(tab: TabState): Promise<void> {
		const inst = this.#instanceFor(tab);
		const restore = [...tab.rootEnabled].map(([method, params]) =>
			this.#rpc({ op: "send", tabId: tab.tabId, method, params }, inst),
		);
		if (tab.rootAutoAttach)
			restore.push(
				this.#rpc(
					{ op: "send", tabId: tab.tabId, method: "Target.setAutoAttach", params: tab.rootAutoAttach },
					inst,
				),
			);
		// Sessions that already enabled Runtime will never ask a second time.
		if (this.#runtimeWanted(tab.tabKey))
			restore.push(
				this.#rpc({ op: "send", tabId: tab.tabId, method: "Runtime.enable" }, inst).then(() => {
					tab.rootRuntimeEnabled = true;
				}),
			);
		if (!restore.length) return;
		for (const result of await Promise.allSettled(restore)) {
			if (result.status === "rejected")
				this.#log("root state restore failed", { tabKey: tab.tabKey, error: String(result.reason) });
		}
	}

	/** Whether a downstream page session still believes this tab's Runtime is enabled. */
	#runtimeWanted(tabKey: string): boolean {
		for (const conn of this.#conns.values()) {
			for (const ref of conn.sessions.values()) {
				if (ref.kind === "page" && ref.tabKey === tabKey && ref.runtimeState === "enabled") return true;
			}
		}
		return false;
	}

	/**
	 * Every CDP command bound for a tab's root session goes through here so a
	 * released debugger costs one attach on next use instead of a failed
	 * command. `banned` (Chrome refused or revoked the debugger) still refuses.
	 */
	async #sendToTab(
		tab: TabState,
		method: string,
		params?: Record<string, unknown>,
		sessionId?: string,
	): Promise<unknown> {
		if (!tab.attached && !(await this.#ensureAttached(tab))) throw new Error(this.#refused(tab));
		tab.inflight++;
		this.#touchTab(tab);
		try {
			return await this.#rpc({ op: "send", tabId: tab.tabId, sessionId, method, params }, this.#instanceFor(tab));
		} finally {
			tab.inflight--;
			this.#touchTab(tab);
		}
	}

	async #cycleRuntime(tab: TabState): Promise<void> {
		await this.#sendToTab(tab, "Runtime.disable");
		await this.#sendToTab(tab, "Runtime.enable");
	}

	#replayRuntimeContexts(conn: CdpConnection, sessionId: string, ref: SessionRef, tab: TabState): void {
		for (const [contextId, params] of tab.runtimeContexts) {
			if (ref.runtimeContexts.has(contextId)) continue;
			ref.runtimeContexts.add(contextId);
			conn.socket.send(JSON.stringify({ sessionId, method: "Runtime.executionContextCreated", params }));
		}
	}

	async #forwardToTab(
		conn: CdpConnection,
		msg: CdpCommand,
		tabKey: string,
		realSessionId: string | undefined,
	): Promise<void> {
		const tab = this.#tabs.get(tabKey);
		if (!tab || !this.#visibleTo(conn, tab)) throw new Error("Chrome tab is outside this connection's ownership");
		if (["Page.bringToFront", "Page.close", "Browser.close"].includes(msg.method)) {
			throw new Error("Use the explicit tab reveal/release lifecycle operation");
		}
		if (!realSessionId) this.#recordRootState(tab, msg);
		// One Chrome session serves every connection told of a child, so a
		// connection letting go of it must not end it for another that holds it,
		// and one that no longer holds it (a repeated detach) cannot end it at all.
		const release = msg.method === "Target.detachFromTarget" ? msg.params?.sessionId : undefined;
		const shared = typeof release === "string" ? tab.realSessions.get(release) : undefined;
		let released: string[] | undefined;
		if (typeof release === "string" && shared) {
			if (!conn.announced.delete(release)) {
				this.#replyError(conn, msg, `No session with given id: ${release}`);
				return;
			}
			// The frames nested in it go with it for this connection.
			released = [release];
			for (let i = 0; i < released.length; i++)
				for (const [child, known] of tab.realSessions)
					if (known.parent === released[i] && conn.announced.delete(child)) released.push(child);
			if ([...this.#conns.values()].some(other => other.announced.has(release))) {
				this.#emit(
					conn,
					"Target.detachedFromTarget",
					{ sessionId: release, targetId: shared.targetId },
					msg.sessionId,
				);
				this.#reply(conn, msg, {});
				return;
			}
			// Its last holder: Chrome ends it, and no late arm is told of it meanwhile.
			shared.releasing = true;
		}
		const arm = msg.method === "Target.setAutoAttach" && msg.params?.autoAttach === true ? msg.sessionId : undefined;
		const send = async (): Promise<void> => {
			// Only a click on a visible tab has anything to wait for; everything
			// else must reach Chrome in the same turn it was forwarded.
			const arrival = this.#paintCursor(tab, msg);
			if (arrival) await arrival;
			const epoch = tab.childEpoch;
			try {
				const result = await this.#sendToTab(tab, msg.method, msg.params, realSessionId);
				// Before the reply, as Chrome does: puppeteer counts the children
				// attached before its setAutoAttach resolves. Only while the arming
				// session and the children it was armed over are both still current.
				if (
					arm !== undefined &&
					epoch === tab.childEpoch &&
					this.#conns.get(conn.id) === conn &&
					(realSessionId === undefined ? conn.sessions.has(arm) : conn.announced.has(realSessionId))
				)
					this.#announceChildren(conn, tab, realSessionId, arm);
				this.#reply(conn, msg, (result as Record<string, unknown> | undefined) ?? {});
			} catch (err) {
				// Chrome kept the child: this connection still holds what it let go of.
				if (shared && released && tab.realSessions.get(released[0]!) === shared) {
					shared.releasing = false;
					for (const child of released) if (tab.realSessions.has(child)) conn.announced.add(child);
				}
				this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
			}
		};
		if (msg.method !== "Input.dispatchMouseEvent") {
			await send();
			return;
		}
		// A mouse event means nothing out of order, and puppeteer dispatches a
		// click's move/press/release concurrently — so the moment the press
		// waits for the pointer, the release it was issued with would overtake
		// it. One queue per tab keeps Chrome seeing what the driver asked for.
		const queued = tab.mouseTail.then(send, send);
		tab.mouseTail = queued;
		await queued;
	}

	/**
	 * Chrome reports a child target once, to the first auto-attach armed over
	 * it: on this relay that is often another connection, or the bridge's own
	 * replay after a reattach before any driver is back, and arming again
	 * reports nothing. So a connection arming auto-attach on `parent` (the
	 * root when undefined) is told here of every child already reported
	 * under it that it has not heard of — the cross-site frames of a tab
	 * claimed after they loaded, or of a tab reattached after Chrome dropped
	 * the debugger.
	 */
	#announceChildren(conn: CdpConnection, tab: TabState, parent: string | undefined, sessionId: string): void {
		for (const [child, known] of tab.realSessions) {
			if (known.parent !== parent || known.releasing || conn.announced.has(child)) continue;
			conn.announced.add(child);
			conn.socket.send(JSON.stringify({ sessionId, method: "Target.attachedToTarget", params: known.event }));
		}
	}

	/**
	 * Move the in-page arrow to the point OMP is about to click.
	 * `Input.dispatchMouseEvent` coordinates are viewport CSS pixels, exactly
	 * what a `position:fixed` overlay wants.
	 *
	 * A click on a tab the user is looking at waits for the glyph to arrive
	 * (Codex does the same, off `isVisible`): the pointer only communicates
	 * anything if it is at the target when the target reacts. Everything else
	 * — hover motion, and any tab that is not the visible one in its window —
	 * costs the click path nothing: a hidden tab gets no animation frames, so
	 * there is nothing to see and nothing to wait for. Failures are swallowed
	 * here and nowhere else; the cursor is cosmetic and must never cost a click.
	 */
	#paintCursor(tab: TabState, msg: CdpCommand): Promise<void> | undefined {
		if (tab.cursorScriptId === undefined || msg.method !== "Input.dispatchMouseEvent" || !tab.active) return;
		const type = msg.params?.type;
		if (type !== "mouseMoved" && type !== "mousePressed") return;
		const { x, y } = msg.params as { x?: unknown; y?: unknown };
		if (typeof x !== "number" || typeof y !== "number") return;
		const move = `window.__ompCursor?.move(${x},${y})`;
		if (type === "mouseMoved") {
			void this.#sendToTab(tab, "Runtime.evaluate", { expression: move }).catch(() => {});
			return;
		}
		return this.#awaitCursorArrival(tab, `${move}.then(() => window.__ompCursor?.press())`);
	}

	async #awaitCursorArrival(tab: TabState, expression: string): Promise<void> {
		const arrival = this.#sendToTab(tab, "Runtime.evaluate", { expression, awaitPromise: true });
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => deadline.reject(new Error("cursor did not arrive in time")),
			CURSOR_ARRIVAL_TIMEOUT_MS,
		);
		try {
			await Promise.race([arrival, deadline.promise]);
		} catch (err) {
			if (tab.cursorPaintFailed) return;
			tab.cursorPaintFailed = true;
			this.#log("cursor paint failed", {
				tabId: tab.tabId,
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			clearTimeout(timer);
		}
	}

	/** Tab pseudo-sessions only exist to satisfy puppeteer's Target hierarchy. */
	#handleTabSessionCommand(conn: CdpConnection, msg: CdpCommand, ref: SessionRef): void {
		switch (msg.method) {
			case "Target.setAutoAttach": {
				const tab = this.#tabs.get(ref.tabKey);
				if (!tab) {
					this.#replyError(conn, msg, `Tab ${ref.tabKey} is gone`);
					return;
				}
				// Emit before replying: puppeteer's TargetManager counts page
				// children attached before the setAutoAttach response resolves.
				const pageSession = this.#mintSession(conn, "page", tab);
				this.#emit(
					conn,
					"Target.attachedToTarget",
					{
						sessionId: pageSession,
						targetInfo: this.#pageInfo(tab, true),
						waitingForDebugger: false,
					},
					msg.sessionId,
				);
				this.#reply(conn, msg, {});
				return;
			}
			case "Runtime.runIfWaitingForDebugger":
				this.#reply(conn, msg, {});
				return;
			case "Target.detachFromTarget": {
				const child = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (child) this.#releaseSession(conn, child, msg.sessionId);
				this.#reply(conn, msg, {});
				return;
			}
			default:
				this.#replyError(conn, msg, `'${msg.method}' is not supported on a tab target`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	async #handleBrowserCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
		if (
			["Target.createTarget", "Target.closeTarget", "Target.activateTarget", "Browser.close"].includes(msg.method)
		) {
			throw new Error("Use the explicit tab create/reveal/release lifecycle operation");
		}
		switch (msg.method) {
			case "Browser.getVersion": {
				const info = this.#instances.get(conn.instanceId)?.info;
				this.#reply(conn, msg, {
					protocolVersion: "1.3",
					product: info?.browserVersion ?? "Chrome/unknown",
					revision: "",
					userAgent: info?.userAgent ?? "",
					jsVersion: "",
				});
				return;
			}
			case "Target.getBrowserContexts":
				this.#reply(conn, msg, { browserContextIds: [] });
				return;
			// Enumerate without attaching: the leased page is the only target this connection has.
			case "Target.getTargets": {
				const targetInfos: TargetInfo[] = [];
				for (const tab of this.#tabs.values()) {
					if (this.#visibleTo(conn, tab)) targetInfos.push(this.#pageInfo(tab, tab.attached));
				}
				this.#reply(conn, msg, { targetInfos });
				return;
			}
			case "Target.setDiscoverTargets": {
				conn.discover = true;
				for (const tab of this.#tabs.values()) {
					if (!this.#visibleTo(conn, tab)) continue;
					tab.announced = true;
					this.#emit(conn, "Target.targetCreated", { targetInfo: this.#tabInfo(tab, tab.attached) });
					this.#emit(conn, "Target.targetCreated", { targetInfo: this.#pageInfo(tab, tab.attached) });
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.setAutoAttach": {
				conn.autoAttach = true;
				const tabs = [...this.#tabs.values()].filter(tab => this.#visibleTo(conn, tab));
				await Promise.all(tabs.map(tab => this.#ensureAttached(tab)));
				for (const tab of tabs) {
					if (!tab.attached) {
						// Attach failed (DevTools open, another debugger, …): retract
						// the target so puppeteer's init never waits on it.
						this.#retractTab(tab);
						continue;
					}
					this.#emitTabAttached(conn, tab);
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.attachToTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				const tab = parsed ? this.#tabs.get(parsed.key) : undefined;
				if (!parsed || !tab || !this.#visibleTo(conn, tab)) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				if (!(await this.#ensureAttached(tab))) {
					this.#replyError(conn, msg, this.#refused(tab));
					return;
				}
				const sessionId = this.#mintSession(conn, parsed.kind, tab);
				const info = parsed.kind === "tab" ? this.#tabInfo(tab, true) : this.#pageInfo(tab, true);
				this.#emit(conn, "Target.attachedToTarget", { sessionId, targetInfo: info, waitingForDebugger: false });
				this.#reply(conn, msg, { sessionId });
				return;
			}
			case "Target.detachFromTarget": {
				const sessionId = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (sessionId) this.#releaseSession(conn, sessionId, undefined);
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.getTargetInfo": {
				const raw = typeof msg.params?.targetId === "string" ? msg.params.targetId : undefined;
				const parsed = raw ? parseTargetId(raw) : null;
				const tab = parsed ? this.#tabs.get(parsed.key) : undefined;
				if (parsed && tab && this.#visibleTo(conn, tab)) {
					const info =
						parsed.kind === "tab" ? this.#tabInfo(tab, tab.attached) : this.#pageInfo(tab, tab.attached);
					this.#reply(conn, msg, { targetInfo: info });
					return;
				}
				this.#reply(conn, msg, {
					targetInfo: {
						targetId: "relay-browser",
						type: "browser",
						title: "",
						url: "",
						attached: true,
						canAccessOpener: false,
					} satisfies TargetInfo,
				});
				return;
			}
			case "Target.createBrowserContext":
				this.#replyError(conn, msg, "Browser contexts are not supported by the omp browser relay");
				return;
			default:
				this.#replyError(conn, msg, `'${msg.method}' wasn't found`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	// ---- extension events -------------------------------------------------------

	#onCdpEvent(
		tabKey: string,
		sourceSessionId: string | undefined,
		method: string,
		params?: Record<string, unknown>,
	): void {
		const tab = this.#tabs.get(tabKey);
		if (!tab) return;
		// Any traffic on this tab is work in progress: the debugger stays.
		this.#touchTab(tab);
		if (!sourceSessionId && method === "Page.javascriptDialogOpening") tab.dialogs.opened(params ?? {});
		// A closed dialog is not a lifecycle end: the page may open the next one
		// immediately, and only an attached debugger sees it. The attachment goes
		// back when sessions end, when the tab goes idle, or on release.
		if (!sourceSessionId && method === "Page.javascriptDialogClosed") tab.dialogs.closed();
		// The only signal that names the page which opened a popup, and the one
		// `chrome.tabs.onCreated` misattributes for a synthesized click.
		if (!sourceSessionId && method === "Page.windowOpen") tab.windowOpenedAt = Date.now();
		// Whichever session saw it, a download belongs to this tab.
		if (method === "Page.downloadWillBegin") this.#instances.get(tab.instanceId)?.downloads.began(tabKey, params);
		else if (method === "Page.downloadProgress") this.#instances.get(tab.instanceId)?.downloads.progressed(params);
		// Track real child sessions so downstream commands can route back, and
		// so a driver arming auto-attach later still hears of them (#announceChildren).
		const child = typeof params?.sessionId === "string" ? params.sessionId : undefined;
		const info = params?.targetInfo;
		const targetId = info && typeof info === "object" && "targetId" in info ? info.targetId : undefined;
		const attached = method === "Target.attachedToTarget" ? child : undefined;
		// A child reported while a detach is in flight dies with that attachment: nobody is told of it.
		if (attached !== undefined && !tab.attached) return;
		if (attached !== undefined && params) {
			tab.realSessions.set(attached, { parent: sourceSessionId, targetId, event: params });
			this.#realSessionTabs.set(attached, tabKey);
		} else if (method === "Target.detachedFromTarget" && child !== undefined) {
			tab.realSessions.delete(child);
			this.#realSessionTabs.delete(child);
			for (const conn of this.#conns.values()) conn.announced.delete(child);
		} else if (method === "Target.targetInfoChanged" && targetId !== undefined) {
			for (const known of tab.realSessions.values())
				if (known.targetId === targetId) known.event = { ...known.event, targetInfo: info };
		}
		if (sourceSessionId) {
			// Event from a real child session: pass through verbatim to every
			// connection that was told about the child. A connection that has not
			// heard of it could not place the event; a child it reports is kept
			// for that connection's arm on it instead (#announceChildren).
			const payload = JSON.stringify({ sessionId: sourceSessionId, method, params });
			for (const conn of this.#conns.values()) {
				if (!conn.announced.has(sourceSessionId)) continue;
				if (attached !== undefined) {
					if (conn.announced.has(attached)) continue;
					conn.announced.add(attached);
				}
				conn.socket.send(payload);
			}
			return;
		}
		if (method.startsWith("Runtime.")) {
			const createdContext = method === "Runtime.executionContextCreated" ? params?.context : undefined;
			const createdContextId =
				createdContext &&
				typeof createdContext === "object" &&
				"id" in createdContext &&
				typeof createdContext.id === "number"
					? createdContext.id
					: undefined;
			const destroyedContextId =
				method === "Runtime.executionContextDestroyed" && typeof params?.executionContextId === "number"
					? params.executionContextId
					: undefined;
			if (createdContextId !== undefined && params) tab.runtimeContexts.set(createdContextId, params);
			if (destroyedContextId !== undefined) tab.runtimeContexts.delete(destroyedContextId);
			if (method === "Runtime.executionContextsCleared") tab.runtimeContexts.clear();

			for (const conn of this.#conns.values()) {
				for (const [pageSession, ref] of conn.sessions) {
					if (ref.kind !== "page" || ref.tabKey !== tabKey) continue;
					if (destroyedContextId !== undefined) ref.runtimeContexts.delete(destroyedContextId);
					if (method === "Runtime.executionContextsCleared") ref.runtimeContexts.clear();
					// `default` sessions never enabled Runtime but still get the
					// legacy fan-out; only an explicit `Runtime.disable` silences one.
					if (ref.runtimeState === "disabled") continue;
					if (createdContextId !== undefined) {
						if (ref.runtimeContexts.has(createdContextId)) continue;
						ref.runtimeContexts.add(createdContextId);
					}
					conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }));
				}
			}
			return;
		}
		// Other root-session events fan out once per minted page session. Real
		// child attach/detach goes only to sessions that armed auto-attach.
		const childEvent = method === "Target.attachedToTarget" || method === "Target.detachedFromTarget";
		for (const conn of this.#conns.values()) {
			const sessions = childEvent ? conn.autoAttachSessionsForTab(tabKey) : conn.sessionsForTab(tabKey, "page");
			if (attached !== undefined && sessions.length > 0) {
				if (conn.announced.has(attached)) continue;
				conn.announced.add(attached);
			}
			for (const pageSession of sessions)
				conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }));
		}
	}

	#onTabDetached(tabKey: string, reason: string, relayInitiated: boolean): void {
		const tab = this.#tabs.get(tabKey);
		if (!tab) return;
		// The extension acknowledges successful explicit detach before its RPC
		// result; native onDetach remains an independent user/browser event.
		if (relayInitiated) {
			// A replacement hello can observe the old attachment before the
			// pending detach completes. Reconcile that stale snapshot unless a
			// later attach has already superseded this detach.
			if (!tab.reattachedAfterDetach) tab.attached = false;
			return;
		}
		// Ownership outlives the attachment: the user cancelling the infobar (or
		// Chrome dropping it on a `chrome://` navigation) makes the tab
		// undrivable, not the user's again. Dropping the lease here is what left
		// tabs behind in an "Oh My Pi" group with nothing able to release them.
		this.#log("tab detached", {
			tabKey,
			reason,
			leased: this.#instances.get(tab.instanceId)?.managed.leaseForTab(tab.tabId) !== undefined,
		});
		tab.attached = false;
		tab.attaching = null;
		this.#resetRuntime(tab);
		this.#forgetChildren(tab);
		tab.banned = true;
		tab.banReason = describeDetach(reason);
		tab.canceledByUser = reason === "canceled_by_user";
		// Nothing can reach the page to take the opt-out back; its next document starts clean.
		tab.autofillOptedOut = false;
		this.#retractTab(tab);
	}

	#onTabRemoved(tabKey: string): void {
		const tab = this.#tabs.get(tabKey);
		if (!tab) return;
		this.#instances.get(tab.instanceId)?.managed.remove(tab.tabId);
		this.#instances.get(tab.instanceId)?.downloads.forgetTab(tabKey);
		this.#retractTab(tab);
		this.#tabs.delete(tabKey);
	}

	#onTabUpsert(snap: TabSnapshot, inst: ExtInstance, opts: { silent?: boolean } = {}): void {
		const key = tabKeyOf(inst.code, snap.tabId);
		let tab = this.#tabs.get(key);
		snap = mergeTabSnapshot(tab, snap);
		// A leased tab stays tracked whatever it navigates to, so its owner can
		// still release or close it; only unleased pages a debugger can never
		// attach to drop out of discovery, keeping them unclaimable.
		if (!INELIGIBLE_URL.test(snap.url) || inst.managed.leaseForTab(snap.tabId) !== undefined)
			inst.managed.upsert(snap);
		else inst.managed.remove(snap.tabId, UNDEBUGGABLE);
		if (!tab) {
			tab = new TabState(inst.instanceId, inst.code, snap.tabId, snap);
			this.#tabs.set(key, tab);
		} else {
			if (tab.url !== snap.url) {
				tab.banned = false;
				tab.banReason = undefined;
				tab.canceledByUser = false;
			}
			tab.update(snap);
		}
		if (opts.silent) return;
		const eligible = this.#eligible(tab);
		if (eligible && !tab.announced) {
			tab.announced = true;
			for (const conn of this.#conns.values()) {
				if (!conn.discover || !this.#visibleTo(conn, tab)) continue;
				this.#emit(conn, "Target.targetCreated", { targetInfo: this.#tabInfo(tab, tab.attached) });
				this.#emit(conn, "Target.targetCreated", { targetInfo: this.#pageInfo(tab, tab.attached) });
			}
			for (const conn of this.#conns.values()) {
				if (!conn.autoAttach || !this.#visibleTo(conn, tab)) continue;
				void this.#ensureAttached(tab).then(ok => {
					if (ok) this.#emitTabAttached(conn, tab);
				});
			}
			return;
		}
		if (!eligible && tab.announced) {
			this.#retractTab(tab);
			return;
		}
		if (eligible && tab.announced) {
			for (const conn of this.#conns.values()) {
				if (!conn.discover || !this.#visibleTo(conn, tab)) continue;
				this.#emit(conn, "Target.targetInfoChanged", { targetInfo: this.#tabInfo(tab, tab.attached) });
				this.#emit(conn, "Target.targetInfoChanged", { targetInfo: this.#pageInfo(tab, tab.attached) });
			}
		}
	}

	// ---- lease presentation ------------------------------------------------------

	/**
	 * Mark a leased tab for the user: swap its favicon for a cursor glyph, and
	 * arm the in-page pointer overlay so a driven tab that becomes visible
	 * shows where OMP is clicking. Both survive the page's own navigations via
	 * the per-document install. Best-effort — a page that refuses injection
	 * simply keeps its own icon and shows no arrow.
	 */
	async #showLeaseBadge(tab: TabState): Promise<void> {
		try {
			const installed = (await this.#sendToTab(tab, "Page.addScriptToEvaluateOnNewDocument", {
				source: LEASE_BADGE_INSTALL,
			})) as { identifier?: string } | undefined;
			tab.badgeScriptId = installed?.identifier;
			await this.#sendToTab(tab, "Runtime.evaluate", { expression: LEASE_BADGE_INSTALL });
			const cursor = (await this.#sendToTab(tab, "Page.addScriptToEvaluateOnNewDocument", {
				source: CURSOR_OVERLAY_INSTALL,
			})) as { identifier?: string } | undefined;
			tab.cursorScriptId = cursor?.identifier;
			tab.cursorPaintFailed = false;
			await this.#sendToTab(tab, "Runtime.evaluate", { expression: CURSOR_OVERLAY_INSTALL });
		} catch (err) {
			this.#log("lease badge skipped", { tabKey: tab.tabKey, error: err instanceof Error ? err.message : String(err) });
		}
	}

	/** The install identifier is the proof something was swapped; without it there is nothing to put back. */
	async #hideLeaseBadge(tab: TabState): Promise<void> {
		if (tab.badgeScriptId === undefined && tab.cursorScriptId === undefined) return;
		try {
			if (tab.badgeScriptId !== undefined) {
				await this.#sendToTab(tab, "Page.removeScriptToEvaluateOnNewDocument", { identifier: tab.badgeScriptId });
				await this.#sendToTab(tab, "Runtime.evaluate", { expression: LEASE_BADGE_RESTORE });
			}
			if (tab.cursorScriptId !== undefined) {
				await this.#sendToTab(tab, "Page.removeScriptToEvaluateOnNewDocument", { identifier: tab.cursorScriptId });
				await this.#sendToTab(tab, "Runtime.evaluate", { expression: CURSOR_OVERLAY_REMOVE });
			}
		} catch (err) {
			this.#log("lease badge restore skipped", {
				tabKey: tab.tabKey,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		tab.badgeScriptId = undefined;
		tab.cursorScriptId = undefined;
	}

	/**
	 * Close a leased tab's documents to inline autofill menus for as long as
	 * the debugger is attached (see {@link AUTOFILL_OPT_OUT_INSTALL}). The
	 * per-document script dies with the session, so every attach adds it again.
	 * Best-effort: a page that refuses injection only loses the prevention.
	 */
	async #optOutAutofill(tab: TabState, inst: ExtInstance): Promise<void> {
		if (!this.#autofillOptOut || inst.managed.leaseForTab(tab.tabId) === undefined) return;
		tab.autofillOptedOut = true;
		try {
			await this.#sendToTab(tab, "Page.addScriptToEvaluateOnNewDocument", { source: AUTOFILL_OPT_OUT_INSTALL });
			await this.#sendToTab(tab, "Runtime.evaluate", { expression: AUTOFILL_OPT_OUT_INSTALL });
		} catch (err) {
			this.#log("autofill opt-out skipped", {
				tabKey: tab.tabKey,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Before the relay hands the debugger back: whoever uses the tab next gets
	 * autofill again. Sent on the attachment still held, after `attached` is
	 * already false, so a new command waits for the detach instead of racing it.
	 */
	async #restoreAutofill(tab: TabState): Promise<void> {
		if (!tab.autofillOptedOut) return;
		tab.autofillOptedOut = false;
		try {
			await this.#rpc(
				{
					op: "send",
					tabId: tab.tabId,
					method: "Runtime.evaluate",
					params: { expression: AUTOFILL_OPT_OUT_REMOVE },
				},
				this.#instanceFor(tab),
			);
		} catch (err) {
			this.#log("autofill restore skipped", {
				tabKey: tab.tabKey,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Take every OMP mark off a tab's current document over the attachment
	 * still held — badge, cursor, autofill opt-out — whoever put them there:
	 * after a lost socket no lease is left to take them off, and a restarted
	 * relay never knew their script ids. The per-document scripts end with the
	 * detach itself.
	 */
	async #clearPageMarks(tab: TabState): Promise<void> {
		tab.autofillOptedOut = false;
		tab.badgeScriptId = undefined;
		tab.cursorScriptId = undefined;
		const inst = this.#instanceFor(tab);
		const removals = await Promise.allSettled(
			[LEASE_BADGE_RESTORE, CURSOR_OVERLAY_REMOVE, AUTOFILL_OPT_OUT_REMOVE].map(expression =>
				this.#rpc({ op: "send", tabId: tab.tabId, method: "Runtime.evaluate", params: { expression } }, inst),
			),
		);
		for (const removal of removals)
			if (removal.status === "rejected")
				this.#log("page mark removal skipped", { tabKey: tab.tabKey, error: String(removal.reason) });
	}

	/**
	 * Hand a tab back to the user: its own favicon, no debugger, out of the
	 * owner's group, closed only when asked. Restoring and detaching before
	 * the extension touches the group — and ungrouping before any close —
	 * leaves the strip as if OMP had never driven the tab.
	 */
	async #releaseTab(inst: ExtInstance, tabId: number, close: boolean): Promise<void> {
		const tab = this.#tabs.get(tabKeyOf(inst.code, tabId));
		if (tab) {
			if (!close) await this.#hideLeaseBadge(tab);
			await this.#detachTab(tab);
		}
		await this.#rpc({ op: "releaseTab", tabId, close }, inst);
		// Tracked only because it was leased: with the lease gone a page no
		// debugger can attach to leaves discovery, so nobody can claim it.
		if (tab && INELIGIBLE_URL.test(tab.url)) inst.managed.remove(tabId, UNDEBUGGABLE);
	}

	/**
	 * Detach one tab's `chrome.debugger` without touching downstream sessions:
	 * the lease ending, and the tab going idle mid-lease, both land here. An
	 * `orphaned` attachment outlived the lease that marked its page, so every
	 * OMP mark comes off the current document first.
	 */
	async #detachTab(tab: TabState, orphaned = false): Promise<void> {
		if (!tab.attached) return;
		tab.attached = false;
		this.#touchTab(tab);
		this.#resetRuntime(tab);
		// Chrome drops the child sessions with the attachment; a reattach reports fresh ones.
		this.#forgetChildren(tab);
		tab.reattachedAfterDetach = false;
		const inst = this.#instances.get(tab.instanceId);
		const socket = inst?.socket;
		const done = (orphaned ? this.#clearPageMarks(tab) : this.#restoreAutofill(tab))
			// Bound to the socket it started on: after a swap the next hello decides
			// about whatever attachment Chrome kept, and hands it back itself.
			.then(() => (inst && inst.socket === socket ? this.#rpc({ op: "detach", tabId: tab.tabId }, inst) : undefined))
			.then(
				() => {},
				() => {},
			);
		tab.detaching = done;
		await done;
		if (tab.detaching === done) tab.detaching = null;
	}

	/**
	 * Rearm a tab's idle detach. Chrome shows its debugging infobar for exactly
	 * as long as the attachment lives, so the attachment tracks the work: about
	 * {@link DEBUGGER_IDLE_MS} after the last CDP message the debugger goes
	 * back, while the lease, the group, the glyph and every downstream
	 * puppeteer session survive. {@link RelayBridge.#sendToTab} reattaches and
	 * {@link RelayBridge.#restoreRoot} puts the domains back, so the next
	 * command is unaffected. Called after every detach too: with the attachment
	 * gone there is nothing left to arm.
	 */
	#touchTab(tab: TabState): void {
		clearTimeout(tab.idleTimer);
		tab.idleTimer = undefined;
		if (!tab.attached || this.#idleMs <= 0) return;
		tab.idleTimer = setTimeout(() => {
			tab.idleTimer = undefined;
			this.#idleDetach(tab);
		}, this.#idleMs);
		tab.idleTimer.unref();
	}

	#idleDetach(tab: TabState): void {
		// A command may be blocked in the page (puppeteer's waits run inside
		// one), and only an attached debugger can see or answer a dialog.
		if (tab.inflight > 0 || tab.dialogs.snapshot().status === "open") {
			this.#touchTab(tab);
			return;
		}
		if (!tab.attached || tab.detaching) return;
		this.#log("idle detach", {
			tabKey: tab.tabKey,
			idleMs: this.#idleMs,
			holders: this.#sessionHolders(tab.tabKey).length,
		});
		void this.#detachTab(tab);
	}

	/** Tear a tab out of every downstream connection (closed, detached, or now ineligible). */
	#retractTab(tab: TabState): void {
		for (const [realSession, tabKey] of this.#realSessionTabs)
			if (tabKey === tab.tabKey) this.#realSessionTabs.delete(realSession);
		this.#forgetChildren(tab);
		for (const conn of this.#conns.values()) {
			const tabSessions = conn.sessionsForTab(tab.tabKey, "tab");
			for (const pageSession of conn.sessionsForTab(tab.tabKey, "page")) {
				conn.sessions.delete(pageSession);
				this.#emit(
					conn,
					"Target.detachedFromTarget",
					{ sessionId: pageSession, targetId: pageTargetIdFromKey(tab.tabKey) },
					tabSessions[0],
				);
			}
			for (const tabSession of tabSessions) {
				conn.sessions.delete(tabSession);
				this.#emit(conn, "Target.detachedFromTarget", {
					sessionId: tabSession,
					targetId: tabTargetIdFromKey(tab.tabKey),
				});
			}
			if (conn.discover && tab.announced) {
				this.#emit(conn, "Target.targetDestroyed", { targetId: pageTargetIdFromKey(tab.tabKey) });
				this.#emit(conn, "Target.targetDestroyed", { targetId: tabTargetIdFromKey(tab.tabKey) });
			}
		}
		tab.announced = false;
	}

	/**
	 * No child of this tab is replayed any more, not even to an arm already in
	 * flight, and a fresh report of one is announced again.
	 */
	#forgetChildren(tab: TabState): void {
		for (const conn of this.#conns.values())
			for (const child of tab.realSessions.keys()) conn.announced.delete(child);
		tab.childEpoch++;
		tab.realSessions.clear();
	}

	// ---- session + attach bookkeeping --------------------------------------------

	#mintSession(conn: CdpConnection, kind: "tab" | "page", tab: TabState): string {
		const sessionId = `S${kind === "tab" ? "T" : "P"}${tab.tabId}.${conn.id}.${++this.#sessionSeq}`;
		conn.sessions.set(sessionId, {
			kind,
			tabKey: tab.tabKey,
			tabId: tab.tabId,
			runtimeState: "default",
			runtimeContexts: new Set(),
			runtimeEnabling: null,
			runtimeEpoch: 0,
			autoAttach: false,
		});
		return sessionId;
	}

	#releaseSession(conn: CdpConnection, sessionId: string, parentSessionId: string | undefined): void {
		const ref = conn.sessions.get(sessionId);
		if (!ref) return;
		conn.sessions.delete(sessionId);
		const targetId = ref.kind === "tab" ? tabTargetIdFromKey(ref.tabKey) : pageTargetIdFromKey(ref.tabKey);
		this.#emit(conn, "Target.detachedFromTarget", { sessionId, targetId }, parentSessionId);
		// An explicit release of the last session must drop the attachment too,
		// or it outlives every downstream session: the infobar stays up, and
		// dismissing it bans the tab for the rest of the epoch.
		this.#detachIfUnheld(ref.tabKey);
	}

	/** Whether the exact tab can be driven right now, and if not, why not. */
	debuggerState(instanceId: string, tabId: number): DebuggerState {
		const inst = this.#instances.get(instanceId);
		const tab = inst && this.#tabs.get(tabKeyOf(inst.code, tabId));
		if (!tab) return { attached: false, revoked: "the tab is gone from Chrome" };
		if (tab.attached) return { attached: true };
		if (INELIGIBLE_URL.test(tab.url)) return { attached: false, revoked: `the tab ${UNDEBUGGABLE}` };
		return tab.banned
			? {
					attached: false,
					revoked: tab.banReason ?? describeDetach("target_closed"),
					canceledByUser: tab.canceledByUser,
				}
			: { attached: false };
	}

	/** Serialize dialog metadata only after the caller has validated the exact lease. */
	dialogState(instanceId: string, tabId: number): DialogJournalState {
		const inst = this.#instances.get(instanceId);
		const tab = inst && this.#tabs.get(tabKeyOf(inst.code, tabId));
		return tab?.attached ? tab.dialogs.snapshot() : { status: "unobserved", dialog: null };
	}

	async dialog(leaseId: string, owner: string, options: unknown, signal?: AbortSignal): Promise<DialogJournalState> {
		const instanceId = this.instanceForLease(leaseId);
		if (instanceId === undefined) throw this.stale(leaseId);
		const inst = this.#instance(instanceId);
		const lease = inst.managed.get(leaseId, owner);
		const tab = this.#tabs.get(tabKeyOf(inst.code, lease.tab.tabId));
		if (!tab) throw this.stale(leaseId);
		// Like any command, a look at a tab whose debugger went idle reattaches it.
		if (!tab.attached && !(await this.#ensureAttached(tab))) throw new Error(this.#refused(tab));
		const request = parseDialogRequest(options);
		if (!("id" in request)) return tab.dialogs.snapshot();
		const finish = inst.managed.beginOperation(leaseId);
		try {
			if (signal?.aborted) throw new Error("Dialog response canceled before dispatch");
			return await tab.dialogs.resolve(request, params =>
				this.#rpc({ op: "send", tabId: tab.tabId, method: "Page.handleJavaScriptDialog", params }, inst),
			);
		} finally {
			finish();
		}
	}

	#detachIfUnheld(tabKey: string): void {
		if (this.#sessionHolders(tabKey).length > 0) return;
		const tab = this.#tabs.get(tabKey);
		if (!tab?.attached || tab.dialogs.snapshot().status === "open") return;
		void this.#detachTab(tab);
	}

	/**
	 * Everything the debugger session owned is gone with the attachment: the
	 * cached document handle, the injected utility world and every element
	 * handle a driver still holds are dead object ids, even though the page and
	 * its execution contexts are untouched.
	 *
	 * `Runtime.executionContextsCleared` is what a downstream puppeteer needs
	 * to hear to drop them and re-acquire on next use (and to re-run pending
	 * wait tasks against the fresh context). Without it the next command reuses
	 * a stale object id and fails with "Could not find object with given id",
	 * which is what makes an idle detach invisible instead of a regression.
	 */
	#resetRuntime(tab: TabState): void {
		tab.dialogs.reset();
		tab.runtimeContexts.clear();
		tab.rootRuntimeEnabled = false;
		tab.rootRuntimeEnabling = null;
		tab.runtimeGeneration++;
		for (const conn of this.#conns.values()) {
			for (const [pageSession, ref] of conn.sessions) {
				if (ref.kind !== "page" || ref.tabKey !== tab.tabKey) continue;
				ref.runtimeContexts.clear();
				if (ref.runtimeState === "disabled") continue;
				conn.socket.send(JSON.stringify({ sessionId: pageSession, method: "Runtime.executionContextsCleared" }));
			}
		}
	}

	/** Connections currently holding any session on a tab. */
	#sessionHolders(tabKey: string): CdpConnection[] {
		const out: CdpConnection[] = [];
		for (const conn of this.#conns.values()) {
			if (conn.sessionsForTab(tabKey).length > 0) out.push(conn);
		}
		return out;
	}

	#emitTabAttached(conn: CdpConnection, tab: TabState): void {
		if (!this.#visibleTo(conn, tab)) return;
		if (conn.sessionsForTab(tab.tabKey, "tab").length > 0) return;
		const sessionId = this.#mintSession(conn, "tab", tab);
		this.#emit(conn, "Target.attachedToTarget", {
			sessionId,
			targetInfo: this.#tabInfo(tab, true),
			waitingForDebugger: false,
		});
	}

	async #ensureAttached(tab: TabState): Promise<boolean> {
		// The extension acknowledges successful detach before resolving the RPC.
		// Awaiting prevents a replacement attach racing either operation.
		while (tab.detaching) await tab.detaching;
		if (tab.attached) return true;
		const inst = this.#instances.get(tab.instanceId);
		if (tab.banned || !inst?.socket) return false;
		if (tab.attaching) return await tab.attaching;
		const attempt = this.#rpc({ op: "attach", tabId: tab.tabId }, inst)
			.then(async () => {
				tab.attached = true;
				// A fresh attachment: any child still on record belonged to a dead one.
				this.#forgetChildren(tab);
				tab.reattachedAfterDetach = true;
				this.#log("debugger attached", {
					tabKey: tab.tabKey,
					leased: inst.managed.leaseForTab(tab.tabId) !== undefined,
				});
				// An attach nobody follows up on still has to expire.
				this.#touchTab(tab);
				await this.#restoreRoot(tab);
				// Before any forwarded command can focus a field: the per-document
				// install is what an autofocused field on the next page meets.
				await this.#optOutAutofill(tab, inst);
				// Driving starts here, so this is where the tab strip learns about
				// it — including after an idle detach dropped the glyph's script.
				// Awaited: the per-document install has to be registered before the
				// first forwarded command can navigate, or the new document has no
				// overlay until the next reattach. Best-effort inside, never throws.
				if (this.#markTabs && inst.managed.leaseForTab(tab.tabId) !== undefined) await this.#showLeaseBadge(tab);
				return true;
			})
			.catch(err => {
				this.#log("attach failed", {
					tabKey: tab.tabKey,
					url: tab.url,
					error: err instanceof Error ? err.message : String(err),
				});
				if (!(err instanceof ExtensionReplacedError)) {
					tab.banned = true;
					tab.banReason = describeAttachFailure(err instanceof Error ? err.message : String(err));
				}
				return false;
			})
			.finally(() => {
				tab.attaching = null;
			});
		tab.attaching = attempt;
		return await attempt;
	}

	/** What a call on a tab the debugger cannot reach answers: why first, then where. */
	#refused(tab: TabState): string {
		const reason =
			this.debuggerState(tab.instanceId, tab.tabId).revoked ??
			(this.#instances.get(tab.instanceId)?.socket
				? "the attach was interrupted; try again"
				: "the OMP extension in Chrome is disconnected");
		return `Chrome refused OMP's debugger on this tab: ${reason} (${shortUrl(tab.url)})`;
	}

	#eligible(tab: TabState): boolean {
		if (tab.banned) return false;
		// A browser whose extension socket is gone cannot be driven: hide its tabs
		// until the instance reconnects.
		if (!this.#instances.get(tab.instanceId)?.socket) return false;
		if (!tab.url) return true;
		return !INELIGIBLE_URL.test(tab.url);
	}

	#tabInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: tabTargetIdFromKey(tab.tabKey),
			type: "tab",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
		};
	}

	#pageInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: pageTargetIdFromKey(tab.tabKey),
			type: "page",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
		};
	}

	// ---- plumbing ---------------------------------------------------------------

	#reply(conn: CdpConnection, msg: CdpCommand, result: Record<string, unknown>): void {
		conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result }));
	}

	#replyError(conn: CdpConnection, msg: CdpCommand, message: string, code = CDP_ERROR_SERVER): void {
		conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, error: { code, message } }));
	}

	#emit(conn: CdpConnection, method: string, params: Record<string, unknown>, sessionId?: string): void {
		conn.socket.send(JSON.stringify({ sessionId, method, params }));
	}

	/** The extension instance a tab belongs to; throws if the browser vanished. */
	#instanceFor(tab: TabState): ExtInstance {
		const inst = this.#instances.get(tab.instanceId);
		if (!inst) throw new Error("relay extension is not connected");
		return inst;
	}

	#rpc(req: RelayRpcRequest, inst: ExtInstance, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
		const socket = inst.socket;
		if (!socket) return Promise.reject(new Error("relay extension is not connected"));
		const id = ++this.#rpcSeq;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pendingRpc.delete(id);
			const detail = req.op === "send" ? { tabId: req.tabId, sessionId: req.sessionId, method: req.method } : {};
			this.#log("extension rpc timed out", { instanceId: inst.instanceId, op: req.op, timeoutMs, ...detail });
			reject(new Error(`extension rpc '${req.op}' timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		this.#pendingRpc.set(id, { instanceId: inst.instanceId, resolve, reject, timer });
		socket.send(JSON.stringify({ t: "rpc", id, ...req } satisfies RelayToExtMessage));
		return promise;
	}
}
