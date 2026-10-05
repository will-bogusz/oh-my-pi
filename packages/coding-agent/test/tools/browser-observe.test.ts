import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BrowserNetworkManager } from "@oh-my-pi/pi-coding-agent/tools/browser/network";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { TERN_KIT_SOURCE } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/page-kit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const BUTTONS = 200;

function buttons(count: number, label: string): string {
	return Array.from(
		{ length: count },
		(_, i) => `<button onclick="document.title = '${label} ${i}'">Item ${i}</button>`,
	).join("");
}

const PAGE = `data:text/html,${encodeURIComponent(buttons(BUTTONS, "clicked"))}`;

/**
 * Pages served on 127.0.0.1 link to localhost, a different site, so following the link moves the tab
 * to a new renderer that numbers its nodes from scratch. The page navigated to has at least as many
 * nodes as the one observed, so every id the observed page handed out names a node there too.
 */
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const { pathname, port } = new URL(request.url);
		const link = (target: string) => `<a href="http://localhost:${port}/${target}">Next</a>`;
		const pages: Record<string, string> = {
			"/first": link("second") + buttons(BUTTONS, "first"),
			"/second": buttons(BUTTONS * 2, "second"),
			"/cached": link("left") + buttons(BUTTONS * 2, "cached"),
			"/left": buttons(BUTTONS, "left"),
		};
		const body = pages[pathname];
		if (body === undefined) return new Response("not found", { status: 404 });
		const restored = `<script>addEventListener("pageshow", e => { if (e.persisted) document.title = "restored"; })</script>`;
		return new Response(restored + body, { headers: { "content-type": "text/html" } });
	},
});

afterAll(() => {
	server.stop(true);
});

async function runOnPage(url: string, code: string, timeoutMs = 20_000): Promise<unknown> {
	const [value] = await runCellsOnPage(url, [() => code], timeoutMs);
	return value;
}

/**
 * Run cells one after another in one tab on `url`, each its own `tab.run` as a direct helper call is;
 * each cell's code is built from the values the earlier cells returned.
 */
async function runCellsOnPage(
	url: string,
	cells: ((earlier: unknown[]) => string)[],
	timeoutMs = 20_000,
): Promise<unknown[]> {
	const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
	if (!("browser" in browser)) throw new Error("Expected a Puppeteer browser");
	const name = `observe-${process.pid}`;
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;
	try {
		await acquireTab(name, browser, { url, timeoutMs: 30_000 });
		const values: unknown[] = [];
		for (const cell of cells)
			values.push((await runInTab(name, { code: cell(values), timeoutMs, session })).returnValue);
		return values;
	} finally {
		await releaseTab(name, { kill: true });
		if (browser.browser.connected) await releaseBrowser(browser, { kill: true });
	}
}

