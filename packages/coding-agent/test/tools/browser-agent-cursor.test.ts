import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	acquireBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { decodePng } from "@oh-my-pi/pi-coding-agent/tools/browser/screenshot";
import { acquireTab, getTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { $which } from "@oh-my-pi/pi-utils/which";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const FFMPEG_AVAILABLE = Boolean($which("ffmpeg"));

/**
 * Main's identity colour, #268bd2, matched within a few levels: the cursor's arrow and badge fill it solidly, while
 * Linux Chrome's subpixel text antialiasing leaves bluish fringes on black text that a looser match counts.
 */
const CURSOR_RGB = [0x26, 0x8b, 0xd2] as const;

function sessionWith(cursor: boolean): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "browser.cursor": cursor }),
		getSessionFile: () => null,
		getAgentId: () => "Main",
	} as unknown as ToolSession;
}

const page = (body: string): Response =>
	new Response(`<!doctype html><body style="margin:0;background:#fff">${body}</body>`, {
		headers: { "content-type": "text/html" },
	});

let server: Bun.Server<undefined>;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	// The iframe is served from `localhost`, another site than the top page's `127.0.0.1`: Chrome runs it out of process.
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/frame") {
				return page(
					`<button style="position:absolute;left:100px;top:80px;width:100px;height:40px;border:0;background:#ddd">In</button>`,
				);
			}
			if (pathname === "/next") return page("<p style='font:20px sans-serif;margin:0'>next</p>");
			return page(
				`<button id="go" style="position:absolute;left:80px;top:80px;width:120px;height:40px;border:0;background:#ddd">Go</button>` +
					`<a id="next" href="/next" style="position:absolute;left:80px;top:300px;font:20px sans-serif;color:#000">Next</a>` +
					`<iframe src="http://localhost:${server.port}/frame" style="position:absolute;left:400px;top:60px;width:300px;height:200px;border:0"></iframe>`,
			);
		},
	});
});

afterAll(() => {
	server?.stop(true);
});

/**
 * Cell code returning a viewport capture taken past `page.screenshot` (which hides the cursor), once the page has drawn every
 * cursor call omp sent before it (they run in order on the page's main thread).
 */
const RAW_CAPTURE = `
	await page.evaluate(() => {
		const frames = Promise.withResolvers();
		requestAnimationFrame(() => requestAnimationFrame(frames.resolve));
		return frames.promise;
	});
	const cdp = await page.createCDPSession();
	const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
	await cdp.detach();
	return { png: data, width: await page.evaluate(() => innerWidth) };
`;

async function run<T>(name: string, session: ToolSession, code: string): Promise<T> {
	const result = await runInTab(name, { code, timeoutMs: 30_000, session });
	return result.returnValue as T;
}

/** Open tab `name` on the fixture in a headless browser of its own; `close` closes both. */
async function openTab(
	name: string,
	session: ToolSession,
): Promise<{ handle: PuppeteerBrowserHandle; close: () => Promise<void> }> {
	const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
	if (!("browser" in handle)) throw new Error("Expected a Puppeteer browser");
	const close = async (): Promise<void> => {
		await releaseTab(name);
		if (handle.browser.connected) await releaseBrowser(handle, { kill: true });
	};
	try {
		await acquireTab(name, handle, { url: `http://127.0.0.1:${server.port}/`, timeoutMs: 30_000 });
		// Reduced motion: no glide or ripple, so a capture shows the cursor where it was last placed.
		await run(
			name,
			session,
			`await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);`,
		);
	} catch (error) {
		await close();
		throw error;
	}
	return { handle, close };
}

/** Cursor-coloured pixels inside the CSS-pixel box around (`x`, `y`) the pointer and its badge cover, and outside it. */
function cursorPixels(
	capture: { png: Uint8Array; width: number },
	at?: { x: number; y: number },
): { inside: number; outside: number } {
	const image = decodePng(capture.png);
	const scale = image.width / capture.width;
	let inside = 0;
	let outside = 0;
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			const i = (y * image.width + x) * 4;
			const near = CURSOR_RGB.every((channel, c) => Math.abs(image.pixels[i + c]! - channel) <= 6);
			if (!near) continue;
			const cssX = x / scale;
			const cssY = y / scale;
			if (at && cssX >= at.x - 30 && cssX <= at.x + 100 && cssY >= at.y - 30 && cssY <= at.y + 50) inside++;
			else outside++;
		}
	}
	return { inside, outside };
}

function workerOf(name: string): unknown {
	const tab = getTab(name);
	return tab?.backend === "worker" ? tab.worker : undefined;
}

async function rawCapture(name: string, session: ToolSession): Promise<{ png: Uint8Array; width: number }> {
	const capture = await run<{ png: string; width: number }>(name, session, RAW_CAPTURE);
	return { png: Buffer.from(capture.png, "base64"), width: capture.width };
}

