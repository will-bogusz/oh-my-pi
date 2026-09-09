import { expect, it } from "bun:test";
import {
	clickInBackground,
	type HandleOpGuard,
	readPageMetrics,
	toActionableHandle,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer, { type ElementHandle } from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

it("does not dispatch a timed-out quiet click when scrolling later completes", async () => {
	const started = Promise.withResolvers<void>();
	const scroll = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	let points = 0;
	let clicks = 0;
	let disposed = false;
	const handle = {
		click: async () => {
			throw new Error("raw click must not wait for IntersectionObserver");
		},
		scrollIntoView: async () => {
			started.resolve();
			await scroll.promise;
			finished.resolve();
		},
		clickablePoint: async () => {
			points++;
			return { x: 10, y: 20 };
		},
		frame: {
			page: () => ({
				isClosed: () => false,
				emulateFocusedPage: async () => {},
				mouse: { click: async () => clicks++ },
			}),
		},
		type: async () => {},
		dispose: async () => {
			disposed = true;
		},
	} as unknown as ElementHandle;
	const deadline = new AbortController();
	const guard: HandleOpGuard = (_label, action) => action(deadline.signal);
	const enriched = toActionableHandle(handle, guard, undefined, true);
	const pending = enriched.click();
	await started.promise;
	deadline.abort(new Error("quiet click deadline"));
	await expect(pending).rejects.toThrow("quiet click deadline");
	scroll.resolve();
	await finished.promise;
	await Promise.resolve();
	expect(disposed).toBe(true);
	expect(points).toBe(0);
	expect(clicks).toBe(0);
	await expect(enriched.click()).rejects.toThrow("invalidated");
});

it("checks cancellation again after geometry and before trusted pointer input", async () => {
	const deadline = new AbortController();
	let clicks = 0;
	const handle = {
		scrollIntoView: async () => {},
		clickablePoint: async () => {
			deadline.abort(new Error("lease released"));
			return { x: 10, y: 20 };
		},
		frame: {
			page: () => ({
				isClosed: () => false,
				emulateFocusedPage: async () => {},
				mouse: { click: async () => clicks++ },
			}),
		},
	} as unknown as ElementHandle;
	await expect(clickInBackground(handle, {}, deadline.signal)).rejects.toThrow("lease released");
	expect(clicks).toBe(0);
});

// Opt-in real Chromium regression, without a visible browser or user profile.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"clicks with trusted input while real Puppeteer waits on a suspended intersection observer",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 5000,
			defaultViewport: null,
			args: ["--window-size=1000,900"],
		});
		try {
			const page = await browser.newPage();
			expect(page.viewport()).toBeNull();
			expect((await readPageMetrics(page)).viewport.width).toBe(1000);
			await page.setContent(
				'<div style="height:1800px"></div><input type="checkbox" data-events="" onclick="this.dataset.events += event.isTrusted + String.fromCharCode(44)">',
			);
			const handle = await page.$("input");
			if (!handle) throw new Error("missing test checkbox");
			// Puppeteer's action decorators transfer the handle into its utility world.
			const utility = (
				page.mainFrame() as unknown as { isolatedRealm(): { evaluate(script: string): Promise<unknown> } }
			).isolatedRealm();
			await utility.evaluate(
				"globalThis.observerWaits=0; globalThis.IntersectionObserver=class { observe(){globalThis.observerWaits++} disconnect(){} }",
			);
			let originalFinished = false;
			void handle.click().then(
				() => {
					originalFinished = true;
				},
				() => {},
			);
			for (let i = 0; i < 100; i++) {
				if ((await utility.evaluate("globalThis.observerWaits")) === 1) break;
				await Bun.sleep(10);
			}
			expect(await utility.evaluate("globalThis.observerWaits")).toBe(1);
			expect(originalFinished).toBe(false);
			expect(await page.evaluate("document.querySelector('input').dataset.events")).toBe("");
			const guard: HandleOpGuard = (_label, action) => action(AbortSignal.timeout(2000));
			await toActionableHandle(handle, guard, undefined, true).click();
			expect(await page.evaluate("document.querySelector('input').checked")).toBe(true);
			expect(await page.evaluate("document.querySelector('input').dataset.events")).toBe("true,");
			expect(originalFinished).toBe(false);
			expect(await utility.evaluate("globalThis.observerWaits")).toBe(1);
		} finally {
			await browser.close();
		}
	},
	15_000,
);
