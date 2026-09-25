import * as path from "node:path";
import { getBrowserRelayDir } from "@oh-my-pi/pi-utils";
import type { DialogJournalState } from "../dialog-journal";
import { RelayAccess, type BrowserAuthentication } from "./access";
import { type DebuggerState, RelayBridge, type RelaySocket } from "./bridge";
import buildInfo from "./extension-assets/build-info.json.txt" with { type: "text" };
import type { ChromeTabLease, DiscoveredChromeTab } from "./managed-tabs";
import { EXTENSION_RECONNECT_MAX_MS, isTabSnapshot, type ExtToRelayMessage, type RelayToExtMessage } from "./protocol";

/** Identity of the extension build shipped with this relay; the parity gate's yardstick. */
export const EXPECTED_EXTENSION_BUILD_ID: string = JSON.parse(buildInfo).buildId;
/**
 * How long a request waits for a paired but disconnected browser before it is
 * refused: one full redial interval of the extension's backoff (which grew
 * while the relay was down) plus its authenticate/hello round trip.
 */
export const RELAY_RECONNECT_GRACE_MS = EXTENSION_RECONNECT_MAX_MS + 2_000;

export interface ExtensionBuildStatus {
	/** Only present while connected; never inferred from exported files. */
	loadedBuildId?: string;
	expectedBuildId: string;
	status: "matching" | "different" | "unknown";
}

export interface BrowserInstance {
	id: string;
	label: string;
	connected: boolean;
	generation?: string;
	extension?: ExtensionBuildStatus;
}
export interface InstanceTab extends DiscoveredChromeTab {
	browserId: string;
	browserLabel: string;
}
export interface InstanceLease extends ChromeTabLease {
	dialog?: DialogJournalState;
	/** Whether OMP can drive the tab right now; `revoked` says why not when the tab is open but undebuggable. */
	debugger?: DebuggerState;
	browserId: string;
	browserLabel: string;
	tab: InstanceTab;
}
/** A paired browser. Its id is the extension's stable instance id, the one identity everywhere. */
interface Instance {
	id: string;
	label: string;
	generation?: string;
	extensionBuildId?: string;
}
interface Pending {
	authenticated?: { id: string; label: string };
	timer: NodeJS.Timeout;
}

type Hello = Extract<ExtToRelayMessage, { t: "hello" }>;
function validHello(value: unknown): value is Hello {
	if (!value || typeof value !== "object") return false;
	const hello = value as Hello;
	return (
		hello.t === "hello" &&
		typeof hello.userAgent === "string" &&
		typeof hello.browserVersion === "string" &&
		(hello.instanceId === undefined || typeof hello.instanceId === "string") &&
		(hello.extensionBuildId === undefined ||
			(typeof hello.extensionBuildId === "string" && /^[a-f0-9]{64}$/.test(hello.extensionBuildId))) &&
		Array.isArray(hello.tabs) &&
		hello.tabs.length <= 20_000 &&
		Array.isArray(hello.attachedTabIds) &&
		hello.attachedTabIds.every(Number.isInteger) &&
		hello.tabs.every(isTabSnapshot)
	);
}

/**
 * Paired browsers in front of one multi-instance CDP bridge. A socket reaches
 * the bridge only after it authenticated as a paired browser and sent a valid
 * hello, so a pending handshake can never evict a healthy peer.
 */
