import { logger, untilAborted } from "@oh-my-pi/pi-utils";
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

/**
 * `title`/`url` match as substrings — a tab's title is whatever the page put
 * there this second (notification counts, "(1) ", live scores), so requiring
 * the whole string made `getTab({title})` unusable for the names a model can
 * actually see. Ambiguity is still an error, never a silent first-match.
 */
function matchesChromeTab(tab: InstanceTab, selector: ChromeTabSelector): boolean {
	return (
		(selector.title === undefined ||
			(tab.title ?? "").toLowerCase().includes(selector.title.trim().toLowerCase())) &&
		(selector.url === undefined || tab.url.toLowerCase().includes(selector.url.trim().toLowerCase())) &&
		(selector.browserId === undefined || tab.browserId === selector.browserId) &&
		(selector.windowId === undefined || tab.windowId === selector.windowId)
	);
}

/** Resolve a user-specified location without ordering heuristics or implicit tab creation. */
export function selectChromeTab(tabs: readonly InstanceTab[], selector: ChromeTabSelector): InstanceTab {
	if (
		(!selector.title?.trim() && !selector.url?.trim()) ||
		(selector.windowId !== undefined && (!Number.isSafeInteger(selector.windowId) || selector.windowId <= 0))
	)
		throw new ToolError(
			"getTab requires a title or URL substring; windowId, when supplied, must be a positive integer",
		);
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
	/** `tab.keep()`: leave this page open for the user when the task ends. */
	keep?: boolean;
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

/**
 * `browser.relay` is the switch for existing-Chrome control, not just for
 * `browser.open`: with it off, discovery and claiming are off too, so nothing
 * a model does spawns the relay daemon on a machine that never opted in. An
 * explicit `app.relay: true` on the call still wins, and `PI_BROWSER_RELAY`
 * remains the final kill switch.
 */
async function chromeEndpoint(session: ToolSession, signal?: AbortSignal, forced?: boolean): Promise<string> {
	const kind = resolveRelayKind({
		settingEnabled: forced === true || session.settings.get("browser.relay"),
		url: session.settings.get("browser.relayUrl"),
	});
	if (!kind)
		throw new ToolError(
			"Control of existing Chrome browsers is off. Enable the browser.relay setting (or pass app.relay:true), and check PI_BROWSER_RELAY is not set to 0.",
		);
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

/** Per-call escape hatch for an explicit `app.relay: true` against a disabled setting. */
export interface ChromeAccessOptions {
	browserId?: string;
	relay?: boolean;
}

export async function listChromeInstances(
	session: ToolSession,
	signal?: AbortSignal,
	opts: ChromeAccessOptions = {},
): Promise<BrowserInstance[]> {
	return await chromeRequest(await chromeEndpoint(session, signal, opts.relay), { action: "instances" }, signal);
}

export async function discoverChromeTabs(
	session: ToolSession,
	signal?: AbortSignal,
	opts: ChromeAccessOptions = {},
): Promise<InstanceTab[]> {
	return await chromeRequest(
		await chromeEndpoint(session, signal, opts.relay),
		{ action: "discover", owner: actor(session).owner, browserId: opts.browserId },
		signal,
	);
}

export async function closeChromeTab(
	session: ToolSession,
	id: string,
	signal?: AbortSignal,
	opts: ChromeAccessOptions = {},
): Promise<void> {
	const owner = actor(session).owner;
	await chromeRequest(
		await chromeEndpoint(session, signal, opts.relay),
		{ action: "closeTab", id, owner, browserId: opts.browserId },
		signal,
	);
	// Organization can also close a tab already controlled by this actor.
	for (const handle of handles.values()) {
		if (handle.owner === owner && handle.lease.tab.id === id) await forgetChromeHandle(handle);
	}
}

export function requireChromeHandle(id: string, session: ToolSession): ManagedChromeHandle {
	const handle = handles.get(id);
	if (!handle || handle.released || handle.owner !== actor(session).owner) {
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

/**
 * Dispose-time sweep for handles the ordinary tab reaper cannot see: a tab
 * claimed across an open JavaScript dialog has no page worker until the
 * dialog is answered, so nothing in the tabs map names it. Teardown hands
 * the page back untouched — an interrupted task's work is the user's now.
 */
export async function releaseDeferredChromeTabsForOwner(ownerId: string): Promise<number> {
	const owned = [...handles.values()].filter(
		handle => handle.ownerSessionId === ownerId && !handle.released && !getTab(handle.id),
	);
	const results = await Promise.allSettled(
		owned.map(handle => releaseChromeTab(handle, false, AbortSignal.timeout(3000))),
	);
	const failures = results.filter(result => result.status === "rejected");
	if (failures.length)
		throw new AggregateError(
			failures.map(result => result.reason),
			"Pending Chrome cleanup failed",
		);
	return owned.length;
}

/** Outcome of one turn-settle sweep over an agent session's managed Chrome tabs. */
export interface ChromeSettleResult {
	/** Handles handed back; tabs OMP created are physically closed. */
	released: number;
	/** Handles handed back with the page left open because the model called `keep()`. */
	kept: number;
}

/**
 * Turn-settle sweep over the managed Chrome tabs of one agent session
 * (issue #8246 follow-up). At the terminal settle the model is done, so
 * every lease it still holds is dead weight the user can see: the
 * "OMP is debugging this browser" infobar, the coloured task group, and
 * (for tabs OMP opened) the tabs themselves.
 *
 * Every lease is handed back; the only question is whether the page survives.
 * `tab.keep()` and a tab claimed from the user leave it open, a tab OMP
 * opened is closed. There is no cross-turn lease — the next turn re-claims by
 * exact tab id.
 *
 * Best-effort and never throws: a settle sweep that fails must not break the
 * event flow, and session dispose reaps whatever is left.
 */
export async function releaseChromeTabsForOwner(ownerId: string, signal?: AbortSignal): Promise<ChromeSettleResult> {
	const result: ChromeSettleResult = { released: 0, kept: 0 };
	if (!ownerId) return result;
	const owned = [...handles.values()].filter(handle => handle.ownerSessionId === ownerId && !handle.released);
	for (const handle of owned) {
		const keep = handle.keep === true;
		try {
			await releaseChromeTab(handle, !keep && handle.lease.created, signal ?? AbortSignal.timeout(3000));
			if (keep) result.kept++;
			else result.released++;
		} catch (error) {
			// One wedged tab must not abandon the rest of the sweep; the next
			// settle (or dispose) retries whatever is still registered.
			logger.debug("Failed to release managed Chrome tab at turn settle; continuing sweep", {
				tab: handle.lease.tab.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
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
		relay?: boolean;
	},
): Promise<ManagedChromeHandle> {
	const url = await chromeEndpoint(session, opts.signal, opts.relay);
	const identity = actor(session);
	const label = opts.label?.trim() || "Oh My Pi";
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
		// A renderer blocked by a JavaScript dialog never resolves `target.page()`,
		// so the page worker attaches on the first call after the dialog is
		// answered ({@link ensureChromePage}). The claim itself still succeeds:
		// holding the lease is the only way to answer the dialog at all.
		if (lease.dialog?.status === "open") {
			if (opts.selector && !matchesChromeTab(lease.tab, opts.selector))
				throw new ToolError("Chrome tab changed before acquisition; discover the exact target again");
		} else {
			await initializeChromePage(handle, session, opts);
		}
		handles.set(handle.id, handle);
		return handle;
	} catch (error) {
		try {
			// The caller never got this handle, so a tab OMP just created is litter.
			await releaseChromeTab(handle, lease.created, AbortSignal.timeout(3000));
		} catch (cleanupError) {
			throw new ToolError(
				`Chrome acquisition failed for ${lease.tab.id}: ${String(error)}. Cleanup also failed: ${String(cleanupError)}`,
			);
		}
		if (error instanceof ToolAbortError || (error instanceof Error && error.name === "AbortError")) throw error;
		throw new ToolError(
			`Chrome acquisition failed for tab ${lease.tab.id} in browser ${lease.browserId}: ${String(error)}. Control was released without closing a page you did not open. Discover and claim this exact tab to inspect its current state before continuing.`,
		);
	}
}

/**
 * Hand the tab back to Chrome. `close` decides whether the page survives:
 * `false` leaves it open, ungrouped, undebugged and unleased — the "keep"
 * contract; `true` closes it. Local resources are always drained, so an
 * unreachable relay can neither strand a worker nor turn a keep into a close.
 */
export async function releaseChromeTab(
	handle: ManagedChromeHandle,
	close: boolean,
	signal: AbortSignal,
): Promise<void> {
	let leaseError: unknown;
	if (!handle.released) {
		// Invalidation can tear down the worker before the HTTP reply arrives. Mark
		// local retirement first so its release callback cannot dispatch recovery twice.
		handle.released = true;
		handles.delete(handle.id);
		try {
			await chromeRequest(
				handle.url,
				{ action: "releaseTab", id: handle.lease.id, owner: handle.owner, close },
				signal,
			);
		} catch (error) {
			leaseError = new ToolError(
				`Chrome tab ${handle.lease.tab.id} (lease ${handle.lease.id}) was not confirmed as ${close ? "closed" : "released"}: ${String(error)}. Rediscover the exact tab before continuing.`,
			);
		}
	}
	try {
		await releaseTab(handle.id);
	} catch (error) {
		throw leaseError
			? new ToolError(`${String(leaseError)}. Local cleanup also failed: ${String(error)}`)
			: (error as Error);
	}
	if (leaseError) throw leaseError;
}

export async function chromeLifecycle(
	handle: ManagedChromeHandle,
	action: "keep" | "reveal" | "release" | "close",
	signal?: AbortSignal,
): Promise<void> {
	// `keep` is a local decision applied at release time; there is nothing for
	// the relay to remember, because the lease does not survive the turn.
	if (action === "keep") {
		handle.keep = true;
		return;
	}
	if (action === "reveal") {
		await chromeRequest(handle.url, { action, id: handle.lease.id, owner: handle.owner }, signal);
		return;
	}
	await releaseChromeTab(
		handle,
		action === "close" || (handle.lease.created && !handle.keep),
		signal ?? AbortSignal.timeout(3000),
	);
}

/** Local-only retirement, for a tab that is already gone from Chrome. */
async function forgetChromeHandle(handle: ManagedChromeHandle): Promise<void> {
	handle.released = true;
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
				if (!handle.released) await releaseChromeTab(handle, false, AbortSignal.timeout(3000));
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

/**
 * Make sure this handle has a live page worker before a page operation. Every
 * acquisition path lands here: a claim whose renderer was free attached during
 * acquisition and this returns immediately, while a claim taken across an open
 * JavaScript dialog attaches on the first call after the dialog is answered
 * (Chrome never resolves `target.page()` while a modal blocks the renderer).
 */
export async function ensureChromePage(
	handle: ManagedChromeHandle,
	session: ToolSession,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	if (getTab(handle.id)) return;
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

/**
 * Child tabs the relay auto-leased to this handle's owner because a page
 * script or a new-window link opened them from this exact tab. They are owned
 * but not driven; `browser.claim(row.id)` adopts one.
 */
export async function chromeChildTabs(
	handle: ManagedChromeHandle,
	signal?: AbortSignal,
): Promise<readonly InstanceTab[]> {
	const response = await chromeRequest<{ tabs?: InstanceTab[] }>(
		handle.url,
		{ action: "childTabs", id: handle.lease.id, owner: handle.owner },
		signal,
	);
	return response.tabs ?? [];
}
