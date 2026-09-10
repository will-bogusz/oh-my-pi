import * as path from "node:path";
import { getBrowserRelayDir } from "@oh-my-pi/pi-utils";
import type { DialogState } from "../dialogs";
import { RelayAccess, type BrowserAuthentication } from "./access";
import { type DebuggerState, RelayBridge, type RelaySocket } from "./bridge";
import buildInfo from "./extension-assets/build-info.json.txt" with { type: "text" };
import type { ChromeTabLease, DiscoveredChromeTab } from "./managed-tabs";
import { isTabSnapshot, type ExtToRelayMessage, type RelayToExtMessage } from "./protocol";

/** Identity of the extension build shipped with this relay; the parity gate's yardstick. */
export const EXPECTED_EXTENSION_BUILD_ID: string = JSON.parse(buildInfo).buildId;

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
	dialog?: DialogState;
	/** Whether OMP can drive the tab right now; `revoked` says why not when the tab is open but undebuggable. */
	debugger?: DebuggerState;
	browserId: string;
	browserLabel: string;
	tab: InstanceTab;
}
interface Instance {
	id: string;
	label: string;
	bridge: RelayBridge;
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
		(hello.extensionBuildId === undefined ||
			(typeof hello.extensionBuildId === "string" && /^[a-f0-9]{64}$/.test(hello.extensionBuildId))) &&
		Array.isArray(hello.tabs) &&
		hello.tabs.length <= 20_000 &&
		Array.isArray(hello.attachedTabIds) &&
		hello.attachedTabIds.every(Number.isInteger) &&
		hello.tabs.every(isTabSnapshot)
	);
}

