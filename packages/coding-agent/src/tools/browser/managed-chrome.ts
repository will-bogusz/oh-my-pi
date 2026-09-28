import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { DialogJournalState } from "./dialog-journal";
import type { ToolSession } from "../../sdk";
import { ToolAbortError, throwIfAborted } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { acquireBrowser, holdBrowser, releaseBrowser } from "./registry";
import { readRelayControlToken } from "./relay/access";
import type { BrowserInstance, InstanceLease, InstanceTab } from "./relay/instances";
import { ensureRelayDaemon, isLoopbackRelayUrl, probeRelayServer } from "./relay/daemon";
import { chromeTabName, describeGoneTab, shortUrl } from "./relay/managed-tabs";
import { resolveRelayKind } from "./relay/kind";
import { localBrowserRequest } from "./relay/local-http";
import { cfgBrowserRelay, cfgBrowserRelayUrl } from "./settings";
import { acquireTab, getTab, releaseTab, type TabSession } from "./tab-supervisor";

const embeddingActors = new WeakMap<ToolSession, string>();
const handles = new Map<string, ManagedChromeHandle>();
/** Handles that ended, oldest first, so a late call on one hears why instead of "stale". */
const endedHandles = new Map<string, ManagedChromeHandle>();
const ENDED_HANDLES_KEPT = 128;

/** The relay's answer that a lease or tab id is over; the message says why. */
export class ChromeTabGoneError extends ToolError {}

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
export function matchesChromeTab(
	tab: Pick<InstanceTab, "title" | "url"> & Partial<Pick<InstanceTab, "browserId" | "windowId">>,
	selector: ChromeTabSelector,
): boolean {
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
	/** Why the handle stopped working — what every later call on it answers. Set once. */
	ended?: string;
	initializing?: Promise<void>;
	/**
	 * Chrome dropped this handle's page along with OMP's debugger. Until a worker
	 * attaches again, an unobserved dialog journal is that detach's reset, not a
	 * dialog answer of unknown outcome.
	 */
	pageLost?: boolean;
}

/**
 * The relay's ownership key for this tool session: the session and agent the
 * lease belongs to, stable for the session's lifetime.
 */
export function browserActorId(session: ToolSession): string {
	const sessionId = session.getSessionId?.();
	const agentId = session.getAgentId?.();
	let fallback = embeddingActors.get(session);
	if (!fallback) {
		fallback = crypto.randomUUID();
		embeddingActors.set(session, fallback);
	}
	return JSON.stringify([sessionId ?? fallback, agentId ?? fallback]);
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
		const body = value && typeof value === "object" ? (value as { error?: unknown; gone?: unknown }) : {};
		const message = body.error !== undefined ? String(body.error) : `Chrome request failed (${response.status})`;
		throw body.gone === true ? new ChromeTabGoneError(message) : new ToolError(message);
	}
	return value as T;
}

/** Session-start relay ensures still in flight, by endpoint; one per process at a time. */
const relayPrestarts = new Map<string, Promise<void>>();

/**
 * `browser.relay` is the switch for existing-Chrome control, not just for
 * `browser.open`: with it off, discovery and claiming are off too, so nothing
 * a model does spawns the relay daemon on a machine that never opted in. An
 * explicit `app.relay: true` on the call still wins, and `PI_BROWSER_RELAY`
 * remains the final kill switch.
 */
async function chromeEndpoint(session: ToolSession, signal?: AbortSignal, forced?: boolean): Promise<string> {
	const kind = resolveRelayKind({
		settingEnabled: forced === true || cfgBrowserRelay.get(session.settings),
		url: cfgBrowserRelayUrl.get(session.settings),
	});
	if (!kind)
		throw new ToolError(
			"Control of existing Chrome browsers is off. Enable the browser.relay setting (or pass app.relay:true), and check PI_BROWSER_RELAY is not set to 0.",
		);
	const url = kind.cdpUrl.replace(/\/+$/, "");
	// A session-start ensure still in flight owns the cold start. Racing it from
	// this process can use up this call's start rounds while that start is still
	// being published, and fail an acquisition the relay was about to serve.
	const prestart = relayPrestarts.get(url);
	if (prestart) await untilAborted(signal, prestart);
	// One probe per acquisition: starting the daemon already reads `/health`,
	// and what it read is what decides whether this build can drive the relay.
	const health = isLoopbackRelayUrl(url)
		? await ensureRelayDaemon({ cdpUrl: url, signal })
		: await probeRelayServer(url);
	if (!health)
		throw new ToolError(
			`No browser relay is listening at ${url}. Start one with \`omp browser-relay\`, or point ` +
				"browser.relayUrl at the endpoint your extension is paired to (`omp browser-relay list` shows it).",
		);
	if (health === "legacy")
		throw new ToolError(
			`The browser relay at ${url} is an older service (no protocol-2 /health), so this build cannot use it. ` +
				"Point browser.relayUrl at the relay your extension is paired to (`omp browser-relay list` shows it), " +
				"or stop the stale relay on that port; do not retry against this endpoint.",
		);
	return url;
}