export class BrowserInstances {
	readonly access: RelayAccess;
	readonly bridge: RelayBridge;
	#instances = new Map<string, Instance>();
	#pending = new Map<RelaySocket, Pending>();
	/** Sockets that completed authentication and hello, with the instance they speak for. */
	#sockets = new Map<RelaySocket, string>();
	#awaitingHello = new Set<() => void>();
	/** How long the last {@link settled} wait lasted without its browser coming back; cleared by any hello. */
	#unansweredWaitMs: number | undefined;
	/**
	 * Bound port of the relay serving these instances, set once it is listening.
	 * Only used to spell out the reinstall command a build-skewed extension needs.
	 */
	port: number | undefined;
	constructor(
		access: RelayAccess,
		options: {
			log?: (message: string, data?: Record<string, unknown>) => void;
			group?: boolean;
		} = {},
	) {
		this.access = access;
		this.bridge = new RelayBridge(options);
		for (const browser of access.browsers())
			this.#instances.set(browser.id, { id: browser.id, label: browser.label });
	}
	get ready(): boolean {
		return [...this.#instances.keys()].some(id => this.bridge.connected(id));
	}
	/**
	 * A freshly started relay answers HTTP before the paired extension has
	 * reconnected: the extension redials on a backoff that grew while the relay
	 * was down, up to {@link EXTENSION_RECONNECT_MAX_MS} apart. When the browser
	 * asked for (else any paired browser) is known but not connected, wait up to
	 * `graceMs` for its hello; unpaired or already-connected relays return at
	 * once. A wait that expires is remembered, so the refusal says it waited.
	 */
	settled(opts: { browserId?: string; graceMs?: number } = {}): Promise<void> {
		const { browserId, graceMs = RELAY_RECONNECT_GRACE_MS } = opts;
		const connected = () =>
			browserId && this.#instances.has(browserId) ? this.bridge.connected(browserId) : this.ready;
		if (this.#instances.size === 0 || connected()) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const done = () => {
			clearTimeout(timer);
			this.#awaitingHello.delete(wake);
			resolve();
		};
		const wake = () => {
			if (connected()) done();
		};
		const timer = setTimeout(() => {
			this.#unansweredWaitMs = graceMs;
			done();
		}, graceMs);
		this.#awaitingHello.add(wake);
		return promise;
	}
	list(): BrowserInstance[] {
		return [...this.#instances.values()].map(instance => {
			const connected = this.bridge.connected(instance.id);
			return {
				id: instance.id,
				label: instance.label,
				connected,
				generation: instance.generation,
				extension: {
					loadedBuildId: connected ? instance.extensionBuildId : undefined,
					expectedBuildId: EXPECTED_EXTENSION_BUILD_ID,
					status:
						!connected || !instance.extensionBuildId
							? "unknown"
							: instance.extensionBuildId === EXPECTED_EXTENSION_BUILD_ID
								? "matching"
								: "different",
				},
			};
		});
	}

