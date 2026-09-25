import { mergeTabSnapshot, type TabSnapshot } from "./protocol";

export interface DiscoveredChromeTab extends TabSnapshot {
	id: string;
	ownership?: "available" | "this_actor" | "other_actor";
	/** Discovery id of the nearest still-leased tab this one was opened from. */
	popupOf?: string;
}

export interface ChromeTabLease {
	id: string;
	targetId: string;
	tab: DiscoveredChromeTab;
	created: boolean;
}

interface OwnedLease extends ChromeTabLease {
	owner: string;
	taskId: string;
	label: string;
	popupOf?: string;
	/** Auto-leased child of a leased tab; the owner has not asked for it yet. */
	unclaimedChild: boolean;
	releasing: boolean;
	pending: Set<Promise<void>>;
	connections: Set<number>;
	idleTimer?: NodeJS.Timeout;
}

/** Why a lease or a discovered tab id stopped resolving. */
interface Ending {
	/** Completes "Chrome tab <title> …", e.g. "was closed in Chrome". */
	reason: string;
	page: Pick<TabSnapshot, "title" | "url">;
	/** Discovery id of the page; still discoverable means the page outlived the lease. */
	tabId: string;
}

/** Endings remembered per browser; the oldest are forgotten first. */
const ENDINGS_KEPT = 512;

/** Default tab-group title; the client may name the group per task. */
export const DEFAULT_TAB_GROUP_LABEL = "Oh My Pi";

/**
 * A lease or discovered tab id that no longer resolves. The message says why
 * and what to do next; the relay marks these answers so a client can retire
 * its handle instead of retrying it.
 */
export class ChromeTabGoneError extends Error {
	override name = "ChromeTabGoneError";
}

/** Origin and path only: a query or fragment can be longer than the whole reason. */
export function shortUrl(url: string): string {
	let short = url;
	try {
		const parsed = new URL(url);
		if (parsed.origin !== "null") short = parsed.origin + parsed.pathname;
	} catch {}
	return short.length > 96 ? `${short.slice(0, 95)}…` : short;
}

/** How messages name a Chrome tab: its title, else where it is, short enough to leave room for why. */
export function chromeTabName(page: Pick<TabSnapshot, "title" | "url">): string {
	const name = page.title || shortUrl(page.url);
	return JSON.stringify(name.length > 60 ? `${name.slice(0, 59)}…` : name);
}

/**
 * The one sentence for a Chrome tab OMP can no longer drive: which page, why,
 * and the recovery — claim it again while its discovery id still names it,
 * otherwise discover again.
 */
export function describeGoneTab(page: Pick<TabSnapshot, "title" | "url">, reason: string, reclaimId?: string): string {
	return `Chrome tab ${chromeTabName(page)} ${reason}. ${reclaimId ? `Claim ${JSON.stringify(reclaimId)} again to drive it.` : "Discover tabs again."}`;
}

/** An id nothing remembers: never issued here, forgotten, or from before a relay restart. */
export function unknownChromeTab(id: string): ChromeTabGoneError {
	return new ChromeTabGoneError(
		`Chrome tab id ${JSON.stringify(id)} is unknown to this relay (it may have restarted since). Discover tabs again.`,
	);
}

export interface ManagedChromeOperations {
	/** Target id a downstream connection addresses this browser's tab by. */
	targetId(tabId: number): string;
	create(url: string): Promise<TabSnapshot>;
	/** Put the tab in the owner's group, titled `label`. */
	group(tabId: number, owner: string, label: string): Promise<void>;
	reveal(tabId: number): Promise<void>;
	/** Hand the tab back: restore the favicon, detach the debugger, leave the group, close when asked. */
	release(tabId: number, close: boolean): Promise<void>;
	invalidate(leaseId: string): void;
	/** An explicit claim is the go-ahead to try the debugger once more, even where Chrome refused it before. */
	allowAttach(tabId: number): void;
}

/** Physical-tab authority is independent of CDP connections and display names. */
export class ManagedChromeTabs {
	#tabs = new Map<number, DiscoveredChromeTab>();
	#leases = new Map<string, OwnedLease>();
	#owners = new Map<number, string>();
	/** Lease and discovery ids that ended, with why; one namespace since both are UUIDs. */
	#endings = new Map<string, Ending>();
	#operations: ManagedChromeOperations;
	#idleGraceMs: number;

