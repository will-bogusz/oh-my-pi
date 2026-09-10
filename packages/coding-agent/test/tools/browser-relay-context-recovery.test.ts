/**
 * Execution-context recovery across back-to-back main-frame navigations
 * (Gusto session, Class B): a menu click navigated `/profile/pay` →
 * `/u/companies` → an onward redirect, and `observe()` then failed with
 * `Runtime.callFunctionOn: Cannot find context with specified id` — as did a
 * fresh attempt 4.6 s later. Only release + claim (a new CDP session) recovered.
 *
 * omp's puppeteer never sends `Runtime.enable` (the loudest automation tell),
 * so a frame's execution contexts are pull-acquired on demand instead of being
 * pushed by Chrome. The relay bridge forwards Chrome's stream faithfully — it
 * simply has no Runtime lifecycle to forward. What broke was the acquisition:
 * one that started on document B and finished after C committed installed B's
 * dead context ids anyway, and one that failed that way left the world empty
 * with no push event able to fill it, so the caller waited out the whole 30 s
 * default timeout.
 *
 * The fixture is the Gusto shape: page A on one origin, a control whose click
 * navigates to B on a second origin (renderer swap), and B redirecting onward
 * to C. B's redirect is held until the acquisition's first probe leaves the
 * client, so the second navigation always commits with an acquisition in
 * flight instead of depending on timing luck. The real relay extension is in
 * the loop because its round trip is what makes the window wide enough to hit.
 */
import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBrowserRelayCommand } from "@oh-my-pi/pi-coding-agent/cli/browser-relay-cli";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import puppeteer, { type Browser, type ConnectionTransport, type Page } from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

interface Fixture {
	start: string;
	/** Hold B's onward redirect until the next {@link Fixture.release}. */
	arm(): void;
	release(): void;
	stop(): Promise<void>;
}

/**
 * A → B → C across two origins. B holds one request open until the test
 * releases it and only then replaces itself with C, so the second navigation
 * is scheduled by the test rather than by a timer.
 */
function startRedirectFixture(): Fixture {
	let gate = Promise.withResolvers<void>();
	const document = (body: string): Response =>
		new Response(`<!doctype html><meta charset=utf-8>${body}`, { headers: { "content-type": "text/html" } });
	const onward = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/gate") {
				await gate.promise;
				return new Response("go");
			}
			if (pathname === "/b")
				return document(
					`<title>B</title><h1 id=route>B</h1><script>fetch("/gate").then(()=>location.replace("/c"))</script>`,
				);
			return document(`<title>C</title><h1 id=route>C</h1><p id=done>final</p>`);
		},
	});
	// `localhost` on another port is a different site from `127.0.0.1`, so the
	// first navigation swaps renderer processes exactly as Gusto's did.
	const home = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			document(
				`<title>A</title><button id=go onclick="location.href='http://localhost:${onward.port}/b'">Go</button><p id=here>A</p>`,
			),
	});
	return {
		start: `http://127.0.0.1:${home.port}/a`,
		arm: () => {
			gate = Promise.withResolvers<void>();
		},
		release: () => gate.resolve(),
		stop: async () => {
			gate.resolve();
			await home.stop(true);
			await onward.stop(true);
		},
	};
}

/**
 * Poll the main world until the onward document is the current one. A
 * `waitForSelector` cannot be used here: its wait task lives in the utility
 * world, and with `Runtime.enable` off nothing re-runs it when a navigation
 * replaces the document underneath it — a separate gap in the stealth patch
 * that this test must not depend on.
 */
async function settleOnFinalDocument(page: Page): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const path = await page.evaluate("location.pathname").catch(() => undefined);
		if (path === "/c" && (await page.evaluate("document.getElementById('done') !== null").catch(() => false)))
			return "/c";
		await Bun.sleep(50);
	}
	return String(await page.evaluate("location.pathname").catch(() => "<unreachable>"));
}

