import { afterAll, beforeAll, expect, it } from "bun:test";
import type { Server } from "bun";
import puppeteer, { type Page } from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";
import { startWorker, type WorkerHarness } from "./browser-worker-harness";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

/**
 * `/never` is requested and never answered; `/next` answers after a second, so
 * its navigation is still pending when a late stop could land; `/` answers at
 * once; `/streaming/<key>` sends its head, then its tail once the test opens
 * that key's gate.
 */
let server: Server<unknown> | undefined;
const requested = new Map<string, PromiseWithResolvers<void>>();
const tails = new Map<string, PromiseWithResolvers<void>>();
const hanging: Array<() => void> = [];
const signal = (map: Map<string, PromiseWithResolvers<void>>, key: string): PromiseWithResolvers<void> => {
	let entry = map.get(key);
	if (!entry) {
		entry = Promise.withResolvers<void>();
		map.set(key, entry);
	}
	return entry;
};

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		fetch(request) {
			const html = { "content-type": "text/html; charset=utf-8" };
			const path = new URL(request.url).pathname;
			signal(requested, path).resolve();
			if (path === "/never") return new Promise<Response>(resolve => hanging.push(() => resolve(new Response("late"))));
			if (path === "/next")
				return Bun.sleep(1_000).then(() => new Response("<!doctype html><title>Next page</title>", { headers: html }));
			if (path.startsWith("/streaming/")) {
				const tail = signal(tails, path);
				return new Response(
					new ReadableStream({
						async start(controller) {
							controller.enqueue(new TextEncoder().encode("<!doctype html><title>Streaming</title><p>Head</p>"));
							await tail.promise;
							controller.enqueue(new TextEncoder().encode("<p>Tail</p>"));
							controller.close();
						},
					}),
					{ headers: html },
				);
			}
			return new Response("<!doctype html><title>First page</title>", { headers: html });
		},
	});
});

afterAll(async () => {
	for (const tail of tails.values()) tail.resolve();
	for (const release of hanging.splice(0)) release();
	await server?.stop(true);
});

/** A real worker on its own Chromium, with the test's handle on the worker's page. */
async function withWorker(body: (worker: WorkerHarness, page: Page, origin: string) => Promise<void>): Promise<void> {
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
		await body(worker, page, `http://127.0.0.1:${server!.port}`);
	} finally {
		await worker.close();
		await browser.close();
	}
}

const gotoCode = (url: string) => `await tab.goto(${JSON.stringify(url)});`;

it.skipIf(!CHROMIUM_AVAILABLE)(
	"stops an aborted goto's load without cancelling the navigation the tab runs next",
	() =>
		withWorker(async (worker, page, origin) => {
			expect((await worker.run({ code: gotoCode(`${origin}/`), timeoutMs: 10_000 })).ok).toBe(true);
			const aborted = worker.run({ id: "abandoned", code: gotoCode(`${origin}/never`), timeoutMs: 10_000 });
			await signal(requested, "/never").promise;
			// The next CDP session the worker opens attaches late, as on a busy
			// browser: cleanup that waited on one would land after the next
			// navigation started. A real delay: the race is on the wall clock.
			const proto = Object.getPrototypeOf(page) as { createCDPSession: Page["createCDPSession"] };
			const create = proto.createCDPSession;
			let delayNext = true;
			proto.createCDPSession = async function (this: Page) {
				const delay = delayNext;
				delayNext = false;
				const session = await create.call(this);
				if (delay) await Bun.sleep(500);
				return session;
			};
			try {
				worker.send({ type: "abort", id: "abandoned" });
				expect((await aborted).ok).toBe(false);
				const next = await worker.run({
					code: `${gotoCode(`${origin}/next`)} return await page.title();`,
					timeoutMs: 10_000,
				});
				if (!next.ok) throw new Error(next.error.message);
				expect(next.payload.returnValue).toBe("Next page");
			} finally {
				proto.createCDPSession = create;
			}
		}),
	30_000,
);

it.skipIf(!CHROMIUM_AVAILABLE)(
	"lets a goto still loading when its run ends finish loading",
	() =>
		withWorker(async (worker, page, origin) => {
			// The cell returns once the head is in, leaving goto waiting for the load.
			const run = await worker.run({
				code: `void tab.goto(${JSON.stringify(`${origin}/streaming/floating`)}).catch(() => {});
await page.waitForFunction(() => document.body?.innerText.includes("Head"), { timeout: 5_000 });`,
				timeoutMs: 10_000,
			});
			if (!run.ok) throw new Error(run.error.message);
			signal(tails, "/streaming/floating").resolve();
			await page.waitForFunction(`document.body.innerText.includes("Tail")`, { timeout: 5_000 });
		}),
	30_000,
);
