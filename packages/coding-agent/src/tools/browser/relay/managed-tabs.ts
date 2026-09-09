import { mergeTabSnapshot, type TabSnapshot } from "./protocol";

export interface DiscoveredChromeTab extends TabSnapshot {
	id: string;
	ownership?: "available" | "this_actor" | "other_actor";
	/** Discovery id of the tab that opened this one, while its lease lasts. */
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

/** Default tab-group title; the client may name the group per task. */
export const DEFAULT_TAB_GROUP_LABEL = "Oh My Pi";

export interface ManagedChromeOperations {
	create(url: string): Promise<TabSnapshot>;
	/** Put the tab in the owner's group, titled `label`. */
	group(tabId: number, owner: string, label: string): Promise<void>;
	reveal(tabId: number): Promise<void>;
	/** Hand the tab back: restore the favicon, detach the debugger, leave the group, close when asked. */
	release(tabId: number, close: boolean): Promise<void>;
	invalidate(leaseId: string): void;
}

/** Physical-tab authority is independent of CDP connections and display names. */
export class ManagedChromeTabs {
	#tabs = new Map<number, DiscoveredChromeTab>();
	#leases = new Map<string, OwnedLease>();
	#owners = new Map<number, string>();
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

	remove(tabId: number): void {
		this.#tabs.delete(tabId);
		const leaseId = this.#owners.get(tabId);
		if (leaseId) this.#revoke(leaseId);
	}

	reset(): void {
		for (const leaseId of this.#leases.keys()) this.#revoke(leaseId);
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

	claim(id: string, owner: string, taskId = owner, label = DEFAULT_TAB_GROUP_LABEL): ChromeTabLease {
		const tab = [...this.#tabs.values()].find(candidate => candidate.id === id);
		if (!tab) throw new Error("The discovered tab is stale. Discover Chrome tabs again.");
		const reserved = this.#leases.get(this.#owners.get(tab.tabId) ?? "");
		// A tab auto-leased for this owner (child of one of its tabs) is adopted, not re-claimed.
		if (reserved?.owner === owner && reserved.unclaimedChild && !reserved.releasing) {
			reserved.unclaimedChild = false;
			this.#touch(reserved);
			return this.#public(reserved);
		}
		return this.#claim(tab, owner, false, taskId, label);
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
			this.#revoke(lease.id);
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
			targetId: `PAGE${tab.tabId}`,
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

	#require(id: string, owner: string): OwnedLease {
		const lease = this.#leases.get(id);
		if (!lease || lease.owner !== owner || lease.releasing)
			throw new Error("Chrome tab ownership is stale or belongs to another actor.");
		return lease;
	}

	tabForLease(id: string): number | undefined {
		const lease = this.#leases.get(id);
		return lease && !lease.releasing ? lease.tab.tabId : undefined;
	}

	/** Connection liveness is independent of actions; an idle live task retains authority. */
	connected(id: string, connectionId: number): void {
		const lease = this.#leases.get(id);
		if (!lease || lease.releasing) throw new Error("Chrome tab ownership is no longer valid");
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
			if (!lease.connections.size && this.#leases.get(lease.id) === lease) void this.#release(lease, false);
		}, this.#idleGraceMs);
		lease.idleTimer.unref();
	}

	beginOperation(id: string): () => void {
		const lease = this.#leases.get(id);
		if (!lease || lease.releasing) throw new Error("Chrome tab ownership is no longer valid");
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
		await this.#release(this.#require(id, owner), close, signal);
	}

	/** Close an exact discovered tab without ever opening a page-control connection. */
	async closeTab(id: string, owner: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const tab = [...this.#tabs.values()].find(candidate => candidate.id === id);
		if (!tab) throw new Error("The discovered tab is stale. Discover Chrome tabs again.");
		const leaseId = this.#owners.get(tab.tabId) ?? this.#claim(tab, owner, false, owner, DEFAULT_TAB_GROUP_LABEL).id;
		await this.releaseTab(leaseId, owner, true, signal);
	}

	async #release(lease: OwnedLease, close: boolean, signal?: AbortSignal): Promise<void> {
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
			if (close && this.#tabs.get(lease.tab.tabId)?.id === lease.tab.id) this.remove(lease.tab.tabId);
		} finally {
			this.#revoke(lease.id);
		}
	}

	#revoke(id: string): void {
		const lease = this.#leases.get(id);
		if (!lease) return;
		clearTimeout(lease.idleTimer);
		this.#leases.delete(id);
		for (const child of this.#leases.values()) {
			if (child.unclaimedChild && child.popupOf === lease.tab.id) void this.#release(child, false);
		}
		this.#owners.delete(lease.tab.tabId);
		if (!lease.releasing) this.#operations.invalidate(id);
	}
}