/** One mature CDP bridge per authenticated browser; pending handshakes cannot evict healthy peers. */
export class BrowserInstances {
	readonly access: RelayAccess;
	#instances = new Map<string, Instance>();
	#pending = new Map<RelaySocket, Pending>();
	#sockets = new Map<RelaySocket, Instance>();
	#awaitingHello = new Set<() => void>();
	/**
	 * Bound port of the relay serving these instances, set once it is listening.
	 * Only used to spell out the reinstall command a build-skewed extension needs.
	 */
	port: number | undefined;
	#options: {
		log?: (message: string, data?: Record<string, unknown>) => void;
		group?: boolean;
	};
	constructor(
		access: RelayAccess,
		options: {
			log?: (message: string, data?: Record<string, unknown>) => void;
			group?: boolean;
		} = {},
	) {
		this.access = access;
		this.#options = options;
		for (const browser of access.browsers())
			this.#instances.set(browser.id, { id: browser.id, label: browser.label, bridge: new RelayBridge(options) });
	}
	get ready(): boolean {
		return [...this.#instances.values()].some(instance => instance.bridge.ready);
	}
	/**
	 * A freshly started relay answers HTTP before the paired extension has
	 * reconnected (its retry lands within ~1 s), so the first request of a
	 * session would otherwise see zero browsers. When a browser is paired but
	 * none is connected, wait up to `graceMs` for the first hello; unpaired or
	 * already-connected relays return at once.
	 */
	settled(graceMs = 3000): Promise<void> {
		if (this.ready || this.#instances.size === 0) return Promise.resolve();
		return new Promise(resolve => {
			const done = () => {
				clearTimeout(timer);
				this.#awaitingHello.delete(done);
				resolve();
			};
			const timer = setTimeout(done, graceMs);
			this.#awaitingHello.add(done);
		});
	}
	list(): BrowserInstance[] {
		return [...this.#instances.values()].map(instance => ({
			id: instance.id,
			label: instance.label,
			connected: instance.bridge.ready,
			generation: instance.generation,
			extension: {
				loadedBuildId: instance.bridge.ready ? instance.extensionBuildId : undefined,
				expectedBuildId: EXPECTED_EXTENSION_BUILD_ID,
				status:
					!instance.bridge.ready || !instance.extensionBuildId
						? "unknown"
						: instance.extensionBuildId === EXPECTED_EXTENSION_BUILD_ID
							? "matching"
							: "different",
			},
		}));
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
			this.#sockets.get(socket)?.bridge.extMessage(socket, raw);
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
					this.#instances.set(result.browser.id, {
						...pending.authenticated,
						bridge: new RelayBridge(this.#options),
					});
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
			let instance = this.#instances.get(identity.id);
			if (!instance) {
				instance = { ...identity, bridge: new RelayBridge(this.#options) };
				this.#instances.set(identity.id, instance);
			}
			this.access.setLabel(identity.id, identity.label);
			instance.label = identity.label;
			instance.generation = crypto.randomUUID();
			instance.extensionBuildId = message.extensionBuildId;
			clearTimeout(pending.timer);
			this.#pending.delete(socket);
			this.#sockets.set(socket, instance);
			instance.bridge.extConnected(socket);
			instance.bridge.extMessage(socket, raw);
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
		this.#sockets.get(socket)?.bridge.extClosed(socket);
		this.#sockets.delete(socket);
	}

	select(id?: string): Instance {
		if (id) {
			const instance = this.#instances.get(id);
			if (!instance) throw new Error("Unknown browser instance. List paired browsers again");
			if (!instance.bridge.ready)
				throw new Error(`Browser ${JSON.stringify(instance.label)} is disconnected. Reconnect its extension`);
			return instance;
		}
		const connected = [...this.#instances.values()].filter(instance => instance.bridge.ready);
		if (connected.length !== 1)
			throw new Error(
				connected.length
					? "Multiple browsers are connected. Select an exact browserId from browser.instances()"
					: "No paired browser is connected. Run omp browser-relay pair and finish setup in the extension",
			);
		return connected[0]!;
	}
	discover(owner?: string, browserId?: string): InstanceTab[] {
		const instances = browserId
			? [this.select(browserId)]
			: [...this.#instances.values()].filter(instance => instance.bridge.ready);
		return instances.flatMap(instance =>
			instance.bridge.managed.discover(owner).map(tab => this.#tab(instance, tab)),
		);
	}
	async refresh(owner?: string, browserId?: string): Promise<InstanceTab[]> {
		const instances = browserId
			? [this.select(browserId)]
			: [...this.#instances.values()].filter(instance => instance.bridge.ready);
		await Promise.all(instances.map(instance => instance.bridge.refreshTabs()));
		return this.discover(owner, browserId);
	}

	/**
	 * Release debugger attachments across connected browsers. `owner` scopes it
	 * to one actor's tabs; omitting it releases every attachment the relay holds
	 * (process or daemon shutdown).
	 */
	async detachDebuggers(owner?: string, browserId?: string): Promise<number[]> {
		const instances = browserId
			? [this.select(browserId)]
			: [...this.#instances.values()].filter(instance => instance.bridge.ready);
		const detached = await Promise.all(instances.map(instance => instance.bridge.detachDebuggers({ owner })));
		return detached.flat();
	}

	#tab(instance: Instance, tab: DiscoveredChromeTab): InstanceTab {
		return { ...tab, browserId: instance.id, browserLabel: instance.label };
	}
	#lease(instance: Instance, lease: ChromeTabLease): InstanceLease {
		return {
			...lease,
			dialog: instance.bridge.dialogState(lease.tab.tabId),
			debugger: instance.bridge.debuggerState(lease.tab.tabId),
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
		if (!instance.bridge.ready || instance.extensionBuildId === EXPECTED_EXTENSION_BUILD_ID) return;
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
		return this.#lease(instance, await instance.bridge.managed.create(url, owner, taskId, label));
	}
	claim(id: string, owner: string, taskId?: string, label?: string, browserId?: string): InstanceLease {
		const instance = this.#forTab(id, browserId);
		this.#requireExtensionParity(instance);
		return this.#lease(instance, instance.bridge.managed.claim(id, owner, taskId, label));
	}
	#forTab(id: string, browserId?: string): Instance {
		const instance = [...this.#instances.values()].find(
			candidate => candidate.bridge.ready && candidate.bridge.managed.discover().some(tab => tab.id === id),
		);
		if (!instance || (browserId && browserId !== instance.id))
			throw new Error("Discovered tab is stale or belongs to a different browser instance");
		return instance;
	}
	async closeTab(id: string, owner: string, browserId?: string, signal?: AbortSignal): Promise<void> {
		await this.#forTab(id, browserId).bridge.managed.closeTab(id, owner, signal);
	}
	forLease(id: string): Instance | undefined {
		return [...this.#instances.values()].find(instance => instance.bridge.managed.tabForLease(id) !== undefined);
	}
	requireLease(id: string): Instance {
		const instance = this.forLease(id);
		if (!instance) throw new Error("Browser tab ownership is stale");
		return instance;
	}
	get(id: string, owner: string): InstanceLease {
		const instance = this.requireLease(id);
		this.#requireExtensionParity(instance);
		return this.#lease(instance, instance.bridge.managed.get(id, owner));
	}
	async releaseTab(id: string, owner: string, close: boolean, signal?: AbortSignal): Promise<void> {
		await this.requireLease(id).bridge.managed.releaseTab(id, owner, close, signal);
	}
	childTabs(id: string, owner: string): InstanceTab[] {
		const instance = this.requireLease(id);
		return instance.bridge.managed.childTabs(id, owner).map(tab => this.#tab(instance, tab));
	}
	unpair(id: string): void {
		this.access.unpair(id);
		for (const [socket, pending] of this.#pending)
			if (pending.authenticated?.id === id) {
				this.extClosed(socket);
				socket.close();
			}
		for (const [socket, instance] of this.#sockets)
			if (instance.id === id) {
				this.extClosed(socket);
				socket.close();
			}
		this.#instances.delete(id);
	}
	close(): void {
		for (const socket of [...this.#pending.keys(), ...this.#sockets.keys()]) {
			this.extClosed(socket);
			socket.close();
		}
	}
}
