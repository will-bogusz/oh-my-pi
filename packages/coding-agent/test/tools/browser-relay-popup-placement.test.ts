import { describe, expect, it } from "bun:test";
import { type PlacementChrome, PopupPlacement } from "../../../browser-relay/extension/popup-placement";

const NO_WINDOW = -1;

/** Chrome's tabs and windows as the placement sees them, recording what it changed. */
class FakeChrome implements PlacementChrome {
	readonly tabs = new Map<number, { active: boolean; windowId: number }>();
	readonly windows = new Map<number, { type: string; focused: boolean }>();
	readonly calls: string[] = [];
	/** The placement's clock, in ms. */
	now = 0;
	/** What `windows.getLastFocused({ windowTypes: ["normal"] })` answers; `onLastFocused` runs as it does. */
	lastNormal: number | undefined = 1;
	onLastFocused = (): void => {};
	/** Holds `getTab(id)` for these ids until the test releases it, signalling `reached` when it gets there. */
	readonly gates = new Map<number, { reached: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }>();

	async getTab(tabId: number) {
		const gate = this.gates.get(tabId);
		if (gate) {
			this.gates.delete(tabId);
			gate.reached.resolve();
			await gate.release.promise;
		}
		const tab = this.tabs.get(tabId);
		return tab ? { ...tab } : null;
	}
	async selectTab(tabId: number) {
		this.calls.push(`select ${tabId}`);
	}
	async getWindow(windowId: number) {
		return this.windows.get(windowId) ?? { type: "normal", focused: false };
	}
	async focusWindow(windowId: number) {
		this.calls.push(`focus ${windowId}`);
	}
	async lastFocusedNormalWindow() {
		this.onLastFocused();
		return this.lastNormal;
	}
}

/** omp's page opened tab 3 in popup window 7. */
function popupWindow(chrome: FakeChrome, placement: PopupPlacement, focused: boolean): void {
	chrome.tabs.set(3, { active: true, windowId: 7 });
	chrome.windows.set(7, { type: "popup", focused });
	placement.opened(3);
}

/** Chrome selects tab `tabId` in window 1, as it does for a new tab or a click. */
function select(chrome: FakeChrome, placement: PopupPlacement, tabId: number): void {
	for (const tab of chrome.tabs.values()) if (tab.windowId === 1) tab.active = false;
	chrome.tabs.set(tabId, { active: true, windowId: 1 });
	placement.activated(1, tabId);
}

function setup(focused = true): { chrome: FakeChrome; placement: PopupPlacement } {
	const chrome = new FakeChrome();
	const placement = new PopupPlacement(chrome, () => chrome.now);
	chrome.tabs.set(1, { active: false, windowId: 1 }); // omp's tab
	chrome.tabs.set(2, { active: true, windowId: 1 }); // the user's tab
	placement.seed(1, 2, focused);
	return { chrome, placement };
}