	constructor(operations: ManagedChromeOperations, options: { orphanGraceMs?: number } = {}) {
		this.#operations = operations;
		this.#idleGraceMs = options.orphanGraceMs ?? 300_000;
	}

	upsert(tab: TabSnapshot): void {
		const previous = this.#tabs.get(tab.tabId);
		this.#tabs.set(tab.tabId, { ...mergeTabSnapshot(previous, tab), id: previous?.id ?? crypto.randomUUID() });
	}

	/** The tab left discovery; `reason` completes "Chrome tab X …" for anyone still holding its ids. */
	remove(tabId: number, reason = "was closed in Chrome"): void {
		const tab = this.#tabs.get(tabId);
		if (tab) {
			this.#tabs.delete(tabId);
			this.#end(tab.id, tab, reason);
		}
		const leaseId = this.#owners.get(tabId);
		if (leaseId) this.#revoke(leaseId, reason);
	}

	/** The extension connection is gone: every lease ends and every discovery id is reissued on reconnect. */
	reset(): void {
		const reason = "was dropped when the OMP extension in Chrome disconnected";
		for (const leaseId of this.#leases.keys()) this.#revoke(leaseId, reason);
		for (const tab of this.#tabs.values()) this.#end(tab.id, tab, reason);
		this.#tabs.clear();
	}

	discover(owner?: string): DiscoveredChromeTab[] {
		return [...this.#tabs.values()].map(tab => {
			const lease = this.#leases.get(this.#owners.get(tab.tabId) ?? "");
			return {
				...tab,
				ownership: !lease ? "available" : lease.owner === owner ? "this_actor" : "other_actor",
				popupOf: lease?.popupOf,
			};
		});
	}

	/**
	 * Why `id` (a lease or a discovered tab) cannot be used, when this browser
	 * remembers it; undefined for an id it never issued.
	 */
	unavailable(id: string): ChromeTabGoneError | undefined {
		if (this.#leases.get(id)?.releasing)
			return new ChromeTabGoneError("This Chrome tab is being released by its owner; it takes no new work.");
		const ending = this.#endings.get(id);
		if (!ending) return undefined;
		if (this.#discovered(ending.tabId))
			return new ChromeTabGoneError(describeGoneTab(ending.page, ending.reason, ending.tabId));
		// The page is gone as well; its own ending is the more exact account.
		const closed = this.#endings.get(ending.tabId) ?? ending;
		return new ChromeTabGoneError(describeGoneTab(ending.page, closed.reason));
	}

	claim(id: string, owner: string, taskId = owner, label = DEFAULT_TAB_GROUP_LABEL): ChromeTabLease {
		const tab = this.#discovered(id);
		if (!tab) throw this.#gone(id);
		const held = this.#leases.get(this.#owners.get(tab.tabId) ?? "");
		let lease: ChromeTabLease;
		// The owner's own lease — a popup auto-leased to it, or a tab whose
		// handle it lost — comes back as it is instead of reading as taken.
		if (held?.owner === owner && !held.releasing) {
			held.unclaimedChild = false;
			this.#touch(held);
			lease = this.#public(held);
		} else {
			lease = this.#claim(tab, owner, false, taskId, label);
		}
		this.#operations.allowAttach(tab.tabId);
		return lease;
	}

	get(id: string, owner: string): ChromeTabLease {
		const lease = this.#require(id, owner);
		this.#touch(lease);
		return this.#public(lease);
	}

	async create(url: string, owner: string, taskId: string, label = DEFAULT_TAB_GROUP_LABEL): Promise<ChromeTabLease> {
		const snapshot = await this.#operations.create(url);
		this.upsert(snapshot);
		const tab = this.#tabs.get(snapshot.tabId)!;
		const lease = this.#claim(tab, owner, true, taskId, label);
		try {
			await this.#operations.group(snapshot.tabId, owner, label);
			return this.get(lease.id, owner);
		} catch (error) {
			this.#revoke(lease.id, "was closed because OMP could not group it");
			await this.#operations.release(snapshot.tabId, true).catch(() => undefined);
			throw error;
		}
	}

	/**
	 * A tab the browser opened from a leased tab (`window.open`, target=_blank,
	 * native popup). Ownership follows the opener — never page script — so the
	 * child is driven, grouped and released with the rest of the owner's tabs.
	 */
	async adoptChild(snapshot: TabSnapshot, openerTabId: number): Promise<void> {
		const parent = this.#leases.get(this.#owners.get(openerTabId) ?? "");
		if (!parent || parent.releasing) return;
		this.upsert(snapshot);
		const tab = this.#tabs.get(snapshot.tabId);
		if (!tab || this.#owners.has(snapshot.tabId)) return;
		const lease = this.#claim(tab, parent.owner, true, parent.taskId, parent.label);
		const owned = this.#leases.get(lease.id)!;
		owned.popupOf = parent.tab.id;
		owned.unclaimedChild = true;
		await this.#operations.group(snapshot.tabId, parent.owner, parent.label).catch(() => undefined);
	}

	/** Tabs opened by one of this owner's tabs since it was claimed, oldest first. */
	childTabs(parentId: string, owner: string): DiscoveredChromeTab[] {
		const parent = this.#require(parentId, owner);
		this.#touch(parent);
		const out: DiscoveredChromeTab[] = [];
		for (const lease of this.#leases.values()) {
			if (lease.popupOf !== parent.tab.id || lease.releasing) continue;
			out.push(this.#public(lease).tab);
		}
		return out;
	}

	#claim(tab: DiscoveredChromeTab, owner: string, created: boolean, taskId: string, label: string): ChromeTabLease {
		if (this.#owners.has(tab.tabId))
			throw new Error("This Chrome tab is already owned by an OMP actor. Release it before claiming it elsewhere.");
		const lease: OwnedLease = {
			id: crypto.randomUUID(),
			targetId: this.#operations.targetId(tab.tabId),
			tab: { ...tab },
			created,
			owner,
			taskId,
			label,
			unclaimedChild: false,
			releasing: false,
			pending: new Set(),
			connections: new Set(),
		};
		this.#leases.set(lease.id, lease);
		this.#owners.set(tab.tabId, lease.id);
		this.#touch(lease);
		return this.#public(lease);
	}

	#public(lease: OwnedLease): ChromeTabLease {
		return {
			id: lease.id,
			targetId: lease.targetId,
			tab: { ...(this.#tabs.get(lease.tab.tabId) ?? lease.tab), ownership: "this_actor", popupOf: lease.popupOf },
			created: lease.created,
		};
	}

	#discovered(id: string): DiscoveredChromeTab | undefined {
		for (const tab of this.#tabs.values()) if (tab.id === id) return tab;
		return undefined;
	}

	#gone(id: string): ChromeTabGoneError {
		return this.unavailable(id) ?? unknownChromeTab(id);
	}

	/** Remember why an id ended; the newest account of an id replaces the older one. */
	#end(id: string, tab: DiscoveredChromeTab, reason: string): void {
		this.#endings.delete(id);
		this.#endings.set(id, { reason, page: { title: tab.title, url: tab.url }, tabId: tab.id });
		if (this.#endings.size > ENDINGS_KEPT) this.#endings.delete(this.#endings.keys().next().value!);
	}

	/** A lease that can take new work. */
	#live(id: string): OwnedLease {
		const lease = this.#leases.get(id);
		if (!lease || lease.releasing) throw this.#gone(id);
		return lease;
	}

	#require(id: string, owner: string): OwnedLease {
		const lease = this.#live(id);
		if (lease.owner !== owner) throw new Error("This Chrome tab lease belongs to another actor.");
		return lease;
	}

	tabForLease(id: string): number | undefined {
		const lease = this.#leases.get(id);
		return lease && !lease.releasing ? lease.tab.tabId : undefined;
	}

	/** Connection liveness is independent of actions; an idle live task retains authority. */
	connected(id: string, connectionId: number): void {
		const lease = this.#live(id);
		clearTimeout(lease.idleTimer);
		lease.idleTimer = undefined;
		lease.connections.add(connectionId);
	}

	disconnected(id: string, connectionId: number): void {
		const lease = this.#leases.get(id);
		if (!lease) return;
		lease.connections.delete(connectionId);
		this.#touch(lease);
	}

	/**
	 * A lease with no live connection is reclaimed once nothing has touched it
	 * for the grace window: the host process can die without settling, and the
	 * relay outlives it, so a forgotten lease would block the tab forever.
	 */
	#touch(lease: OwnedLease): void {
		if (lease.releasing || lease.connections.size) return;
		clearTimeout(lease.idleTimer);
		lease.idleTimer = setTimeout(() => {
			lease.idleTimer = undefined;
			if (!lease.connections.size && this.#leases.get(lease.id) === lease)
				void this.#release(
					lease,
					false,
					`was released after ${Math.ceil(this.#idleGraceMs / 1000)} s with no OMP connection`,
				);
		}, this.#idleGraceMs);
		lease.idleTimer.unref();
	}

	beginOperation(id: string): () => void {
		const lease = this.#live(id);
		const pending = Promise.withResolvers<void>();
		lease.pending.add(pending.promise);
		return () => {
			lease.pending.delete(pending.promise);
			pending.resolve();
			if (this.#leases.get(id) === lease) this.#touch(lease);
		};
	}

	leaseForTab(tabId: number): string | undefined {
		return this.#owners.get(tabId);
	}

	/** Physical tabs one actor currently owns; a releasing lease no longer counts. */
	tabsForOwner(owner: string): number[] {
		const out: number[] = [];
		for (const lease of this.#leases.values()) {
			if (lease.owner === owner && !lease.releasing) out.push(lease.tab.tabId);
		}
		return out;
	}

	async reveal(id: string, owner: string): Promise<void> {
		await this.#operations.reveal(this.#require(id, owner).tab.tabId);
	}

	/**
	 * Give the tab back to the user. `close: false` keeps the page: it leaves
	 * the group, loses the debugger and the glyph, and stops being owned.
	 */
	async releaseTab(id: string, owner: string, close: boolean, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		await this.#release(this.#require(id, owner), close, "was released by its owner", signal);
	}

	/** Close an exact discovered tab without ever opening a page-control connection. */
	async closeTab(id: string, owner: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const tab = this.#discovered(id);
		if (!tab) throw this.#gone(id);
		const leaseId = this.#owners.get(tab.tabId) ?? this.#claim(tab, owner, false, owner, DEFAULT_TAB_GROUP_LABEL).id;
		await this.releaseTab(leaseId, owner, true, signal);
	}

	async #release(lease: OwnedLease, close: boolean, reason: string, signal?: AbortSignal): Promise<void> {
		if (lease.releasing) return;
		clearTimeout(lease.idleTimer);
		lease.releasing = true;
		this.#operations.invalidate(lease.id);
		await Promise.allSettled(lease.pending);
		try {
			// Pending work may outlive a removal/reconnect that reuses the physical tab number.
			if (this.#tabs.get(lease.tab.tabId)?.id !== lease.tab.id) {
				if (close) throw new Error("The tab changed during closure. Discover Chrome tabs again.");
				return;
			}
			signal?.throwIfAborted();
			await this.#operations.release(lease.tab.tabId, close);
			if (close && this.#tabs.get(lease.tab.tabId)?.id === lease.tab.id)
				this.remove(lease.tab.tabId, "was closed by its owner");
		} finally {
			this.#revoke(lease.id, reason);
		}
	}

	/** The one place a lease stops existing; its ending is recorded here, whatever ended it. */
	#revoke(id: string, reason: string): void {
		const lease = this.#leases.get(id);
		if (!lease) return;
		clearTimeout(lease.idleTimer);
		this.#leases.delete(id);
		this.#owners.delete(lease.tab.tabId);
		// The latest metadata of this lease's own page, never a later tab that reused its number.
		const page = this.#tabs.get(lease.tab.tabId);
		this.#end(id, page?.id === lease.tab.id ? page : lease.tab, reason);
		if (!lease.releasing) this.#operations.invalidate(id);
		// A popup outlives the page between it and the tab being driven (a
		// sign-in window that opens the consent page, then closes): children
		// move up to this lease's own opener, and only unclaimed ones with no
		// opener left are handed back with it.
		const heir =
			lease.popupOf !== undefined && [...this.#leases.values()].some(other => other.tab.id === lease.popupOf)
				? lease.popupOf
				: undefined;
		for (const child of this.#leases.values()) {
			if (child.popupOf !== lease.tab.id) continue;
			child.popupOf = heir;
			if (heir === undefined && child.unclaimedChild)
				void this.#release(child, false, `was released when the tab that opened it ${reason}`);
		}
	}
}
