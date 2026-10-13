import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import {
	getTab,
	releaseRelayTabsForOwner,
	releaseTab,
	runInTab,
	type WorkerTabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { isRecord } from "@oh-my-pi/pi-utils";
import puppeteer, { type Browser, type Dialog, type Page } from "puppeteer-core";
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

	function workerTab(): WorkerTabSession {
		const tab = getTab(name);
		if (tab?.backend !== "worker") throw new Error("expected a worker tab");
		return tab;
	}

	async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
		const deadline = performance.now() + ms;
		while (!check() && performance.now() < deadline) await Bun.sleep(20);
		return check();
	}

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
			expect(next.text).toContain("emulation was put back");
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
		"keeps the debugger on a page that opens a dialog while omp is letting go, and puts its overrides back",
		async () => {
			const { ext, page } = await openRelayTab();
			/** Hand back, and have the page open a confirm once the release has started taking omp's overrides off. */
			async function releaseIntoDialog(message: string) {
				const clearing = ext.nextSend("Emulation.clearDeviceMetricsOverride");
				const shown = Promise.withResolvers<Dialog>();
				page.once("dialog", shown.resolve);
				const release = releaseRelayTabsForOwner(OWNER);
				await clearing;
				const answered = page.evaluate(text => confirm(text), message).catch(() => undefined);
				return { released: await release, dialog: await shown.promise, answered };
			}

			const asked = await releaseIntoDialog("during release");
			expect(asked.released).toBe(0);
			expect(ext.attached).toBe(true);
			const next = await invoke({ action: "run", code: "return await tab.dialog();", timeout: 10 });
			expect(next.value).toMatchObject({ open: true, type: "confirm", message: "during release" });
			expect(next.text).toContain("as omp was letting go");
			await invoke({ action: "run", code: "await tab.handleDialog({ accept: true });", timeout: 10 });
			expect(await asked.answered).toBe(true);

			// The clears the dialog held up run once the user answers it; the overrides go back on behind them.
			await invoke({
				action: "run",
				code: "await tab.emulate({ viewport: { width: 500, height: 400 } });",
				timeout: 10,
			});
			const reapplied = ext.nextSend("Emulation.setDeviceMetricsOverride");
			const focused = ext.nextSend("Emulation.setFocusEmulationEnabled", '"enabled":true');
			const again = await releaseIntoDialog("again");
			expect(again.released).toBe(0);
			await again.dialog.dismiss();
			await Promise.all([reapplied, focused]);
			// Through the test's own session, which Chrome orders apart from omp's: wait for the size to land.
			let measured: unknown;
			for (const deadline = performance.now() + 3_000; performance.now() < deadline;) {
				measured = await size(page);
				if (Bun.deepEquals(measured, [500, 400])) break;
			}
			expect(measured).toEqual([500, 400]);
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
			const shown = Promise.withResolvers<Dialog>();
			page.once("dialog", shown.resolve);
			await page.evaluate(() => {
				setTimeout(() => confirm("while away?"), 0);
			});
			const dialog = await shown.promise;

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

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"lets go of a tab once a reattach its interrupted call started settles, and runs a later call on it",
		async () => {
			const { ext } = await openRelayTab();
			expect(await releaseRelayTabsForOwner(OWNER)).toBe(1);
			// The reattach's probe of the page is held, so the call is interrupted while the reattach goes on.
			const probe = ext.holdSend("Runtime.evaluate", '"expression":"0"');
			const interrupt = new AbortController();
			const call = runInTab(name, {
				code: "return 3;",
				timeoutMs: 10_000,
				signal: interrupt.signal,
				session: tool,
			}).catch((error: unknown) => error);
			await probe.arrived;
			interrupt.abort();
			expect(await call).toBeInstanceOf(ToolAbortError);
			const reattach = workerTab().workerRecovery;
			expect(reattach).toBeDefined();

			// The turn hands back while the reattach is still in flight.
			const handBack = releaseRelayTabsForOwner(OWNER);
			probe.release();
			await reattach;
			expect(await handBack).toBe(1);
			expect(ext.attached).toBe(false);
			expect(workerTab().released).toBeDefined();

			// A hand-back waiting on a reattach that a newer call then takes over leaves that call its tab.
			const held = ext.holdSend("Runtime.evaluate", '"expression":"0"');
			const interrupted = new AbortController();
			const first = runInTab(name, {
				code: "return 4;",
				timeoutMs: 10_000,
				signal: interrupted.signal,
				session: tool,
			}).catch((error: unknown) => error);
			await held.arrived;
			interrupted.abort();
			expect(await first).toBeInstanceOf(ToolAbortError);
			const laterHandBack = releaseRelayTabsForOwner(OWNER);
			const newer = invoke({ action: "run", code: "return 5;", timeout: 10 });
			held.release();
			expect((await newer).value).toBe(5);
			await laterHandBack;
			expect(ext.attached).toBe(true);
			expect(workerTab().released).toBeUndefined();
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"lets a worker that exits during the release end it, with no second worker attached until the next call",
		async () => {
			const { ext, page } = await openRelayTab();
			await page.evaluate("globalThis.samePage = 7");
			// A second after this run the worker ends the way a library's stray rejection ends it: its stack never
			// touches the run's source, so the run guard leaves it alone.
			await invoke({
				action: "run",
				code: `await tab.emulate({ timezone: "Asia/Tokyo" });
				setTimeout(() => {
					const err = new Error("library-internal");
					err.stack = "Error: library-internal\\n    at #onFileChooser (puppeteer/Page.js:1:1)";
					Promise.reject(err);
				}, 1_000);`,
				timeout: 10,
			});
			const old = workerTab().worker;
			const exited = Promise.withResolvers<void>();
			old.onExit(() => exited.resolve());
			// A recovery that takes the exited worker over terminates it first, which ends its exit listeners.
			const terminate = old.terminate.bind(old);
			old.terminate = async () => {
				exited.resolve();
				await terminate();
			};
			// The release's first clear is held, so the worker exits under the release.
			const clear = ext.holdSend("Emulation.clearDeviceMetricsOverride");
			const release = releaseRelayTabsForOwner(OWNER);
			await clear.arrived;
			await exited.promise;
			clear.release();
			expect(await release).toBe(1);
			expect(workerTab().worker).toBe(old);
			expect(workerTab().workerRecovery).toBeUndefined();
			expect(workerTab().released).toBeDefined();
			// The attachment goes with the exited worker's connection, which the relay closes on its own time.
			expect(await until(() => !ext.attached)).toBe(true);

			const attaches = ext.attaches;
			const next = await invoke({
				action: "run",
				code: "return await page.evaluate(() => globalThis.samePage);",
				timeout: 10,
			});
			expect(next.value).toBe(7);
			expect(next.text).toContain(REATTACHED);
			// The worker never answered, so the note names what may be gone instead of claiming it came back.
			expect(next.text).toContain("which it could not read back");
			expect(next.text).not.toContain("put back");
			expect(ext.attaches).toBe(attaches + 1);
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps the ids tab.addInitScript returned across the reattach",
		async () => {
			const { page } = await openRelayTab();
			const first = await invoke({
				action: "run",
				code: 'return (await tab.addInitScript("globalThis.initFirst = 1;")).id;',
				timeout: 10,
			});
			const kept = await invoke({
				action: "run",
				code: 'return (await tab.addInitScript("globalThis.initKept = 1;")).id;',
				timeout: 10,
			});
			const keptId = String(kept.value);
			await invoke({
				action: "run",
				code: `await tab.removeInitScript(${JSON.stringify(first.value)});`,
				timeout: 10,
			});
			expect(await releaseRelayTabsForOwner(OWNER)).toBe(1);

			const next = await invoke({
				action: "run",
				code: `const listed = await tab.initScripts(); await tab.removeInitScript(${JSON.stringify(keptId)}); return [listed, await tab.initScripts()];`,
				timeout: 10,
			});
			expect(next.value).toEqual([[{ id: keptId, source: "globalThis.initKept = 1;" }], []]);
			await page.reload();
			expect(await page.evaluate("globalThis.initKept")).toBeUndefined();
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"puts back a viewport set by reopening the tab after the reattach",
		async () => {
			const { page } = await openRelayTab();
			const natural = await page.evaluate("[innerWidth, innerHeight, devicePixelRatio]");
			await invoke({ action: "open", viewport: { width: 503, height: 407, scale: 2 }, timeout: 10 });
			expect(await page.evaluate("[innerWidth, innerHeight, devicePixelRatio]")).toEqual([503, 407, 2]);

			expect(await releaseRelayTabsForOwner(OWNER)).toBe(1);
			expect(await page.evaluate("[innerWidth, innerHeight, devicePixelRatio]")).toEqual(natural);
			const next = await invoke({
				action: "run",
				code: "return await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);",
				timeout: 10,
			});
			expect(next.value).toEqual([503, 407, 2]);
		},
		60_000,
	);
});