describe("PopupPlacement", () => {
	it("reselects the tab a popup displaced", async () => {
		const { chrome, placement } = setup();
		placement.opened(3);
		select(chrome, placement, 3);
		await placement.background(3);
		expect(chrome.calls).toEqual(["select 2"]);
	});

	it("leaves the selection alone when the user switches tabs while it looks up the displaced tab", async () => {
		const { chrome, placement } = setup();
		chrome.tabs.set(4, { active: false, windowId: 1 });
		placement.opened(3);
		select(chrome, placement, 3);
		const gate = { reached: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		chrome.gates.set(2, gate);
		const backgrounded = placement.background(3);
		await gate.reached.promise;
		select(chrome, placement, 4);
		gate.release.resolve();
		await backgrounded;
		expect(chrome.calls).toEqual([]);
	});

	it.each([
		{ order: "first popup first", first: 3, second: 5 },
		{ order: "second popup first", first: 5, second: 3 },
	])(
		"restores the user's tab, never another popup, when two popups displace each other ($order)",
		async ({ first, second }) => {
			const { chrome, placement } = setup();
			placement.opened(3);
			select(chrome, placement, 3);
			placement.opened(5);
			select(chrome, placement, 5);
			await placement.background(first);
			await placement.background(second);
			expect(chrome.calls).toEqual(["select 2"]);
		},
	);

	it("leaves a popup the user selected again before the request arrived", async () => {
		const { chrome, placement } = setup();
		placement.opened(3);
		select(chrome, placement, 3);
		select(chrome, placement, 2);
		select(chrome, placement, 3);
		await placement.background(3);
		expect(chrome.calls).toEqual([]);
	});

	it("restores a popup the user selected by hand once it was put back", async () => {
		const { chrome, placement } = setup();
		placement.opened(3);
		select(chrome, placement, 3);
		await placement.background(3);
		select(chrome, placement, 2);
		// The user picks the popup, then omp's page opens another one over it.
		select(chrome, placement, 3);
		placement.opened(5);
		select(chrome, placement, 5);
		chrome.calls.length = 0;
		await placement.background(5);
		expect(chrome.calls).toEqual(["select 3"]);
	});

	it.each([
		{ order: "after Chrome reports the popup's focus", reported: true },
		{ order: "before Chrome reports the popup's focus", reported: false },
	])(
		"gives focus back to the window a popup window took it from, the request arriving $order",
		async ({ reported }) => {
			const { chrome, placement } = setup();
			popupWindow(chrome, placement, true);
			if (reported) placement.focusChanged(7);
			await placement.background(3);
			expect(chrome.calls).toEqual(["focus 1"]);
		},
	);

	it("gives focus back once a popup window Chrome had not shown yet takes it", async () => {
		const { chrome, placement } = setup();
		popupWindow(chrome, placement, false);
		await placement.background(3);
		expect(chrome.calls).toEqual([]);
		placement.focusChanged(7);
		await Promise.resolve();
		expect(chrome.calls).toEqual(["focus 1"]);
	});

	it.each([
		{ case: "the user focused another window first", first: 9 },
		{ case: "the user switched to another app first", first: NO_WINDOW },
	])("leaves a popup window that takes focus late alone when $case", async ({ first }) => {
		const { chrome, placement } = setup();
		popupWindow(chrome, placement, false);
		await placement.background(3);
		placement.focusChanged(first);
		chrome.now += 1_000;
		placement.focusChanged(7);
		await Promise.resolve();
		expect(chrome.calls).toEqual([]);
	});

	it("leaves a popup window alone when the user clicks it after moving away from it", async () => {
		const { chrome, placement } = setup();
		popupWindow(chrome, placement, false);
		placement.focusChanged(7);
		placement.focusChanged(9);
		await placement.background(3);
		placement.focusChanged(7);
		await Promise.resolve();
		expect(chrome.calls).toEqual([]);
	});

	it("leaves a popup window alone when Chrome already reports it unfocused before the user's switch arrives", async () => {
		const { chrome, placement } = setup();
		popupWindow(chrome, placement, false);
		placement.focusChanged(7);
		await placement.background(3);
		expect(chrome.calls).toEqual([]);
	});

	it("gives focus back to the window focused last when Chrome had focus before any focus change was seen", async () => {
		const { chrome, placement } = setup(false);
		popupWindow(chrome, placement, true);
		placement.focusChanged(7);
		await placement.background(3);
		expect(chrome.calls).toEqual(["focus 1"]);
	});

	it.each([
		{ case: "the user moves on while Chrome looks up the window focused last", moveTo: 9, last: 1 },
		{ case: "the window focused last is the popup's own", moveTo: undefined, last: 7 },
	])("focuses nothing when focus was not known before a popup window and $case", async ({ moveTo, last }) => {
		const { chrome, placement } = setup(false);
		popupWindow(chrome, placement, true);
		chrome.lastNormal = last;
		if (moveTo !== undefined) chrome.onLastFocused = () => placement.focusChanged(moveTo);
		placement.focusChanged(7);
		await placement.background(3);
		expect(chrome.calls).toEqual([]);
	});

	it("keeps a focus change Chrome reported while the hello's snapshot was being taken", async () => {
		const chrome = new FakeChrome();
		const placement = new PopupPlacement(chrome, () => chrome.now);
		placement.focusChanged(NO_WINDOW);
		chrome.now += 1_000;
		placement.seed(1, 2, true);
		popupWindow(chrome, placement, true);
		placement.focusChanged(7);
		await placement.background(3);
		expect(chrome.calls).toEqual([]);
	});

	it.each([
		{ case: "Chrome was not the active app", before: [NO_WINDOW], after: [], focused: false },
		{ case: "the popup made Chrome the active app", before: [NO_WINDOW], after: [], focused: true },
		{ case: "the user focused another window since", before: [], after: [9], focused: false },
		{ case: "the user switched to another app since", before: [], after: [NO_WINDOW], focused: false },
	])("focuses nothing for a popup window when $case", async ({ before, after, focused }) => {
		const { chrome, placement } = setup();
		for (const windowId of before) {
			placement.focusChanged(windowId);
			chrome.now += 1_000;
		}
		popupWindow(chrome, placement, focused);
		placement.focusChanged(7);
		for (const windowId of after) placement.focusChanged(windowId);
		await placement.background(3);
		expect(chrome.calls).toEqual([]);
	});

	it.each([
		{ order: "after Chrome reports the popup's focus", at: "after" },
		{ order: "between the two focus reports", at: "between" },
		{ order: "before Chrome reports no focus", at: "before" },
	])(
		"looks through a moment of no focus between the user's window and a popup window, the request arriving $order",
		async ({ at }) => {
			const { chrome, placement } = setup();
			popupWindow(chrome, placement, at === "after");
			if (at === "before") await placement.background(3);
			placement.focusChanged(NO_WINDOW);
			chrome.now += 20;
			if (at === "between") await placement.background(3);
			placement.focusChanged(7);
			if (at === "after") await placement.background(3);
			await Promise.resolve();
			expect(chrome.calls).toEqual(["focus 1"]);
		},
	);

	it("focuses no closed window through a moment of no focus", async () => {
		const { chrome, placement } = setup();
		popupWindow(chrome, placement, true);
		chrome.lastNormal = undefined;
		placement.focusChanged(NO_WINDOW);
		placement.windowRemoved(1);
		placement.focusChanged(7);
		await placement.background(3);
		expect(chrome.calls).toEqual([]);
	});

	it("puts back a popup's popup opened before omp attached to the first popup", async () => {
		const { chrome, placement } = setup();
		placement.openedFrom(1, 3, true);
		select(chrome, placement, 3);
		placement.openedFrom(3, 5, false);
		select(chrome, placement, 5);
		await placement.background(5);
		expect(chrome.calls).toEqual(["select 2"]);
	});

	it("leaves a tab the user's own tab opened alone", async () => {
		const { chrome, placement } = setup();
		placement.openedFrom(2, 3, false);
		select(chrome, placement, 3);
		await placement.background(3);
		expect(chrome.calls).toEqual([]);
	});

	it.each([
		{ order: "first popup first", first: 3, second: 5 },
		{ order: "second popup first", first: 5, second: 3 },
	])(
		"gives focus back to the user's window, never another popup window, when two popup windows took it ($order)",
		async ({ first, second }) => {
			const { chrome, placement } = setup();
			popupWindow(chrome, placement, true);
			placement.focusChanged(7);
			chrome.windows.set(7, { type: "popup", focused: false });
			chrome.tabs.set(5, { active: true, windowId: 8 });
			chrome.windows.set(8, { type: "popup", focused: true });
			placement.opened(5);
			placement.focusChanged(8);
			await placement.background(first);
			await placement.background(second);
			expect(chrome.calls).toEqual(["focus 1"]);
		},
	);

	it("gives focus back to the user's window once a popup window opened over another popup window takes it", async () => {
		const { chrome, placement } = setup();
		popupWindow(chrome, placement, true);
		placement.focusChanged(7);
		chrome.tabs.set(5, { active: true, windowId: 8 });
		chrome.windows.set(8, { type: "popup", focused: false });
		placement.opened(5);
		await placement.background(5);
		expect(chrome.calls).toEqual([]);
		placement.focusChanged(8);
		await Promise.resolve();
		expect(chrome.calls).toEqual(["focus 1"]);
	});

	it("forgets a closed window's selection", async () => {
		const { chrome, placement } = setup();
		placement.windowRemoved(1);
		placement.opened(3);
		select(chrome, placement, 3);
		await placement.background(3);
		expect(chrome.calls).toEqual([]);
	});
});
