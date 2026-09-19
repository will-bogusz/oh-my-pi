import { setTimeout as sleep } from "node:timers/promises";

import { untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import type { Frame, Page } from "puppeteer-core";
import { throwIfAborted } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** The only page global this module reads; the worker's ambient `document` has no `readyState`. */
declare const document: { readyState: string };

export type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

const READY_POLL_MS = 50;
const READY_PROBE_TIMEOUT_MS = 1_000;
/** Round trip allowed for puppeteer to record a same-document URL change. */
const SAME_DOCUMENT_URL_MS = 500;
/**
 * Grace granted for `readyState === "complete"` once the main document is
 * interactive. A child frame whose response never ends holds its parent's load
 * event — and with it the parent's readyState — open forever, so for such pages
 * a `waitUntil: "load"` navigation can only ever report the parsed DOM.
 */
const LOAD_GRACE_MS = 2_000;
/** How long a suspected navigation gets to commit before a stalled CDP call counts as a failure. */
const NAVIGATION_CONFIRM_MS = 1_000;

/** Errors Chrome produces while it is replacing a document. */
const NAVIGATION_SHAPED_ERROR_RE =
	/execution context (was )?destroyed|inspected target navigated|target crashed|target closed|session closed|frame (was )?detached|because of a navigation/i;

class PhaseTimeout extends Error {}

export interface MainFrameNavigateOptions {
	/** Op label used in the timeout message, e.g. `tab.goto("/x")`. */
	label: string;
	timeoutMs: number;
	waitUntil?: WaitUntil;
	signal?: AbortSignal;
	/** Best-effort `Page.stopLoading`, run before a timeout is reported. */
	stopLoading?: () => Promise<void>;
}

/**
 * Navigate and resolve once the page's **main frame** committed the navigation and
 * reached the requested phase.
 *
 * Neither wait can go through `page.goto`. Puppeteer's `waitUntil` needs the expected
 * lifecycle event from every child frame that started loading
 * (`LifecycleWatcher.#checkLifecycleComplete`), so one cross-origin iframe that never
 * finishes hangs the navigation on a page that is fully usable; and puppeteer detects
 * the commit itself from the `Page.lifecycleEvent` named `init`, so a session that
 * stopped receiving lifecycle events (what the relay's idle detach leaves behind until
 * its replay lands) hangs `goto` for any `waitUntil`, including an empty one. So the
 * commit comes from `Page.navigate`'s own answer and the phase from the main frame's
 * `readyState`. On timeout the report names the URL and readyState actually observed
 * instead of suggesting a different `waitUntil`, which does not help when child frames
 * are the reason.
 */
export async function navigateMainFrame(page: Page, url: string, opts: MainFrameNavigateOptions): Promise<void> {
	const deadline = Date.now() + opts.timeoutMs;
	const waitUntil = opts.waitUntil ?? "load";
	const sameDocument = sameDocumentTarget(page.url(), url);
	const session = await untilAborted(opts.signal, () => page.createCDPSession());
	try {
		const navigated = await withTimeout(
			untilAborted(opts.signal, () => session.send("Page.navigate", { url })),
			Math.max(deadline - Date.now(), 1),
			new PhaseTimeout(`navigation to ${url} never committed`),
		);
		// `net::ERR_ABORTED` is Chrome reporting a download or a navigation the page
		// itself replaced; puppeteer treats it as a success and so do we.
		if (navigated.errorText && navigated.errorText !== "net::ERR_ABORTED")
			throw new ToolError(`${opts.label} failed: ${navigated.errorText}`);
		// A same-document target (identical URL, or only the fragment differs) keeps the
		// document that is already there: it has no new phase to reach. `Page.navigate`
		// answers before puppeteer has processed `navigatedWithinDocument`, so give the
		// event a moment or the caller's next `tab.url()` reads the pre-navigation URL.
		if (sameDocument !== undefined) {
			const settleBy = Math.min(deadline, Date.now() + SAME_DOCUMENT_URL_MS);
			while (page.url() !== sameDocument && Date.now() < settleBy) {
				await untilAborted(opts.signal, () => sleep(READY_POLL_MS));
			}
			return;
		}
		if (waitUntil === "load" || waitUntil === "domcontentloaded") {
			await waitForMainFramePhase(page, waitUntil, deadline, opts.signal);
		} else {
			await untilAborted(opts.signal, () =>
				page.waitForNetworkIdle({
					idleTime: 500,
					concurrency: waitUntil === "networkidle2" ? 2 : 0,
					timeout: Math.max(deadline - Date.now(), 1),
				}),
			);
		}
	} catch (error) {
		const timedOut = error instanceof PhaseTimeout || (error instanceof Error && error.name === "TimeoutError");
		if (timedOut) await reportNavigationTimeout(page, opts);
		throw error;
	} finally {
		await session.detach().catch(() => undefined);
	}
}

/** The absolute target when it resolves to the document `current` already holds. */
function sameDocumentTarget(current: string, target: string): string | undefined {
	try {
		const from = new URL(current);
		const to = new URL(target, current);
		if (from.origin !== to.origin || from.pathname !== to.pathname || from.search !== to.search) return undefined;
		return to.href;
	} catch {
		return undefined;
	}
}

export interface MainFrameNavigationWatch {
	/** Description of the first main-frame navigation seen since the watch started. */
	seen(): string | undefined;
	/**
	 * Why a stalled page command should be forgiven: a main-frame navigation observed
	 * during the command, or an error saying the document went away. Waits up to
	 * {@link NAVIGATION_CONFIRM_MS} for a commit, because a navigation that has only
	 * started still explains the stall.
	 */
	excuse(error: unknown): Promise<string | undefined>;
	stop(): void;
}

/**
 * Watch a page for the main-frame navigation that makes an unanswered CDP call benign:
 * while Chrome swaps documents (often processes too) commands on the old context can
 * never answer, and treating that as a broken page poisons a perfectly good handle.
 */
export function watchMainFrameNavigation(page: Page): MainFrameNavigationWatch {
	let seen: string | undefined;
	const arrived = Promise.withResolvers<string>();
	const onNavigated = (frame: Frame): void => {
		if (frame.parentFrame() !== null) return;
		seen ??= `main frame navigated to ${frame.url()}`;
		arrived.resolve(seen);
	};
	const onCrash = (): void => {
		seen ??= "page target crashed";
		arrived.resolve(seen);
	};
	page.on("framenavigated", onNavigated);
	page.on("error", onCrash);
	return {
		seen: () => seen,
		excuse: async error => {
			const message = error instanceof Error ? error.message : String(error);
			if (NAVIGATION_SHAPED_ERROR_RE.test(message)) return message;
			if (seen) return seen;
			return await Promise.race([arrived.promise, sleep(NAVIGATION_CONFIRM_MS, undefined, { ref: false })]);
		},
		stop: () => {
			page.off("framenavigated", onNavigated);
			page.off("error", onCrash);
		},
	};
}

async function waitForMainFramePhase(
	page: Page,
	phase: "load" | "domcontentloaded",
	deadline: number,
	signal?: AbortSignal,
): Promise<void> {
	let interactiveSince: number | undefined;
	for (;;) {
		throwIfAborted(signal);
		const state = await readReadyState(page);
		if (state === "complete") return;
		if (state === "interactive") {
			if (phase === "domcontentloaded") return;
			interactiveSince ??= Date.now();
			// Take the parsed DOM once the grace (or the caller's budget) is spent:
			// pending child frames must not turn a usable page into a timeout.
			if (Date.now() >= Math.min(deadline, interactiveSince + LOAD_GRACE_MS)) return;
		} else if (state === "loading") {
			// A redirect or client-side navigation replaced the document mid-wait.
			interactiveSince = undefined;
		}
		if (deadline - Date.now() <= 0) throw new PhaseTimeout(`main frame never reached ${phase}`);
		await untilAborted(signal, () => sleep(Math.min(READY_POLL_MS, deadline - Date.now())));
	}
}

/** Main-frame `document.readyState`, or `undefined` while the context is unreachable. */
async function readReadyState(page: Page): Promise<string | undefined> {
	try {
		const state = await withTimeout(
			page.mainFrame().evaluate(() => document.readyState),
			READY_PROBE_TIMEOUT_MS,
			"readyState probe timed out",
		);
		return typeof state === "string" ? state : undefined;
	} catch {
		return undefined;
	}
}

async function reportNavigationTimeout(page: Page, opts: MainFrameNavigateOptions): Promise<never> {
	// Read the state before stopping: `Page.stopLoading` changes what we would report.
	const url = page.url();
	const readyState = (await readReadyState(page)) ?? "unreachable";
	const stopped = opts.stopLoading ? "; pending navigation stopped" : "";
	await opts.stopLoading?.().catch(() => undefined);
	throw new ToolError(
		`${opts.label} timed out after ${opts.timeoutMs}ms${stopped} — current URL: ${url}, readyState: ${readyState}`,
	);
}