/**
 * Start the loopback relay while the session starts instead of inside its
 * first acquisition. A relay started on demand makes that acquisition wait
 * for the extension's next redial (backoff up to `EXTENSION_RECONNECT_MAX_MS`);
 * started now, the redial usually lands before the model's first browser call.
 * Fire-and-forget and silent: failures are debug-logged, and the acquisition
 * still ensures the relay itself. The started relay is broker-owned, so it
 * outlives this session while any omp process holds the global broker.
 */
export function prestartChromeRelay(session: ToolSession): void {
	const kind = resolveRelayKind({
		settingEnabled: cfgBrowserRelay.get(session.settings),
		url: cfgBrowserRelayUrl.get(session.settings),
	});
	if (!kind || !isLoopbackRelayUrl(kind.cdpUrl)) return;
	const cdpUrl = kind.cdpUrl;
	if (relayPrestarts.has(cdpUrl)) return;
	const pending = ensureRelayDaemon({ cdpUrl })
		.then(
			health => {
				if (!health) logger.debug("Browser relay prestart found no relay", { cdpUrl });
			},
			(error: unknown) => {
				logger.debug("Browser relay prestart failed", {
					cdpUrl,
					error: error instanceof Error ? error.message : String(error),
				});
			},
		)
		.finally(() => relayPrestarts.delete(cdpUrl));
	relayPrestarts.set(cdpUrl, pending);
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
		{ action: "discover", owner: browserActorId(session), browserId: opts.browserId },
		signal,
	);
}

export async function closeChromeTab(
	session: ToolSession,
	id: string,
	signal?: AbortSignal,
	opts: ChromeAccessOptions = {},
): Promise<void> {
	const owner = browserActorId(session);
	await chromeRequest(
		await chromeEndpoint(session, signal, opts.relay),
		{ action: "closeTab", id, owner, browserId: opts.browserId },
		signal,
	);
	// Organization can also close a tab already controlled by this actor.
	for (const handle of handles.values()) {
		if (handle.owner === owner && handle.lease.tab.id === id)
			await forgetChromeHandle(handle, describeGoneTab(handle.lease.tab, "was closed by browser.closeTab()"));
	}
}

export function requireChromeHandle(id: string, session: ToolSession): ManagedChromeHandle {
	const handle = handles.get(id) ?? endedHandles.get(id);
	if (!handle)
		throw new ToolError(
			"Unknown Chrome tab handle (OMP may have restarted since it was issued). Discover and claim the tab again.",
		);
	if (handle.owner !== browserActorId(session)) throw new ToolError("This Chrome tab handle belongs to another actor.");
	if (handle.ended) throw new ToolError(handle.ended);
	return handle;
}

export function isManagedChromeHandle(id: string): boolean {
	return handles.has(id);
}

export async function releaseChromeTabsForActor(session: ToolSession, signal?: AbortSignal): Promise<number> {
	const owner = browserActorId(session);
	const owned = [...handles.values()].filter(handle => handle.owner === owner);
	for (const handle of owned)
		await releaseChromeTab(
			handle,
			false,
			signal ?? AbortSignal.timeout(3000),
			"was handed back when all of this agent's browser tabs were released",
		);
	return owned.length;
}

/**

 * Turn-settle sweep over the managed Chrome tabs of one agent session
 * (issue #8246 follow-up). At the terminal settle the model is done, so
 * every lease it still holds is dead weight the user can see: the
 * "OMP is debugging this browser" infobar and the coloured task group.
 *
 * Every lease is handed back and every page stays open — the user can take
 * over a half-finished tab (sign in, pick the right link) and ask the model
 * to continue on it. Nothing here ever closes a tab: cleanup is the model's
 * job (`tab.close()` on what it opened, when it is done with it). There is
 * no cross-turn lease — the next turn re-claims by exact tab id.
 *
 * Best-effort and never throws: a settle sweep that fails must not break the
 * event flow, and session dispose reaps whatever is left.
 */
