import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { TERN_KIT_SOURCE } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/page-kit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const PAGE = `data:text/html,${encodeURIComponent(
	'<button id="a" onclick="document.title = \'clicked\'">Alpha</button><button id="b">Beta</button>',
)}`;

/** Run `code` in a fresh headless tab on `url` and return its value. */
async function runOnPage(code: string, url = PAGE): Promise<unknown> {
	const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
	if (!("browser" in browser)) throw new Error("Expected a Puppeteer browser");
	const name = `observe-ids-${process.pid}`;
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;
	try {
		await acquireTab(name, browser, { url, timeoutMs: 30_000 });
		return (await runInTab(name, { code, timeoutMs: 20_000, session })).returnValue;
	} finally {
		await releaseTab(name, { kill: true });
		if (browser.browser.connected) await releaseBrowser(browser, { kill: true });
	}
}

describe("browser observe ids", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps an element's id across observations and never hands a retired id to another element",
		async () => {
			const result = await runOnPage(`
				const ids = observation => observation.elements.map(element => [element.name, element.id]);
				const failure = async id => {
					try {
						await tab.id(id);
						return "resolved";
					} catch (error) {
						return error.message;
					}
				};
				const first = await tab.observe();
				await tab.evaluate(() => {
					const gamma = document.createElement("button");
					gamma.textContent = "Gamma";
					document.body.prepend(gamma);
					document.querySelector("#b").remove();
				});
				const second = await tab.observe();
				await (await tab.id(1)).click();
				const title = await tab.title();
				const removed = await failure(2);
				await tab.goto("data:text/html,<button>Alpha</button>");
				const navigated = await failure(1);
				const third = await tab.observe();
				return { first: ids(first), second: ids(second), title, removed, navigated, third: ids(third) };
			`);
			expect(result).toEqual({
				first: [
					["Alpha", 1],
					["Beta", 2],
				],
				second: [
					["Gamma", 3],
					["Alpha", 1],
				],
				title: "clicked",
				removed: "Element id 2 is stale. Run tab.observe() again.",
				navigated: "Element id 1 is stale. Run tab.observe() again.",
				third: [["Alpha", 4]],
			});
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps Tern page-kit ids across observations and continues numbering in a new document",
		async () => {
			const result = await runOnPage(`
				const kit = ${JSON.stringify(TERN_KIT_SOURCE)};
				const observe = firstId =>
					tab.evaluate(firstId => globalThis.__ompTernKit.observe({ firstId }).elements.map(e => [e.name, e.id]), firstId);
				await tab.evaluate(kit);
				const first = await observe(1);
				await tab.evaluate(() => {
					const gamma = document.createElement("button");
					gamma.textContent = "Gamma";
					document.body.prepend(gamma);
					document.querySelector("#b").remove();
				});
				const second = await observe(3);
				let removed = "resolved";
				try {
					await tab.evaluate(() => globalThis.__ompTernKit.count({ engine: "id", id: 2 }));
				} catch (error) {
					removed = error.message;
				}
				await tab.goto("data:text/html,<button>Alpha</button>");
				await tab.evaluate(kit);
				const third = await observe(4);
				return { first, second, removed, third };
			`);
			expect(result).toEqual({
				first: [
					["Alpha", 1],
					["Beta", 2],
				],
				second: [
					["Gamma", 3],
					["Alpha", 1],
				],
				removed: expect.stringContaining("Element id 2 is stale"),
				third: [["Alpha", 4]],
			});
		},
		45_000,
	);
});

describe("browser observe after an action", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"shows the result of a slow fetch and of a slow navigation the cell's action started",
		async () => {
			const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
			// Real delays: the browser's own requests must still be in flight when observe() starts.
			const server = Bun.serve({
				port: 0,
				async fetch(request) {
					const { pathname } = new URL(request.url);
					if (pathname === "/saved") {
						await Bun.sleep(400);
						return new Response("Saved");
					}
					if (pathname === "/next") {
						await Bun.sleep(400);
						return html("<h1>Step 2</h1><button>Finish</button>");
					}
					return html(
						`<button id="save" onclick="fetch('/saved').then(r => r.text()).then(t => document.body.append(Object.assign(document.createElement('button'), { textContent: t })))">Save</button>` +
							'<form action="/next"><button id="continue">Continue</button></form>',
					);
				},
			});
			try {
				const result = await runOnPage(
					`
						const names = observation => observation.elements.map(element => element.name);
						await tab.click("#save");
						const afterFetch = names(await tab.observe());
						await tab.click("#continue");
						const afterNavigation = await tab.observe();
						return { afterFetch, path: new URL(afterNavigation.url).pathname, afterNavigation: names(afterNavigation) };
					`,
					`http://127.0.0.1:${server.port}/`,
				);
				expect(result).toEqual({
					afterFetch: ["Save", "Continue", "Saved"],
					path: "/next",
					afterNavigation: ["Finish"],
				});
			} finally {
				server.stop(true);
			}
		},
		45_000,
	);
});
