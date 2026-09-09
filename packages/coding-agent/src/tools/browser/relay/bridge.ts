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
 * Session id namespaces seen by a downstream connection:
 * - minted tab pseudo-sessions (`ST<tab>.<conn>.<n>`) — Target emulation only
 * - minted page pseudo-sessions (`SP<tab>.<conn>.<n>`) — forwarded to the
 *   tab's root debugger session
 * - real child session ids (OOPIFs, workers) — created by Chrome under the
 *   shared root session and passed through verbatim
 */
import {
	type ExtToRelayMessage,
	isTabSnapshot,
	mergeTabSnapshot,
	type RelayRpcRequest,
	type RelayToExtMessage,
	type TabSnapshot,
} from "./protocol";
import { DialogJournal, parseDialogRequest, type DialogState } from "../dialogs";
import { ManagedChromeTabs } from "./managed-tabs";
import { LEASE_BADGE_INSTALL, LEASE_BADGE_RESTORE } from "./lease-badge";

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
	tabId: number;
	runtimeState: RuntimeState;
	/** Context ids already announced to this pseudo-session. */
	readonly runtimeContexts: Set<number>;
	/** In-flight `Runtime.enable` for this session; duplicates await it. */
	runtimeEnabling: Promise<void> | null;
	/** Monotonic ownership token for enable rollback and replay. */
	runtimeEpoch: number;
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

	constructor(
		readonly id: number,
		readonly socket: RelaySocket,
		readonly leaseId: string,
		readonly leasedTab?: TabState,
	) {}

	sessionsForTab(tabId: number, kind?: "tab" | "page"): string[] {
		const out: string[] = [];
		for (const [sessionId, ref] of this.sessions) {
			if (ref.tabId === tabId && (!kind || ref.kind === kind)) out.push(sessionId);
		}
		return out;
	}
}

/** Transport replacement is retryable and must not permanently ban a tab. */
class ExtensionReplacedError extends Error {}

/** Debugger attachment of one tab as the lease's owner sees it. */
export interface DebuggerState {
	attached: boolean;
	/** Present while Chrome will not let OMP drive the tab even though it is open. */
	revoked?: string;
}

/**
 * Chrome ends an extension's debugger session with `target_closed` for more
 * than a closed tab: it also force-detaches when a frame the extension may
 * not debug commits in the page — most often another extension's
 * `chrome-extension://` UI, which is what password managers inject into
 * sign-in forms. The tab stays open; only OMP's control ends.
 */
