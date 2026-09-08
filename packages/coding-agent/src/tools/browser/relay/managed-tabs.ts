import { mergeTabSnapshot, type TabSnapshot } from "./protocol";

export interface DiscoveredChromeTab extends TabSnapshot {
	id: string;
	ownership?: "available" | "this_actor" | "other_actor";
	popupOf?: string;
}

export interface ChromeTabLease {
	id: string;
	targetId: string;
	tab: DiscoveredChromeTab;
	created: boolean;
	retained: boolean;
}

interface OwnedLease extends ChromeTabLease {
	owner: string;
	taskId: string;
	label: string;
	popupOf?: string;
	unclaimedPopup: boolean;
	releasing: boolean;
	pending: Set<Promise<void>>;
	connections: Set<number>;
	orphanTimer?: NodeJS.Timeout;
}

export interface ManagedChromeOperations {
	create(url: string, opener?: { windowId: number; openerTabId: number }): Promise<TabSnapshot>;
	navigate?(tabId: number, url: string): Promise<void>;
	group(tabId: number, taskId: string, label: string): Promise<void>;
	reveal(tabId: number): Promise<void>;
	close(tabId: number): Promise<void>;
	invalidate(leaseId: string): void;
}

/** Physical-tab authority is independent of CDP connections and display names. */
export class ManagedChromeTabs {
	#tabs = new Map<number, DiscoveredChromeTab>();
	#leases = new Map<string, OwnedLease>();
	#owners = new Map<number, string>();
	#operations: ManagedChromeOperations;
	#orphanGraceMs: number;

