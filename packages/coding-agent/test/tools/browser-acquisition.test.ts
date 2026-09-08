import { expect, it, spyOn } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import initialObservationCode from "../../src/tools/browser/initial-observation.js.txt" with { type: "text" };
import * as managed from "@oh-my-pi/pi-coding-agent/tools/browser/managed-chrome";
import * as supervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

it("reports missing inspection channels while preserving independently readable text", async () => {
	const calls: string[] = [];
	const displays: unknown[] = [];
	const context = createContext({
		tab: {
			observe: async () => {
				calls.push("controls");
				throw new Error("AX unavailable");
			},
			ariaSnapshot: async () => {
				calls.push("tree");
				return '- paragraph "Saved result"';
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
	expect(result.initialTree).toContain("Saved result");
	expect(calls).toEqual(["controls", "tree", "capture"]);
	expect(displays).toEqual([result]);
	calls.length = 0;
	const textOnly = await runInContext(`(${initialObservationCode})({tab}, {screenshot: false})`, context);
	expect(calls).toEqual(["controls", "tree"]);
	expect(textOnly.screenshotError).toBeUndefined();
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
			ariaSnapshot: async () => {
				calls.push("tree");
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

it("preserves cancelled acquisition and surfaces unconfirmed recovery separately", async () => {
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
			retained: false,
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
	const lifecycle = spyOn(managed, "preserveChromeTab").mockImplementation(async target => {
		expect(target.lease.id).toBe("lease");
		calls.push("preserve");
		if (retentionFails) throw new Error("Retention unconfirmed");
	});
	try {
		const prelude = createBrowserPrelude(session);
		await expect(
			prelude.invoke({ action: "create", url: "http://fixture/" }, { session, toolCallId: "cancel" }),
		).rejects.toThrow("Cancelled inspection");
		expect(calls).toEqual(["preserve"]);
		calls.length = 0;
		retentionFails = true;
		await expect(
			prelude.invoke({ action: "create", url: "http://fixture/" }, { session, toolCallId: "failed-cleanup" }),
		).rejects.toThrow("Cleanup also failed: Error: Retention unconfirmed");
		expect(calls).toEqual(["preserve"]);
	} finally {
		lifecycle.mockRestore();
		run.mockRestore();
		acquire.mockRestore();
	}
});

it("requires an unambiguous title/URL match across browser profiles and windows", () => {
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
	expect(() => managed.selectChromeTab(rows, { title: "Enrollment", url: "https://fixture.test/other" })).toThrow(
		"No Chrome tab matches",
	);
	expect(() => managed.selectChromeTab(rows, { title: "enrollment" })).toThrow("No Chrome tab matches");
	expect(() => managed.selectChromeTab(rows, { browserId: "work" })).toThrow("requires an exact title or URL");
	expect(() => managed.selectChromeTab(rows, { title: "Enrollment", windowId: 1.5 })).toThrow("positive integer");
});