function describeDetach(reason: string): string {
	if (reason === "canceled_by_user") return "the user cancelled OMP's debugging of this tab from Chrome's infobar";
	return (
		"Chrome revoked OMP's debugger on this tab while the tab stayed open, usually because another " +
		"extension (a password manager, for example) embedded its own UI in the page"
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
	url: string;
	title: string;
	active: boolean;
	windowId: number;
	pinned: boolean;
	/** Chrome tab group id from the last snapshot; -1 when ungrouped. */
	groupId: number;
	/** Whether `chrome.debugger` is currently attached to this tab. */
	attached = false;
	/** Set when attach failed or the user cancelled the debugger; cleared on navigation. */
	banned = false;
	/** Why the debugger cannot be (re)attached while `banned`, in the model's terms. */
	banReason: string | undefined;
	/** Whether targets for this tab were announced to discovering connections. */
	announced = false;
	attaching: Promise<boolean> | null = null;
	/** Relay-initiated detach in flight; reattach serializes behind it. */
	detaching: Promise<void> | null = null;
	/** Badge script installed for the lease, removed when the lease ends. */
	badgeScriptId: string | undefined;
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
	 * Root-session domain enables the drivers asked for (`"Page.enable"` → its
	 * params), minus any later `disable`. Chrome resets every domain on the
	 * client it detaches and puppeteer never re-enables, so a reattach has to
	 * put these back or dialog/download/lifecycle events stop silently.
	 */
	readonly rootEnabled = new Map<string, Record<string, unknown> | undefined>();
	/** Real Chrome session ids (OOPIF/worker children) living under this tab's root session. */
	readonly realSessions = new Set<string>();
	/** Live execution contexts from the shared root debugger session. */
	readonly runtimeContexts = new Map<number, Record<string, unknown>>();
	/** Whether the shared root Runtime domain has been enabled by the bridge. */
	rootRuntimeEnabled = false;
	rootRuntimeEnabling: Promise<void> | null = null;
	/** Invalidates an in-flight Runtime enable when the debugger detaches. */
	runtimeGeneration = 0;

	constructor(
		readonly tabId: number,
		snap: TabSnapshot,
	) {
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

const RPC_TIMEOUT_MS = 20_000;
const CDP_ERROR_METHOD_NOT_FOUND = -32601;
const CDP_ERROR_SERVER = -32000;
/**
 * How long an attached tab may sit without CDP traffic before its
 * `chrome.debugger` attachment — and with it Chrome's "being debugged" infobar
 * — goes back. The bar then tracks the work (last step + ~10 s), not the turn.
 */
const DEBUGGER_IDLE_MS = 10_000;
/** How stale a `Page.windowOpen` may be and still explain a new tab. */
const WINDOW_OPEN_MATCH_MS = 3_000;

function tabTargetId(tabId: number): string {
	return `TAB${tabId}`;
}

function pageTargetId(tabId: number): string {
	return `PAGE${tabId}`;
}

/** Reverse of {@link tabTargetId}/{@link pageTargetId}; null for foreign ids. */
function parseTargetId(targetId: string): { kind: "tab" | "page"; tabId: number } | null {
	const match = /^(TAB|PAGE)(\d+)$/.exec(targetId);
	if (!match) return null;
	return { kind: match[1] === "TAB" ? "tab" : "page", tabId: Number(match[2]) };
}

/**
 * Multiplexing CDP bridge between downstream puppeteer connections and the
 * relay extension. One bridge per paired browser instance; all state lives here so an
 * extension service-worker restart only has to re-handshake.
 */
export class RelayBridge {
	readonly managed: ManagedChromeTabs;
	#tabs = new Map<number, TabState>();
	#conns = new Map<number, CdpConnection>();
	#connSeq = 0;
	#sessionSeq = 0;
	#rpcSeq = 0;
	#ext: RelaySocket | null = null;
	#extInfo: { userAgent: string; browserVersion: string } | null = null;
	#pendingRpc = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
	>();
	/** Real child session id → owning tab, learned from `Target.attachedToTarget` events. */
	#realSessionTabs = new Map<string, number>();
	#log: (message: string, data?: Record<string, unknown>) => void;
	/** Mark the tabs OMP drives (owner tab group + favicon glyph); off leaves the strip untouched. */
	#markTabs: boolean;
	/** Idle window after which an attached tab's debugger goes back; 0 keeps it for the whole lease. */
	#idleMs: number;

	constructor(
		opts: {
			log?: (message: string, data?: Record<string, unknown>) => void;
			/** Mark tabs the agent drives: one Chrome tab group per owner, plus a favicon glyph. */
			group?: boolean;
			/** Hand a tab's debugger back after this long without CDP traffic; 0 keeps it for the lease. */
			debuggerIdleMs?: number;
		} = {},
	) {
		this.#log = opts.log ?? (() => {});
		this.#markTabs = opts.group ?? false;
		this.#idleMs = opts.debuggerIdleMs ?? DEBUGGER_IDLE_MS;
		this.managed = new ManagedChromeTabs({
			create: async url => {
				const result = (await this.#rpc({ op: "createTab", url })) as { tab: TabSnapshot };
				this.#onTabUpsert(result.tab);
				return result.tab;
			},
			group: async (tabId, owner, label) => {
				if (!this.#markTabs) return;
				await this.#rpc({ op: "group", tabId, owner, label });
			},
			reveal: async tabId => {
				await this.#rpc({ op: "activateTab", tabId, focusWindow: true });
			},
			release: (tabId, close) => this.#releaseTab(tabId, close),
			invalidate: leaseId => {
				for (const conn of this.#conns.values()) if (conn.leaseId === leaseId) conn.socket.close();
			},
		});
	}

	/** A connection only ever sees the one tab its lease owns. */
	#visibleTo(conn: CdpConnection, tab: TabState): boolean {
		return this.#eligible(tab) && this.managed.tabForLease(conn.leaseId) === tab.tabId;
	}

	/** True once the extension has completed its hello handshake. */
	get ready(): boolean {
		return this.#ext !== null && this.#extInfo !== null;
	}

	/** Payload for `GET /json/version`. */
	versionInfo(wsUrl: string): Record<string, string> {
		const ua = this.#extInfo?.userAgent ?? "";
		return {
			Browser: this.#extInfo?.browserVersion ?? "Chrome/unknown",
			"Protocol-Version": "1.3",
			"User-Agent": ua,
			"V8-Version": "",
			"WebKit-Version": "",
			webSocketDebuggerUrl: wsUrl,
		};
	}

	// ---- extension lifecycle -------------------------------------------------

	#rejectPendingExtensionRpcs(error: Error): void {
		for (const pending of this.#pendingRpc.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pendingRpc.clear();
	}

	/** A new extension socket connected; replaces any previous one. */
	extConnected(socket: RelaySocket): void {
		if (this.#ext && this.#ext !== socket) {
			this.#log("replacing extension socket");
			this.managed.reset();
			for (const tab of this.#tabs.values()) this.#resetRuntime(tab);
			this.#rejectPendingExtensionRpcs(new ExtensionReplacedError());
			this.#ext.close();
		}
		this.#ext = socket;
	}

	extClosed(socket: RelaySocket): void {
		if (this.#ext !== socket) return;
		this.#ext = null;
		this.#extInfo = null;
		this.managed.reset();
		this.#rejectPendingExtensionRpcs(new Error("relay extension disconnected"));
		for (const tab of this.#tabs.values()) {
			tab.attached = false;
			tab.attaching = null;
			this.#resetRuntime(tab);
		}
	}

	extMessage(socket: RelaySocket, raw: string): void {
		if (socket !== this.#ext) return;
		let msg: ExtToRelayMessage;
		try {
			msg = JSON.parse(raw) as ExtToRelayMessage;
		} catch {
			this.#log("dropping malformed extension message");
			return;
		}
		switch (msg.t) {
			case "hello":
				this.#onHello(msg);
				return;
			case "rpcResult": {
				const pending = this.#pendingRpc.get(msg.id);
				if (!pending) return;
				this.#pendingRpc.delete(msg.id);
				clearTimeout(pending.timer);
				if (msg.ok) pending.resolve(msg.result);
				else pending.reject(new Error(msg.error ?? "extension rpc failed"));
				return;
			}
			case "cdpEvent":
				this.#onCdpEvent(msg.tabId, msg.sessionId, msg.method, msg.params);
				return;
			case "detached":
				this.#onTabDetached(msg.tabId, msg.reason, msg.relayInitiated === true);
				return;
			case "tabCreated":
				this.#onTabUpsert(msg.tab);
				return;
			case "tabOpened": {
				// Read the window's visible tab before the child's own snapshot lands.
				const displaced = msg.tab.active ? this.#visibleTab(msg.tab.windowId, msg.tab.tabId) : undefined;
				this.#onTabUpsert(msg.tab);
				void this.#adoptChild(msg.tab, msg.openerTabId, displaced);
				return;
			}
			case "tabUpdated":
				this.#onTabUpsert(msg.tab);
				return;
			case "tabActivated":
				this.#onTabActivated(msg.tabId, msg.windowId);
				return;
			case "tabRemoved":
				this.#onTabRemoved(msg.tabId);
				return;
			case "ping":
				socket.send(JSON.stringify({ t: "pong" } satisfies RelayToExtMessage));
				return;
		}
	}

	/** Fresh metadata only: no debugger attach, navigation, grouping or activation. */
	async refreshTabs(): Promise<void> {
		const extension = this.#ext;
		const result = await this.#rpc({ op: "queryTabs" });
		if (extension !== this.#ext) throw new Error("Browser connection changed during discovery");
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
			this.#onTabUpsert(tab, { silent: true });
		}
		for (const tabId of this.#tabs.keys()) if (!seen.has(tabId)) this.#onTabRemoved(tabId);
	}

	/**
	 * Hand back the `chrome.debugger` attachments this bridge holds so Chrome
	 * takes its "started debugging this browser" infobar down. Tab ownership,
	 * page state and downstream sessions survive; the next command sent to one
	 * of these tabs reattaches lazily.
	 *
	 * `owner` restricts the release to one actor's leased tabs: a turn ending
	 * must not rip the debugger off a tab another actor is still driving. A tab
	 * with an open JavaScript dialog keeps its debugger — nothing else can
	 * answer that dialog.
	 *
	 * Returns the tabs Chrome confirmed detached.
	 */
	async detachDebuggers(opts: { owner?: string } = {}): Promise<number[]> {
		const scope = opts.owner === undefined ? undefined : new Set(this.managed.tabsForOwner(opts.owner));
		const tabs = [...this.#tabs.values()].filter(
			tab =>
				tab.attached && (scope === undefined || scope.has(tab.tabId)) && tab.dialogs.snapshot().status !== "open",
		);
		if (!tabs.length) return [];
		for (const tab of tabs) {
			tab.attached = false;
			this.#touchTab(tab);
			this.#resetRuntime(tab);
			tab.reattachedAfterDetach = false;
		}
		const tabIds = tabs.map(tab => tab.tabId);
		const request = this.#rpc({ op: "detachAll", tabIds });
		// Reattachment serializes behind the release, exactly as for one tab.
		const settled = request.then(
			() => {},
			() => {},
		);
		for (const tab of tabs) tab.detaching = settled;
		try {
			const result = await request;
			const detached =
				result && typeof result === "object" && "detached" in result && Array.isArray(result.detached)
					? result.detached.filter((tabId): tabId is number => Number.isInteger(tabId))
					: [];
			this.#log("released debugger attachments", { requested: tabIds.length, detached: detached.length });
			return detached;
		} finally {
			for (const tab of tabs) if (tab.detaching === settled) tab.detaching = null;
		}
	}

	#onTabActivated(tabId: number, windowId: number): void {
		// Even an ineligible/unknown selected tab deactivates every known peer.
		for (const tab of this.#tabs.values()) {
			if (tab.windowId !== windowId) continue;
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
				{ silent: true },
			);
		}
	}

	/** The tab this window currently shows, ignoring `exclude` (a child that just appeared). */
	#visibleTab(windowId: number, exclude?: number): number | undefined {
		for (const tab of this.#tabs.values()) {
			if (tab.windowId === windowId && tab.active && tab.tabId !== exclude) return tab.tabId;
		}
		return undefined;
	}

	/**
	 * A tab the browser opened from another tab. Chrome's `openerTabId` is not
	 * trustworthy for a CDP-synthesized click — it attributes the child to the
	 * window's active tab — so an opener that holds no lease falls back to the
	 * leased tab that just reported `Page.windowOpen` on its own debugger
	 * session, which only the real opener can have done.
	 *
	 * Chrome opens `target=_blank` children active and the extension cannot ask
	 * it not to, so an adopted child hands the window's visible tab straight
	 * back: agent work never changes what the user is looking at.
	 */
	async #adoptChild(snap: TabSnapshot, openerTabId: number, displaced?: number): Promise<void> {
		const opener = this.#resolveOpener(openerTabId);
		this.#log("tab opened", { tabId: snap.tabId, reportedOpener: openerTabId, opener, active: snap.active });
		if (opener === undefined) return;
		// The visible tab goes back first and on its own round trip: the user
		// looks at the child for exactly as long as this takes, so it must not
		// queue behind the child's grouping. No window focus either — the child
		// never became the user's foreground concern.
		const restored =
			displaced === undefined
				? undefined
				: this.#rpc({ op: "activateTab", tabId: displaced, focusWindow: false }).catch(() => undefined);
		await this.managed.adoptChild(snap, opener);
		await restored;
	}

	/** Which leased tab opened a child: Chrome's answer when it is one of ours, else the `Page.windowOpen` witness. */
	#resolveOpener(openerTabId: number): number | undefined {
		if (this.managed.leaseForTab(openerTabId) !== undefined) return openerTabId;
		const cutoff = Date.now() - WINDOW_OPEN_MATCH_MS;
		let best: TabState | undefined;
		for (const tab of this.#tabs.values()) {
			if (tab.windowOpenedAt < cutoff || this.managed.leaseForTab(tab.tabId) === undefined) continue;
			if (!best || tab.windowOpenedAt > best.windowOpenedAt) best = tab;
		}
		if (!best) return undefined;
		// One witness explains one child; a second popup needs its own event.
		best.windowOpenedAt = 0;
		return best.tabId;
	}

	#onHello(msg: Extract<ExtToRelayMessage, { t: "hello" }>): void {
		this.#extInfo = { userAgent: msg.userAgent, browserVersion: msg.browserVersion };
		const seen = new Set<number>();
		const attachedNow = new Set(msg.attachedTabIds);
		for (const snap of msg.tabs) {
			seen.add(snap.tabId);
			this.#onTabUpsert(snap, { silent: true });
		}
		for (const tabId of Array.from(this.#tabs.keys())) {
			if (!seen.has(tabId)) this.#onTabRemoved(tabId);
		}
		for (const tab of this.#tabs.values()) {
			const wasAttached = tab.attached;
			tab.attached = attachedNow.has(tab.tabId);
			tab.attaching = null;
			// A service-worker restart can drop attachments while downstream
			// connections still hold sessions: restore them best-effort.
			if (wasAttached && !tab.attached && this.#sessionHolders(tab.tabId).length > 0) {
				void this.#ensureAttached(tab).then(ok => {
					if (!ok) this.#onTabDetached(tab.tabId, "reattach_failed", false);
				});
			}
		}
		this.#log("extension connected", { tabs: this.#tabs.size, version: msg.browserVersion });
	}

	// ---- downstream (puppeteer) lifecycle -------------------------------------

	/** Register a downstream CDP websocket; returns the connection id. */
	cdpConnected(socket: RelaySocket, leaseId: string): number {
		const tabId = this.managed.tabForLease(leaseId);
		const conn = new CdpConnection(
			++this.#connSeq,
			socket,
			leaseId,
			tabId === undefined ? undefined : this.#tabs.get(tabId),
		);
		this.managed.connected(leaseId, conn.id);
		this.#conns.set(conn.id, conn);
		this.#log("cdp client connected", { conn: conn.id });
		return conn.id;
	}

	cdpClosed(connId: number): void {
		const conn = this.#conns.get(connId);
		if (!conn) return;
		this.#conns.delete(connId);
		this.managed.disconnected(conn.leaseId, connId);
		const touched = new Set<number>();
		if (conn.leasedTab && this.#tabs.get(conn.leasedTab.tabId) === conn.leasedTab) touched.add(conn.leasedTab.tabId);
		for (const ref of conn.sessions.values()) touched.add(ref.tabId);
		conn.sessions.clear();
		// Drop the debugger (and its infobar) from tabs nobody drives anymore.
		for (const tabId of touched) this.#detachIfUnheld(tabId);
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
			const finish = this.managed.beginOperation(conn.leaseId);
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
		if (this.managed.tabForLease(conn.leaseId) === undefined) {
			throw new Error("Chrome tab ownership is no longer valid");
		}
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
		const realTab = this.#realSessionTabs.get(sessionId);
		if (realTab !== undefined) {
			await this.#forwardToTab(conn, msg, realTab, sessionId);
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
		const tab = this.#tabs.get(ref.tabId);
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
			await this.#forwardToTab(conn, msg, ref.tabId, undefined);
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
		const tab = this.#tabs.get(ref.tabId);
		if (!tab) {
			ref.runtimeState = prev;
			throw new Error(`No tab with id ${ref.tabId}`);
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
	 * debugger, so {@link RelayBridge.detachDebuggers} stays invisible to the
	 * connections that set it up. `Runtime.enable` never reaches here — the
	 * bridge owns root Runtime itself.
	 */
	#recordRootState(tab: TabState, msg: CdpCommand): void {
		if (msg.method === "Target.setAutoAttach") {
			tab.rootAutoAttach = msg.params;
			return;
		}
		const toggle = /^(\w+)\.(enable|disable)$/.exec(msg.method);
		if (!toggle) return;
		if (toggle[2] === "enable") tab.rootEnabled.set(`${toggle[1]!}.enable`, msg.params);
		else tab.rootEnabled.delete(`${toggle[1]!}.enable`);
	}

	/**
	 * Put a freshly reattached tab back the way its drivers left it. Issued in
	 * parallel: the reattach should cost one round trip, not one per domain. A
	 * single failed restore costs that domain's events, never the attach.
	 */
	async #restoreRoot(tab: TabState): Promise<void> {
		const restore = [...tab.rootEnabled].map(([method, params]) =>
			this.#rpc({ op: "send", tabId: tab.tabId, method, params }),
		);
		if (tab.rootAutoAttach)
			restore.push(
				this.#rpc({ op: "send", tabId: tab.tabId, method: "Target.setAutoAttach", params: tab.rootAutoAttach }),
			);
		// Sessions that already enabled Runtime will never ask a second time.
		if (this.#runtimeWanted(tab.tabId))
			restore.push(
				this.#rpc({ op: "send", tabId: tab.tabId, method: "Runtime.enable" }).then(() => {
					tab.rootRuntimeEnabled = true;
				}),
			);
		if (!restore.length) return;
		for (const result of await Promise.allSettled(restore)) {
			if (result.status === "rejected")
				this.#log("root state restore failed", { tabId: tab.tabId, error: String(result.reason) });
		}
	}

	/** Whether a downstream page session still believes this tab's Runtime is enabled. */
	#runtimeWanted(tabId: number): boolean {
		for (const conn of this.#conns.values()) {
			for (const ref of conn.sessions.values()) {
				if (ref.kind === "page" && ref.tabId === tabId && ref.runtimeState === "enabled") return true;
			}
		}
		return false;
	}

	/**
	 * Every CDP command bound for a tab's root session goes through here so a
	 * released debugger costs one attach on next use instead of a failed
	 * command. `banned` (the user dismissed the infobar) still refuses.
	 */
	async #sendToTab(
		tab: TabState,
		method: string,
		params?: Record<string, unknown>,
		sessionId?: string,
	): Promise<unknown> {
		if (!tab.attached && !(await this.#ensureAttached(tab)))
			throw new Error(
				`Chrome debugger could not attach to tab ${tab.tabId} (${tab.url})${tab.banReason ? `: ${tab.banReason}` : ""}`,
			);
		tab.inflight++;
		this.#touchTab(tab);
		try {
			return await this.#rpc({ op: "send", tabId: tab.tabId, sessionId, method, params });
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
		tabId: number,
		realSessionId: string | undefined,
	): Promise<void> {
		const tab = this.#tabs.get(tabId);
		if (!tab || !this.#visibleTo(conn, tab)) throw new Error("Chrome tab is outside this connection's ownership");
		if (["Page.bringToFront", "Page.close", "Browser.close"].includes(msg.method)) {
			throw new Error("Use the explicit tab reveal/release lifecycle operation");
		}
		if (!realSessionId) this.#recordRootState(tab, msg);
		try {
			const result = await this.#sendToTab(tab, msg.method, msg.params, realSessionId);
			this.#reply(conn, msg, (result as Record<string, unknown> | undefined) ?? {});
		} catch (err) {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		}
	}

	/** Tab pseudo-sessions only exist to satisfy puppeteer's Target hierarchy. */
	#handleTabSessionCommand(conn: CdpConnection, msg: CdpCommand, ref: SessionRef): void {
		switch (msg.method) {
			case "Target.setAutoAttach": {
				const tab = this.#tabs.get(ref.tabId);
				if (!tab) {
					this.#replyError(conn, msg, `Tab ${ref.tabId} is gone`);
					return;
				}
				// Emit before replying: puppeteer's TargetManager counts page
				// children attached before the setAutoAttach response resolves.
				const pageSession = this.#mintSession(conn, "page", tab.tabId);
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
				this.#reply(conn, msg, {
					protocolVersion: "1.3",
					product: this.#extInfo?.browserVersion ?? "Chrome/unknown",
					revision: "",
					userAgent: this.#extInfo?.userAgent ?? "",
					jsVersion: "",
				});
				return;
			}
			case "Target.getBrowserContexts":
				this.#reply(conn, msg, { browserContextIds: [] });
				return;
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
				const tab = parsed ? this.#tabs.get(parsed.tabId) : undefined;
				if (!parsed || !tab || !this.#visibleTo(conn, tab)) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				if (!(await this.#ensureAttached(tab))) {
					this.#replyError(conn, msg, `Cannot attach to tab ${tab.tabId} (${tab.url})${tab.banReason ? `: ${tab.banReason}` : ""}`);
					return;
				}
				const sessionId = this.#mintSession(conn, parsed.kind, tab.tabId);
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
				const tab = parsed ? this.#tabs.get(parsed.tabId) : undefined;
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
		tabId: number,
		sourceSessionId: string | undefined,
		method: string,
		params?: Record<string, unknown>,
	): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		// Any traffic on this tab is work in progress: the debugger stays.
		this.#touchTab(tab);
		if (!sourceSessionId && method === "Page.javascriptDialogOpening") tab.dialogs.opened(params ?? {});
		// A closed dialog is not a lifecycle end: the page may open the next one
		// immediately, and only an attached debugger sees it. The attachment goes
		// back when sessions end, on release, or at turn end.
		if (!sourceSessionId && method === "Page.javascriptDialogClosed") tab.dialogs.closed();
		// The only signal that names the page which opened a popup, and the one
		// `chrome.tabs.onCreated` misattributes for a synthesized click.
		if (!sourceSessionId && method === "Page.windowOpen") tab.windowOpenedAt = Date.now();
		// Track real child sessions so downstream commands can route back.
		if (method === "Target.attachedToTarget") {
			const child = params?.sessionId;
			if (typeof child === "string") {
				tab.realSessions.add(child);
				this.#realSessionTabs.set(child, tabId);
			}
		} else if (method === "Target.detachedFromTarget") {
			const child = params?.sessionId;
			if (typeof child === "string") {
				tab.realSessions.delete(child);
				this.#realSessionTabs.delete(child);
			}
		}
		if (sourceSessionId) {
			// Event from a real child session: pass through verbatim to every
			// connection that observes this tab.
			const payload = JSON.stringify({ sessionId: sourceSessionId, method, params });
			for (const conn of this.#conns.values()) {
				if (conn.sessionsForTab(tabId, "page").length > 0) conn.socket.send(payload);
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
					if (ref.kind !== "page" || ref.tabId !== tabId) continue;
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
		// Other root-session events fan out once per minted page session.
		for (const conn of this.#conns.values()) {
			for (const pageSession of conn.sessionsForTab(tabId, "page")) {
				conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }));
			}
		}
	}

	#onTabDetached(tabId: number, reason: string, relayInitiated: boolean): void {
		const tab = this.#tabs.get(tabId);
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
		this.#log("tab detached", { tabId, reason, leased: this.managed.leaseForTab(tabId) !== undefined });
		tab.attached = false;
		tab.attaching = null;
		this.#resetRuntime(tab);
		tab.banned = true;
		tab.banReason = describeDetach(reason);
		this.#retractTab(tab);
	}

	#onTabRemoved(tabId: number): void {
		this.managed.remove(tabId);
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		this.#retractTab(tab);
		this.#tabs.delete(tabId);
	}

	#onTabUpsert(snap: TabSnapshot, opts: { silent?: boolean } = {}): void {
		snap = mergeTabSnapshot(this.#tabs.get(snap.tabId), snap);
		// A leased tab stays tracked whatever it navigates to, so its owner can
		// still release or close it; only unleased pages a debugger can never
		// attach to drop out of discovery, keeping them unclaimable.
		if (!INELIGIBLE_URL.test(snap.url) || this.managed.leaseForTab(snap.tabId) !== undefined)
			this.managed.upsert(snap);
		else this.managed.remove(snap.tabId);
		let tab = this.#tabs.get(snap.tabId);
		if (!tab) {
			tab = new TabState(snap.tabId, snap);
			this.#tabs.set(snap.tabId, tab);
		} else {
			if (tab.url !== snap.url) {
				tab.banned = false;
				tab.banReason = undefined;
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
	 * Mark a leased tab in the tab strip: swap its favicon for a cursor glyph,
	 * and keep it swapped across the page's own navigations. Best-effort — a
	 * page that refuses injection simply keeps its own icon.
	 */
	async #showLeaseBadge(tabId: number): Promise<void> {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		try {
			const installed = (await this.#sendToTab(tab, "Page.addScriptToEvaluateOnNewDocument", {
				source: LEASE_BADGE_INSTALL,
			})) as { identifier?: string } | undefined;
			tab.badgeScriptId = installed?.identifier;
			await this.#sendToTab(tab, "Runtime.evaluate", { expression: LEASE_BADGE_INSTALL });
		} catch (err) {
			this.#log("lease badge skipped", { tabId, error: err instanceof Error ? err.message : String(err) });
		}
	}

	/** The install identifier is the proof something was swapped; without it there is nothing to put back. */
	async #hideLeaseBadge(tab: TabState): Promise<void> {
		if (tab.badgeScriptId === undefined) return;
		try {
			await this.#sendToTab(tab, "Page.removeScriptToEvaluateOnNewDocument", { identifier: tab.badgeScriptId });
			await this.#sendToTab(tab, "Runtime.evaluate", { expression: LEASE_BADGE_RESTORE });
		} catch (err) {
			this.#log("lease badge restore skipped", {
				tabId: tab.tabId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		tab.badgeScriptId = undefined;
	}

	/**
	 * Hand a tab back to the user: its own favicon, no debugger, out of the
	 * owner's group, closed only when asked. Restoring and detaching before
	 * the extension touches the group — and ungrouping before any close —
	 * leaves the strip as if OMP had never driven the tab.
	 */
	async #releaseTab(tabId: number, close: boolean): Promise<void> {
		const tab = this.#tabs.get(tabId);
		if (tab) {
			if (!close) await this.#hideLeaseBadge(tab);
			await this.#detachTab(tab);
		}
		await this.#rpc({ op: "releaseTab", tabId, close });
		// Tracked only because it was leased: with the lease gone a page no
		// debugger can attach to leaves discovery, so nobody can claim it.
		if (tab && INELIGIBLE_URL.test(tab.url)) this.managed.remove(tabId);
	}

	/**
	 * Detach one tab's `chrome.debugger` without touching downstream sessions:
	 * the lease ending, and the tab going idle mid-lease, both land here.
	 */
	async #detachTab(tab: TabState): Promise<void> {
		if (!tab.attached) return;
		tab.attached = false;
		this.#touchTab(tab);
		this.#resetRuntime(tab);
		tab.reattachedAfterDetach = false;
		const done = this.#rpc({ op: "detach", tabId: tab.tabId }).then(
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
			tabId: tab.tabId,
			idleMs: this.#idleMs,
			holders: this.#sessionHolders(tab.tabId).length,
		});
		void this.#detachTab(tab);
	}

	/** Tear a tab out of every downstream connection (closed, detached, or now ineligible). */
	#retractTab(tab: TabState): void {
		for (const realSession of tab.realSessions) this.#realSessionTabs.delete(realSession);
		tab.realSessions.clear();
		for (const conn of this.#conns.values()) {
			const tabSessions = conn.sessionsForTab(tab.tabId, "tab");
			for (const pageSession of conn.sessionsForTab(tab.tabId, "page")) {
				conn.sessions.delete(pageSession);
				this.#emit(
					conn,
					"Target.detachedFromTarget",
					{ sessionId: pageSession, targetId: pageTargetId(tab.tabId) },
					tabSessions[0],
				);
			}
			for (const tabSession of tabSessions) {
				conn.sessions.delete(tabSession);
				this.#emit(conn, "Target.detachedFromTarget", { sessionId: tabSession, targetId: tabTargetId(tab.tabId) });
			}
			if (conn.discover && tab.announced) {
				this.#emit(conn, "Target.targetDestroyed", { targetId: pageTargetId(tab.tabId) });
				this.#emit(conn, "Target.targetDestroyed", { targetId: tabTargetId(tab.tabId) });
			}
		}
		tab.announced = false;
	}

	// ---- session + attach bookkeeping --------------------------------------------

	#mintSession(conn: CdpConnection, kind: "tab" | "page", tabId: number): string {
		const sessionId = `S${kind === "tab" ? "T" : "P"}${tabId}.${conn.id}.${++this.#sessionSeq}`;
		conn.sessions.set(sessionId, {
			kind,
			tabId,
			runtimeState: "default",
			runtimeContexts: new Set(),
			runtimeEnabling: null,
			runtimeEpoch: 0,
		});
		return sessionId;
	}

	#releaseSession(conn: CdpConnection, sessionId: string, parentSessionId: string | undefined): void {
		const ref = conn.sessions.get(sessionId);
		if (!ref) return;
		conn.sessions.delete(sessionId);
		const targetId = ref.kind === "tab" ? tabTargetId(ref.tabId) : pageTargetId(ref.tabId);
		this.#emit(conn, "Target.detachedFromTarget", { sessionId, targetId }, parentSessionId);
		// An explicit release of the last session must drop the attachment too,
		// or it outlives every downstream session: the infobar stays up, and
		// dismissing it bans the tab for the rest of the epoch.
		this.#detachIfUnheld(ref.tabId);
	}

	/** Whether the exact tab can be driven right now, and if not, why not. */
	debuggerState(tabId: number): DebuggerState {
		const tab = this.#tabs.get(tabId);
		if (!tab) return { attached: false, revoked: "the tab is gone from Chrome" };
		if (tab.attached) return { attached: true };
		return tab.banned ? { attached: false, revoked: tab.banReason ?? describeDetach("target_closed") } : { attached: false };
	}

	/** Serialize dialog metadata only after the caller has validated the exact lease. */
	dialogState(tabId: number): DialogState {
		const tab = this.#tabs.get(tabId);
		return tab?.attached ? tab.dialogs.snapshot() : { status: "unobserved", dialog: null };
	}

	async dialog(leaseId: string, owner: string, options: unknown, signal?: AbortSignal): Promise<DialogState> {
		const lease = this.managed.get(leaseId, owner);
		const tab = this.#tabs.get(lease.tab.tabId);
		if (!tab?.attached) throw new Error("Dialog observation is unavailable: exact tab debugger is not attached");
		const request = parseDialogRequest(options);
		if (!("id" in request)) return tab.dialogs.snapshot();
		const finish = this.managed.beginOperation(leaseId);
		try {
			if (signal?.aborted) throw new Error("Dialog response canceled before dispatch");
			return await tab.dialogs.resolve(request, params =>
				this.#rpc({ op: "send", tabId: tab.tabId, method: "Page.handleJavaScriptDialog", params }),
			);
		} finally {
			finish();
		}
	}

	#detachIfUnheld(tabId: number): void {
		if (this.#sessionHolders(tabId).length > 0) return;
		const tab = this.#tabs.get(tabId);
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
				if (ref.kind !== "page" || ref.tabId !== tab.tabId) continue;
				ref.runtimeContexts.clear();
				if (ref.runtimeState === "disabled") continue;
				conn.socket.send(JSON.stringify({ sessionId: pageSession, method: "Runtime.executionContextsCleared" }));
			}
		}
	}

	/** Connections currently holding any session on a tab. */
	#sessionHolders(tabId: number): CdpConnection[] {
		const out: CdpConnection[] = [];
		for (const conn of this.#conns.values()) {
			if (conn.sessionsForTab(tabId).length > 0) out.push(conn);
		}
		return out;
	}

	#emitTabAttached(conn: CdpConnection, tab: TabState): void {
		if (!this.#visibleTo(conn, tab)) return;
		if (conn.sessionsForTab(tab.tabId, "tab").length > 0) return;
		const sessionId = this.#mintSession(conn, "tab", tab.tabId);
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
		if (tab.banned || !this.#ext) return false;
		if (tab.attaching) return await tab.attaching;
		const attempt = this.#rpc({ op: "attach", tabId: tab.tabId })
			.then(async () => {
				tab.attached = true;
				tab.reattachedAfterDetach = true;
				this.#log("debugger attached", {
					tabId: tab.tabId,
					leased: this.managed.leaseForTab(tab.tabId) !== undefined,
				});
				// An attach nobody follows up on still has to expire.
				this.#touchTab(tab);
				await this.#restoreRoot(tab);
				// Driving starts here, so this is where the tab strip learns about
				// it — including after a turn-end detach dropped the glyph's script.
				if (this.#markTabs && this.managed.leaseForTab(tab.tabId) !== undefined)
					void this.#showLeaseBadge(tab.tabId);
				return true;
			})
			.catch(err => {
				this.#log("attach failed", {
					tabId: tab.tabId,
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

	#eligible(tab: TabState): boolean {
		if (tab.banned) return false;
		if (!tab.url) return true;
		return !INELIGIBLE_URL.test(tab.url);
	}

	#tabInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: tabTargetId(tab.tabId),
			type: "tab",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
		};
	}

	#pageInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: pageTargetId(tab.tabId),
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

	#rpc(req: RelayRpcRequest, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
		const ext = this.#ext;
		if (!ext) return Promise.reject(new Error("relay extension is not connected"));
		const id = ++this.#rpcSeq;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pendingRpc.delete(id);
			reject(new Error(`extension rpc '${req.op}' timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		this.#pendingRpc.set(id, { resolve, reject, timer });
		ext.send(JSON.stringify({ t: "rpc", id, ...req } satisfies RelayToExtMessage));
		return promise;
	}
}
