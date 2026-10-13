import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { releaseRelayTabsForOwner, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { isRecord } from "@oh-my-pi/pi-utils";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";
import { ChromeBackedExtension } from "./relay-chrome-backed-extension";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const OWNER = "turn-release-owner";
const REATTACHED = "omp let go of this tab when the last turn ended";

describe("relay tabs at the end of a turn", () => {
	let chromium: Browser | undefined;
	let site: Bun.Server<undefined> | undefined;
	let relay: RelayServer | undefined;
	let extension: ChromeBackedExtension | undefined;
	let tool: ToolSession;
	const name = `relay-turn-${process.pid}`;

	beforeAll(async () => {
		if (!CHROMIUM_AVAILABLE) return;
		const executablePath = await ensureChromiumExecutable();
		if (!executablePath) throw new Error("Chromium executable missing");
		// No default viewport: the test's own page session must not hold a size override of its own.
		chromium = await puppeteer.launch({
			executablePath,
			headless: true,
			defaultViewport: null,
			args: ["--no-first-run"],
		});
		site = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response('<title>Turn</title><button id="ask" onclick="confirm(\'keep me?\')">ask</button>', {
					headers: { "content-type": "text/html" },
				}),
		});
	});

	afterAll(async () => {
		await chromium?.close();
		site?.stop(true);
	});

	afterEach(async () => {
		await releaseTab(name, { kill: false }).catch(() => undefined);
		extension?.close();
		relay?.stop();
	});

	async function invoke(parameters: Record<string, unknown>) {
		const result = await createBrowserPrelude(tool).invoke(
			{ name, ...parameters },
			{ session: tool, toolCallId: "relay-turn" },
		);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		return { text, value: isRecord(result.details) ? result.details.value : undefined };
	}

	/** Borrow a page through the relay as `OWNER`'s session; returns the extension and the test's own handle on the page. */
	async function openRelayTab(
		options: Record<string, unknown> = {},
	): Promise<{ ext: ChromeBackedExtension; page: Page }> {
		if (!chromium || !site) throw new Error("Chromium not launched");
		const page = await chromium.newPage();
		const url = `${site.url}turn?case=${crypto.randomUUID()}`;
		await page.goto(url);
		// Puppeteer exposes a target's CDP id only on the private field.
		const target = page.target() as unknown as { _targetId: string };
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port, group: false });
		extension = await ChromeBackedExtension.connect(port, chromium.wsEndpoint(), target._targetId, url);
		tool = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => OWNER,
			settings: Settings.isolated({
				"browser.enabled": true,
				"browser.relay": true,
				"browser.relayUrl": `http://127.0.0.1:${port}`,
				"browser.cmux": false,
				"browser.tern": false,
				"tools.maxTimeout": 0,
			}),
		};
		await invoke({ action: "open", app: { relay: true, target: "case=" }, timeout: 20, ...options });
		return { ext: extension, page };
	}

	const size = (page: Page) => page.evaluate("[innerWidth, innerHeight]");

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"lets go of the debugger with the emulated size cleared, and reattaches with the emulation put back",
		async () => {
			const { ext, page } = await openRelayTab();
			const natural = await size(page);
			await invoke({
				action: "run",
				code: 'await tab.emulate({ viewport: { width: 500, height: 400 }, timezone: "Asia/Tokyo" });',
				timeout: 10,
			});
			expect(await size(page)).toEqual([500, 400]);

			expect(await releaseRelayTabsForOwner(OWNER)).toBe(1);
			expect(ext.attached).toBe(false);
			// The page leaves the emulated size, which a bare detach would leave in place.
			expect(await size(page)).toEqual(natural);

			const attaches = ext.attaches;
			const next = await invoke({
				action: "run",
				code: "return await page.evaluate(() => [innerWidth, innerHeight, Intl.DateTimeFormat().resolvedOptions().timeZone]);",
				timeout: 10,
			});
			expect(ext.attaches).toBe(attaches + 1);
			expect(next.value).toEqual([500, 400, "Asia/Tokyo"]);
			expect(next.text).toContain(REATTACHED);
			// Said once: the next call is an ordinary one.
			const after = await invoke({ action: "run", code: "return 1;", timeout: 10 });
			expect(after.text).not.toContain(REATTACHED);
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"names the routes and recordings the release ended in the next result",
		async () => {
			const { ext } = await openRelayTab();
			await invoke({
				action: "run",
				code: 'await tab.route("**/never", { status: 204 }); await tab.harStart();',
				timeout: 10,
			});
			expect(await releaseRelayTabsForOwner(OWNER)).toBe(1);
			expect(ext.attached).toBe(false);
			const next = await invoke({ action: "run", code: "return (await tab.routes()).length;", timeout: 10 });
			expect(next.value).toBe(0);
			expect(next.text).toContain("1 tab.route route");
			expect(next.text).toContain("the HAR recording from tab.harStart(), unwritten");
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps the debugger on a page waiting on a dialog, which it can still answer, and says so",
		async () => {
			const { ext } = await openRelayTab();
			const asked = await invoke({ action: "run", code: 'await tab.click("#ask");', timeout: 10 });
			expect(asked.text).toContain("confirm");
			expect(await releaseRelayTabsForOwner(OWNER)).toBe(0);
			expect(ext.attached).toBe(true);
			const next = await invoke({ action: "run", code: "return await tab.dialog();", timeout: 10 });
			expect(next.value).toMatchObject({ open: true, type: "confirm" });
			expect(next.text).toContain("omp kept its debugger on this tab when the last turn ended");
			await invoke({ action: "run", code: "await tab.handleDialog({ accept: true });", timeout: 10 });
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"fails the next call at once, and stays released, when the page opened a dialog while omp was away",
		async () => {
			const { ext, page } = await openRelayTab();
			await invoke({ action: "run", code: "return 1;", timeout: 10 });
			expect(await releaseRelayTabsForOwner(OWNER)).toBe(1);
			expect(ext.attached).toBe(false);
			// The user's side of the page sees the dialog; no attachment made after it opened can.
			const shown = new Promise<{ dismiss(): Promise<void> }>(resolve => page.once("dialog", resolve));
			await page.evaluate(() => {
				setTimeout(() => confirm("while away?"), 0);
			});
			const dialog = await shown;

			const started = performance.now();
			const stopped = await invoke({ action: "run", code: "return 1;", timeout: 20 }).catch(
				(error: unknown) => error,
			);
			expect(String(stopped)).toContain("its page has stopped since");
			// Well inside the call's 20 s budget, which a stalled adoption would spend.
			expect(performance.now() - started).toBeLessThan(8_000);
			expect(ext.attached).toBe(false);

			await dialog.dismiss();
			const next = await invoke({ action: "run", code: "return 2;", timeout: 10 });
			expect(next.value).toBe(2);
			expect(next.text).toContain(REATTACHED);
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps persist tabs and tabs held to allowed_domains attached, and leaves other owners' tabs alone",
		async () => {
			const { ext } = await openRelayTab({ persist: true });
			expect(await releaseRelayTabsForOwner("another-session")).toBe(0);
			expect(await releaseRelayTabsForOwner(OWNER)).toBe(0);
			expect(ext.attached).toBe(true);
			await releaseTab(name, { kill: false });
			extension?.close();
			relay?.stop();

			const fenced = await openRelayTab({ allowed_domains: ["127.0.0.1"] });
			expect(await releaseRelayTabsForOwner(OWNER)).toBe(0);
			expect(fenced.ext.attached).toBe(true);
		},
		60_000,
	);
});