	constructor(operations: ManagedChromeOperations, options: { orphanGraceMs?: number } = {}) {
		this.#operations = operations;
		this.#orphanGraceMs = options.orphanGraceMs ?? 30_000;
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

	claim(id: string, owner: string, taskId = owner, label = "OMP task"): ChromeTabLease {
		const tab = [...this.#tabs.values()].find(candidate => candidate.id === id);
		if (!tab) throw new Error("The discovered tab is stale. Discover Chrome tabs again.");
		const reserved = this.#leases.get(this.#owners.get(tab.tabId) ?? "");
		if (reserved?.owner === owner && reserved.unclaimedPopup && !reserved.releasing) {
			reserved.unclaimedPopup = false;
			this.#scheduleRecovery(reserved);
			return this.#public(reserved);
		}
		return this.#claim(tab, owner, false, taskId, label);
	}

	get(id: string, owner: string): ChromeTabLease {
		return this.#public(this.#require(id, owner));
	}

	async create(url: string, owner: string, taskId: string, label: string): Promise<ChromeTabLease> {
		const snapshot = await this.#operations.create(url);
		this.upsert(snapshot);
		const tab = this.#tabs.get(snapshot.tabId)!;
		const lease = this.#claim(tab, owner, true, taskId, label);
		try {
			await this.#operations.group(snapshot.tabId, taskId, label);
			return this.get(lease.id, owner);
		} catch (error) {
			this.#revoke(lease.id);
			await this.#operations.close(snapshot.tabId).catch(() => undefined);
			throw error;
		}
	}

	/** The parent lease is a scoped capability; ownership never comes from page script. */
	async popup(parentId: string, url: string, signal?: AbortSignal): Promise<DiscoveredChromeTab> {
		signal?.throwIfAborted();
		const parent = this.#leases.get(parentId);
		if (!parent || parent.releasing) throw new Error("Popup parent ownership is stale");
		const location = new URL(url);
		if (!["https:", "http:"].includes(location.protocol) && url !== "about:blank")
			throw new Error("Background popups support HTTP(S) and about:blank URLs only");
		if (!this.#operations.navigate) throw new Error("Background popup navigation is unavailable");
		const finish = this.beginOperation(parentId);
		try {
			const source = this.#tabs.get(parent.tab.tabId) ?? parent.tab;
			const snapshot = await this.#operations.create("about:blank", {
				windowId: source.windowId,
				openerTabId: parent.tab.tabId,
			});
			this.upsert(snapshot);
			const child = this.#claim(this.#tabs.get(snapshot.tabId)!, parent.owner, true, parent.taskId, parent.label);
			const owned = this.#leases.get(child.id)!;
			owned.popupOf = parent.tab.id;
			owned.unclaimedPopup = true;
			clearTimeout(owned.orphanTimer);
			owned.orphanTimer = undefined;
			try {
				// Recheck after physical creation so release/cancellation cannot race a late navigation.
				signal?.throwIfAborted();
				if (parent.releasing) throw new Error("Popup parent was released during creation");
				await this.#operations.group(snapshot.tabId, parent.taskId, parent.label);
				signal?.throwIfAborted();
				if (parent.releasing) throw new Error("Popup parent was released during creation");
				await this.#operations.navigate(snapshot.tabId, url);
				return this.#public(owned).tab;
			} catch (error) {
				this.#revoke(child.id);
				await this.#operations.close(snapshot.tabId).catch(() => undefined);
				throw error;
			}
		} finally {
			finish();
		}
	}

	#claim(tab: DiscoveredChromeTab, owner: string, created: boolean, taskId: string, label: string): ChromeTabLease {
		if (this.#owners.has(tab.tabId))
			throw new Error("This Chrome tab is already owned by an OMP actor. Release it before claiming it elsewhere.");
		const lease: OwnedLease = {
			id: crypto.randomUUID(),
			targetId: `PAGE${tab.tabId}`,
			tab: { ...tab },
			created,
			retained: false,
			owner,
			taskId,
			label,
			unclaimedPopup: false,
			releasing: false,
			pending: new Set(),
			connections: new Set(),
		};
		this.#leases.set(lease.id, lease);
		this.#owners.set(tab.tabId, lease.id);
		this.#scheduleRecovery(lease);
		return this.#public(lease);
	}

	#public(lease: OwnedLease): ChromeTabLease {
		return {
			id: lease.id,
			targetId: lease.targetId,
			tab: { ...(this.#tabs.get(lease.tab.tabId) ?? lease.tab), ownership: "this_actor", popupOf: lease.popupOf },
			created: lease.created,
			retained: lease.retained,
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
		clearTimeout(lease.orphanTimer);
		lease.orphanTimer = undefined;
		lease.connections.add(connectionId);
	}

	disconnected(id: string, connectionId: number): void {
		const lease = this.#leases.get(id);
		if (!lease) return;
		lease.connections.delete(connectionId);
		this.#scheduleRecovery(lease);
	}

	#scheduleRecovery(lease: OwnedLease): void {
		if (lease.releasing || lease.connections.size || lease.unclaimedPopup || lease.orphanTimer) return;
		lease.orphanTimer = setTimeout(() => {
			lease.orphanTimer = undefined;
			if (!lease.connections.size && this.#leases.get(lease.id) === lease) void this.#release(lease, "preserve");
		}, this.#orphanGraceMs);
		lease.orphanTimer.unref();
	}

	beginOperation(id: string): () => void {
		const lease = this.#leases.get(id);
		if (!lease || lease.releasing) throw new Error("Chrome tab ownership is no longer valid");
		const pending = Promise.withResolvers<void>();
		lease.pending.add(pending.promise);
		return () => {
			lease.pending.delete(pending.promise);
			pending.resolve();
		};
	}

	leaseForTab(tabId: number): string | undefined {
		return this.#owners.get(tabId);
	}

	retain(id: string, owner: string): void {
		this.#require(id, owner).retained = true;
	}

	async reveal(id: string, owner: string): Promise<void> {
		await this.#operations.reveal(this.#require(id, owner).tab.tabId);
	}

	async release(id: string, owner: string): Promise<void> {
		const lease = this.#require(id, owner);
		await this.#release(lease, "release");
	}

	/** Recovery relinquishes ownership without a separate retention request or physical closure. */
	async releasePreserving(id: string, owner: string): Promise<void> {
		await this.#release(this.#require(id, owner), "preserve");
	}

	/** Explicit closure overrides retention; release alone never closes adopted tabs. */
	async close(id: string, owner: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		await this.#release(this.#require(id, owner), "close", signal);
	}

	/** Reserve an exact discovered target without creating a page-control connection. */
	async closeTab(id: string, owner: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const tab = [...this.#tabs.values()].find(candidate => candidate.id === id);
		if (!tab) throw new Error("The discovered tab is stale. Discover Chrome tabs again.");
		const leaseId = this.#owners.get(tab.tabId) ?? this.#claim(tab, owner, false, owner, "OMP task").id;
		await this.close(leaseId, owner, signal);
	}

	async #release(lease: OwnedLease, mode: "release" | "preserve" | "close", signal?: AbortSignal): Promise<void> {
		if (lease.releasing) return;
		const id = lease.id;
		clearTimeout(lease.orphanTimer);
		lease.releasing = true;
		this.#operations.invalidate(id);
		await Promise.allSettled(lease.pending);
		try {
			if (mode === "close" || (mode === "release" && lease.created && !lease.retained)) {
				signal?.throwIfAborted();
				// Pending work may outlive a removal/reconnect that reuses the physical tab number.
				if (this.#tabs.get(lease.tab.tabId)?.id !== lease.tab.id) {
					if (mode === "close") throw new Error("The tab changed during closure. Discover Chrome tabs again.");
					return;
				}
				await this.#operations.close(lease.tab.tabId);
				if (this.#tabs.get(lease.tab.tabId)?.id === lease.tab.id) this.remove(lease.tab.tabId);
			}
		} finally {
			this.#revoke(id);
		}
	}

	#revoke(id: string): void {
		const lease = this.#leases.get(id);
		if (!lease) return;
		clearTimeout(lease.orphanTimer);
		this.#leases.delete(id);
		for (const child of this.#leases.values()) {
			if (child.unclaimedPopup && child.popupOf === lease.tab.id) void this.#release(child, "preserve");
		}
		this.#owners.delete(lease.tab.tabId);
		if (!lease.releasing) this.#operations.invalidate(id);
	}
}