it.skipIf(!CHROMIUM_AVAILABLE)(
	"keeps a tab evaluable when a second navigation commits under an in-flight context acquisition",
	async () => {
		const fixture = startRedirectFixture();
		const relay = startRelayServer({ port: 0 });
		const root = await mkdtemp(path.join(tmpdir(), "omp-context-recovery-"));
		let chrome: Browser | undefined;
		let client: Browser | undefined;
		try {
			const extension = path.join(root, "extension");
			await runBrowserRelayCommand({ action: "install", dir: extension, port: relay.port });
			chrome = await puppeteer.launch({
				executablePath: await chromiumExecutable(),
				headless: true,
				pipe: true,
				enableExtensions: true,
				userDataDir: path.join(root, "profile"),
				defaultViewport: null,
			});
			const extensionId = await chrome.installExtension(extension);
			const options = await chrome.newPage();
			await options.goto(`chrome-extension://${extensionId}/options.html`);
			await options.type("#label", "Context recovery fixture");
			await options.type("#code", relay.access.issueCode().code);
			await options.click("#save");
			for (let attempt = 0; attempt < 400 && !relay.instances.list().some(one => one.connected); attempt++)
				await Bun.sleep(25);
			expect(relay.instances.list().some(one => one.connected)).toBe(true);
			await options.close();
			// The launch pipe is not a driver: disarm its auto-attach so it does
			// not own every new target's debugger.
			const setupSession = await chrome.target().createCDPSession();
			await setupSession
				.connection()
				?.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
			await setupSession.detach();
			await chrome.disconnect();

			const lease = await relay.instances.create(fixture.start, "actor", "task", "Context recovery");
			const version = (await (
				await fetch(`http://127.0.0.1:${relay.port}/managed/${lease.id}/json/version`)
			).json()) as { webSocketDebuggerUrl: string };
			const socket = new WebSocket(version.webSocketDebuggerUrl);
			const opened = Promise.withResolvers<void>();
			socket.addEventListener("open", () => opened.resolve());
			await opened.promise;
			let armed = false;
			const transport: ConnectionTransport = {
				send: raw => {
					const message = JSON.parse(raw) as { method?: string };
					// `Page.createIsolatedWorld` opens an acquisition, and two more
					// relay round trips remain after it, so releasing the redirect
					// here always commits C with the acquisition still outstanding.
					if (armed && message.method === "Page.createIsolatedWorld") {
						armed = false;
						fixture.release();
					}
					socket.send(raw);
				},
				close: () => socket.close(),
			};
			socket.addEventListener("message", event => transport.onmessage?.(String(event.data)));
			socket.addEventListener("close", () => transport.onclose?.());
			client = await puppeteer.connect({ transport, defaultViewport: null, protocolTimeout: 45_000 });
			const page = await client
				.targets()
				.find(candidate => candidate.type() === "page")
				?.page();
			if (!page) throw new Error("Missing leased page");
			let onA = false;
			for (let attempt = 0; attempt < 100 && !onA; attempt++) {
				onA = (await page.evaluate("document.getElementById('here') !== null").catch(() => false)) === true;
				if (!onA) await Bun.sleep(50);
			}
			expect(onA).toBe(true);
			// A context acquisition that produces nothing used to fall back to
			// waiting for a push event; a short default makes that park cheap to
			// observe instead of a 30 s stall.
			page.setDefaultTimeout(3_000);

			// A single round is a coin flip between the two ways an acquisition
			// can be caught by the second navigation; two dozen covers both.
			const parked: string[] = [];
			for (let round = 0; round < 24; round++) {
				fixture.arm();
				if (round) await page.goto(fixture.start, { timeout: 15_000 });
				const onB = Promise.withResolvers<void>();
				const reachedB = (frame: { parentFrame(): unknown; url(): string }): void => {
					if (!frame.parentFrame() && frame.url().endsWith("/b")) onB.resolve();
				};
				page.on("framenavigated", reachedB);
				// String form: the browser tool's `declare global` narrows
				// `document` project-wide, so DOM lib names are unavailable here.
				await page.evaluate("document.getElementById('go').click()");
				await onB.promise;
				page.off("framenavigated", reachedB);
				armed = true;

				const straddle = Date.now();
				const during = await page.evaluate(() => 1 + 1).then(
					value => `ok ${String(value)}`,
					(error: Error) => `error ${error.message.split("\n")[0]}`,
				);
				// Racing a navigation may legitimately fail this call — a direct
				// CDP client reports a destroyed context the same way. What it may
				// never do is sit on a push event this connection cannot receive.
				if (during.includes("Timed out after waiting") || Date.now() - straddle > 2_500)
					parked.push(`round ${round}: ${during} after ${Date.now() - straddle}ms`);
				armed = false;

				expect(await settleOnFinalDocument(page)).toBe("/c");
				expect(await page.evaluate(() => 1 + 1)).toBe(2);
				expect(await page.accessibility.snapshot()).toBeTruthy();
			}
			expect(parked).toEqual([]);
			// The Gusto failure survived a fresh observation 4.6 s later: nothing
			// re-invalidates a poisoned world, so only elapsed time exposes it.
			await Bun.sleep(2_500);
			expect(await page.evaluate(() => 1 + 1)).toBe(2);
			expect(await page.accessibility.snapshot()).toBeTruthy();
		} finally {
			client?.disconnect();
			chrome?.process()?.kill("SIGTERM");
			relay.stop();
			await fixture.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	180_000,
);

it.skipIf(!CHROMIUM_AVAILABLE)(
	"reports a context acquisition the second navigation defeated instead of parking, without the relay",
	async () => {
		// The relay only widens the window: the same acquisition raced the same
		// navigation on a plain CDP connection, and parked there too.
		const fixture = startRedirectFixture();
		const launcher = await puppeteer.launch({ executablePath: await chromiumExecutable(), headless: true });
		const endpoint = launcher.wsEndpoint();
		await launcher.disconnect();
		let client: Browser | undefined;
		try {
			const socket = new WebSocket(endpoint);
			const opened = Promise.withResolvers<void>();
			socket.addEventListener("open", () => opened.resolve());
			await opened.promise;
			let armed = false;
			const transport: ConnectionTransport = {
				send: raw => {
					const message = JSON.parse(raw) as { method?: string };
					if (armed && message.method === "Page.createIsolatedWorld") {
						armed = false;
						fixture.release();
					}
					socket.send(raw);
				},
				close: () => socket.close(),
			};
			socket.addEventListener("message", event => transport.onmessage?.(String(event.data)));
			socket.addEventListener("close", () => transport.onclose?.());
			client = await puppeteer.connect({ transport, defaultViewport: null, protocolTimeout: 45_000 });
			const page = await client.newPage();
			page.setDefaultTimeout(3_000);
			const parked: string[] = [];
			for (let round = 0; round < 12; round++) {
				fixture.arm();
				await page.goto(fixture.start, { timeout: 15_000 });
				const onB = Promise.withResolvers<void>();
				const reachedB = (frame: { parentFrame(): unknown; url(): string }): void => {
					if (!frame.parentFrame() && frame.url().endsWith("/b")) onB.resolve();
				};
				page.on("framenavigated", reachedB);
				await page.evaluate("document.getElementById('go').click()");
				await onB.promise;
				page.off("framenavigated", reachedB);
				armed = true;
				const straddle = Date.now();
				const during = await page.evaluate(() => 1 + 1).then(
					value => `ok ${String(value)}`,
					(error: Error) => `error ${error.message.split("\n")[0]}`,
				);
				if (during.includes("Timed out after waiting") || Date.now() - straddle > 2_500)
					parked.push(`round ${round}: ${during} after ${Date.now() - straddle}ms`);
				armed = false;
				expect(await settleOnFinalDocument(page)).toBe("/c");
				expect(await page.evaluate(() => 1 + 1)).toBe(2);
			}
			expect(parked).toEqual([]);
		} finally {
			client?.disconnect();
			const closer = await puppeteer.connect({ browserWSEndpoint: endpoint }).catch(() => undefined);
			await closer?.close().catch(() => undefined);
			await fixture.stop();
		}
	},
	180_000,
);