export async function releaseChromeTabsForOwner(ownerId: string, signal?: AbortSignal): Promise<number> {
	if (!ownerId) return 0;
	const owned = [...handles.values()].filter(handle => handle.ownerSessionId === ownerId);
	let released = 0;
	for (const handle of owned) {
		try {
			await releaseChromeTab(
				handle,
				false,
				signal ?? AbortSignal.timeout(3000),
				"was handed back to the user when the previous turn ended",
			);
			released++;
		} catch (error) {
			// One wedged tab must not abandon the rest of the sweep; the next
			// settle (or dispose) retries whatever is still registered.
			logger.debug("Failed to release managed Chrome tab at turn settle; continuing sweep", {
				tab: handle.lease.tab.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return released;
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
	const owner = browserActorId(session);
	const label = opts.label?.trim() || "Oh My Pi";
	if (opts.action === "claim" && !opts.id)
		throw new ToolError("Claim requires the exact id returned by browser.discover()");
	const lease = await chromeRequest<InstanceLease>(
		url,
		{
			action: opts.action,
			browserId: opts.browserId,
			owner,
			label,
			id: opts.id,
			url: opts.url ?? "about:blank",
		},
		opts.signal,
	);
	// Claiming a tab this actor already leases returns that lease. Whatever
	// handle held it is replaced — its worker may be the one Chrome cut off —
	// so exactly one worker drives the tab, freshly attached.
	for (const previous of [...handles.values()].filter(held => held.lease.id === lease.id))
		await forgetChromeHandle(
			previous,
			describeGoneTab(previous.lease.tab, "was claimed again, which replaced this handle", lease.tab.id),
		);
	const handle: ManagedChromeHandle = {
		id: crypto.randomUUID(),
		label,
		owner,
		ownerSessionId: session.getSessionId?.() ?? undefined,
		url,
		lease,
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
		// Ask before handing it back, so the answer is about what went wrong and not this release.
		const revoked = await explainRevokedChromeControl(handle, error);
		try {
			// The caller never got this handle. A blank tab OMP just created is
			// litter; one Chrome revoked control of is the user's next step, and
			// one the model asked for by URL is its own to close.
			await releaseChromeTab(handle, lease.created && !revoked && !opts.url, AbortSignal.timeout(3000));
		} catch (cleanupError) {
			throw new ToolError(
				`Chrome acquisition failed for ${lease.tab.id}: ${String(error)}. Cleanup also failed: ${String(cleanupError)}`,
			);
		}
		if (error instanceof ToolAbortError || (error instanceof Error && error.name === "AbortError")) throw error;
		if (revoked) throw revoked;
		throw new ToolError(
			`Chrome acquisition failed for tab ${lease.tab.id} in browser ${lease.browserId}: ${String(error)}. Control was released without closing a page you did not open. Discover and claim this exact tab to inspect its current state before continuing.`,
		);
	}
}

/**
 * Hand the tab back to Chrome. `close` decides whether the page survives:
 * `false` leaves it open, ungrouped, undebugged and unleased — the hand-back
 * contract; `true` closes it. Local resources are always drained, so an
 * unreachable relay can neither strand a worker nor turn a hand-back into a close.
 */
export async function releaseChromeTab(
	handle: ManagedChromeHandle,
	close: boolean,
	signal: AbortSignal,
	reason = close ? "was closed by OMP" : "was handed back by OMP",
): Promise<void> {
	let leaseError: unknown;
	if (!handle.ended) {
		// Invalidation can tear down the worker before the HTTP reply arrives.
		// Retire first so its release callback cannot dispatch recovery twice.
		retire(handle, describeGoneTab(handle.lease.tab, reason, close ? undefined : handle.lease.tab.id));
		try {
			await chromeRequest(
				handle.url,
				{ action: "releaseTab", id: handle.lease.id, owner: handle.owner, close },
				signal,
			);
		} catch (error) {
			// Handing back a lease the relay already ended is done; closing its page is not.
			if (!(error instanceof ChromeTabGoneError))
				leaseError = new ToolError(
					`Chrome tab ${handle.lease.tab.id} (lease ${handle.lease.id}) was not confirmed as ${close ? "closed" : "released"}: ${String(error)}. Rediscover the exact tab before continuing.`,
				);
			else if (close) leaseError = error;
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

/**
 * Reveal, hand back or close a handle's tab. Returns the tab as it was just
 * before, so the caller can name the page the user sees rather than the
 * snapshot taken when the handle was acquired.
 */
export async function chromeLifecycle(
	handle: ManagedChromeHandle,
	action: "reveal" | "release" | "close",
	signal?: AbortSignal,
): Promise<InstanceTab> {
	const tab = await currentChromeTab(handle, signal);
	if (action === "reveal") {
		await leaseRequest(handle, { action }, signal);
		return tab;
	}
	await releaseChromeTab(
		handle,
		action === "close",
		signal ?? AbortSignal.timeout(3000),
		action === "close" ? "was closed by tab.close()" : "was handed back by tab.release()",
	);
	return tab;
}

/**
 * The relay's current view of a handle's tab — title and URL follow the page
 * as it navigates — else what the handle last recorded. Naming only: a relay
 * that cannot answer here leaves the action itself to report why.
 */
async function currentChromeTab(handle: ManagedChromeHandle, signal?: AbortSignal): Promise<InstanceTab> {
	if (handle.ended) return handle.lease.tab;
	const bound = AbortSignal.timeout(1500);
	try {
		const lease = await chromeRequest<InstanceLease>(
			handle.url,
			{ action: "get", id: handle.lease.id, owner: handle.owner },
			signal ? AbortSignal.any([signal, bound]) : bound,
		);
		return lease.tab;
	} catch {
		return handle.lease.tab;
	}
}

/** The one place a handle stops working; `ended` is what every later call on it answers. */
function retire(handle: ManagedChromeHandle, ended: string): void {
	handle.ended = ended;
	handles.delete(handle.id);
	endedHandles.set(handle.id, handle);
	if (endedHandles.size > ENDED_HANDLES_KEPT) endedHandles.delete(endedHandles.keys().next().value!);
}

/** Local-only retirement, for a lease that is over or passed to another handle. */
async function forgetChromeHandle(handle: ManagedChromeHandle, ended: string): Promise<void> {
	retire(handle, ended);
	await releaseTab(handle.id);
}

/**
 * A request about one handle's lease. The relay answering that the lease is
 * over retires the handle with the relay's account, so later calls say why
 * without asking again; the page worker it no longer feeds goes behind it.
 */
async function leaseRequest<T>(
	handle: ManagedChromeHandle,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<T> {
	try {
		return await chromeRequest<T>(handle.url, { ...args, id: handle.lease.id, owner: handle.owner }, signal);
	} catch (error) {
		if (error instanceof ChromeTabGoneError && !handle.ended) {
			retire(handle, error.message);
			void releaseTab(handle.id).catch(() => undefined);
		}
		throw error;
	}
}

/**
 * What a page call looks like when the connection under it died: puppeteer's
 * close errors (the call in flight when Chrome drops the debugger reads
 * "Detached while handling command", the next one "Attempted to use detached
 * Frame"), and the refusals a relay — this build or an older one — answers
 * for a tab its debugger cannot reach.
 */
const LOST_CONTROL =
	/Target closed|Session closed|Connection closed|Detached while handling command|detached Frame|no longer available|refused OMP's debugger|could not attach|Cannot attach|Dialog observation is unavailable|focus state could not be restored/;

/**
 * Where a page call that died with its connection leaves the lease: over (the
 * relay's account of why), or standing on an open tab Chrome will not let OMP
 * drive (`debugger.revoked` says why). Undefined for any other failure.
 */
async function lostChromeControl(
	handle: ManagedChromeHandle,
	error: unknown,
): Promise<InstanceLease | ChromeTabGoneError | undefined> {
	if (
		!(error instanceof Error) ||
		!(error.name === "TargetCloseError" || error.name === "ConnectionClosedError" || LOST_CONTROL.test(error.message))
	)
		return undefined;
	try {
		const lease = await leaseRequest<InstanceLease>(handle, { action: "get" }, AbortSignal.timeout(1500));
		return lease.debugger?.revoked ? lease : undefined;
	} catch (refusal) {
		return refusal instanceof ChromeTabGoneError ? refusal : undefined;
	}
}

/**
 * A lost page call in the model's terms, since a raw "Target closed" reads as
 * a closed tab: why the lease is over, or Chrome's reason, where the tab stays
 * open, and `next`. The user pressing Cancel on Chrome's infobar is a decision
 * about this session, so that answer offers no way around it.
 */
function describeLostControl(lost: InstanceLease | ChromeTabGoneError, next: string): ToolError {
	if (lost instanceof ChromeTabGoneError) return lost;
	if (lost.debugger?.canceledByUser)
		return new ToolError(
			`The user stopped OMP's control of ${chromeTabName(lost.tab)} from Chrome's infobar. Do not claim it again, ` +
				"reconnect, or work around it; stop here and report what was done and what remains.",
		);
	return new ToolError(
		`Chrome revoked OMP's control of ${chromeTabName(lost.tab)}: ${lost.debugger?.revoked}. The tab stays open at ${shortUrl(lost.tab.url)}. ${next}`,
	);
}

/** An acquisition that lost its page leaves no handle behind, so the way back is claiming the tab again. */
export async function explainRevokedChromeControl(
	handle: ManagedChromeHandle,
	error: unknown,
): Promise<ToolError | undefined> {
	const lost = await lostChromeControl(handle, error);
	return (
		lost &&
		describeLostControl(
			lost,
			`Do not close it; ask the user to finish that step in Chrome, then claim ${JSON.stringify(handle.lease.tab.id)} again.`,
		)
	);
}

/** Dialog control bypasses the renderer and a worker blocked by the modal. */
export async function chromeDialog(
	handle: ManagedChromeHandle,
	options: unknown,
	signal?: AbortSignal,
): Promise<DialogJournalState> {
	return await leaseRequest<DialogJournalState>(handle, { action: "dialog", dialog: options }, signal);
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
			// Chrome answers for the tab's initial empty document until the URL it
			// was created with commits; the worker holds `ready` until then.
			expectUrl: handle.lease.tab.url,
			timeoutMs: opts.timeoutMs,
			signal: opts.signal,
			ownerSessionId: session.getSessionId?.() ?? undefined,
			ownerActorId: handle.owner,
			onRelease: async () => {
				if (!handle.ended)
					await releaseChromeTab(
						handle,
						false,
						AbortSignal.timeout(3000),
						"was handed back when its page worker closed",
					);
			},
		});
		// Creation initially reports a pending URL and no group. Refresh after the
		// worker has attached, retaining the URL/title read directly from this page.
		handle.lease = await leaseRequest<InstanceLease>(handle, { action: "get" }, opts.signal);
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
 * A page Chrome dropped with the debugger starts over like any claim: only a
 * dialog seen open still holds it back.
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
			if (state.status !== "closed" && !handle.pageLost)
				throw new ToolError(
					`The pending dialog's outcome is unknown. Page control cannot resume until closure is observed; inspect tab.dialog() before continuing, or claim ${JSON.stringify(handle.lease.tab.id)} again to start over`,
				);
			await initializeChromePage(handle, session, { timeoutMs, signal });
			handle.pageLost = false;
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
 * Run a page operation on a leased tab through Chrome dropping OMP's debugger
 * under it. A frame Chrome lets no other extension debug — most often a
 * password manager's inline menu — detaches OMP and gets the tab banned at the
 * relay, but the lease stands, so the handle does too: claim the tab again (the
 * same lease, whose ban lifts for exactly one fresh attach), drop the worker
 * whose page died with Chrome's old session, and run once more. `operation`
 * hears whether its first run had already reached the page. A second loss is
 * reported with Chrome's current reason; the next call takes the same retry.
 */
export async function runOnChromePage<T>(
	handle: ManagedChromeHandle,
	session: ToolSession,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	operation: (rerun: boolean) => Promise<T>,
): Promise<T> {
	const next =
		"OMP already retried once. Do not close or claim it again: ask the user to finish that step in Chrome; the next call on this tab tries again.";
	let worker: TabSession | undefined;
	try {
		await ensureChromePage(handle, session, timeoutMs, signal);
		worker = getTab(handle.id);
		return await operation(false);
	} catch (error) {
		const lost = await lostChromeControl(handle, error);
		if (!lost) throw error;
		if (lost instanceof ChromeTabGoneError || lost.debugger?.canceledByUser) throw describeLostControl(lost, next);
		handle.pageLost = true;
	}
	await chromeRequest(
		handle.url,
		{ action: "claim", id: handle.lease.tab.id, browserId: handle.lease.browserId, owner: handle.owner },
		signal,
	);
	// Chrome's session under that worker is gone; the lease is not, so nothing is handed back.
	if (worker && getTab(handle.id) === worker) await releaseTab(handle.id, { skipOnRelease: true });
	try {
		await ensureChromePage(handle, session, timeoutMs, signal);
		return await operation(worker !== undefined);
	} catch (error) {
		const lost = await lostChromeControl(handle, error);
		throw lost ? describeLostControl(lost, next) : error;
	}
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
	const response = await leaseRequest<{ tabs?: InstanceTab[] }>(handle, { action: "childTabs" }, signal);
	return response.tabs ?? [];
}
