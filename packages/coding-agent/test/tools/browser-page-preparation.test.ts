import { expect, it } from "bun:test";
import type {
	ReadyInfo,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer from "puppeteer-core";

declare const document: { hasFocus(): boolean };

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"prepares accessibility and input together, then restores focus after success and failure",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
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