describe("browser observe", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"lists elements without resolving each one and resolves an id only when it is used",
		async () => {
			const result = await runOnPage(
				PAGE,
				`
					const client = page.mainFrame().client;
					const send = client.send;
					let resolved = 0;
					client.send = function (method, ...args) {
						if (method === "DOM.resolveNode") resolved++;
						return send.call(this, method, ...args);
					};
					let observation;
					try {
						observation = await tab.observe();
					} finally {
						client.send = send;
					}
					await (await tab.id(observation.elements[7].id)).click();
					const title = await tab.title();
					await tab.evaluate(() => document.querySelectorAll("button")[9].remove());
					let removed = "resolved";
					try {
						await tab.id(observation.elements[9].id);
					} catch (error) {
						removed = error.message;
					}
					return { listed: observation.elements.length, resolved, title, removed };
				`,
			);
			expect(result).toEqual({
				listed: BUTTONS,
				resolved: 0,
				title: "clicked 7",
				removed: "Element id 10 is stale. Run tab.observe() again.",
			});
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"reports an unresolved id stale once a link has taken the page to another site",
		async () => {
			const result = (await runOnPage(
				`http://127.0.0.1:${server.port}/first`,
				`
					const observation = await tab.observe();
					const link = observation.elements.find(entry => entry.role === "link");
					const button = observation.elements.find(entry => entry.name === "Item 7");
					await Promise.all([page.waitForNavigation(), (await tab.id(link.id)).click()]);
					// Have the new renderer hand out backend node ids, as accessibility or layout tracking would.
					await page.accessibility.snapshot();
					let outcome;
					try {
						await (await tab.id(button.id)).click();
						outcome = "clicked " + (await tab.title());
					} catch (error) {
						outcome = error.message;
					}
					return { url: page.url(), id: button.id, outcome };
				`,
			)) as { url: string; id: number; outcome: string };
			expect(result.url).toBe(`http://localhost:${server.port}/second`);
			expect(result.outcome).toBe(`Element id ${result.id} is stale. Run tab.observe() again.`);
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"forgets ids observed on a page the back/forward cache has replaced",
		async () => {
			const result = (await runOnPage(
				`http://127.0.0.1:${server.port}/cached`,
				`
					const link = (await tab.observe()).elements.find(entry => entry.role === "link");
					await Promise.all([page.waitForNavigation(), (await tab.id(link.id)).click()]);
					const button = (await tab.observe()).elements.find(entry => entry.name === "Item 7");
					await page.goBack();
					const title = await tab.title();
					await page.accessibility.snapshot();
					let outcome;
					try {
						await (await tab.id(button.id)).click();
						outcome = "clicked " + (await tab.title());
					} catch (error) {
						outcome = error.message;
					}
					return { title, id: button.id, outcome };
				`,
			)) as { title: string; id: number; outcome: string };
			expect(result.title).toBe("restored");
			expect(result.outcome).toBe(`Element id ${result.id} is stale. Run tab.observe() again.`);
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"resolves the document root listed by includeAll without dropping the other ids",
		async () => {
			const result = await runOnPage(
				PAGE,
				`
					const observation = await tab.observe({ includeAll: true });
					const root = observation.elements[0];
					const nodeType = await (await tab.id(root.id)).evaluate(node => node.nodeType);
					const button = observation.elements.find(entry => entry.role === "button" && entry.name === "Item 7");
					await (await tab.id(button.id)).click();
					return { role: root.role, nodeType, title: await tab.title() };
				`,
			);
			expect(result).toEqual({ role: "RootWebArea", nodeType: 9, title: "clicked 7" });
		},
		45_000,
	);
});

/**
 * Save answers at once (delay it with `page.emulateNetworkConditions`); Hang starts a request the
 * server holds until the test ends, like a long poll or a hung API. The page's `startPoll()` opens such a
 * request itself and, on the page's own timer, marks the body `data-late` 2.5 s later: short of the 3 s
 * bound, so a read shows whether it waited for that request.
 */
function saveServer() {
	const held = new Set<() => void>();
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/saved") return new Response("Saved");
			if (pathname === "/hold") {
				const { promise, resolve } = Promise.withResolvers<void>();
				held.add(resolve);
				await promise;
				return new Response("released");
			}
			return new Response(
				`<button id="save" onclick="fetch('/saved').then(r => r.text()).then(t => document.body.append(Object.assign(document.createElement('button'), { textContent: t })))">Save</button>` +
					`<button id="hang" onclick="fetch('/hold')">Hang</button>` +
					`<script>function startPoll() { fetch('/hold'); setTimeout(() => { document.body.dataset.late = 'late'; }, 2500); }</script>`,
				{ headers: { "content-type": "text/html" } },
			);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/`,
		stop() {
			for (const release of held) release();
			server.stop(true);
		},
	};
}

const NAMES = "(await tab.observe()).elements.map(element => element.name)";

describe("browser observe after an action", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"shows the result of a fetch the click started",
		async () => {
			const pages = saveServer();
			try {
				const result = await runOnPage(
					pages.url,
					`
						// Chromium holds the response 400 ms, so it is still on its way when observe() starts.
						await page.emulateNetworkConditions({ download: -1, upload: -1, latency: 400 });
						await tab.click("#save");
						return ${NAMES};
					`,
				);
				expect(result).toEqual(["Save", "Hang", "Saved"]);
			} finally {
				pages.stop();
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"reads the page within a short cell when the click's request never answers",
		async () => {
			const pages = saveServer();
			try {
				const result = await runOnPage(pages.url, `await tab.click("#hang"); return ${NAMES};`, 3_000);
				expect(result).toEqual(["Save", "Hang"]);
			} finally {
				pages.stop();
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"does not wait for a request that was already open before the action",
		async () => {
			const pages = saveServer();
			try {
				const result = await runOnPage(
					pages.url,
					`
						await tab.observe();
						const sent = page.waitForRequest(request => request.url().endsWith("/hold"));
						await tab.evaluate(() => startPoll());
						await sent;
						await tab.click("#save");
						const names = ${NAMES};
						return [names, await page.evaluate(() => document.body.dataset.late ?? "early")];
					`,
				);
				expect(result).toEqual([["Save", "Hang", "Saved"], "early"]);
			} finally {
				pages.stop();
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"excludes an earlier request in the same clock tick but waits for the action's request",
		async () => {
			const pages = saveServer();
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			if (!("browser" in browser)) throw new Error("Expected a Puppeteer browser");
			const page = await browser.browser.newPage();
			const network = new BrowserNetworkManager(page);
			try {
				await page.goto(pages.url);
				await network.start();
				// Both requests and the action boundary share one clock tick.
				const clock = spyOn(Date, "now").mockReturnValue(1_000);
				try {
					const earlier = page.waitForRequest(request => request.url().endsWith("/hold"));
					await page.click("#hang");
					await earlier;
					const since = network.nextRequestSeq;
					expect(network.hasPendingRequests(since)).toBe(false);
					const started = page.waitForRequest(request => request.url().endsWith("/hold"));
					await page.click("#hang");
					await started;
					expect(network.hasPendingRequests(since)).toBe(true);
				} finally {
					clock.mockRestore();
				}
			} finally {
				await network.close();
				await page.close();
				await releaseBrowser(browser, { kill: true });
				pages.stop();
			}
		},
		45_000,
	);
});

/**
 * Load fills the pane from `/detail`, which answers at once: `page.emulateNetworkConditions` delays it
 * in Chromium, so the DOM stays quiet while the response is outstanding. Never also opens a request the
 * server holds until the test ends, plus a `/mark` request whose response sets `data-late` on the body.
 * `startPoll()` opens the same two requests from the page itself, not from an action.
 */
function detailServer() {
	const held = new Set<() => void>();
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/detail") return new Response("Detail");
			if (pathname === "/mark") return new Response("late");
			if (pathname === "/hold") {
				const { promise, resolve } = Promise.withResolvers<void>();
				held.add(resolve);
				await promise;
				return new Response("released");
			}
			const hold = "fetch('/hold'); fetch('/mark').then(() => { document.body.dataset.late = 'late'; })";
			return new Response(
				`<button id="load" onclick="pane.textContent = 'Loading'; fetch('/detail').then(r => r.text()).then(t => pane.textContent = t)">Load</button>` +
					`<button id="never" onclick="pane.textContent = 'Loading'; ${hold}">Never</button>` +
					`<div id="pane">Empty</div><script>function startPoll() { ${hold}; }</script>`,
				{ headers: { "content-type": "text/html" } },
			);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/`,
		stop() {
			for (const release of held) release();
			server.stop(true);
		},
	};
}

