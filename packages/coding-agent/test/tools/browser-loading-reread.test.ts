import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import puppeteer, { type Browser, type CDPSession, type Frame, type Page } from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";
import { startWorker, type WorkerHarness } from "./browser-worker-harness";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

/**
 * A page that shows a loading indicator, served on 127.0.0.1, with a frame on
 * localhost: a different site, so Chrome runs the frame out of process and an
 * observation reads it on its own session. The indicator keeps the observation
 * re-reading the page until its settle budget runs out.
 */
let server: Server<unknown> | undefined;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
			if (new URL(request.url).pathname === "/frame") return html(`<!doctype html><button>Frame control</button>`);
			return html(
				`<!doctype html><title>Transfer</title><main><div role="progressbar" aria-label="Loading" aria-busy="true"></div><button>Approve transfer</button></main><iframe title="widget" src="http://localhost:${server!.port}/frame"></iframe>`,
			);
		},
	});
});

afterAll(async () => {
	await server?.stop(true);
});

type Send = CDPSession["send"];

/**
 * Open the page on a real worker, then run `observe` with `intercept` in front
 * of every CDP call the tab's sessions make, restoring them after. The delays
 * the cases add are real: the snapshot's deadline is measured on the wall
 * clock, and they stand in for a renderer slow to answer it.
 */
async function observeWith(
	intercept: (context: { method: string; frameId?: string; page: Page; child: Frame; send: () => Promise<unknown> }) => Promise<unknown>,
): Promise<string> {
	const browser: Browser = await puppeteer.launch({
		executablePath: await chromiumExecutable(),
		headless: true,
		protocolTimeout: 10_000,
	});
	const worker: WorkerHarness = startWorker();
	let restore: (() => void) | undefined;
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
		await page.goto(`http://127.0.0.1:${server!.port}/`);
		const child = page.frames().find(frame => frame.parentFrame());
		if (!child || child.client === page.mainFrame().client) throw new Error("The frame is not out of process");
		const proto = Object.getPrototypeOf(page.mainFrame().client) as { send: Send };
		const original = proto.send;
		restore = () => {
			proto.send = original;
		};
		proto.send = function (this: CDPSession, method: string, ...args: unknown[]) {
			const [params] = args;
			const frameId =
				params && typeof params === "object" && "frameId" in params && typeof params.frameId === "string"
					? params.frameId
					: undefined;
			const send = () => (original as (...a: unknown[]) => Promise<unknown>).call(this, method, ...args);
			return intercept({ method, frameId, page, child, send });
		} as Send;
		const outcome = await worker.run({
			code: "return String(await tab.observe({ diff: false, display: false }));",
			timeoutMs: 15_000,
		});
		if (!outcome.ok) throw new Error(outcome.error.message);
		return String(outcome.payload.returnValue);
	} finally {
		restore?.();
		await worker.close();
		await browser.close();
	}
}

describe("re-reading a page that still shows a loading indicator", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"returns the newer read of the page even when it could not read a frame in time",
		async () => {
			let mainReads = 0;
			let childReads = 0;
			const text = await observeWith(async ({ method, frameId, page, child, send }) => {
				if (method !== "Accessibility.getFullAXTree") return send();
				if (frameId === child._id) {
					// The first read of the frame answers; the second does not in time.
					if (++childReads > 1) await Bun.sleep(5_000);
					return send();
				}
				// The page finishes its work between the first and the second read.
				if (frameId === page.mainFrame()._id && ++mainReads === 2)
					await page.evaluate(
						`document.querySelector("main").innerHTML = "<h1>Transfer completed</h1><button>Download receipt</button>"`,
					);
				return send();
			});
			expect(mainReads).toBeGreaterThanOrEqual(2);
			expect(text).toContain('heading "Transfer completed"');
			expect(text).not.toContain("Approve transfer");
			expect(text).toMatch(/\[iframe .*did not answer in time/);
		},
		30_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps a complete read rather than start a re-read too short for a slow frame",
		async () => {
			const text = await observeWith(async ({ method, frameId, child, send }) => {
				const answer = await send();
				// Every read of the frame answers, but only after 1.25 s.
				if (method === "Accessibility.getFullAXTree" && frameId === child._id) await Bun.sleep(1_250);
				return answer;
			});
			expect(text).toContain('button "Frame control"');
			expect(text).not.toContain("did not answer in time");
		},
		30_000,
	);
});