	extConnected(socket: RelaySocket): void {
		const timer = setTimeout(() => {
			this.#pending.delete(socket);
			socket.close();
		}, 10_000);
		timer.unref();
		this.#pending.set(socket, { timer });
	}
	extMessage(socket: RelaySocket, raw: string): void {
		const pending = this.#pending.get(socket);
		if (!pending) {
			if (this.#sockets.has(socket)) this.bridge.extMessage(socket, raw);
			return;
		}
		try {
			const message = JSON.parse(raw) as { t?: string; auth?: BrowserAuthentication };
			if (!pending.authenticated) {
				if (message.t !== "authenticate" || !message.auth)
					throw new Error("Authenticate this browser before sending tabs");
				const result = this.access.authenticate(message.auth);
				pending.authenticated = { id: result.browser.id, label: result.browser.label };
				if (!this.#instances.has(result.browser.id))
					this.#instances.set(result.browser.id, { ...pending.authenticated });
				// The build this relay expects travels with the handshake so a
				// skewed extension can reload itself instead of waiting for the
				// user to notice; extensions that predate the field ignore it.
				socket.send(
					JSON.stringify({
						t: "authenticated",
						credential: result.credential,
						expectedBuildId: EXPECTED_EXTENSION_BUILD_ID,
					} satisfies Extract<RelayToExtMessage, { t: "authenticated" }>),
				);
				return;
			}
			if (!validHello(message)) throw new Error("Invalid browser hello; healthy connection preserved");
			const identity = pending.authenticated;
			// The paired identity is the instance identity: a hello naming another
			// instance would hand this browser's socket another browser's tabs.
			if (message.instanceId !== undefined && message.instanceId !== identity.id)
				throw new Error("Browser hello names a different instance than it authenticated as; healthy connection preserved");
			let instance = this.#instances.get(identity.id);
			if (!instance) {
				instance = { ...identity };
				this.#instances.set(identity.id, instance);
			}
			this.access.setLabel(identity.id, identity.label);
			instance.label = identity.label;
			instance.generation = crypto.randomUUID();
			instance.extensionBuildId = message.extensionBuildId;
			clearTimeout(pending.timer);
			this.#pending.delete(socket);
			this.#sockets.set(socket, identity.id);
			this.bridge.extConnected(socket, identity.id);
			this.bridge.extMessage(socket, raw);
			this.#unansweredWaitMs = undefined;
			for (const wake of this.#awaitingHello) wake();
		} catch (error) {
			clearTimeout(pending.timer);
			this.#pending.delete(socket);
			socket.send(
				JSON.stringify({ t: "authenticationError", error: error instanceof Error ? error.message : String(error) }),
			);
			socket.close();
		}
	}
	extClosed(socket: RelaySocket): void {
		const pending = this.#pending.get(socket);
		if (pending) clearTimeout(pending.timer);
		this.#pending.delete(socket);
		if (this.#sockets.delete(socket)) this.bridge.extClosed(socket);
	}

	select(id?: string): Instance {
		// Every request has already waited in `settled`; a refusal after that says so.
		const waited =
			this.#unansweredWaitMs === undefined
				? ""
				: ` after waiting ${Math.round(this.#unansweredWaitMs / 100) / 10} s for its extension to reconnect to this relay`;
		if (id) {
			const instance = this.#instances.get(id);
			if (!instance) throw new Error("Unknown browser instance. List paired browsers again");
			if (!this.bridge.connected(id))
				throw new Error(
					`Browser ${JSON.stringify(instance.label)} is disconnected${waited}. Check that Chrome is running with the OMP extension enabled`,
				);
			return instance;
		}
		const connected = this.#connected();
		if (connected.length === 1) return connected[0]!;
		if (connected.length > 1)
			throw new Error("Multiple browsers are connected. Select an exact browserId from browser.instances()");
		if (this.#instances.size === 0)
			throw new Error(
				"No paired browser is connected. Run omp browser-relay pair and finish setup in the extension",
			);
		const paired = [...this.#instances.values()].map(instance => JSON.stringify(instance.label)).join(", ");
		throw new Error(
			`No paired browser is connected${waited}: ${paired} ${this.#instances.size === 1 ? "is" : "are"} paired. Check that Chrome is running with the OMP extension enabled; it redials the relay at most ${EXTENSION_RECONNECT_MAX_MS / 1000} s apart`,
		);
	}
	/** The exact browser asked for, else every connected one. */
	#scope(browserId?: string): Instance[] {
		return browserId ? [this.select(browserId)] : this.#connected();
	}
	#connected(): Instance[] {
		return [...this.#instances.values()].filter(instance => this.bridge.connected(instance.id));
	}
	discover(owner?: string, browserId?: string): InstanceTab[] {
		return this.#scope(browserId).flatMap(instance =>
			this.bridge
				.managed(instance.id)
				.discover(owner)
				.map(tab => this.#tab(instance, tab)),
		);
	}
	async refresh(owner?: string, browserId?: string): Promise<InstanceTab[]> {
		await Promise.all(this.#scope(browserId).map(instance => this.bridge.refreshTabs(instance.id)));
		return this.discover(owner, browserId);
	}

	/**
	 * Release debugger attachments across connected browsers. `owner` scopes it
	 * to one actor's tabs; omitting it releases every attachment the relay holds
	 * (process or daemon shutdown).
	 */
	async detachDebuggers(owner?: string, browserId?: string): Promise<number[]> {
		const detached = await Promise.all(
			this.#scope(browserId).map(instance => this.bridge.detachDebuggers({ owner, instanceId: instance.id })),
		);
		return detached.flat();
	}

	#tab(instance: Instance, tab: DiscoveredChromeTab): InstanceTab {
		return { ...tab, browserId: instance.id, browserLabel: instance.label };
	}
	#lease(instance: Instance, lease: ChromeTabLease): InstanceLease {
		return {
			...lease,
			dialog: this.bridge.dialogState(instance.id, lease.tab.tabId),
			debugger: this.bridge.debuggerState(instance.id, lease.tab.tabId),
			browserId: instance.id,
			browserLabel: instance.label,
			tab: this.#tab(instance, lease.tab),
		};
	}
	/**
	 * A Chrome running some other build of the extension contradicts the relay
	 * silently — a v0.2 worker focuses the window on an `activateTab` that asked
	 * it not to — so the skew is refused where a tab is acquired instead of
	 * surfacing later as Chrome doing the opposite of what the model asked.
	 * Only checked while connected: a disconnected instance has its own errors.
	 */
	#requireExtensionParity(instance: Instance): void {
		if (!this.bridge.connected(instance.id) || instance.extensionBuildId === EXPECTED_EXTENSION_BUILD_ID) return;
		const dir = path.join(getBrowserRelayDir(), "extension");
		const port = this.port === undefined ? "" : ` --port ${this.port}`;
		throw new Error(
			`Chrome ${JSON.stringify(instance.label)} is running a different build of the OMP extension than this relay: ` +
				`loaded ${instance.extensionBuildId ?? "(a build too old to report its id)"}, expected ${EXPECTED_EXTENSION_BUILD_ID}. ` +
				`Refresh it with: omp browser-relay install --dir ${dir}${port} --name ${JSON.stringify(instance.label)} — ` +
				"then open chrome://extensions and click Reload on that extension. " +
				"Once Chrome runs a build that supports it, the extension reloads itself on the next connect.",
		);
	}
	async create(url: string, owner: string, taskId: string, label?: string, browserId?: string): Promise<InstanceLease> {
		const instance = this.select(browserId);
		this.#requireExtensionParity(instance);
		return this.#lease(instance, await this.bridge.managed(instance.id).create(url, owner, taskId, label));
	}
	claim(id: string, owner: string, taskId?: string, label?: string, browserId?: string): InstanceLease {
		const instance = this.#forTab(id, browserId);
		this.#requireExtensionParity(instance);
		return this.#lease(instance, this.bridge.managed(instance.id).claim(id, owner, taskId, label));
	}
	#forTab(id: string, browserId?: string): Instance {
		const instance = this.#connected().find(candidate =>
			this.bridge
				.managed(candidate.id)
				.discover()
				.some(tab => tab.id === id),
		);
		if (!instance) throw this.bridge.stale(id);
		if (browserId && browserId !== instance.id)
			throw new Error(
				`Chrome tab ${JSON.stringify(id)} is in a different browser: ${JSON.stringify(instance.label)}, not ${JSON.stringify(browserId)}`,
			);
		return instance;
	}
	async closeTab(id: string, owner: string, browserId?: string, signal?: AbortSignal): Promise<void> {
		await this.bridge.managed(this.#forTab(id, browserId).id).closeTab(id, owner, signal);
	}
	forLease(id: string): Instance | undefined {
		const instanceId = this.bridge.instanceForLease(id);
		return instanceId === undefined ? undefined : this.#instances.get(instanceId);
	}
	requireLease(id: string): Instance {
		const instance = this.forLease(id);
		if (!instance) throw this.bridge.stale(id);
		return instance;
	}
	get(id: string, owner: string): InstanceLease {
		const instance = this.requireLease(id);
		this.#requireExtensionParity(instance);
		return this.#lease(instance, this.bridge.managed(instance.id).get(id, owner));
	}
	async reveal(id: string, owner: string): Promise<void> {
		await this.bridge.managed(this.requireLease(id).id).reveal(id, owner);
	}
	async releaseTab(id: string, owner: string, close: boolean, signal?: AbortSignal): Promise<void> {
		await this.bridge.managed(this.requireLease(id).id).releaseTab(id, owner, close, signal);
	}
	childTabs(id: string, owner: string): InstanceTab[] {
		const instance = this.requireLease(id);
		return this.bridge
			.managed(instance.id)
			.childTabs(id, owner)
			.map(tab => this.#tab(instance, tab));
	}
	unpair(id: string): void {
		this.access.unpair(id);
		for (const [socket, pending] of this.#pending)
			if (pending.authenticated?.id === id) {
				this.extClosed(socket);
				socket.close();
			}
		for (const [socket, instanceId] of this.#sockets)
			if (instanceId === id) {
				this.extClosed(socket);
				socket.close();
			}
		this.bridge.forget(id);
		this.#instances.delete(id);
	}
	close(): void {
		for (const socket of [...this.#pending.keys(), ...this.#sockets.keys()]) {
			this.extClosed(socket);
			socket.close();
		}
	}
}
