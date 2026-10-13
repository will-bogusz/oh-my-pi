import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import type {
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { getPuppeteerDir } from "@oh-my-pi/pi-utils";
import puppeteer, { type Browser, type WebWorker } from "puppeteer-core";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const ASSETS = path.resolve(import.meta.dir, "../../src/tools/browser/relay/extension-assets");

interface TestWorker {
	outcome: Promise<Extract<WorkerOutbound, { type: "ready" | "init-failed" }>>;
	close(): Promise<void>;
}

function startWorker(payload: WorkerInitPayload): TestWorker {
	const outcome = Promise.withResolvers<Extract<WorkerOutbound, { type: "ready" | "init-failed" }>>();
	const closed = Promise.withResolvers<void>();
	let receive!: (message: WorkerInbound | WorkerOutbound) => void;
	new WorkerCore(
		{
			send(message) {
				if (message.type === "ready" || message.type === "init-failed") outcome.resolve(message);
			},
			onMessage(handler) {
				receive = handler;
				return () => {};
			},
			close() {
				closed.resolve();
			},
		},
		false,
	);
	receive({ type: "init", payload });
	return {
		outcome: outcome.promise,
		async close() {
			receive({ type: "close" });
			await closed.promise;
		},
	};
}

interface RelayBrowser {
	browser: Browser;
	/** The relay extension's service worker, for reading Chrome's own tab state. */
	extension: WebWorker;
}

interface RelayFixture extends RelayBrowser {
	server: RelayServer;
	cdpUrl: string;
	origin: string;
	/** Another Chromium with its own profile and the same extension, as a second browser on the relay. */
	launchBrowser(): Promise<RelayBrowser>;
	close(): Promise<void>;
}

/**
 * Headless Chromium running the real relay extension against a relay on a free port, plus a loopback
 * site. The extension's `chrome.debugger.onDetach` listener is exposed as `testDebuggerDetach`, since a
 * programmatic detach does not fire it, and `testRefuseRemoves` makes that many `chrome.tabs.remove`
 * calls reject first.
 */
async function launchRelayFixture(
	log?: (message: string, data?: Record<string, unknown>) => void,
): Promise<RelayFixture> {
	const port = await findFreeCdpPort();
	const server = startRelayServer({ port, group: false, log });
	const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-isolation-"));
	const pages = Bun.serve({
		port: 0,
		fetch(request) {
			const route = new URL(request.url).pathname;
			const html =
				route === "/first"
					? `<title>First</title><button onclick="this.textContent='clicked'">First</button><p id="hover" onmouseover="this.textContent='hovered'">Hover</p>`
					: route === "/second"
						? "<title>Second</title><button>Second</button>"
						: route === "/opener"
							? `<title>Opener</title><a id="link" target="_blank" href="/popup?k=link">link</a>
<button id="open" onclick="window.open('/popup?k=open')">open</button>
<button id="window" onclick="window.open('/popup?k=window', '', 'width=300,height=300')">window</button>
<iframe src="http://localhost:${new URL(request.url).port}/frame"></iframe>`
							: route === "/frame"
								? `<a id="frame" target="_blank" href="http://127.0.0.1:${new URL(request.url).port}/popup?k=frame">frame</a>`
								: route === "/popup"
									? `<title>Popup</title><button id="b" onclick="this.textContent='clicked'">b</button><input id="i">
<button id="nest" onclick="window.open('/popup?k=nested')">nest</button>`
									: "<title>Human sentinel</title><h1>Keep me</h1>";
			return new Response(html, { headers: { "Content-Type": "text/html" } });
		},
	});
	const browsers: Browser[] = [];
	async function close() {
		try {
			await Promise.all(browsers.map(browser => browser.close()));
		} finally {
			server.stop();
			pages.stop(true);
			await fs.rm(extensionDir, { recursive: true, force: true });
		}
	}
	async function launchBrowser(): Promise<RelayBrowser> {
		const browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			pipe: true,
			enableExtensions: [extensionDir],
			args: ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain"],
		});
		browsers.push(browser);
		const extension = await (
			await browser.waitForTarget(target => target.type() === "service_worker", { timeout: 15_000 })
		).worker();
		if (!extension) throw new Error("Missing relay extension worker");
		return { browser, extension };
	}
	try {
		for (const file of ["manifest.json", "options.html", "options.js"]) {
			await fs.copyFile(path.join(ASSETS, `${file}.txt`), path.join(extensionDir, file));
		}
		const background = await fs.readFile(path.join(ASSETS, "background.js.txt"), "utf8");
		// Point the disposable extension at this relay before its code can dial a user's default relay.
		await fs.writeFile(
			path.join(extensionDir, "background.js"),
			`const registerDetach = chrome.debugger.onDetach.addListener.bind(chrome.debugger.onDetach);
chrome.debugger.onDetach.addListener = listener => {
	globalThis.testDebuggerDetach = listener;
	registerDetach(listener);
};
const removeTab = chrome.tabs.remove.bind(chrome.tabs);
chrome.tabs.remove = tabId => {
	if (globalThis.testRefuseRemoves > 0) {
		globalThis.testRefuseRemoves--;
		return Promise.reject(new Error("Tabs cannot be edited right now (user may be dragging a tab)."));
	}
	return removeTab(tabId);
};
chrome.storage.local.set({ port: ${port} }).then(() => {
${background}
});`,
		);
		const { browser, extension } = await launchBrowser();
		const cdpUrl = `http://127.0.0.1:${port}`;
		// Finish the extension hello before the native CDP client attaches to the sentinel.
		const outcome = await waitForRelayExtension(cdpUrl);
		if (outcome !== "ready") throw new Error(`Relay fixture handshake failed: ${outcome}`);
		return {
			browser,
			extension,
			server,
			cdpUrl,
			origin: `http://127.0.0.1:${pages.port}`,
			launchBrowser,
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}

function chromeTabId(targetId: string): number {
	return Number(targetId.slice(targetId.lastIndexOf(".") + 1));
}

/** Chrome's own view of a tab (`{ active }`), or null once it is closed. */
async function chromeTab(fixture: RelayFixture, tabId: number): Promise<unknown> {
	return await fixture.extension.evaluate(
		`chrome.tabs.query({}).then(tabs => { const tab = tabs.find(tab => tab.id === ${tabId}); return tab ? { active: tab.active } : null; })`,
	);
}

async function activeChromeTabUrl(fixture: RelayFixture): Promise<unknown> {
	return await fixture.extension.evaluate(
		"chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => tabs[0]?.url)",
	);
}

/** Whether the relay extension holds a `chrome.debugger` attachment on the tab: only its own answers a command. */
async function relayAttached(fixture: RelayFixture, tabId: number): Promise<unknown> {
	return await fixture.extension.evaluate(
		`chrome.debugger.sendCommand({ tabId: ${tabId} }, "Runtime.evaluate", { expression: "1" }).then(() => true, () => false)`,
	);
}

async function chromeTabIdOf(fixture: RelayFixture, url: string): Promise<number> {
	const tabId = await fixture.extension.evaluate(
		`chrome.tabs.query({}).then(tabs => tabs.find(tab => tab.url === ${JSON.stringify(url)})?.id)`,
	);
	if (typeof tabId !== "number") throw new Error(`No Chrome tab shows ${url}`);
	return tabId;
}

const session = {
	cwd: process.cwd(),
	hasUI: false,
	settings: Settings.isolated(),
	getSessionFile: () => null,
} as unknown as ToolSession;

describe.skipIf(!CHROMIUM_AVAILABLE)("relay tab ownership", () => {
	it("opens default relay tabs in the background and closes them, leaving borrowed pages open", async () => {
		const fixture = await launchRelayFixture();
		const human = await fixture.browser.newPage();
		const humanUrl = `${fixture.origin}/human`;
		await human.goto(humanUrl);
		await human.bringToFront();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const names = [`relay-first-${process.pid}`, `relay-second-${process.pid}`, `relay-borrowed-${process.pid}`];
		try {
			const first = await acquireTab(names[0]!, relay, { url: `${fixture.origin}/first`, timeoutMs: 15_000 });
			// An open that adopted the selected tab would have navigated it to the `url`.
			expect(human.url()).toBe(humanUrl);
			const second = await acquireTab(names[1]!, relay, { url: `${fixture.origin}/second`, timeoutMs: 15_000 });
			expect(first.tab.targetId).not.toBe(second.tab.targetId);
			expect(human.url()).toBe(humanUrl);
			expect(await human.title()).toBe("Human sentinel");
			// The user's tab stays selected; the owned tabs were created unselected.
			expect(await activeChromeTabUrl(fixture)).toBe(humanUrl);
			expect(await chromeTab(fixture, chromeTabId(first.tab.targetId))).toEqual({ active: false });

			const clicked = await runInTab(names[0]!, {
				code: "await tab.click('button'); return await tab.text('button');",
				timeoutMs: 10_000,
				session,
			});
			expect(clicked.returnValue).toBe("clicked");
			// Hover waits for a rendered frame, which a hidden tab never produces: this passes only while the
			// unselected tab is focus-emulated.
			const hovered = await runInTab(names[0]!, {
				code: "await tab.hover('#hover'); return await tab.text('#hover');",
				timeoutMs: 10_000,
				session,
			});
			expect(hovered.returnValue).toBe("hovered");
			// A screenshot of the unselected tab is captured in place: it never selects the tab.
			const shot = await runInTab(names[0]!, {
				code: "return typeof (await tab.screenshot());",
				timeoutMs: 10_000,
				session,
			});
			expect(shot.returnValue).toBe("string");
			expect(await activeChromeTabUrl(fixture)).toBe(humanUrl);
			expect(await chromeTab(fixture, chromeTabId(first.tab.targetId))).toEqual({ active: false });

			await releaseTab(names[0]!);
			expect(await chromeTab(fixture, chromeTabId(first.tab.targetId))).toBeNull();
			expect(await human.title()).toBe("Human sentinel");
			const surviving = await runInTab(names[1]!, { code: "return await tab.title();", timeoutMs: 10_000, session });
			expect(surviving.returnValue).toBe("Second");

			// `app.target` borrows the user's page; closing releases it without closing it.
			const borrowed = await acquireTab(names[2]!, relay, { target: "Human sentinel", timeoutMs: 15_000 });
			expect(borrowed.tab.targetId).not.toBe(first.tab.targetId);
			await releaseTab(names[2]!);
			expect(human.isClosed()).toBeFalse();
			expect(await human.title()).toBe("Human sentinel");
		} finally {
			for (const name of names) await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("attaches the debugger only to tabs omp opens or adopts, never to the user's other tabs", async () => {
		const fixture = await launchRelayFixture();
		const human = await fixture.browser.newPage();
		const humanUrl = `${fixture.origin}/human`;
		await human.goto(humanUrl);
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const names = [`relay-own-only-${process.pid}`, `relay-adopt-only-${process.pid}`];
		try {
			const humanTabId = await chromeTabIdOf(fixture, humanUrl);
			const owned = await acquireTab(names[0]!, relay, { url: `${fixture.origin}/first`, timeoutMs: 15_000 });
			expect(await relayAttached(fixture, chromeTabId(owned.tab.targetId))).toBeTrue();
			expect(await relayAttached(fixture, humanTabId)).toBeFalse();
			const clicked = await runInTab(names[0]!, {
				code: "await tab.click('button'); return await tab.text('button');",
				timeoutMs: 10_000,
				session,
			});
			expect(clicked.returnValue).toBe("clicked");
			expect(await relayAttached(fixture, humanTabId)).toBeFalse();

			// `app.target` adopts the user's tab, which attaches it.
			await acquireTab(names[1]!, relay, { target: "Human sentinel", timeoutMs: 15_000 });
			expect(await relayAttached(fixture, humanTabId)).toBeTrue();
			const read = await runInTab(names[1]!, { code: "return await tab.title();", timeoutMs: 10_000, session });
			expect(read.returnValue).toBe("Human sentinel");
		} finally {
			for (const name of names) await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("owns popups omp's tab opens and keeps them behind the user's selection", async () => {
		const fixture = await launchRelayFixture();
		const human = await fixture.browser.newPage();
		const humanUrl = `${fixture.origin}/human`;
		await human.goto(humanUrl);
		await human.bringToFront();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-popups-${process.pid}`;
		try {
			await acquireTab(name, relay, { url: `${fixture.origin}/opener`, timeoutMs: 15_000 });
			// A blank tab the user opens by hand stays theirs.
			await fixture.browser.newPage();
			await human.bringToFront();
			const humanTabId = await chromeTabIdOf(fixture, humanUrl);
			const blankTabId = await chromeTabIdOf(fixture, "about:blank");
			// Headless Chrome reports every window focused, so this holds the user's focus fixed; the visible run checks it.
			const userWindowFocused = () =>
				fixture.extension.evaluate(
					`chrome.tabs.get(${humanTabId}).then(tab => chrome.windows.get(tab.windowId)).then(window => window.focused)`,
				);
			const focusedBefore = await userWindowFocused();
			// The last opens from a cross-site frame, which Chrome runs in its own process.
			const outOfProcess = await runInTab(name, {
				code: `const frame = page.frames().find(frame => frame.url().includes("/frame"));
return frame.client !== page.mainFrame().client;`,
				timeoutMs: 10_000,
				session,
			});
			expect(outOfProcess.returnValue).toBeTrue();
			for (const key of ["link", "open", "window", "frame"]) {
				const click =
					key === "frame"
						? `await page.frames().find(frame => frame.url().includes("/frame")).click("#frame");`
						: `await tab.click("#${key}");`;
				const opened = await runInTab(name, {
					code: `const popup = Promise.withResolvers();
page.once("popup", popup.resolve);
${click}
const got = await popup.promise;
await got.waitForFunction(() => location.search === "?k=${key}");
return got.url();`,
					timeoutMs: 10_000,
					session,
				});
				expect(opened.returnValue).toBe(`${fixture.origin}/popup?k=${key}`);
				const popupTabId = await chromeTabIdOf(fixture, `${fixture.origin}/popup?k=${key}`);
				expect(await relayAttached(fixture, popupTabId)).toBeTrue();
				// The relay backgrounds the popup right after Chrome reports it; give that one RPC time to land. A
				// popup window stays where Chrome put it, not minimized.
				const expected =
					key === "window" ? { window: "popup", state: "normal" } : { active: false, window: "normal" };
				let placement: Record<string, unknown> = {};
				for (let attempt = 0; attempt < 40; attempt++) {
					placement = (await fixture.extension.evaluate(`(async () => {
						const tab = await chrome.tabs.get(${popupTabId});
						const window = await chrome.windows.get(tab.windowId);
						return { active: tab.active, window: window.type, state: window.state };
					})()`)) as Record<string, unknown>;
					if (Object.entries(expected).every(([field, value]) => placement[field] === value)) break;
					await Bun.sleep(50);
				}
				expect(placement).toMatchObject(expected);
				// Where it was put, the popup still renders and takes pointer and keyboard input.
				const driven = await runInTab(name, {
					code: `const got = (await page.browser().pages()).find(p => p.url().endsWith("?k=${key}"));
const shot = await got.screenshot();
await got.click("#b");
await got.type("#i", "typed");
return { visible: await got.evaluate(() => document.visibilityState), shot: shot.length > 0,
	button: await got.$eval("#b", b => b.textContent), input: await got.$eval("#i", i => i.value) };`,
					timeoutMs: 10_000,
					session,
				});
				expect(driven.returnValue).toEqual({ visible: "visible", shot: true, button: "clicked", input: "typed" });
				expect(await chromeTab(fixture, humanTabId)).toEqual({ active: true });
				expect(await userWindowFocused()).toBe(focusedBefore);
				expect(
					await fixture.extension.evaluate(`chrome.tabs.get(${popupTabId}).then(async tab => {
						const window = await chrome.windows.get(tab.windowId);
						return { active: tab.active, window: window.type, state: window.state };
					})`),
				).toMatchObject(expected);
			}
			expect(await relayAttached(fixture, blankTabId)).toBeFalse();
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("keeps a popup's own popup rendering and taking input behind the user's selection", async () => {
		const fixture = await launchRelayFixture();
		const human = await fixture.browser.newPage();
		const humanUrl = `${fixture.origin}/human`;
		await human.goto(humanUrl);
		await human.bringToFront();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-nested-popup-${process.pid}`;
		try {
			await acquireTab(name, relay, { url: `${fixture.origin}/opener`, timeoutMs: 15_000 });
			const humanTabId = await chromeTabIdOf(fixture, humanUrl);
			const driven = await runInTab(name, {
				code: `const child = Promise.withResolvers();
page.once("popup", child.resolve);
await tab.click("#open");
const popup = await child.promise;
await popup.waitForSelector("#nest");
const grandchild = Promise.withResolvers();
popup.once("popup", grandchild.resolve);
await popup.click("#nest");
const got = await grandchild.promise;
await got.waitForFunction(() => location.search === "?k=nested");
await got.click("#b");
await got.type("#i", "typed");
return { focus: await got.evaluate(() => document.hasFocus()), visible: await got.evaluate(() => document.visibilityState),
	button: await got.$eval("#b", b => b.textContent), input: await got.$eval("#i", i => i.value) };`,
				timeoutMs: 15_000,
				session,
			});
			expect(driven.returnValue).toEqual({ focus: true, visible: "visible", button: "clicked", input: "typed" });
			expect(await chromeTab(fixture, humanTabId)).toEqual({ active: true });
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("opens a default tab in the browser of the tab omp used last, not the first selected one", async () => {
		const secondHello = Promise.withResolvers<void>();
		let hellos = 0;
		const fixture = await launchRelayFixture(message => {
			if (message === "extension connected" && ++hellos === 2) secondHello.resolve();
		});
		// The first browser shows the first selected tab, which a new tab would otherwise follow.
		const human = await fixture.browser.newPage();
		await human.goto(`${fixture.origin}/human`);
		await human.bringToFront();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const names = [
			`relay-near-human-${process.pid}`,
			`relay-near-other-${process.pid}`,
			`relay-near-own-${process.pid}`,
		];
		/** The browser a relay target id belongs to (`PAGE<browser>.<tab>`). */
		const browserOf = (targetId: string) => targetId.slice(4, targetId.lastIndexOf("."));
		try {
			// Borrowing waits until the relay lists the tab, so the first browser's selected tab is listed first.
			const inFirst = await acquireTab(names[0]!, relay, { target: "Human sentinel", timeoutMs: 15_000 });
			const other = await fixture.launchBrowser();
			// The relay announces a browser's tabs to connected clients only as they change after its hello.
			await secondHello.promise;
			await (await other.browser.newPage()).goto(`${fixture.origin}/first`);
			const inSecond = await acquireTab(names[1]!, relay, { target: "First", timeoutMs: 15_000 });
			expect(browserOf(inSecond.tab.targetId)).not.toBe(browserOf(inFirst.tab.targetId));
			const owned = await acquireTab(names[2]!, relay, { url: `${fixture.origin}/second`, timeoutMs: 15_000 });
			expect(browserOf(owned.tab.targetId)).toBe(browserOf(inSecond.tab.targetId));
		} finally {
			for (const name of names) await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("closes an owned tab Chrome refuses to close at first", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-refused-close-${process.pid}`;
		try {
			const { tab } = await acquireTab(name, relay, { url: `${fixture.origin}/first`, timeoutMs: 15_000 });
			// A release sends two closes (the worker's, then the supervisor's by id); Chrome refuses the first two tries.
			await fixture.extension.evaluate("globalThis.testRefuseRemoves = 2");
			await releaseTab(name);
			// The close returned with the tab gone.
			expect(await chromeTab(fixture, chromeTabId(tab.targetId))).toBeNull();
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("closes an owned relay tab whose debugger the user dismissed", async () => {
		const detached = Promise.withResolvers<void>();
		let ownedTabId = 0;
		const fixture = await launchRelayFixture((message, data) => {
			if (message === "tab detached" && typeof data?.tabKey === "string" && data.tabKey.endsWith(`:${ownedTabId}`))
				detached.resolve();
		});
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-detached-${process.pid}`;
		try {
			const { tab } = await acquireTab(name, relay, { url: `${fixture.origin}/first`, timeoutMs: 20_000 });
			ownedTabId = chromeTabId(tab.targetId);
			expect(fixture.server.bridge.listTargets().some(target => target.id === tab.targetId)).toBeTrue();
			// Replay the infobar dismissal through the extension's real listener.
			await fixture.extension.evaluate(`chrome.debugger.detach({ tabId: ${ownedTabId} }).then(() => {
				globalThis.testDebuggerDetach({ tabId: ${ownedTabId} }, "canceled_by_user");
			})`);
			await detached.promise;
			expect(fixture.server.bridge.listTargets().some(target => target.id === tab.targetId)).toBeFalse();
			expect(await chromeTab(fixture, ownedTabId)).not.toBeNull();
			await releaseTab(name);
			expect(await chromeTab(fixture, ownedTabId)).toBeNull();
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("drops a closed owned tab's handle and browser hold when timeout recovery loses its connection", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		if (!("browser" in relay)) throw new Error("Expected relay Chromium connection");
		const name = `relay-closed-recovery-${process.pid}`;
		const referencesBefore = relay.refCount;
		const { tab } = await acquireTab(name, relay, { timeoutMs: 15_000 });
		try {
			// The supervisor's own connection never attaches the tab, so Chrome reports the close.
			const closed = fixture.extension.evaluate(`{
				const { promise, resolve } = Promise.withResolvers();
				const listener = tabId => {
					if (tabId !== ${chromeTabId(tab.targetId)}) return;
					chrome.tabs.onRemoved.removeListener(listener);
					resolve();
				};
				chrome.tabs.onRemoved.addListener(listener);
				promise;
			}`);
			const run = runInTab(name, { code: "await page.close(); await wait(60_000);", timeoutMs: 5_000, session });
			await closed;
			relay.browser.disconnect();
			expect(await rejectionOf(run)).toBeInstanceOf(Error);
			expect(getTabsMapForTest().has(name)).toBeFalse();
			expect(relay.refCount).toBe(referencesBefore);
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 30_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("owned tab recovery", () => {
	it("keeps an owned target alive after a failed recovery init so a retry can adopt it", async () => {
		const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in launched)) throw new Error("Expected Chromium");
		const page = await launched.browser.newPage();
		await page.goto("data:text/html,<title>Recovery sentinel</title>");
		const target = page.target();
		if (!("_targetId" in target) || typeof target._targetId !== "string") throw new Error("Missing target ID");
		const payload: WorkerInitPayload = {
			mode: "attach",
			browserWSEndpoint: launched.browser.wsEndpoint(),
			safeDir: getPuppeteerDir(),
			uploadDir: "/tmp/omp-uploads-test",
			page: { kind: "owned", targetId: target._targetId },
			recover: true,
		};
		const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-recovery-download-"));
		const blockedDownloadPath = path.join(downloadDir, "not-a-directory");
		await fs.writeFile(blockedDownloadPath, "existing file");
		const failed = startWorker({ ...payload, downloadsPath: blockedDownloadPath });
		let retried: TestWorker | undefined;
		try {
			expect((await failed.outcome).type).toBe("init-failed");
			expect(page.isClosed()).toBeFalse();
			retried = startWorker(payload);
			const ready = await retried.outcome;
			if (ready.type !== "ready") throw new Error("Expected the retry to adopt the owned target");
			expect(ready.info.targetId).toBe(target._targetId);
			await retried.close();
			retried = undefined;
			// Closing the worker that owns the page closes it. Ask Chrome: this connection's `page`
			// learns of the close only once its own target event arrives.
			const { targetInfos } = await launched.browser
				.target()
				.createCDPSession()
				.then(async session => {
					const targets = await session.send("Target.getTargets");
					await session.detach();
					return targets;
				});
			expect(targetInfos.map(info => info.targetId)).not.toContain(target._targetId);
		} finally {
			await retried?.close();
			await failed.close();
			await page.close().catch(() => undefined);
			await fs.rm(downloadDir, { recursive: true, force: true });
			await releaseBrowser(launched, { kill: true });
		}
	}, 30_000);

	it("adopts a page on a CDP endpoint that rejects unknown methods in its own words, sending it no relay claim", async () => {
		const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in launched)) throw new Error("Expected Chromium");
		const page = await launched.browser.newPage();
		await page.goto("data:text/html,<title>Plain CDP sentinel</title>");
		const target = page.target();
		if (!("_targetId" in target) || typeof target._targetId !== "string") throw new Error("Missing target ID");
		// A CDP shim in front of Chromium that words its unknown-method error differently.
		const relayMethods: string[] = [];
		const upstreams = new Map<object, { socket: WebSocket; queued: string[] }>();
		const proxy = Bun.serve({
			port: 0,
			fetch(request, server) {
				return server.upgrade(request) ? undefined : new Response("CDP shim", { status: 404 });
			},
			websocket: {
				open(client) {
					const socket = new WebSocket(launched.browser.wsEndpoint());
					const queued: string[] = [];
					socket.onopen = () => {
						for (const message of queued.splice(0)) socket.send(message);
					};
					socket.onmessage = event => client.send(String(event.data));
					socket.onclose = () => client.close();
					upstreams.set(client, { socket, queued });
				},
				message(client, raw) {
					const message = JSON.parse(String(raw)) as { id: number; method: string; sessionId?: string };
					if (message.method.startsWith("OMP.")) {
						relayMethods.push(message.method);
						client.send(
							JSON.stringify({
								id: message.id,
								sessionId: message.sessionId,
								error: { code: -32000, message: "Unsupported command" },
							}),
						);
						return;
					}
					const upstream = upstreams.get(client)!;
					if (upstream.socket.readyState === WebSocket.OPEN) upstream.socket.send(String(raw));
					else upstream.queued.push(String(raw));
				},
				close(client) {
					upstreams.get(client)?.socket.close();
					upstreams.delete(client);
				},
			},
		});
		const worker = startWorker({
			mode: "attach",
			browserWSEndpoint: `ws://127.0.0.1:${proxy.port}/devtools/browser`,
			safeDir: getPuppeteerDir(),
			uploadDir: "/tmp/omp-uploads-test",
			page: { kind: "borrowed", targetId: target._targetId },
		});
		try {
			const outcome = await worker.outcome;
			expect(outcome.type).toBe("ready");
			expect(relayMethods).toEqual([]);
		} finally {
			await worker.close();
			proxy.stop(true);
			await page.close().catch(() => undefined);
			await releaseBrowser(launched, { kill: true });
		}
	}, 30_000);
});
