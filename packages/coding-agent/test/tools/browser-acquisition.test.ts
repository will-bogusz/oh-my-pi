import { expect, it, spyOn } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import initialObservationCode from "../../src/tools/browser/initial-observation.js.txt" with { type: "text" };
import * as managed from "@oh-my-pi/pi-coding-agent/tools/browser/managed-chrome";
import * as supervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

it("reports missing inspection channels and displays only the errors, never the state blob", async () => {
	const calls: string[] = [];
	const displays: unknown[] = [];
	const context = createContext({
		tab: {
			observe: async () => {
				calls.push("controls");
				throw new Error("AX unavailable");
			},
			screenshot: async () => {
				calls.push("capture");
				throw new Error("Capture unavailable");
			},
		},
		display: (value: unknown) => displays.push(value),
	});
	const result = await runInContext(`(${initialObservationCode})({tab}, {})`, context);
	expect(result.initialObservation).toBeUndefined();
	expect(result.initialScreenshot).toBeUndefined();
	expect(result.inspectionError).toContain("AX unavailable");
	expect(result.screenshotError).toContain("Capture unavailable");
	expect(calls).toEqual(["controls", "capture"]);
	expect(displays).toEqual([{ inspectionError: result.inspectionError, screenshotError: result.screenshotError }]);
	calls.length = 0;
	displays.length = 0;
	const textOnly = await runInContext(`(${initialObservationCode})({tab}, {screenshot: false})`, context);
	expect(calls).toEqual(["controls"]);
	expect(textOnly.screenshotError).toBeUndefined();
	// A clean acquisition adds nothing: observe() printed the tree already.
	context.tab.observe = async () => ({ tree: "url: x\ne1 button \"Go\"", elements: [] });
	context.tab.screenshot = async () => "/tmp/shot.webp";
	displays.length = 0;
	const clean = await runInContext(`(${initialObservationCode})({tab}, {})`, context);
	expect(clean.initialObservation.tree).toContain('e1 button "Go"');
	expect(displays).toEqual([]);
});

it("propagates cancellation instead of returning a partially acquired page", async () => {
	const controller = new AbortController();
	const calls: string[] = [];
	const context = createContext({
		tab: {
			signal: controller.signal,
			observe: async () => {
				controller.abort();
				throw new ToolAbortError("Cancelled inspection");
			},
			screenshot: async () => {
				calls.push("capture");
			},
		},
		display: () => calls.push("display"),
	});
	await expect(runInContext(`(${initialObservationCode})({tab}, {})`, context)).rejects.toThrow(
		"Cancelled inspection",
	);
	expect(calls).toEqual([]);
});

it("hands a cancelled acquisition back, closing only a page it opened, and reports unconfirmed cleanup", async () => {
	const session: ToolSession = {
		cwd: import.meta.dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "browser.enabled": true }),
	};
	const handle: managed.ManagedChromeHandle = {
		id: "worker-handle",
		label: "Fixture",
		owner: "actor",
		url: "http://fixture",
		released: false,
		lease: {
			id: "lease",
			targetId: "PAGE7",
			created: true,
			browserId: "profile",
			browserLabel: "Fixture profile",
			tab: {
				id: "discovery-7",
				tabId: 7,
				browserId: "profile",
				browserLabel: "Fixture profile",
				windowId: 3,
				title: "Fixture",
				url: "http://fixture/",
				active: false,
				pinned: false,
				groupId: -1,
				ownership: "this_actor",
			},
		},
	};
	const calls: string[] = [];
	let retentionFails = false;
	const acquire = spyOn(managed, "acquireChromeTab").mockResolvedValue(handle);
	const run = spyOn(supervisor, "runInTab").mockRejectedValue(new ToolAbortError("Cancelled inspection"));
	const closes: boolean[] = [];
	const lifecycle = spyOn(managed, "releaseChromeTab").mockImplementation(async (target, close) => {
		expect(target.lease.id).toBe("lease");
		calls.push("release");
		closes.push(close);
		if (retentionFails) throw new Error("Retention unconfirmed");
	});
	try {
		const prelude = createBrowserPrelude(session);
		await expect(
			prelude.invoke({ action: "create", url: "http://fixture/" }, { session, toolCallId: "cancel" }),
		).rejects.toThrow("Cancelled inspection");
		expect(calls).toEqual(["release"]);
		// The caller never received this handle, so the tab OMP just created is
		// litter rather than work to preserve.
		expect(closes).toEqual([true]);
		calls.length = 0;
		retentionFails = true;
		await expect(
			prelude.invoke({ action: "create", url: "http://fixture/" }, { session, toolCallId: "failed-cleanup" }),
		).rejects.toThrow("Cleanup also failed: Error: Retention unconfirmed");
		expect(calls).toEqual(["release"]);
	} finally {
		lifecycle.mockRestore();
		run.mockRestore();
		acquire.mockRestore();
	}
});

it("matches title/URL substrings case-insensitively and refuses an ambiguous selector", () => {
	const base = {
		url: "https://fixture.test/form",
		title: "Enrollment",
		windowId: 3,
		tabId: 7,
		active: false,
		pinned: false,
		groupId: -1,
		ownership: "available" as const,
		browserLabel: "Profile",
	};
	const rows = [
		{ ...base, id: "a", browserId: "work" },
		{ ...base, id: "b", browserId: "personal" },
		{ ...base, id: "c", browserId: "work", windowId: 4, tabId: 8 },
	];
	expect(() => managed.selectChromeTab(rows, { title: "Enrollment" })).toThrow("ambiguous (3 matches)");
	expect(managed.selectChromeTab(rows, { title: "Enrollment", browserId: "personal" }).id).toBe("b");
	expect(managed.selectChromeTab(rows, { url: base.url, browserId: "work", windowId: 4 }).id).toBe("c");
	// A page's own live title is what a model can see; matching it must not
	// depend on reproducing the whole string or its casing.
	expect(managed.selectChromeTab(rows, { title: " enROLL ", browserId: "personal" }).id).toBe("b");
	expect(managed.selectChromeTab(rows, { url: "/form", browserId: "personal" }).id).toBe("b");
	expect(() => managed.selectChromeTab(rows, { title: "Enrollment", url: "https://fixture.test/other" })).toThrow(
		"No Chrome tab matches",
	);
	expect(() => managed.selectChromeTab(rows, { title: "Enrollment Confirmation" })).toThrow("No Chrome tab matches");
	expect(() => managed.selectChromeTab(rows, { browserId: "work" })).toThrow("requires a title or URL substring");
	expect(() => managed.selectChromeTab(rows, { title: "  ", browserId: "work" })).toThrow(
		"requires a title or URL substring",
	);
	expect(() => managed.selectChromeTab(rows, { title: "Enrollment", windowId: 1.5 })).toThrow("positive integer");
});
