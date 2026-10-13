/** Chrome's `windows.WINDOW_ID_NONE`: no Chrome window has focus (another app is active). */
const NO_WINDOW = -1;

/** The Chrome calls placing a popup needs; tests pass a fake. */
export interface PlacementChrome {
	getTab(tabId: number): Promise<{ active: boolean; windowId: number } | null>;
	selectTab(tabId: number): Promise<unknown>;
	getWindow(windowId: number): Promise<{ type?: string; focused: boolean }>;
	focusWindow(windowId: number): Promise<unknown>;
	/** The normal window that had focus last, whether or not Chrome is the active app. */
	lastFocusedNormalWindow(): Promise<number | undefined>;
}

/** What a tab's selection replaced, and the window's selection count when it happened. */
interface Displaced {
	previous: number | undefined;
	generation: number;
}

/**
 * Puts a popup an omp page opened behind the user's selection. It follows tab selection and window focus
 * from Chrome's events, so each popup undoes exactly what its own appearance displaced, and only while
 * nothing has changed since: a tab or window the user picked in the meantime is never overridden.
 */
export class PopupPlacement {
	readonly #chrome: PlacementChrome;
	/** Selected tab per window. */
	#selected = new Map<number, number>();
	/** Selection changes per window. */
	#generation = new Map<number, number>();
	/** For each tab, the tab its selection replaced in its window. */
	#displacedTab = new Map<number, Displaced>();
	/** Popups from tabs omp drives that the user has not selected since. */
	#popups = new Set<number>();
	/** The focused window; `undefined` until this worker has seen where focus is. */
	#focused: number | undefined;
	/** For each window, the window that had focus before Chrome focused it (`undefined`: not known). */
	#focusedBefore = new Map<number, number | undefined>();
	/** Popup windows asked to give focus back before Chrome focused them → the window to return it to. */
	#awaitingFocus = new Map<number, number>();

	constructor(chrome: PlacementChrome) {
		this.#chrome = chrome;
	}

	/** The selection and focus this worker found at its hello, before it saw any change. */
	seed(windowId: number, tabId: number, focused: boolean): void {
		if (!this.#selected.has(windowId)) this.#selected.set(windowId, tabId);
		if (focused && this.#focused === undefined) this.#focused = windowId;
	}

	activated(windowId: number, tabId: number): void {
		const generation = (this.#generation.get(windowId) ?? 0) + 1;
		this.#generation.set(windowId, generation);
		// A popup selected again after Chrome first selected it is the user's choice from then on.
		if (this.#displacedTab.has(tabId)) this.#popups.delete(tabId);
		this.#displacedTab.set(tabId, { previous: this.#selected.get(windowId), generation });
		this.#selected.set(windowId, tabId);
	}

	focusChanged(windowId: number): void {
		const back = this.#awaitingFocus.get(windowId);
		// Only the very next focus change can be the popup taking it; any other means the user moved on.
		this.#awaitingFocus.clear();
		// The window may have closed meanwhile; there is nothing to give focus back to then.
		if (back !== undefined) void this.#chrome.focusWindow(back).catch(() => undefined);
		if (windowId !== NO_WINDOW) this.#focusedBefore.set(windowId, this.#focused);
		this.#focused = windowId;
	}

	/** A tab omp drives opened `tabId`. Recorded at once, so a later popup never restores this one. */
	opened(tabId: number): void {
		this.#popups.add(tabId);
	}

	removed(tabId: number): void {
		this.#displacedTab.delete(tabId);
		this.#popups.delete(tabId);
	}

	windowRemoved(windowId: number): void {
		this.#selected.delete(windowId);
		this.#generation.delete(windowId);
		this.#focusedBefore.delete(windowId);
		this.#awaitingFocus.delete(windowId);
	}

	/**
	 * Put popup `tabId` behind the user's selection: reselect the tab its appearance displaced (through any
	 * popups that displaced each other), or, for a popup window, hand focus back to the window it took it
	 * from. Never focuses a window that did not have focus a moment ago, so Chrome is not raised.
	 */
	async background(tabId: number): Promise<void> {
		this.#popups.add(tabId);
		const tab = await this.#chrome.getTab(tabId);
		if (!tab) return;
		const window = await this.#chrome.getWindow(tab.windowId);
		if (window.type === "popup") {
			// Chrome cannot move a tab out of a popup window, refuses bounds that put one mostly off screen, and
			// stops rendering a minimized one. It stays where Chrome put it; once the user's window has focus
			// back it sits behind it, and omp's focus emulation keeps it rendering there.
			// Focus goes back only to the window that had it while Chrome was the active app, and only if nothing
			// moved it since; otherwise it was the user's doing, and focusing a window could raise Chrome.
			if (this.#focused === tab.windowId) {
				if (!window.focused) return;
				const before = this.#focusedBefore.get(tab.windowId);
				if (before === undefined) {
					// Chrome had focus before this worker saw any focus change (a Chrome that just started reports
					// none): the popup's own focus says Chrome is the active app, and the normal window focused last
					// is the one it took focus from.
					const last = await this.#chrome.lastFocusedNormalWindow();
					if (last !== undefined && last !== tab.windowId && this.#focused === tab.windowId) {
						await this.#chrome.focusWindow(last);
					}
				} else if (before !== NO_WINDOW) await this.#chrome.focusWindow(before);
			} else if (this.#focused !== undefined && this.#focused !== NO_WINDOW && !this.#focusedBefore.has(tab.windowId)) {
				// Chrome has not reported the popup's focus yet: a new window takes a moment to show.
				if (window.focused) await this.#chrome.focusWindow(this.#focused);
				else this.#awaitingFocus.set(tab.windowId, this.#focused);
			}
			return;
		}
		const own = this.#displacedTab.get(tabId);
		if (!tab.active || !own || this.#generation.get(tab.windowId) !== own.generation) return;
		const seen = new Set([tabId]);
		let previous = own.previous;
		while (previous !== undefined && this.#popups.has(previous) && !seen.has(previous)) {
			seen.add(previous);
			previous = this.#displacedTab.get(previous)?.previous;
		}
		if (previous === undefined || seen.has(previous)) return;
		const target = await this.#chrome.getTab(previous);
		// The user (or another popup) changed the selection while Chrome answered.
		if (target?.windowId !== tab.windowId || this.#generation.get(tab.windowId) !== own.generation) return;
		await this.#chrome.selectTab(previous);
	}
}
