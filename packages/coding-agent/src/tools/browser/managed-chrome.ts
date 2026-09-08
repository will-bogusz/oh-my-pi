import { untilAborted } from "@oh-my-pi/pi-utils";
import type { DialogState } from "./dialogs";
import type { ToolSession } from "../../sdk";
import { ToolAbortError, ToolError, throwIfAborted } from "../tool-errors";
import { acquireBrowser, holdBrowser, releaseBrowser } from "./registry";
import { readRelayControlToken } from "./relay/access";
import type { BrowserInstance, InstanceLease, InstanceTab } from "./relay/instances";
import { ensureRelayDaemon, isLoopbackRelayUrl } from "./relay/daemon";
import { resolveRelayKind } from "./relay/kind";
import { localBrowserRequest } from "./relay/local-http";
import { acquireTab, getTab, releaseTab } from "./tab-supervisor";

const embeddingActors = new WeakMap<ToolSession, string>();
const handles = new Map<string, ManagedChromeHandle>();

export interface ChromeTabSelector {
	title?: string;
	url?: string;
	browserId?: string;
	windowId?: number;
}

function matchesChromeTab(tab: InstanceTab, selector: ChromeTabSelector): boolean {
	return (
		(selector.title === undefined || tab.title === selector.title) &&
		(selector.url === undefined || tab.url === selector.url) &&
		(selector.browserId === undefined || tab.browserId === selector.browserId) &&
		(selector.windowId === undefined || tab.windowId === selector.windowId)
	);
}

/** Resolve a user-specified location without ordering heuristics or implicit tab creation. */
export function selectChromeTab(tabs: readonly InstanceTab[], selector: ChromeTabSelector): InstanceTab {
	if (
		(!selector.title && !selector.url) ||
		(selector.windowId !== undefined && (!Number.isSafeInteger(selector.windowId) || selector.windowId <= 0))
	)
		throw new ToolError("getTab requires an exact title or URL; windowId, when supplied, must be a positive integer");
	const matches = tabs.filter(tab => matchesChromeTab(tab, selector));
	if (matches.length === 0)
		throw new ToolError(
			"No Chrome tab matches this selector. Discover tabs to inspect current titles and URLs; no tab was created or claimed.",
		);
	if (matches.length > 1)
		throw new ToolError(
			`Chrome tab selection is ambiguous (${matches.length} matches). Choose an exact discovery id or narrow the profile/window: ${JSON.stringify(matches.map(({ id, browserId, windowId, title, url }) => ({ id, browserId, windowId, title, url })))}`,
		);
	return matches[0]!;
}

export interface ManagedChromeHandle {
	id: string;
	label: string;
	owner: string;
	ownerSessionId?: string;
	url: string;
	lease: InstanceLease;
	released: boolean;
	deferred?: boolean;
	leaseHold?: WebSocket;
	initializing?: Promise<void>;
}

function actor(session: ToolSession): { owner: string; taskId: string } {
	const sessionId = session.getSessionId?.();
	const agentId = session.getAgentId?.();
	let fallback = embeddingActors.get(session);
	if (!fallback) {
		fallback = crypto.randomUUID();
		embeddingActors.set(session, fallback);
	}
	const taskId = sessionId ?? fallback;
	return { owner: JSON.stringify([taskId, agentId ?? fallback]), taskId };
}

export function browserActorId(session: ToolSession): string {
	return actor(session).owner;
}