/** Cell code making Chromium deliver every response `ms` late. */
const latency = (ms: number) => `await page.emulateNetworkConditions({ download: -1, upload: -1, latency: ${ms} });`;

/** The pane's text and whether the `/mark` response had landed when the read ran. */
const READ_PANE = `await tab.evaluate(() => [pane.textContent, document.body.dataset.late ?? "early"])`;

describe("browser reads after an action", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"read a fetch the click started once it answers, not the loading state",
		async () => {
			const pages = detailServer();
			try {
				const result = await runOnPage(
					pages.url,
					`
						const reads = [];
						for (const latency of [300, 800, 2000]) {
							await page.emulateNetworkConditions({ download: -1, upload: -1, latency });
							await tab.click("#load");
							reads.push(await tab.text("#pane"));
						}
						return reads;
					`,
				);
				expect(result).toEqual(["Detail", "Detail", "Detail"]);
			} finally {
				pages.stop();
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"return the page as it is at the bound when the click's request never answers",
		async () => {
			const pages = detailServer();
			try {
				// `/mark` lands after the emulated 1.5 s; the held request keeps the read waiting past it.
				const result = await runOnPage(
					pages.url,
					`${latency(1500)} await tab.click("#never"); return ${READ_PANE};`,
				);
				expect(result).toEqual(["Loading", "late"]);
			} finally {
				pages.stop();
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"do not wait when no action came before them, even with a request in flight",
		async () => {
			const pages = detailServer();
			try {
				const result = await runOnPage(
					pages.url,
					`
						await tab.observe();
						${latency(1500)}
						const sent = page.waitForRequest(request => request.url().endsWith("/hold"));
						await tab.evaluate(() => startPoll());
						await sent;
						return [await tab.text("#pane"), ${READ_PANE}];
					`,
				);
				expect(result).toEqual(["Empty", ["Empty", "early"]]);
			} finally {
				pages.stop();
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"settle reads issued together once, for all of them",
		async () => {
			const pages = detailServer();
			try {
				const result = await runOnPage(
					pages.url,
					`${latency(800)} await tab.click("#load"); return await Promise.all([tab.text("#pane"), tab.text("#pane")]);`,
				);
				expect(result).toEqual(["Detail", "Detail"]);
			} finally {
				pages.stop();
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keep an element id used in one call valid in the next after an action",
		async () => {
			const [id, , title] = await runCellsOnPage(PAGE, [
				() => `return (await tab.observe()).elements.find(entry => entry.name === "Item 7").id;`,
				([id]) => `await (await tab.id(${id})).click();`,
				([id]) => `await (await tab.id(${id})).click(); return await tab.title();`,
			]);
			expect(typeof id).toBe("number");
			expect(title).toBe("clicked 7");
		},
		45_000,
	);
});

const ID_PAGE = `data:text/html,${encodeURIComponent(
	'<button id="a" onclick="document.title = \'clicked\'">Alpha</button><button id="b">Beta</button>',
)}`;

/** Inserts a Gamma button before Alpha and removes Beta. */
const RERENDER = `() => {
	const gamma = document.createElement("button");
	gamma.textContent = "Gamma";
	document.body.prepend(gamma);
	document.querySelector("#b").remove();
}`;

describe("browser observe ids", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keep an element's id across observations and never hand a retired id to another element",
		async () => {
			const result = await runOnPage(
				ID_PAGE,
				`
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
					await tab.evaluate(${RERENDER});
					const second = await tab.observe();
					await (await tab.id(1)).click();
					const title = await tab.title();
					const removed = await failure(2);
					await tab.goto("data:text/html,<button>Alpha</button>");
					const navigated = await failure(1);
					const third = await tab.observe();
					return { first: ids(first), second: ids(second), title, removed, navigated, third: ids(third) };
				`,
			);
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
		"keep Tern page-kit ids across observations and continue numbering in a new document",
		async () => {
			const result = await runOnPage(
				ID_PAGE,
				`
					const kit = ${JSON.stringify(TERN_KIT_SOURCE)};
					const observe = firstId =>
						tab.evaluate(firstId => globalThis.__ompTernKit.observe({ firstId }).elements.map(e => [e.name, e.id]), firstId);
					await tab.evaluate(kit);
					const first = await observe(1);
					await tab.evaluate(${RERENDER});
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
				`,
			);
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

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keep an id whose cached handle another observe() released or user code disposed",
		async () => {
			const result = await runOnPage(
				ID_PAGE,
				`
					const outcomes = new Set();
					let listed;
					for (let attempt = 0; attempt < 15; attempt++) {
						await tab.observe({ viewportOnly: true });
						await tab.id(1);
						const [outcome, observation] = await Promise.all([
							tab.id(1).then(() => "ok", error => error.message),
							tab.observe(),
						]);
						outcomes.add(outcome);
						listed = observation.elements.map(element => [element.name, element.id]);
					}
					// A handle user code disposed fails its check the same way.
					await (await tab.id(1)).dispose();
					outcomes.add(await tab.id(1).then(() => "ok", error => error.message));
					return { outcomes: [...outcomes], listed };
				`,
			);
			expect(result).toEqual({
				outcomes: ["ok"],
				listed: [
					["Alpha", 1],
					["Beta", 2],
				],
			});
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"retire the least recently observed ids once a document has listed more than 5,000 others",
		async () => {
			const result = await runOnPage(
				ID_PAGE,
				`
					const fill = prefix =>
						tab.evaluate(prefix => {
							for (const button of document.querySelectorAll("button.n")) button.remove();
							for (let i = 0; i < 5000; i++) {
								const button = document.createElement("button");
								button.className = "n";
								button.textContent = prefix + i;
								document.body.append(button);
							}
						}, prefix);
					await fill("x");
					await tab.observe();
					// Alpha leaves the listing while staying in the document, and 5,000 new buttons are listed.
					await tab.evaluate(() => { document.querySelector("#a").style.display = "none"; });
					await fill("y");
					const second = await tab.observe();
					const beta = second.elements.find(element => element.name === "Beta").id;
					await tab.evaluate(() => { document.querySelector("#a").style.display = ""; });
					let alpha = "resolved";
					try {
						await tab.id(1);
					} catch (error) {
						alpha = error.message;
					}
					const third = await tab.observe();
					return { beta, alpha, relisted: third.elements.find(element => element.name === "Alpha").id };
				`,
				50_000,
			);
			expect(result).toEqual({
				beta: 2,
				alpha: "Element id 1 is stale. Run tab.observe() again.",
				relisted: 10_003,
			});
		},
		90_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"give Tern page-kit includeAll text entries ids of their own",
		async () => {
			const result = await runOnPage(
				`data:text/html,${encodeURIComponent('<p>Hello</p><a href="#" aria-label="Open">Read more</a>')}`,
				`
					await tab.evaluate(${JSON.stringify(TERN_KIT_SOURCE)});
					const list = () =>
						tab.evaluate(() =>
							globalThis.__ompTernKit.observe({ includeAll: true, firstId: 1 }).elements.map(e => [e.role, e.id]),
						);
					return { first: await list(), second: await list() };
				`,
			);
			const { first, second } = result as { first: [string, number][]; second: [string, number][] };
			const ids = first.map(([, id]) => id);
			expect(first.filter(([role]) => role === "StaticText").length).toBeGreaterThan(0);
			expect(new Set(ids).size).toBe(ids.length);
			expect(second).toEqual(first);
		},
		45_000,
	);
});
