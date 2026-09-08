/**
 * Wire protocol between the relay server and the Chrome extension.
 *
 * The extension dials out to `ws://127.0.0.1:<port>/ext` and exchanges JSON
 * messages. The relay drives the extension with numbered RPCs; the extension
 * pushes tab lifecycle and `chrome.debugger` events as they happen.
 */

/** Minimal view of a Chrome tab shared between extension and relay. */
export interface TabSnapshot {
	tabId: number;
	url: string;
	title: string;
	active: boolean;
	windowId: number;
	/** Pinned tabs are never grouped (Chrome would silently unpin them). */
	pinned: boolean;
	/** Chrome tab group id; -1 when ungrouped. */
	groupId: number;
}

/** Validate complete tab snapshots returned by the paired extension. */
export function isTabSnapshot(value: unknown): value is TabSnapshot {
	if (!value || typeof value !== "object") return false;
	const tab = value as TabSnapshot;
	return (
		Number.isInteger(tab.tabId) &&
		Number.isInteger(tab.windowId) &&
		typeof tab.url === "string" &&
		typeof tab.title === "string" &&
		typeof tab.active === "boolean" &&
		typeof tab.pinned === "boolean" &&
		Number.isInteger(tab.groupId)
	);
}

/** Empty URL means unavailable metadata, while a real blank navigation is `about:blank`. */
export function mergeTabSnapshot(previous: TabSnapshot | undefined, next: TabSnapshot): TabSnapshot {
	return { ...next, url: next.url || previous?.url || "" };
}

export interface DownloadFileQuery {
	id: string;
	url: string;
	startedAt: number;
}

export interface DownloadFileCandidate {
	id: number;
	path: string;
	url: string;
	finalUrl: string;
	referrer: string;
	startedAt: number;
	state: "in_progress" | "complete" | "interrupted";
	bytesReceived: number;
	totalBytes: number;
	/** Chrome's cached existence flag; verify the actual file separately. */
	exists: boolean;
}

export type DownloadFileLookup =
	| { available: false; reason: string }
	| {
			available: true;
			correlation: "url-and-time-candidates";
			matches: Array<{ id: string; truncated: boolean; candidates: DownloadFileCandidate[] }>;
	  };

export function isDownloadFileQueries(value: unknown): value is DownloadFileQuery[] {
	return (
		Array.isArray(value) &&
		value.length <= 256 &&
		value.every(
			entry =>
				entry &&
				typeof entry === "object" &&
				typeof entry.id === "string" &&
				entry.id.length > 0 &&
				typeof entry.url === "string" &&
				entry.url.length > 0 &&
				Number.isSafeInteger(entry.startedAt) &&
				entry.startedAt > 0 &&
				entry.startedAt < 8_640_000_000_000_000 - 5000,
		)
	);
}

/** RPCs the relay may ask the extension to perform. */
export type RelayRpcRequest =
	| { op: "queryTabs" }
	| { op: "downloadFiles"; queries: DownloadFileQuery[] }
	| { op: "attach"; tabId: number }
	| { op: "detach"; tabId: number }
	| { op: "send"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	| { op: "createTab"; url: string; windowId?: number; openerTabId?: number }
	| { op: "navigateTab"; tabId: number; url: string }
	| { op: "removeTab"; tabId: number }
	| { op: "activateTab"; tabId: number }
	| { op: "taskGroup"; tabId: number; taskId: string; label: string }
	/** Add tabs to the per-window omp group (created/reused by title), remembering prior membership. */
	| { op: "group"; tabIds: number[]; title: string; color: string }
	/** Return tabs to their pre-omp group (or ungroup); no-op for tabs the relay never grouped. */
	| { op: "ungroup"; tabIds: number[] };

/** Messages sent relay → extension. */
export type RelayToExtMessage =
	| ({ t: "rpc"; id: number } & RelayRpcRequest)
	| { t: "pong" }
	| { t: "authenticated"; credential?: string }
	| { t: "authenticationError"; error: string };

/** Messages sent extension → relay. */
export type ExtToRelayMessage =
	| {
			t: "hello";
			userAgent: string;
			browserVersion: string;
			/** Identity embedded in the executing worker; absent in legacy/unbuilt extensions. */
			extensionBuildId?: string;
			tabs: TabSnapshot[];
			/** Tabs that already have a `chrome.debugger` attachment (relay reconciles after a service-worker restart). */
			attachedTabIds: number[];
	  }
	| { t: "cdpEvent"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	| { t: "detached"; tabId: number; reason: string; relayInitiated?: boolean }
	| { t: "tabCreated"; tab: TabSnapshot }
	| { t: "tabUpdated"; tab: TabSnapshot }
	| { t: "tabRemoved"; tabId: number }
	| { t: "tabActivated"; tabId: number; windowId: number }
	| { t: "rpcResult"; id: number; ok: boolean; result?: unknown; error?: string }
	| { t: "ping" };
