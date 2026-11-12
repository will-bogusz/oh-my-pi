/// <reference path="./chrome.d.ts" />
/**
 * While any frame of a tab, cross-site ones included, shows another extension's page, Chrome refuses this
 * extension's debugger there: `attach` and every `sendCommand` fail with "Cannot access a chrome-extension:// URL
 * of different extension". Password managers draw their inline autofill menus as such frames on a focused field.
 * Chrome checks before running the request, so a refused one is retried once every such frame is pointed at an
 * empty document (`srcdoc` outranks `src`, so a vendor that re-points the same frame later loads nothing) and
 * hidden: an inline menu sits over the controls below its field, and emptied it would cover them as a blank box.
 * The relay asks for this only in a tab omp drives, so the user's other tabs keep their menus.
 *
 * Chrome checks a frame's last committed page, so it also accepts an attach while such a frame is still loading,
 * then drops the debugger once the frame navigates. Every re-adoption makes the page focused again, and a vendor
 * that opens its menu on focus starts loading it again. So once Chrome drops omp from a tab omp drives, the frames
 * are emptied and the element focused beside them loses focus before the relay attaches there again: the next
 * worker's focus emulation then focuses no field, and a vendor that builds a new frame on every focus has nothing to
 * open on.
 */

import { FOREIGN_FRAME_REFUSAL } from "../../coding-agent/src/tools/browser/relay/protocol";

/** Waits before each retry: the emptied frames have to commit their blank document first. */
const RETRY_DELAYS_MS = [50, 100, 200, 400];
/**
 * Waits between the passes of the sweep after Chrome drops omp from a tab: another pass runs while the last one
 * emptied a frame, at most four passes over 350 ms.
 */
const DETACH_SWEEP_DELAYS_MS = [50, 100, 200];
/**
 * Longest an attach waits for that sweep. A page that cannot run script (an `alert()` open) holds the sweep, and only
 * an attach can dismiss the dialog; a frame the sweep did not reach is then emptied past Chrome's refusal.
 */
const DETACH_SWEEP_WAIT_MS = 1_000;

interface SweepResult {
	/** Other extensions' frames in the tab, emptied by this sweep or an earlier one. */
	found: number;
	/** Of those, the frames this sweep emptied. */
	emptied: number;
}

/** The sweep in flight per tab, which the refused commands of one burst share. */
const sweeps = new Map<number, Promise<SweepResult>>();
/** The sweep after Chrome dropped omp from a tab omp drives, which the next attach there waits out. */
const detachSweeps = new Map<number, Promise<void>>();

// Page globals of the function injected below, which runs in the tab's frames, not in this worker.
declare const document: ChromePageRoot & {
	createTreeWalker(root: ChromePageRoot, whatToShow: number): { nextNode(): ChromePageElement | null };
	readonly activeElement: { blur(): void } | null;
	readonly body: unknown;
};
declare const NodeFilter: { readonly SHOW_ELEMENT: number };

/** Run a `chrome.debugger` request on `tabId`, emptying other extensions' frames whenever Chrome refuses it for one. */
export async function pastForeignFrames<T>(tabId: number, request: () => Promise<T>): Promise<T> {
	const detachSweep = detachSweeps.get(tabId);
	if (detachSweep) await Promise.race([detachSweep, delay(DETACH_SWEEP_WAIT_MS)]);
	for (let attempt = 0; ; attempt++) {
		try {
			return await request();
		} catch (error) {
			// A vendor may re-show its menu meanwhile, so every refusal sweeps again.
			if (
				attempt === RETRY_DELAYS_MS.length ||
				!FOREIGN_FRAME_REFUSAL.test(String(error)) ||
				(await sweep(tabId)).found === 0
			)
				throw error;
		}
		await delay(RETRY_DELAYS_MS[attempt]);
	}
}

/**
 * Empty other extensions' frames in `tabId` after Chrome dropped omp from it and blur the element focused in each
 * frame that held one, sweeping again while a pass empties a frame; the relay's next attach there waits for it.
 */
export function clearForeignFramesAfterDetach(tabId: number): void {
	const pending = (async () => {
		for (let pass = 0; ; pass++) {
			const { emptied } = await neutralizeForeignFrames(tabId, true);
			if (emptied === 0 || pass === DETACH_SWEEP_DELAYS_MS.length) return;
			await delay(DETACH_SWEEP_DELAYS_MS[pass]);
		}
	})().finally(() => {
		if (detachSweeps.get(tabId) === pending) detachSweeps.delete(tabId);
	});
	detachSweeps.set(tabId, pending);
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function sweep(tabId: number): Promise<SweepResult> {
	let pending = sweeps.get(tabId);
	if (!pending) {
		pending = neutralizeForeignFrames(tabId, false).finally(() => sweeps.delete(tabId));
		sweeps.set(tabId, pending);
	}
	return pending;
}

/** Empty and hide other extensions' frames in every frame of the tab; with `blur`, blur the focus in those frames. */
async function neutralizeForeignFrames(tabId: number, blur: boolean): Promise<SweepResult> {
	try {
		const results = await chrome.scripting.executeScript({
			target: { tabId, allFrames: true },
			injectImmediately: true,
			args: [chrome.runtime.id, blur],
			func: (self: string, blurFocus: boolean) => {
				const counts = { found: 0, emptied: 0 };
				const visit = (root: ChromePageRoot) => {
					const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
					for (let element = walker.nextNode(); element; element = walker.nextNode()) {
						const tag = element.tagName.toUpperCase();
						if (tag === "IFRAME" || tag === "FRAME") {
							const src = element.getAttribute("src") ?? "";
							if (src.startsWith("chrome-extension://") && !src.startsWith(`chrome-extension://${self}/`)) {
								// `srcdoc` outranks `src`; a `<frame>` has no `srcdoc`. Setting `srcdoc` again would
								// reload the frame and delay the blank document the retry waits for.
								if (tag === "FRAME") {
									element.setAttribute("src", "about:blank");
									counts.emptied++;
								} else if (element.getAttribute("srcdoc") === null) {
									element.setAttribute("srcdoc", "");
									counts.emptied++;
								}
								element.style.setProperty("display", "none", "important");
								counts.found++;
							}
						}
						const shadow = chrome.dom.openOrClosedShadowRoot(element);
						if (shadow) visit(shadow);
					}
				};
				visit(document);
				if (blurFocus && counts.found > 0 && document.activeElement !== document.body) document.activeElement?.blur();
				return counts;
			},
		});
		const total = { found: 0, emptied: 0 };
		for (const { result } of results) {
			total.found += result?.found ?? 0;
			total.emptied += result?.emptied ?? 0;
		}
		return total;
	} catch {
		// A page no extension may script (the Web Store, another extension's page), or a tab that closed.
		return { found: 0, emptied: 0 };
	}
}
