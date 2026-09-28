import { afterAll, beforeAll, expect, it } from "bun:test";
import type { Server } from "bun";
import puppeteer, { type Page } from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";
import { startWorker } from "./browser-worker-harness";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

/**
 * `/never` is requested and never answered; `/next` answers after a second, so
 * its navigation is still pending when a late stop could land; `/` answers at
 * once; `/streaming` sends its head, then its tail once the test opens `tailGate`.
 */
let server: Server<unknown> | undefined;
const neverRequested = Promise.withResolvers<void>();
const tailGate = Promise.withResolvers<void>();
const hanging: Array<() => void> = [];

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		fetch(request) {
			const html = { "content-type": "text/html; charset=utf-8" };
			switch (new URL(request.url).pathname) {
				case "/never":
					neverRequested.resolve();
					return new Promise<Response>(resolve => hanging.push(() => resolve(new Response("late"))));
				case "/next":
					return Bun.sleep(1_000).then(
						() => new Response("<!doctype html><title>Next page</title>", { headers: html }),
					);
				case "/streaming":
					return new Response(
						new ReadableStream({
							async start(controller) {
								controller.enqueue(new TextEncoder().encode("<!doctype html><title>Streaming</title><p>Head</p>"));
								await tailGate.promise;
								controller.enqueue(new TextEncoder().encode("<p>Tail</p>"));
								controller.close();
							},
						}),
						{ headers: html },
					);
				default:
					return new Response("<!doctype html><title>First page</title>", { headers: html });
			}
		},
	});
});

afterAll(async () => {
	tailGate.resolve();
	for (const release of hanging.splice(0)) release();
	await server?.stop(true);
});

it.skipIf(!CHROMIUM_AVAILABLE)(
	"stops an aborted goto's load without cancelling the navigation the tab runs next",
	async () => {
		const origin = `http://127.0.0.1:${server!.port}`;
		const browser = await puppeteer.launch({ executablePath: await chromiumExecutable(), headless: true });
		const worker = startWorker();
		const pageProto = Object.getPrototypeOf(await browser.newPage()) as { createCDPSession: Page["createCDPSession"] };
		const create = pageProto.createCDPSession;
		try {
			await worker.init({
				mode: "headless",
				browserWSEndpoint: browser.wsEndpoint(),
				safeDir: process.cwd(),
				timeoutMs: 10_000,
			});
			const first = await worker.run({ code: `await tab.goto(${JSON.stringify(`${origin}/`)});`, timeoutMs: 10_000 });
			expect(first.ok).toBe(true);
			const aborted = worker.run({
				id: "abandoned",
				code: `await tab.goto(${JSON.stringify(`${origin}/never`)});`,
				timeoutMs: 10_000,
			});
			await neverRequested.promise;
			// The next CDP session the worker opens attaches late, as on a busy
			// browser: cleanup that waited on one would land after the next
			// navigation started. A real delay: the race is on the wall clock.
			let delayNext = true;
			pageProto.createCDPSession = async function (this: Page) {
				const delay = delayNext;
				delayNext = false;
				const session = await create.call(this);
				if (delay) await Bun.sleep(500);
				return session;
			};
			worker.send({ type: "abort", id: "abandoned" });
			expect((await aborted).ok).toBe(false);
			const next = await worker.run({
				code: `await tab.goto(${JSON.stringify(`${origin}/next`)}); return await page.title();`,
				timeoutMs: 10_000,
			});
			if (!next.ok) throw new Error(next.error.message);
			expect(next.payload.returnValue).toBe("Next page");
		} finally {
			pageProto.createCDPSession = create;
			await worker.close();
			await browser.close();
		}
	},
	30_000,
);

it.skipIf(!CHROMIUM_AVAILABLE)(
	"lets a goto still loading when its run ends finish loading",
	async () => {
		const browser = await puppeteer.launch({ executablePath: await chromiumExecutable(), headless: true });
		const worker = startWorker();
		try {
			const target = await worker.init({
				mode: "headless",
				browserWSEndpoint: browser.wsEndpoint(),
				safeDir: process.cwd(),
				timeoutMs: 10_000,
			});
			const page = (await browser.pages()).find(
				candidate => (candidate.target() as { _targetId?: string })._targetId === target.targetId,
			);
			if (!page) throw new Error("Missing worker page");
			// The cell returns once the head is in, leaving goto waiting for the load.
			const run = await worker.run({
				code: `void tab.goto(${JSON.stringify(`http://127.0.0.1:${server!.port}/streaming`)}).catch(() => {});
await page.waitForFunction(() => document.body?.innerText.includes("Head"), { timeout: 5_000 });`,
				timeoutMs: 10_000,
			});
			if (!run.ok) throw new Error(run.error.message);
			tailGate.resolve();
			await page.waitForFunction(`document.body.innerText.includes("Tail")`, { timeout: 5_000 });
		} finally {
			await worker.close();
			await browser.close();
		}
	},
	30_000,
);
