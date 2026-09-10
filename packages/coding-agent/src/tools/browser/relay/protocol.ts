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

/** RPCs the relay may ask the extension to perform. */
export type RelayRpcRequest =
	| { op: "queryTabs" }
	| { op: "attach"; tabId: number }
	| { op: "detach"; tabId: number }
	/** Release the extension's debugger attachments (default: all it owns) and report which. */
	| { op: "detachAll"; tabIds?: number[] }
	| { op: "send"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	| { op: "createTab"; url: string }
	/**
	 * Select a tab. `focusWindow` raises its window too — a deliberate reveal.
	 * Adoption never sends this: when Chrome raises and selects a page-opened
	 * child, that child is what the user expects a new tab to look like, and
	 * putting the displaced tab back only makes OMP look like it showed the
	 * wrong page.
	 */
	| { op: "activateTab"; tabId: number; focusWindow: boolean }
	/**
	 * Put one tab in the owner's tab group, created on first use per window and
	 * titled `label`; one group per owner, reused by every later claim.
	 */
	| { op: "group"; tabId: number; owner: string; label: string }
	/**
	 * Hand a tab back to the user: leave its group, then close it when asked.
	 * Ungrouping first is what keeps Chrome from saving the (now empty) group
	 * as a chip in the bookmarks bar.
	 */
	| { op: "releaseTab"; tabId: number; close: boolean };

/** Messages sent relay → extension. */
export type RelayToExtMessage =
	| ({ t: "rpc"; id: number } & RelayRpcRequest)
	| { t: "pong" }
	/**
	 * `expectedBuildId` is the extension build this relay was built against.
	 * Additive and optional in both directions: an older relay omits it and an
	 * older extension ignores it, so neither side's handshake changes shape.
	 */
	| { t: "authenticated"; credential?: string; expectedBuildId?: string }
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
	/**
	 * A tab opened by another tab (`window.open`, target=_blank, native popup).
	 * When the opener holds a lease the relay leases the child to the opener's
	 * owner, in the same group, and serves it from the `childTabs` action.
	 */
	| { t: "tabOpened"; tab: TabSnapshot; openerTabId: number }
	| { t: "tabUpdated"; tab: TabSnapshot }
	| { t: "tabRemoved"; tabId: number }
	| { t: "tabActivated"; tabId: number; windowId: number }
	| { t: "rpcResult"; id: number; ok: boolean; result?: unknown; error?: string }
	| { t: "ping" };