export async function chromeRequest<T>(url: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	const response = await localBrowserRequest(`${url}/managed`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${readRelayControlToken(url)}` },
		body: JSON.stringify(args),
		signal: signal ?? AbortSignal.timeout(25_000),
	});
	if (response.status === 404 || response.status === 410)
		throw new ToolError(
			"This Chrome service is an older build without task-owned tabs. Use a separate endpoint for this build, or update that service after its active tasks finish.",
		);
	if (response.status === 401)
		throw new ToolError(
			"Browser control credential rejected. Check this endpoint’s OMP setup; the running service was preserved.",
		);
	const value: unknown = await response.json();
	if (!response.ok) {
		const message =
			value && typeof value === "object" && "error" in value
				? String(value.error)
				: `Chrome request failed (${response.status})`;
		throw new ToolError(message);
	}
	return value as T;
}

async function chromeEndpoint(session: ToolSession, signal?: AbortSignal): Promise<string> {
	const kind = resolveRelayKind({ settingEnabled: true, url: session.settings.get("browser.relayUrl") });
	if (!kind) throw new ToolError("Chrome browser access is disabled by PI_BROWSER_RELAY");
	const url = kind.cdpUrl.replace(/\/+$/, "");
	if (isLoopbackRelayUrl(url)) await ensureRelayDaemon({ cdpUrl: url, signal });
	const response = await localBrowserRequest(`${url}/health`, { signal: signal ?? AbortSignal.timeout(1500) });
	const health = response.ok ? ((await response.json()) as { service?: string; protocol?: number }) : undefined;
	if (health?.service !== "omp-browser" || health.protocol !== 2)
		throw new ToolError(
			"This endpoint uses an older browser service. Keep active tasks running and choose a separate endpoint, or update after they finish.",
		);
	return url;
}

export async function listChromeInstances(session: ToolSession, signal?: AbortSignal): Promise<BrowserInstance[]> {
	return await chromeRequest(await chromeEndpoint(session, signal), { action: "instances" }, signal);
}

export async function discoverChromeTabs(
	session: ToolSession,
	signal?: AbortSignal,
	browserId?: string,
): Promise<InstanceTab[]> {
	return await chromeRequest(
		await chromeEndpoint(session, signal),
		{ action: "discover", owner: actor(session).owner, browserId },
		signal,
	);
}

export async function closeChromeTab(
	session: ToolSession,
	id: string,
	signal?: AbortSignal,
	browserId?: string,
): Promise<void> {
	const owner = actor(session).owner;
	await chromeRequest(await chromeEndpoint(session, signal), { action: "closeTab", id, owner, browserId }, signal);
	// Organization can also close a tab already controlled by this actor.
	for (const handle of handles.values()) {
		if (handle.owner === owner && handle.lease.tab.id === id) await forgetChromeHandle(handle);
	}
}

export function requireChromeHandle(id: string, session: ToolSession): ManagedChromeHandle {
	const handle = handles.get(id);
	if (
		!handle ||
		handle.released ||
		handle.owner !== actor(session).owner ||
		(!handle.deferred && !getTab(handle.id))
	) {
		throw new ToolError(
			"Chrome tab handle is stale or belongs to another actor. Discover and claim the exact tab again.",
		);
	}
	return handle;
}

export function isManagedChromeHandle(id: string): boolean {
	return handles.has(id);
}

export async function releaseChromeTabsForActor(session: ToolSession, signal?: AbortSignal): Promise<number> {
	const owner = actor(session).owner;
	const owned = [...handles.values()].filter(handle => handle.owner === owner && !handle.released);
	for (const handle of owned) await chromeLifecycle(handle, "release", signal);
	return owned.length;
}

/** Pending-dialog handles have no page worker for the ordinary session reaper to find. */
export async function releaseDeferredChromeTabsForOwner(ownerId: string): Promise<number> {
	const owned = [...handles.values()].filter(
		handle => handle.ownerSessionId === ownerId && handle.deferred && !handle.released,
	);
	const results = await Promise.allSettled(owned.map(handle => preserveChromeTab(handle, AbortSignal.timeout(3000))));
	const failures = results.filter(result => result.status === "rejected");
	if (failures.length)
		throw new AggregateError(
			failures.map(result => result.reason),
			"Pending Chrome cleanup failed",
		);
	return owned.length;
}

export async function acquireChromeTab(
	session: ToolSession,
	opts: {
		action: "create" | "claim";
		browserId?: string;
		id?: string;
		url?: string;
		label?: string;
		selector?: ChromeTabSelector;
		timeoutMs: number;
		signal?: AbortSignal;
	},
): Promise<ManagedChromeHandle> {
	const url = await chromeEndpoint(session, opts.signal);
	const identity = actor(session);
	const label = opts.label?.trim() || "OMP task";
	if (opts.action === "claim" && !opts.id)
		throw new ToolError("Claim requires the exact id returned by browser.discover()");
	const lease = await chromeRequest<InstanceLease>(
		url,
		{
			action: opts.action,
			browserId: opts.browserId,
			...identity,
			label,
			id: opts.id,
			url: opts.url ?? "about:blank",
		},
		opts.signal,
	);
	const handle: ManagedChromeHandle = {
		id: crypto.randomUUID(),
		label,
		owner: identity.owner,
		ownerSessionId: session.getSessionId?.() ?? undefined,
		url,
		lease,
		released: false,
	};
	try {
		if (lease.dialog?.status === "open") {
			if (opts.selector && !matchesChromeTab(lease.tab, opts.selector))
				throw new ToolError("Chrome tab changed before acquisition; discover the exact target again");
			handle.deferred = true;
			handle.leaseHold = await holdChromeLease(handle, opts.signal ?? AbortSignal.timeout(opts.timeoutMs));
		} else {
			await initializeChromePage(handle, session, opts);
		}
		handles.set(handle.id, handle);
		return handle;
	} catch (error) {
		try {
			await preserveChromeTab(handle, AbortSignal.timeout(3000));
		} catch (cleanupError) {
			throw new ToolError(
				`Chrome acquisition failed for ${lease.tab.id}: ${String(error)}. Cleanup also failed: ${String(cleanupError)}`,
			);
		}
		if (error instanceof ToolAbortError || (error instanceof Error && error.name === "AbortError")) throw error;
		throw new ToolError(
			`Chrome acquisition failed for tab ${lease.tab.id} in browser ${lease.browserId}: ${String(error)}. The page was preserved and control released. Discover and claim this exact tab to inspect its current state before continuing.`,
		);
	}
}

async function preserveChromeLease(handle: ManagedChromeHandle, signal: AbortSignal): Promise<void> {
	// Invalidation can tear down the worker before the HTTP reply arrives. Mark
	// local retirement first so its release callback cannot dispatch recovery twice.
	handle.released = true;
	handle.leaseHold?.close();
	handle.leaseHold = undefined;
	handles.delete(handle.id);
	try {
		await chromeRequest(
			handle.url,
			{ action: "releasePreserving", id: handle.lease.id, owner: handle.owner },
			signal,
		);
	} catch (error) {
		throw new ToolError(
			`Preserving release was not confirmed for Chrome tab ${handle.lease.tab.id} (lease ${handle.lease.id}): ${String(error)}. No destructive release was attempted. Rediscover the exact tab before continuing.`,
		);
	}
}

/** Recovery always drains local resources; an unavailable server cannot turn preservation into closure. */
export async function preserveChromeTab(handle: ManagedChromeHandle, signal: AbortSignal): Promise<void> {
	let cleanupError: unknown;
	try {
		if (!handle.released) await preserveChromeLease(handle, signal);
	} catch (error) {
		cleanupError = error;
	}
	try {
		await releaseTab(handle.id);
	} catch (error) {
		cleanupError = cleanupError
			? new ToolError(`${String(cleanupError)}. Local cleanup also failed: ${String(error)}`)
			: error;
	}
	if (cleanupError) throw cleanupError;
}

export async function chromeLifecycle(
	handle: ManagedChromeHandle,
	action: "retain" | "reveal" | "release" | "close",
	signal?: AbortSignal,
): Promise<void> {
	await chromeRequest(handle.url, { action, id: handle.lease.id, owner: handle.owner }, signal);
	if (action === "retain") handle.lease.retained = true;
	if (action === "release" || action === "close") await forgetChromeHandle(handle);
}

async function forgetChromeHandle(handle: ManagedChromeHandle): Promise<void> {
	handle.released = true;
	handle.leaseHold?.close();
	handle.leaseHold = undefined;
	handles.delete(handle.id);
	await releaseTab(handle.id);
}

/** Dialog control bypasses the renderer and a worker blocked by the modal. */
export async function chromeDialog(
	handle: ManagedChromeHandle,
	options: unknown,
	signal?: AbortSignal,
): Promise<DialogState> {
	return await chromeRequest<DialogState>(
		handle.url,
		{ action: "dialog", id: handle.lease.id, owner: handle.owner, dialog: options },
		signal,
	);
}

/** Keep ownership alive without enabling Runtime/Page or waiting for a renderer. */
async function holdChromeLease(handle: ManagedChromeHandle, signal: AbortSignal): Promise<WebSocket> {
	throwIfAborted(signal);
	const endpoint = new URL(handle.url);
	endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
	endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/cdp`;
	endpoint.search = "";
	endpoint.searchParams.set("lease", handle.lease.id);
	const socket = new WebSocket(endpoint);
	const connected = Promise.withResolvers<void>();
	socket.addEventListener("open", () => connected.resolve(), { once: true });
	socket.addEventListener(
		"error",
		() => connected.reject(new ToolError("Pending-dialog ownership connection failed")),
		{ once: true },
	);
	socket.addEventListener(
		"close",
		() => connected.reject(new ToolError("Pending-dialog ownership connection closed before acquisition")),
		{ once: true },
	);
	try {
		await untilAborted(signal, () => connected.promise);
		return socket;
	} catch (error) {
		socket.close();
		throw error;
	}
}

async function initializeChromePage(
	handle: ManagedChromeHandle,
	session: ToolSession,
	opts: { timeoutMs: number; signal?: AbortSignal; selector?: ChromeTabSelector },
): Promise<void> {
	const browser = await acquireBrowser(
		{ kind: "connected", cdpUrl: `${handle.url}/managed/${handle.lease.id}` },
		{ cwd: session.cwd, signal: opts.signal },
	);
	holdBrowser(browser);
	try {
		const { tab } = await acquireTab(handle.id, browser, {
			targetId: handle.lease.targetId,
			timeoutMs: opts.timeoutMs,
			signal: opts.signal,
			ownerSessionId: session.getSessionId?.() ?? undefined,
			ownerActorId: handle.owner,
			onRelease: async () => {
				if (!handle.released) await preserveChromeLease(handle, AbortSignal.timeout(3000));
			},
		});
		// Creation initially reports a pending URL and no group. Refresh after the
		// worker has attached, retaining the URL/title read directly from this page.
		handle.lease = await chromeRequest<InstanceLease>(
			handle.url,
			{ action: "get", id: handle.lease.id, owner: handle.owner },
			opts.signal,
		);
		if (opts.selector && !matchesChromeTab(handle.lease.tab, opts.selector))
			throw new ToolError(
				"Chrome tab changed while acquiring it. Discover again; the previous match was released without navigation or input.",
			);
		if (tab.info.url) handle.lease.tab.url = tab.info.url;
		if (tab.info.title) handle.lease.tab.title = tab.info.title;
		if (opts.selector && !matchesChromeTab(handle.lease.tab, opts.selector))
			throw new ToolError(
				"Chrome tab changed while acquiring it. Discover again; the previous match was released without navigation or input.",
			);
	} finally {
		await releaseBrowser(browser, { kill: false });
	}
}

/** After an explicit dialog decision, initialize the same leased page on first normal use. */
export async function resumeChromePage(
	handle: ManagedChromeHandle,
	session: ToolSession,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	if (!handle.deferred) return;
	if (!handle.initializing) {
		handle.initializing = (async () => {
			const state = await chromeDialog(handle, {}, signal);
			if (state.status === "open")
				throw new ToolError(
					"This tab still has an open dialog. Inspect tab.dialog() and answer its current id before using the page",
				);
			if (state.status !== "closed")
				throw new ToolError(
					"The pending dialog's outcome is unknown. Page control cannot resume until closure is observed; inspect tab.dialog() before continuing",
				);
			await initializeChromePage(handle, session, { timeoutMs, signal });
			handle.deferred = false;
			handle.leaseHold?.close();
			handle.leaseHold = undefined;
		})();
		const initializing = handle.initializing;
		const settled = () => {
			if (handle.initializing === initializing) handle.initializing = undefined;
		};
		// A caller can stop waiting before worker initialization has unwound.
		// Keep the guard until the operation itself settles to prevent duplicate workers.
		void initializing.then(settled, settled);
	}
	const initializing = handle.initializing;
	await untilAborted(signal, () => initializing);
}
