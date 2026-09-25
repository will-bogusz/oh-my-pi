/// <reference lib="dom" />
// The injected function below runs in the page, not the worker.
/**
 * Chrome refuses an extension's debugger on a tab while any frame in it —
 * cross-site ones included — shows another extension's page, and drops a live
 * session the moment such a frame starts loading. Password managers draw their
 * inline autofill menus exactly that way, so one focused field ends OMP's
 * control of the tab.
 *
 * The drop itself cannot be prevented from here: the frame is past Chrome's
 * check before any script sees it in the DOM. What this does is make the next
 * attach possible. When Chrome refuses it for a foreign extension frame, every
 * such frame in the tab is pointed at an empty document (`srcdoc` outranks
 * `src`, so a vendor that later re-shows the same frame loads nothing) and the
 * attach is retried while Chrome tears the old document down. Codex's
 * extension neutralizes frames the same way; the relay only asks for an
 * attach on a tab OMP is driving, so the user's own tabs keep their menus.
 */

const FOREIGN_FRAME_REFUSAL = /chrome-extension:\/\/ URL of different extension/i;
/** Waits before each re-attach: the emptied frames have to commit their blank document first. */
const RETRY_DELAYS_MS = [50, 100, 200, 400];

export async function attachPastForeignFrames(tabId: number, attach: () => Promise<void>): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await attach();
		} catch (error) {
			// A vendor may re-show its menu meanwhile, so every refusal sweeps again.
			if (
				attempt === RETRY_DELAYS_MS.length ||
				!FOREIGN_FRAME_REFUSAL.test(String(error)) ||
				(await neutralizeForeignFrames(tabId)) === 0
			)
				throw error;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, RETRY_DELAYS_MS[attempt]);
		await promise;
	}
}

/** Neutralize other extensions' frames in every frame of the tab; the count of frames changed. */
async function neutralizeForeignFrames(tabId: number): Promise<number> {
	try {
		const results = await chrome.scripting.executeScript({
			target: { tabId, allFrames: true },
			injectImmediately: true,
			args: [chrome.runtime.id],
			func: (self: string) => {
				let changed = 0;
				const visit = (root: Document | ShadowRoot) => {
					const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
					for (let node = walker.nextNode(); node; node = walker.nextNode()) {
						const element = node as HTMLElement;
						if (element instanceof HTMLIFrameElement || element.tagName === "FRAME") {
							const src = element.getAttribute("src") ?? "";
							if (src.startsWith("chrome-extension://") && !src.startsWith(`chrome-extension://${self}/`)) {
								if (element instanceof HTMLIFrameElement) element.setAttribute("srcdoc", "");
								else element.setAttribute("src", "about:blank");
								changed++;
							}
						}
						const shadow = chrome.dom.openOrClosedShadowRoot(element);
						if (shadow) visit(shadow);
					}
				};
				visit(document);
				return changed;
			},
		});
		return results.reduce((total, frame) => total + (frame.result ?? 0), 0);
	} catch {
		// A page no extension may script (the Web Store, another extension's page).
		return 0;
	}
}