describe.skipIf(!CHROMIUM_AVAILABLE)("browser agent cursor", () => {
	it("draws the cursor at each click in the top document only, and leaves it out of tab.screenshot", async () => {
		const session = sessionWith(true);
		const name = `agent-cursor-${process.pid}`;
		const { close } = await openTab(name, session);
		try {
			await run(name, session, `await tab.click("#go");`);
			const atButton = cursorPixels(await rawCapture(name, session), { x: 140, y: 100 });
			expect(atButton.inside).toBeGreaterThan(100);
			expect(atButton.outside).toBe(0);

			// Into the out-of-process iframe: the cursor moves there, none is left at the button, and no frame
			// document but the top one holds a cursor.
			await run(name, session, `await tab.clickAt(550, 160);`);
			const inFrame = cursorPixels(await rawCapture(name, session), { x: 550, y: 160 });
			expect(inFrame.inside).toBeGreaterThan(100);
			expect(inFrame.outside).toBe(0);
			const perFrame = await run<number[]>(
				name,
				session,
				`return await Promise.all(page.frames().map(frame => frame.evaluate(() => document.querySelectorAll("#__omp_agent_cursor__").length)));`,
			);
			expect(perFrame).toEqual([1, 0]);

			const shot = await run<string>(name, session, `return await tab.screenshot({ format: "png", silent: true });`);
			const width = await run<number>(name, session, "return await page.evaluate(() => innerWidth);");
			expect(cursorPixels({ png: await fs.readFile(shot), width })).toEqual({ inside: 0, outside: 0 });
			await fs.rm(shot);

			// Printing hides it too: the host's visibility goes hidden for the print and back after.
			const pdf = JSON.stringify(path.join(os.tmpdir(), `agent-cursor-${process.pid}.pdf`));
			const toggles = await run<string[]>(
				name,
				session,
				`await page.evaluate(() => {
					const host = document.getElementById("__omp_agent_cursor__");
					globalThis.toggles = [];
					new MutationObserver(() => globalThis.toggles.push(host.style.visibility)).observe(host, { attributeFilter: ["style"] });
				});
				await tab.pdf({ path: ${pdf} });
				return await page.evaluate(() => globalThis.toggles);`,
			);
			expect(toggles).toEqual(["hidden", ""]);
			await fs.rm(JSON.parse(pdf));
			expect(cursorPixels(await rawCapture(name, session), { x: 550, y: 160 }).inside).toBeGreaterThan(100);
		} finally {
			await close();
		}
	}, 120_000);

	it("draws the cursor again in the document a click navigated to", async () => {
		const session = sessionWith(true);
		const name = `agent-cursor-nav-${process.pid}`;
		const { close } = await openTab(name, session);
		try {
			await run(name, session, `await tab.click("#next"); await tab.waitForUrl(/\\/next$/);`);
			await run(name, session, `await page.waitForSelector("#__omp_agent_cursor__");`);
			// The click lands near the centre of the link's text, about (100, 311).
			const pixels = cursorPixels(await rawCapture(name, session), { x: 100, y: 311 });
			expect(pixels.inside).toBeGreaterThan(100);
			expect(pixels.outside).toBe(0);
		} finally {
			await close();
		}
	}, 120_000);

	it.skipIf(!FFMPEG_AVAILABLE)(
		"records with the agent cursor alone when the recording asks for its own",
		async () => {
			const session = sessionWith(true);
			const name = `agent-cursor-record-${process.pid}`;
			const { close } = await openTab(name, session);
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-cursor-"));
			try {
				const video = JSON.stringify(path.join(dir, "run.webm"));
				await run(name, session, `await tab.recordStart(${video}, { cursor: true }); await tab.click("#go");`);
				const cursors = await run<string[]>(
					name,
					session,
					`await page.waitForSelector("#__omp_agent_cursor__");
				return await page.evaluate(() => [...document.querySelectorAll("#__omp_agent_cursor__, #__omp_recording_cursor__")].map(element => element.id));`,
				);
				expect(cursors).toEqual(["__omp_agent_cursor__"]);
				await run(name, session, "await tab.recordStop();");
			} finally {
				await close();
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
		120_000,
	);

	it("removes the cursor from a page that outlives its tab after the worker that drew it was replaced", async () => {
		const session = sessionWith(true);
		const name = `agent-cursor-recycle-${process.pid}`;
		const keeper = `${name}-keeper`;
		const { handle, close } = await openTab(name, session);
		try {
			await run(name, session, `await tab.click("#go"); await page.waitForSelector("#__omp_agent_cursor__");`);
			// A library rejection the run guard leaves alone ends the worker; the supervisor attaches a new one.
			const worker = workerOf(name);
			const endWorker = `const err = new Error("library-internal");
err.stack = "Error: library-internal\\n    at #onFileChooser (puppeteer/Page.js:1:1)";
Promise.reject(err);
await Promise.withResolvers().promise;`;
			await rejectionOf(runInTab(name, { code: endWorker, timeoutMs: 30_000, session }));
			const tab = getTab(name);
			expect(tab?.backend === "worker" ? await tab.workerRecovery : undefined).toBe(true);
			expect(workerOf(name)).not.toBe(worker);
			// A second tab keeps omp's browser running once this one is released.
			await acquireTab(keeper, handle, { url: "about:blank", timeoutMs: 30_000 });
			await releaseTab(name, { keepPage: true });
			const pages = await handle.browser.pages();
			const kept = pages.find(candidate => candidate.url() === `http://127.0.0.1:${server.port}/`);
			expect(await kept?.evaluate('document.getElementById("__omp_agent_cursor__") === null')).toBe(true);
		} finally {
			await releaseTab(keeper);
			await close();
		}
	}, 120_000);

	it("draws nothing while browser.cursor is off", async () => {
		const session = sessionWith(false);
		const name = `agent-cursor-off-${process.pid}`;
		const { close } = await openTab(name, session);
		try {
			await run(name, session, `await tab.click("#go");`);
			expect(cursorPixels(await rawCapture(name, session))).toEqual({ inside: 0, outside: 0 });
			expect(
				await run<boolean>(
					name,
					session,
					`return await page.evaluate(() => document.getElementById("__omp_agent_cursor__") === null);`,
				),
			).toBe(true);
		} finally {
			await close();
		}
	}, 120_000);
});
