/** `getTargets().attached` includes other debuggers; only our command channel proves ownership. */
export async function ownedDebuggerTabs(
	targets: ReadonlyArray<{ attached: boolean; tabId?: number }>,
	probe: (tabId: number) => Promise<unknown>,
): Promise<number[]> {
	const owned = await Promise.all(
		targets.map(async target => {
			if (!target.attached || target.tabId === undefined) return undefined;
			try {
				await probe(target.tabId);
				return target.tabId;
			} catch {
				return undefined;
			}
		}),
	);
	return owned.filter((tabId): tabId is number => tabId !== undefined);
}

/** A release window opened by {@link DebuggerAttachments.scheduleRelease}. */
interface PendingRelease {
	promise: Promise<number[]>;
	resolve: (detached: number[] | Promise<number[]>) => void;
	timer: NodeJS.Timeout;
}

/**
 * The tabs this extension currently holds a `chrome.debugger` attachment on,
 * and the policy for giving them back.
 *
 * Chrome keeps an attachment — and the "<extension> started debugging this
 * browser" infobar it draws once per attach — until the extension detaches or
 * is unloaded; it disappears roughly 5 s after the last detach. A relay that
 * only ever attaches therefore leaves that bar over the user's browser for as
 * long as omp runs. Every path that ends our authority to drive the browser
 * (socket close, worker unload, an explicit host request) must release here.
 */
export class DebuggerAttachments {
	#tabs = new Set<number>();
	#detach: (tabId: number) => Promise<void>;
	#graceMs: number;
	#pending: PendingRelease | null = null;
	#log: (message: string, data?: Record<string, unknown>) => void;
	#surrender: ((tabIds: readonly number[]) => Promise<void>) | undefined;

	constructor(opts: {
		detach: (tabId: number) => Promise<void>;
		/** Reconnect window before a dropped relay socket costs the attachments. */
		graceMs?: number;
		/**
		 * Run when the grace really expires, before the attachments go: the last
		 * chance to give the pages back anything only a live attachment can
		 * reach (the lease badge) and to undo the strip marks the dead relay left.
		 */
		surrender?: (tabIds: readonly number[]) => Promise<void>;
		log?: (message: string, data?: Record<string, unknown>) => void;
	}) {
		this.#detach = opts.detach;
		this.#graceMs = opts.graceMs ?? 2_000;
		this.#surrender = opts.surrender;
		this.#log = opts.log ?? ((): void => {});
	}

	/** An attach succeeded (or a handshake reported a pre-existing one). */
	attached(tabId: number): void {
		this.#tabs.add(tabId);
	}

	/** The attachment is gone: our detach, a native `onDetach`, or a closed tab. */
	detached(tabId: number): void {
		this.#tabs.delete(tabId);
	}

	tabs(): number[] {
		return [...this.#tabs];
	}

	/**
	 * Detach the named tabs (default: every owned one) and return those Chrome
	 * confirmed. Forgetting the tab before the call keeps a failed detach from
	 * pinning a stale attachment forever; the next hello re-seeds the truth.
	 */
	async detachAll(tabIds?: readonly number[]): Promise<number[]> {
		const targets = (tabIds ?? this.tabs()).filter(tabId => this.#tabs.has(tabId));
		const detached = await Promise.all(
			targets.map(async tabId => {
				this.#tabs.delete(tabId);
				try {
					await this.#detach(tabId);
					return tabId;
				} catch (error) {
					this.#log("detach failed", { tabId, error: String(error) });
					return undefined;
				}
			}),
		);
		return detached.filter((tabId): tabId is number => tabId !== undefined);
	}

	/**
	 * The relay is unreachable. Give a reconnect the grace window — a relay
	 * restart mid-task must not cost a re-attach — then release everything.
	 * Resolves with the tabs released, or an empty list when {@link hold} or
	 * {@link releaseNow} settles the window first.
	 */
	scheduleRelease(): Promise<number[]> {
		const open = this.#pending;
		if (open) return open.promise;
		const pending = Promise.withResolvers<number[]>();
		const timer = setTimeout(() => {
			this.#pending = null;
			this.#log("releasing debugger attachments", { tabs: this.#tabs.size });
			const held = [...this.#tabs];
			pending.resolve(
				(async () => {
					// A failed handback must still cost the attachments.
					await this.#surrender?.(held).catch((error: unknown) => {
						this.#log("surrender failed", { error: String(error) });
					});
					return await this.detachAll();
				})(),
			);
		}, this.#graceMs);
		this.#pending = { promise: pending.promise, resolve: pending.resolve, timer };
		return pending.promise;
	}

	/** The relay is live again; keep the attachments we already hold. */
	hold(): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = null;
		clearTimeout(pending.timer);
		pending.resolve([]);
	}

	/**
	 * The worker is being unloaded. `onSuspend` gives no time to await, so fire
	 * the detaches and drop the bookkeeping synchronously.
	 */
	releaseNow(): void {
		this.hold();
		for (const tabId of this.#tabs) void this.#detach(tabId).catch(() => {});
		this.#tabs.clear();
	}
}
