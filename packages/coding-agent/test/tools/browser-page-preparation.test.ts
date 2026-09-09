import { expect, it } from "bun:test";
import type {
	Observation,
	ReadyInfo,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

declare const document: { hasFocus(): boolean };

it.skipIf(!CHROMIUM_AVAILABLE)(
	"prepares accessibility and input together, then restores focus after success and failure",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 5000,
		});
		const ready = Promise.withResolvers<ReadyInfo>();
		let result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
		const closed = Promise.withResolvers<void>();
		let receive: (message: WorkerInbound | WorkerOutbound) => void = () => {};
		const transport: Transport = {
			send(message) {
				if (message.type === "ready") ready.resolve(message.info);
				if (message.type === "init-failed") ready.reject(new Error(message.error.message));
				if (message.type === "result") result.resolve(message);
				if (message.type === "closed") closed.resolve();
			},
			onMessage(handler) {
				receive = handler;
				return () => {};
			},
			close() {},
		};
		new WorkerCore(transport, false);
		try {
			receive({
				type: "init",
				payload: {
					mode: "headless",
					// Enable the managed page policy against our disposable Chromium.
					// No popup is created, so no broker HTTP operation is needed.
					browserWSEndpoint: `${browser.wsEndpoint()}?lease=preparation-fixture`,
					safeDir: process.cwd(),
					timeoutMs: 5000,
				},
			});
			const target = await ready.promise;
			const pages = await browser.pages();
			const page = pages.find(
				candidate => (candidate.target() as { _targetId?: string })._targetId === target.targetId,
			);
			if (!page) throw new Error("Missing prepared page");
			await page.setContent('<button onclick="this.dataset.saved=String(document.hasFocus())">Save</button>');
			const foreground = await browser.newPage();
			await foreground.bringToFront();
			expect(await page.evaluate(() => document.hasFocus())).toBe(false);
			const run = async (id: string, code: string) => {
				result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
				receive({ type: "run", id, name: "prepared page", code, timeoutMs: 3000, session: { cwd: process.cwd() } });
				return await result.promise;
			};
			const read = await run("read", 'await page.waitForSelector("aria/Save");');
			expect(read.ok).toBe(true);
			expect([
				await page.evaluate(() => document.hasFocus()),
				await foreground.evaluate(() => document.hasFocus()),
			]).toEqual([false, true]);
			const failed = await run("failure", 'await tab.click("aria/Missing", { timeout: 50 });');
			expect(failed.ok).toBe(false);
			if (failed.ok) throw new Error("Missing selector unexpectedly succeeded");
			expect(failed.error.message).toContain("Missing");
			expect(await page.evaluate(() => document.hasFocus())).toBe(false);
			const recovered = await run("recovered", 'await page.waitForSelector("aria/Save");');
			expect(recovered.ok).toBe(true);
			expect(await page.evaluate(() => document.hasFocus())).toBe(false);
			expect(await foreground.evaluate(() => document.hasFocus())).toBe(true);
			const saved = await run("save", 'await page.waitForSelector("aria/Save"); await tab.click("aria/Save");');
			if (!saved.ok) throw new Error(saved.error.message);
			expect(await page.$eval("button", el => el.getAttribute("data-saved"))).toBe("true");
			expect(await foreground.evaluate(() => document.hasFocus())).toBe(true);
		} finally {
			receive({ type: "close" });
			await closed.promise;
			await browser.close();
		}
	},
	15_000,
);

/**
 * `tab.scroll("down", { by: "page" })` is the form models write. It used to
 * reach CDP as `Input.dispatchMouseEvent { deltaX: "down" }` — a protocol
 * error instead of a scroll — so both argument shapes are pinned here.
 */
it.skipIf(!CHROMIUM_AVAILABLE)(
	"scrolls by pixel deltas and by a page step in a named direction",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 5000,
		});
		const ready = Promise.withResolvers<ReadyInfo>();
		let result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
		const closed = Promise.withResolvers<void>();
		let receive: (message: WorkerInbound | WorkerOutbound) => void = () => {};
		const transport: Transport = {
			send(message) {
				if (message.type === "ready") ready.resolve(message.info);
				if (message.type === "init-failed") ready.reject(new Error(message.error.message));
				if (message.type === "result") result.resolve(message);
				if (message.type === "closed") closed.resolve();
			},
			onMessage(handler) {
				receive = handler;
				return () => {};
			},
			close() {},
		};
		new WorkerCore(transport, false);
		try {
			receive({
				type: "init",
				payload: {
					mode: "headless",
					browserWSEndpoint: browser.wsEndpoint(),
					safeDir: process.cwd(),
					viewport: { width: 800, height: 600 },
					timeoutMs: 5000,
				},
			});
			const target = await ready.promise;
			const pages = await browser.pages();
			const page = pages.find(
				candidate => (candidate.target() as { _targetId?: string })._targetId === target.targetId,
			);
			if (!page) throw new Error("Missing prepared page");
			await page.setContent('<body style="margin:0"><div style="height:6000px"></div></body>');
			const run = async (id: string, code: string) => {
				result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
				receive({ type: "run", id, name: "scrolled page", code, timeoutMs: 3000, session: { cwd: process.cwd() } });
				return await result.promise;
			};
			// A wheel event scrolls asynchronously, so wait for the position to
			// stop moving rather than reading whatever it is one round trip later.
			// The return type is `tab.observe()`'s own; the worker sends it over a
			// structured-clone transport, so there is nothing to validate here.
			const settled = async (id: string, code: string): Promise<Observation> => {
				const message = await run(
					id,
					`await page.evaluate("window.__y = -1");
					${code}
					await page.waitForFunction(
						"(() => { const y = window.scrollY; const stable = window.__y === y; window.__y = y; return stable; })()",
						{ polling: 30, timeout: 2000 },
					);
					return await tab.observe();`,
				);
				if (!message.ok) throw new Error(message.error.message);
				return message.payload.returnValue as Observation;
			};
			// One page step is most of a viewport, so the content at the boundary
			// stays on screen; anything beyond a full viewport would skip content.
			const paged = await settled("paged", 'await tab.scroll("down", { by: "page" });');
			expect(paged.scroll.y).toBeGreaterThan(paged.viewport.height * 0.75);
			expect(paged.scroll.y).toBeLessThanOrEqual(paged.viewport.height);

			const pixels = await settled("pixels", "await tab.scroll(0, 150);");
			expect(pixels.scroll.y).toBe(paged.scroll.y + 150);

			const bad = await run("bad", 'await tab.scroll("sideways");');
			expect(bad.ok).toBe(false);
			if (bad.ok) throw new Error("An unknown direction unexpectedly scrolled");
			expect(bad.error.message).toContain("up, down, left, right");
		} finally {
			receive({ type: "close" });
			await closed.promise;
			await browser.close();
		}
	},
	15_000,
);
