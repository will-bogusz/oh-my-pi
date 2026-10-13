import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as rewriteImports from "@oh-my-pi/pi-coding-agent/eval/js/shared/rewrite-imports";
import * as toolBridge from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { getTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { isRecord } from "@oh-my-pi/pi-utils";
import puppeteer, { type Browser } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";
import { ChromeBackedExtension } from "./relay-chrome-backed-extension";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
/** A call that stays in flight until something ends it. */
const HANG = { code: "await page.evaluate(() => new Promise(() => {}));", timeout: 30 };
/** The call's own evaluation of {@link HANG}, not one the tab's print hold or other setup sends first. */
const evaluatesHang = (params: Record<string, unknown>): boolean =>
	String(params.functionDeclaration).includes("new Promise(() => {})");

describe("relay tabs Chrome detaches omp from", () => {
	let chromium: Browser | undefined;
	let site: Bun.Server<undefined> | undefined;
	let relay: RelayServer | undefined;
	let extension: ChromeBackedExtension | undefined;
	let tool: ToolSession;
	const name = `relay-detach-${process.pid}`;

	beforeAll(async () => {
		if (!CHROMIUM_AVAILABLE) return;
		const executablePath = await ensureChromiumExecutable();
		if (!executablePath) throw new Error("Chromium executable missing");
		chromium = await puppeteer.launch({ executablePath, headless: true, args: ["--no-first-run"] });
		site = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response('<title>Sign in</title><input id="user"><input id="pw" type="password">', {
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
			{ session: tool, toolCallId: "relay-detach" },
		);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		return { text, value: isRecord(result.details) ? result.details.value : undefined };
	}

	/** Adopt a page through the relay and leave state on it that only survives a re-adoption without reload. */
	async function openRelayTab(): Promise<ChromeBackedExtension> {
		if (!chromium || !site) throw new Error("Chromium not launched");
		const page = await chromium.newPage();
		const url = `${site.url}login?case=${crypto.randomUUID()}`;
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
			settings: Settings.isolated({
				"browser.enabled": true,
				"browser.relay": true,
				"browser.relayUrl": `http://127.0.0.1:${port}`,
				"browser.cmux": false,
				"browser.tern": false,
				"tools.maxTimeout": 0,
			}),
		};
		await invoke({ action: "open", app: { relay: true, target: "case=" }, timeout: 20 });
		await invoke({ action: "run", code: "await page.evaluate(() => { window.mark = 'kept'; });", timeout: 10 });
		return extension;
	}

	const readMark = { action: "run", code: "return await page.evaluate(() => window.mark);", timeout: 10 };

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"fails the call in flight at once, names the cause, and re-adopts the same page for the next call",
		async () => {
			const ext = await openRelayTab();
			const evaluating = ext.nextSend("Runtime.callFunctionOn", evaluatesHang);
			const stalled = invoke({ action: "run", ...HANG }).catch((error: unknown) => error);
			await evaluating;
			await ext.chromeDetach("target_closed");
			const failure = String(await stalled);
			expect(failure).toContain("Chrome detached omp from this tab (target_closed) during this call");
			expect(failure).toContain("password manager");
			expect(failure).toContain("may already have landed");
			expect(failure).toContain("reattached to the same tab");
			expect((await invoke(readMark)).value).toBe("kept");
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"aborts the host tool calls the detached call had in flight",
		async () => {
			const ext = await openRelayTab();
			const started = Promise.withResolvers<AbortSignal>();
			const callTool = spyOn(toolBridge, "callSessionTool").mockImplementation(async (_name, _args, options) => {
				const signal = options.signal!;
				started.resolve(signal);
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				throw signal.reason;
			});
			try {
				const evaluating = ext.nextSend("Runtime.callFunctionOn", evaluatesHang);
				const code = `void __omp_call_tool__("probe", {}); ${HANG.code}`;
				const stalled = invoke({ action: "run", code, timeout: HANG.timeout }).catch((error: unknown) => error);
				const signal = await started.promise;
				await evaluating;
				await ext.chromeDetach("target_closed");
				expect(String(await stalled)).toContain(
					"Chrome detached omp from this tab (target_closed) during this call",
				);
				expect(signal.aborted).toBe(true);
			} finally {
				callTool.mockRestore();
			}
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"re-adopts a tab Chrome detached between calls and runs the next call there",
		async () => {
			const ext = await openRelayTab();
			await ext.chromeDetach("target_closed");
			// The detach crosses the relay to the tab's worker on its own sockets; nothing the test can await
			// marks its arrival, and the call must start after it to be a call made on an already-detached tab.
			await Bun.sleep(500);
			const next = await invoke(readMark);
			expect(next.value).toBe("kept");
			expect(next.text).toContain("Chrome had detached omp from this tab since the last call");
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"runs a call on the re-adopted tab when Chrome detached omp before its code started",
		async () => {
			const ext = await openRelayTab();
			// A user agent set by an earlier call is reapplied before each call's code starts.
			await invoke({ action: "run", code: 'await tab.emulate({ userAgent: "omp-detach-test" });', timeout: 10 });
			const reapplying = ext.nextSend("Network.setUserAgentOverride");
			const next = invoke(readMark);
			await reapplying;
			await ext.chromeDetach("target_closed");
			const result = await next;
			expect(result.value).toBe("kept");
			expect(result.text).toContain(
				"omp reattached to the same tab on a new worker, without reloading it, and then ran this call",
			);
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"does not rerun a call detached before its code started once the re-adoption spent its budget",
		async () => {
			const ext = await openRelayTab();
			await invoke({ action: "run", code: 'await tab.emulate({ userAgent: "omp-detach-test" });', timeout: 10 });
			const tab = getTab(name);
			if (tab?.backend !== "worker") throw new Error("expected a worker tab");
			// Hold the re-adoption for the call's whole budget once the detached worker is gone. Real time: the
			// re-adoption's own init deadline reads the same clock, so a faked clock would fail it instead.
			const budgetMs = 1_000;
			const terminate = tab.worker.terminate.bind(tab.worker);
			const held = spyOn(tab.worker, "terminate").mockImplementation(async () => {
				await terminate();
				await Bun.sleep(budgetMs);
			});
			try {
				const reapplying = ext.nextSend("Network.setUserAgentOverride");
				const next = runInTab(name, { code: readMark.code, timeoutMs: budgetMs, session: tool }).catch(
					(error: unknown) => error,
				);
				await reapplying;
				await ext.chromeDetach("target_closed");
				const failure = String(await next);
				expect(failure).toContain("before this call, so its code did not run");
				expect(failure).toContain(`used up this call's ${budgetMs}ms budget, so the call was not run again`);
			} finally {
				held.mockRestore();
			}
			expect((await invoke(readMark)).value).toBe("kept");
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"counts a detach while the call's code is still compiling as before it ran",
		async () => {
			// An inline tab worker runs in this process, so the compile step can be held. Worker threads failing to
			// start is what puts a tab on one. It cannot be re-adopted, so the call reports the tab closed.
			const RealWorker = globalThis.Worker;
			Object.defineProperty(globalThis, "Worker", {
				configurable: true,
				writable: true,
				value: function UnavailableWorker(): never {
					throw new Error("Worker threads unavailable");
				},
			});
			let ext: ChromeBackedExtension;
			try {
				ext = await openRelayTab();
			} finally {
				globalThis.Worker = RealWorker;
			}
			expect(getTab(name)).toMatchObject({ worker: { mode: "inline" } });
			const wrapCode = rewriteImports.wrapCode;
			const compiling = Promise.withResolvers<void>();
			const compiled = Promise.withResolvers<void>();
			const held = spyOn(rewriteImports, "wrapCode").mockImplementation(async code => {
				compiling.resolve();
				await compiled.promise;
				return await wrapCode(code);
			});
			try {
				const next = invoke(readMark).catch((error: unknown) => error);
				await compiling.promise;
				await ext.chromeDetach("target_closed");
				expect(String(await next)).toContain(
					"Chrome detached omp from this tab (target_closed) before this call, so its code did not run",
				);
			} finally {
				compiled.resolve();
				held.mockRestore();
			}
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"fails fast once Chrome refuses the re-adoption",
		async () => {
			const ext = await openRelayTab();
			ext.refuseAttach = true;
			const evaluating = ext.nextSend("Runtime.callFunctionOn", evaluatesHang);
			const stalled = invoke({ action: "run", ...HANG }).catch((error: unknown) => error);
			await evaluating;
			await ext.chromeDetach("target_closed");
			const failure = String(await stalled);
			expect(failure).toContain("Chrome detached omp from this tab (target_closed) during this call");
			expect(failure).toContain("could not reattach");
			const later = String(await invoke(readMark).catch((error: unknown) => error));
			expect(later).toContain("could not reattach");
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"reports a cancel that lands during the re-adoption as a cancel",
		async () => {
			const ext = await openRelayTab();
			const tab = getTab(name);
			if (tab?.backend !== "worker") throw new Error("expected a worker tab");
			// Hold the re-adoption once the detached worker is gone, so the cancel lands while it is under way.
			const terminate = tab.worker.terminate.bind(tab.worker);
			const readopting = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const held = spyOn(tab.worker, "terminate").mockImplementation(async () => {
				await terminate();
				readopting.resolve();
				await resume.promise;
			});
			try {
				const ac = new AbortController();
				const evaluating = ext.nextSend("Runtime.callFunctionOn", evaluatesHang);
				const stalled = runInTab(name, {
					code: HANG.code,
					timeoutMs: 30_000,
					session: tool,
					signal: ac.signal,
				}).catch((error: unknown) => error);
				await evaluating;
				await ext.chromeDetach("target_closed");
				await readopting.promise;
				ac.abort();
				resume.resolve();
				expect(await stalled).toBeInstanceOf(ToolAbortError);
				expect((await invoke(readMark)).value).toBe("kept");
			} finally {
				resume.resolve();
				held.mockRestore();
			}
		},
		60_000,
	);
});
