import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgBrowserRelayReleaseOnTurnEnd } from "@oh-my-pi/pi-coding-agent/tools/browser/settings";
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
			fetch: request => {
				const url = new URL(request.url);
				if (url.pathname === "/data.json") return Response.json({ n: Number(url.searchParams.get("n")) });
				return new Response(
					`<title>Turn</title><button id="ask">ask</button><input type="file" id="pick"><button id="count">count</button>
					<script>
						document.querySelector("#ask").onclick = () => { window.answer = confirm("keep me?"); };
						document.querySelector("#count").onclick = () => {
							window.clicks = (window.clicks ?? 0) + 1;
							console.log("clicked " + window.clicks);
							fetch("/data.json?n=" + window.clicks);
						};
					</script>`,
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
	});

	afterAll(async () => {
		await chromium?.close();
		site?.stop(true);
		// A relay tab's staging folder outlives it until the 24 h sweep; this run's go with it.
		for (const name of await fs.readdir(os.tmpdir())) {
			if (name.startsWith(`omp-uploads-${process.pid}-`))
				await fs.rm(path.join(os.tmpdir(), name), { recursive: true, force: true });
		}
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
		settings: Record<string, unknown> = {},
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
				...settings,
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
			expect(next.text).not.toContain("start fresh");
			// Said once: the next call is an ordinary one.
			const after = await invoke({ action: "run", code: "return 1;", timeout: 10 });
			expect(after.text).not.toContain(REATTACHED);
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps the debugger on a tab while something lives only in the attachment, and says why",
		async () => {
			const { ext } = await openRelayTab();
			const recording = path.join(tool.cwd, `turn-release-${crypto.randomUUID()}.mp4`);
			const har = path.join(tool.cwd, `turn-release-${crypto.randomUUID()}.har`);
			const trace = path.join(tool.cwd, `turn-release-${crypto.randomUUID()}.json`);
			const profile = path.join(tool.cwd, `turn-release-${crypto.randomUUID()}.cpuprofile`);
			const live = [
				{
					set: 'await tab.route("**/never", { status: 204 });',
					reason: "a tab.route() route applies",
					end: "await tab.unroute();",
				},
				{
					set: "await tab.harStart();",
					reason: "the HAR from tab.harStart() records",
					end: `await tab.harStop(${JSON.stringify(har)});`,
				},
				{
					set: "await tab.traceStart();",
					reason: "the trace from tab.traceStart() records",
					end: `await tab.traceStop(${JSON.stringify(trace)});`,
				},
				{
					set: "await tab.profileStart();",
					reason: "the CPU profile from tab.profileStart() records",
					end: `await tab.profileStop(${JSON.stringify(profile)});`,
				},
				{
					set: `await tab.recordStart(${JSON.stringify(recording)});`,
					reason: "the screen recording records",
					end: "await tab.recordStop();",
				},
				{
					set: 'await tab.keyDown("Shift");',
					reason: "keys or buttons tab.keyDown() or tab.mouseDown() pressed stay held",
					end: 'await tab.keyUp("Shift");',
				},
			];
			try {
				for (const { set, reason, end } of live) {
					await invoke({ action: "run", code: set, timeout: 10 });
					expect(await releaseRelayTabsForOwner(OWNER)).toBe(0);
					expect(ext.attached).toBe(true);
					const next = await invoke({ action: "run", code: end, timeout: 20 });
					expect(next.text).toContain(`omp kept its debugger on this tab when a turn ended, because ${reason}`);
				}
				// With all of it ended, the hand-back lets go.
				expect(await releaseRelayTabsForOwner(OWNER)).toBe(1);
				expect(ext.attached).toBe(false);
			} finally {
				await Promise.all([recording, har, trace, profile].map(file => fs.rm(file, { force: true })));
			}
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
			expect(next.text).toContain("omp kept its debugger on this tab when a turn ended");
			await invoke({ action: "run", code: "await tab.handleDialog({ accept: true });", timeout: 10 });
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps a file staged before the release readable after the reattach, in the tab's one staging folder",
		async () => {
			const { ext } = await openRelayTab();
			const file = path.join(tool.cwd, `turn-release-${crypto.randomUUID()}.txt`);
			await Bun.write(file, "staged before the release");
			try {
				await invoke({
					action: "run",
					code: `await tab.uploadFile("#pick", ${JSON.stringify(file)});`,
					timeout: 10,
				});
				const { uploadDir } = workerTab();
				// The paths route: Chrome got a copy in the tab's staging folder, which it reads only when the page does.
				const staged = await fs.readdir(uploadDir, { recursive: true });
				expect(staged.map(entry => path.basename(entry))).toContain(path.basename(file));

				expect(await releaseRelayTabsForOwner(OWNER)).toBe(1);
				expect(ext.attached).toBe(false);
				const next = await invoke({
					action: "run",
					code: 'return await page.evaluate(() => document.querySelector("#pick").files[0].text());',
					timeout: 10,
				});
				expect(next.text).toContain(REATTACHED);
				expect(next.value).toBe("staged before the release");
				// The reattached worker took over the same folder instead of starting another.
				expect(workerTab().uploadDir).toBe(uploadDir);
				expect(await fs.readdir(uploadDir, { recursive: true })).toEqual(staged);
			} finally {
				await fs.rm(file, { force: true });
			}
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
			const focused = ext.nextSend(
				"Emulation.setFocusEmulationEnabled",
				params => isRecord(params) && params.enabled === true,
			);
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
			const probe = ext.holdSend("Runtime.evaluate", params => isRecord(params) && params.expression === "0");
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
			expect(workerTab().turnRelease?.state).toBe("released");

			// A hand-back waiting on a reattach that a newer call then takes over leaves that call its tab.
			const held = ext.holdSend("Runtime.evaluate", params => isRecord(params) && params.expression === "0");
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
			expect(workerTab().turnRelease).toBeUndefined();
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps a tab whose reattach outlasts its call released for the next call, instead of closing it",
		async () => {
			const { ext } = await openRelayTab();
			expect(await releaseRelayTabsForOwner(OWNER)).toBe(1);
			// The new attachment's frame tree is held past the call's budget.
			const frameTree = ext.holdSend("Page.getFrameTree");
			const call = runInTab(name, { code: "return 1;", timeoutMs: 1_000, session: tool }).catch(
				(error: unknown) => error,
			);
			await frameTree.arrived;
			// The call's own wait and the reattach's run out together; either may say so first.
			expect(String(await call)).toMatch(/could not be reattached within|still being reattached/);
			const reattach = workerTab().workerRecovery;
			await reattach?.catch(() => undefined);
			frameTree.release();
			// Still omp's tab, released, with a new worker to take it over.
			expect(workerTab().state).toBe("alive");
			expect(workerTab().turnRelease).toMatchObject({ state: "released", lost: "exited" });

			const next = await invoke({ action: "run", code: "return 2;", timeout: 10 });
			expect(next.value).toBe(2);
			expect(next.text).toContain("lost the tab worker that held its state");
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
			expect(workerTab().turnRelease?.state).toBe("released");
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
			// The worker never answered, so the note names what is gone instead of claiming it came back.
			expect(next.text).toContain("lost the tab worker that held its state");
			expect(next.text).toContain("could not read them back");
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

	/**
	 * One turn's work on a relay tab, the agent handing back (releasing the tab when `release`), and the next turn
	 * reading it all back: element ids and ARIA refs, console and request logs, a response body, the dialog policy, an
	 * uploaded file, emulation, init scripts and run globals.
	 */
	async function twoTurns(release: boolean) {
		const { ext } = await openRelayTab({}, { "browser.relayReleaseOnTurnEnd": release });
		const file = path.join(tool.cwd, `turn-release-${crypto.randomUUID()}.txt`);
		await Bun.write(file, "uploaded in turn one");
		try {
			const first = await invoke({
				action: "run",
				// Loaded while omp is attached, as after any navigation the agent makes, so element ids carry its loader id.
				code: `await tab.goto(page.url());
				await tab.emulate({ timezone: "Asia/Tokyo" });
				await tab.addInitScript("globalThis.fromInit = 1;");
				await tab.setDialogs("accept");
				globalThis.carried = 42;
				const count = (await tab.observe()).elements.find(entry => entry.name === "count").id;
				const ref = /button "count" \\[ref=(e\\d+)\\]/.exec(await tab.ariaSnapshot())[1];
				const responded = tab.waitForResponse("data.json");
				await (await tab.id(count)).click();
				await responded;
				await tab.uploadFile("#pick", ${JSON.stringify(file)});
				return { count, ref };`,
				timeout: 20,
			});
			const { count, ref } = first.value as { count: number; ref: string };

			// The turn ends: the session releases its relay tabs when the setting says so.
			const handedBack = cfgBrowserRelayReleaseOnTurnEnd.get(tool.settings)
				? await releaseRelayTabsForOwner(OWNER)
				: 0;
			expect(handedBack).toBe(release ? 1 : 0);
			expect(ext.attached).toBe(!release);

			const second = await invoke({
				action: "run",
				code: `const byId = await tab.id(${count});
				const byRef = await tab.ref(${JSON.stringify(ref)});
				const responded = tab.waitForResponse("data.json");
				await byId.click();
				await responded;
				// The page asks; the policy answers the confirm as it opens, and without one it would still be waiting.
				await page.evaluate(() => setTimeout(() => { window.answer = confirm("keep me?"); }, 0));
				await page.waitForFunction(() => window.answer !== undefined, { timeout: 3_000 }).catch(() => undefined);
				const requests = await tab.requests({ filter: "data.json" });
				return {
					ids: [await byId.evaluate(el => el.id), await byRef.evaluate(el => el.id)],
					logged: (await tab.console()).entries.map(entry => entry.text),
					requests: requests.map(request => new URL(request.url).search),
					firstBody: (await tab.request(requests[0].id)).body,
					dialog: await tab.dialog(),
					answer: await page.evaluate(() => window.answer),
					uploaded: await page.evaluate(() => document.querySelector("#pick").files[0]?.text()),
					timezone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
					initScripts: (await tab.initScripts()).map(script => script.source),
					carried: globalThis.carried,
				};`,
				timeout: 20,
			});
			return { value: second.value, text: second.text };
		} finally {
			await fs.rm(file, { force: true });
			await releaseTab(name, { kill: false }).catch(() => undefined);
			extension?.close();
			relay?.stop();
		}
	}

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"gives the next turn everything the last one built on a tab it released, as if it had stayed attached",
		async () => {
			const stayed = await twoTurns(false);
			const released = await twoTurns(true);
			const expected = {
				ids: ["count", "count"],
				logged: ["clicked 1", "clicked 2"],
				requests: ["?n=1", "?n=2"],
				firstBody: '{"n":1}',
				dialog: { open: false },
				answer: true,
				uploaded: "uploaded in turn one",
				timezone: "Asia/Tokyo",
				initScripts: ["globalThis.fromInit = 1;"],
				carried: 42,
			};
			expect(stayed.value).toEqual(expected);
			expect(released.value).toEqual(expected);
			expect(released.text).toContain(REATTACHED);
			expect(released.text).not.toContain("start fresh");
		},
		90_000,
	);
});
