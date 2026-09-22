import { expect, it } from "bun:test";
import puppeteer from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";
import { startWorker } from "./browser-worker-harness";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

it.skipIf(!CHROMIUM_AVAILABLE)(
	"removes failed-run dialog handlers and preserves controller observers during user listener removal",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 5000,
		});
		const fixture = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("<p>Request completed</p>", { headers: { "content-type": "text/html" } }),
		});
		const worker = startWorker();
		try {
			const target = await worker.init({
				mode: "headless",
				// Enable the managed page policy against our disposable Chromium.
				// No popup is created, so no broker HTTP operation is needed.
				browserWSEndpoint: `${browser.wsEndpoint()}?lease=preparation-fixture`,
				safeDir: process.cwd(),
				timeoutMs: 5000,
			});
			const pages = await browser.pages();
			const page = pages.find(
				candidate => (candidate.target() as { _targetId?: string })._targetId === target.targetId,
			);
			if (!page) throw new Error("Missing prepared page");
			await page.setContent(
				'<button onclick="document.querySelector(&quot;p&quot;).textContent=prompt(&quot;Name&quot;)">Rename</button><p>Original</p>',
			);
			const run = (id: string, code: string) => worker.run({ id, name: "dialog page", code, timeoutMs: 3000 });
			const original = await run("listeners", 'return page.listenerCount("dialog");');
			if (!original.ok) throw new Error(original.error.message);
			const failed = await run(
				"failed",
				'page.once("dialog", dialog => dialog.accept("Stale response")); throw new Error("Operation stopped before click");',
			);
			expect(failed.ok).toBe(false);
			const cleaned = await run("cleaned", 'return page.listenerCount("dialog");');
			if (!cleaned.ok) throw new Error(cleaned.error.message);
			expect(cleaned.payload.returnValue).toBe(original.payload.returnValue);
			const removed = await run(
				"removed",
				'page.on("dialog", () => {}); page.removeAllListeners("dialog"); return page.listenerCount("dialog");',
			);
			if (!removed.ok) throw new Error(removed.error.message);
			expect(removed.payload.returnValue).toBe(original.payload.returnValue);
			const renamed = await run(
				"renamed",
				'page.once("dialog", dialog => dialog.accept("Fresh café Ω")); await tab.click("button");',
			);
			if (!renamed.ok) throw new Error(renamed.error.message);
			expect(await page.$eval("p", element => element.textContent)).toBe("Fresh café Ω");
			const final = await run("final", 'page.removeAllListeners(); return page.listenerCount("dialog");');
			if (!final.ok) throw new Error(final.error.message);
			expect(final.payload.returnValue).toBe(original.payload.returnValue);
			const request = await run(
				"request",
				`
				let requests = 0;
				const stale = () => { throw new Error("Removed request handler fired"); };
				page.once("request", stale);
				page.off("request", stale);
				page.on("request", stale);
				page.removeAllListeners("request");
				page.on("request", request => { requests++; return request.continue(); });
				await page.setRequestInterception(true);
				await page.goto(${JSON.stringify(fixture.url.toString())});
				return { requests, body: await page.$eval("p", element => element.textContent) };
			`,
			);
			if (!request.ok) throw new Error(request.error.message);
			expect(request.payload.returnValue).toEqual({ requests: 1, body: "Request completed" });
		} finally {
			await worker.close();
			await browser.close();
			fixture.stop(true);
		}
	},
	15_000,
);
