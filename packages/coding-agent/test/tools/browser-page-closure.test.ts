import { expect, it } from "bun:test";
import puppeteer from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";
import { startWorker } from "./browser-worker-harness";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

it.skipIf(!CHROMIUM_AVAILABLE)(
	"returns a completed managed browser run after its target closes with request interception enabled",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 5000,
		});
		const worker = startWorker();
		try {
			const target = await worker.init({
				mode: "headless",
				// Enable the managed page policy against our disposable Chromium.
				// No popup is created, so no broker HTTP operation is needed.
				browserWSEndpoint: `${browser.wsEndpoint()}?lease=closure-fixture`,
				safeDir: process.cwd(),
				timeoutMs: 5000,
			});
			const outcome = await worker.run({
				name: "closure fixture",
				code: 'await page.setRequestInterception(true); await page.close(); display("closed target");',
				timeoutMs: 5000,
			});
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) throw new Error(outcome.error.message);
			expect(outcome.payload.displays).toContainEqual({ type: "text", text: "closed target" });
			const cdp = await browser.target().createCDPSession();
			const remaining = await cdp.send("Target.getTargets");
			expect(remaining.targetInfos.some(info => info.targetId === target.targetId)).toBe(false);
			await cdp.detach();
		} finally {
			await worker.close();
			await browser.close();
		}
	},
	15_000,
);
