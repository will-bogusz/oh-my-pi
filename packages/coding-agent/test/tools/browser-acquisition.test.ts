import { expect, it, spyOn } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import initialObservationCode from "../../src/tools/browser/initial-observation.js.txt" with { type: "text" };
import * as managed from "@oh-my-pi/pi-coding-agent/tools/browser/managed-chrome";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as supervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

it("skips the acquisition capture when the tree failed, and displays only the errors", async () => {
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
	// A page the tree could not be read from is not worth photographing: the
	// capture would spend its own full deadline discovering the same thing.
	expect(calls).toEqual(["controls"]);
	expect(result.screenshotError).toBeUndefined();
	expect(displays).toEqual([{ inspectionError: result.inspectionError }]);
	calls.length = 0;
	displays.length = 0;
	const textOnly = await runInContext(`(${initialObservationCode})({tab}, {screenshot: false})`, context);
	expect(calls).toEqual(["controls"]);
	expect(textOnly.screenshotError).toBeUndefined();
	// A readable tree is photographed, and a capture failure is still reported.
	context.tab.observe = async () => {
		calls.push("controls");
		return { tree: 'url: x\ne1 button "Go"', elements: [] };
	};
	calls.length = 0;
	displays.length = 0;
	const shotFailed = await runInContext(`(${initialObservationCode})({tab}, {})`, context);
	expect(calls).toEqual(["controls", "capture"]);
	expect(shotFailed.screenshotError).toContain("Capture unavailable");
	// A clean acquisition adds nothing: observe() printed the tree already.
	context.tab.screenshot = async () => "/tmp/shot.webp";
	displays.length = 0;
	const clean = await runInContext(`(${initialObservationCode})({tab}, {})`, context);
	expect(clean.initialObservation.tree).toContain('e1 button "Go"');
	expect(clean.initialScreenshot).toBe("/tmp/shot.webp");
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

// A claim's first tree printed whole whatever the caller asked: it could not be
// scoped, compacted or silenced. Its `observation` takes observe()'s options.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"narrows and silences an acquired tab's first tree with observe()'s options",
	async () => {
		const session: ToolSession = {
			cwd: import.meta.dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "browser.enabled": true }),
		};
		const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browser)) throw new Error("Expected a Puppeteer browser");
		// A real tab stands in for the user's Chrome tab the relay would have leased.
		const name = `acquired-${process.pid}-${crypto.randomUUID()}`;
		const html =
			'<nav><a href="#top">Outside link</a></nav><main><h1>Inside heading</h1><button>Inside button</button></main>';
		const tab = {
			id: "discovery-9",
			tabId: 9,
			browserId: "profile",
			browserLabel: "Fixture profile",
			windowId: 3,
			title: "Fixture",
			url: "about:blank",
			active: false,
			pinned: false,
			groupId: -1,
			ownership: "this_actor" as const,
		};
		const acquire = spyOn(managed, "acquireChromeTab").mockResolvedValue({
			id: name,
			label: "Fixture",
			owner: "actor",
			url: tab.url,
			lease: {
				id: "lease",
				targetId: "PAGE9",
				created: true,
				browserId: "profile",
				browserLabel: "Fixture profile",
				tab,
			},
		});
		try {
			await supervisor.acquireTab(name, browser, {
				url: `data:text/html,${encodeURIComponent(html)}`,
				timeoutMs: 30_000,
			});
			const result = await createBrowserPrelude(session).invoke(
				{
					action: "create",
					observation: { selector: "main", compact: true, display: false, screenshot: false },
				},
				{ session, toolCallId: "narrowed" },
			);
			const { value } = result.details as {
				value: { initialObservation: { tree: string }; initialScreenshot?: string };
			};
			const tree = value.initialObservation.tree;
			expect(tree).toContain('button "Inside button"');
			// selector: nothing outside <main>; compact: no non-control content.
			expect(tree).not.toContain("Outside link");
			expect(tree).not.toContain("Inside heading");
			expect(value.initialScreenshot).toBeUndefined();
			// display: false keeps the tree out of the acquisition's output.
			const printed = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
			expect(printed).not.toContain("Inside button");
		} finally {
			acquire.mockRestore();
			await supervisor.releaseTab(name, { kill: true });
			if (browser.browser.connected) await releaseBrowser(browser, { kill: true });
		}
	},
	45_000,
);

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
