/**
 * Navigation and focus-restore contracts (Gusto session, omp-trace D2/D4):
 *
 * - `goto` waits for the **main frame** only. Two cross-origin iframes that never
 *   reached a lifecycle event burned 29 s per navigation and then failed, twice,
 *   on a page that had been usable the whole time.
 * - A focus restore that stalls because the click navigated the page is not a
 *   broken handle; poisoning it forced a release + re-claim mid-task.
 * - The relay replays `Page.setLifecycleEventsEnabled` after its idle detach:
 *   puppeteer sends it once at attach, so without the replay every later
 *   navigation waits for lifecycle events Chrome no longer emits.
 */

import { expect, it } from "bun:test";
import { RelayBridge, type RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import type { RelayRpcRequest, RelayToExtMessage } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { navigateMainFrame } from "@oh-my-pi/pi-coding-agent/tools/browser/navigation";
import { acquireBrowser, type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { prepareBackgroundPage, withBackgroundInput } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import puppeteer, { type CDPSession, type ConnectionTransport, type Page } from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: { get: () => undefined },
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

/** A response whose body is never closed: the request stays in flight forever. */
function stalledBody(prefix: string): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(prefix));
			},
		}),
		{ headers: { "content-type": "text/html; charset=utf-8" } },
	);
}

interface HangingFixture {
	route(path: string): string;
	/** A document whose own body never ends. */
	stalledDocument: string;
	stop(): Promise<void>;
}

/**
 * A site whose every page embeds a cross-origin iframe (separate port, so a real
 * OOPIF) that never finishes loading — the shape of the Guideline frames inside
 * app.gusto.com.
 */
function startHangingIframeFixture(): HangingFixture {
	const iframeHost = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => stalledBody("<p>partial</p>") });
	const iframeUrl = `http://127.0.0.1:${iframeHost.port}/never-ends`;
	const site = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: request => {
			const { pathname } = new URL(request.url);
			if (pathname === "/stalled") return stalledBody("<!doctype html><title>Stalled</title><h1>partial</h1>");
			return new Response(
				`<!doctype html><title>Route ${pathname}</title><h1 id="route">${pathname}</h1>` +
					`<iframe src="${iframeUrl}"></iframe>`,
				{ headers: { "content-type": "text/html; charset=utf-8" } },
			);
		},
	});
	return {
		route: path => `http://127.0.0.1:${site.port}${path}`,
		stalledDocument: `http://127.0.0.1:${site.port}/stalled`,
		stop: async () => {
			await site.stop(true);
			await iframeHost.stop(true);
		},
	};
}

it.skipIf(!CHROMIUM_AVAILABLE)(
	"navigates pages whose cross-origin iframe never finishes loading",
	async () => {
		const fixture = startHangingIframeFixture();
		const session = makeSession();
		const name = `navigation-hanging-${process.pid}`;
		let browser: BrowserHandle | undefined;
		try {
			browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			const createdAt = Date.now();
			await acquireTab(name, browser, {
				url: fixture.route("/overview"),
				timeoutMs: 30_000,
				ownerSessionId: "session-navigation",
			});
			// Creation navigates too: it used to hang on the same child frames.
			expect(Date.now() - createdAt).toBeLessThan(10_000);
			const target = fixture.route("/contributions");
			const result = await runInTab(name, {
				code: `const started = Date.now();
await tab.goto(${JSON.stringify(target)});
const settled = Date.now() - started;
const fragment = Date.now();
await tab.goto(${JSON.stringify(`${target}#section`)});
return { settled, fragmentMs: Date.now() - fragment, url: tab.url(), route: await tab.evaluate("document.getElementById('route').textContent") };`,
				timeoutMs: 30_000,
				session,
			});
			const value = result.returnValue as { settled: number; fragmentMs: number; url: string; route: string };
			expect(value.route).toBe("/contributions");
			expect(value.url).toBe(`${target}#section`);
			expect(value.settled).toBeLessThan(5_000);
			// A same-document navigation resolves on the document that is already there.
			expect(value.fragmentMs).toBeLessThan(2_000);
		} finally {
			await releaseTab(name, { kill: false }).catch(() => undefined);
			if (browser) await releaseBrowser(browser, { kill: true });
			await fixture.stop();
		}
	},
	120_000,
);

it.skipIf(!CHROMIUM_AVAILABLE)(
	"reports the reached URL and readyState when the main document never finishes",
	async () => {
		const fixture = startHangingIframeFixture();
		const session = makeSession();
		const name = `navigation-stalled-${process.pid}`;
		let browser: BrowserHandle | undefined;
		try {
			browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			await acquireTab(name, browser, {
				url: "about:blank",
				timeoutMs: 30_000,
				ownerSessionId: "session-navigation-stalled",
			});
			const result = await runInTab(name, {
				code: `try {
	await tab.goto(${JSON.stringify(fixture.stalledDocument)});
	return "resolved";
} catch (error) {
	return String(error && error.message ? error.message : error);
}`,
				timeoutMs: 8_000,
				session,
			});
			const message = String(result.returnValue);
			expect(message).toContain(`current URL: ${fixture.stalledDocument}`);
			expect(message).toContain("readyState: loading");
			expect(message).toContain("pending navigation stopped");
			// The old hint sent the model back for a second 29 s timeout.
			expect(message).not.toContain("waitUntil");
		} finally {
			await releaseTab(name, { kill: false }).catch(() => undefined);
			if (browser) await releaseBrowser(browser, { kill: true });
			await fixture.stop();
		}
	},
	120_000,
);

it.skipIf(!CHROMIUM_AVAILABLE)(
	"navigates a page whose session stopped receiving lifecycle events",
	async () => {
		// The state a relay idle detach leaves behind before the replay lands:
		// `Page.setLifecycleEventsEnabled` is gone, so puppeteer's own lifecycle
		// watcher never completes for any `waitUntil`.
		const fixture = startHangingIframeFixture();
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 20_000,
		});
		try {
			const page = await browser.newPage();
			// `_client()` is puppeteer's own session for this page — the one whose
			// lifecycle events the relay's idle detach drops. No public accessor exists.
			const internals = page as unknown as { _client(): CDPSession };
			const client = internals._client();
			await client.send("Page.setLifecycleEventsEnabled", { enabled: false });
			const target = fixture.route("/static");
			await expect(page.goto(target, { waitUntil: "load", timeout: 2_000 })).rejects.toThrow("Navigation timeout");
			await navigateMainFrame(page, fixture.route("/after-detach"), {
				label: "tab.goto()",
				timeoutMs: 10_000,
			});
			expect(page.url()).toBe(fixture.route("/after-detach"));
		} finally {
			await browser.close();
			await fixture.stop();
		}
	},
	120_000,
);

/** Puppeteer `Page` stub with the navigation-watch surface the restore path uses. */
function fakePage(overrides: { emulateFocusedPage: (enabled: boolean) => Promise<void> }): {
	page: Page;
	emit(event: string, arg: unknown): void;
} {
	const listeners = new Map<string, Set<(arg: unknown) => void>>();
	const page = {
		isClosed: () => false,
		on: (event: string, handler: (arg: unknown) => void) => {
			const set = listeners.get(event) ?? new Set();
			set.add(handler);
			listeners.set(event, set);
		},
		off: (event: string, handler: (arg: unknown) => void) => {
			listeners.get(event)?.delete(handler);
		},
		...overrides,
	} as unknown as Page;
	return {
		page,
		emit: (event, arg) => {
			for (const handler of listeners.get(event) ?? []) handler(arg);
		},
	};
}

it(
	"keeps a background handle usable when focus restore stalls in a navigation",
	async () => {
		let restores = 0;
		const stalled = Promise.withResolvers<void>();
		const { page, emit } = fakePage({
			emulateFocusedPage: async (enabled: boolean) => {
				if (enabled) return;
				restores++;
				// The click navigated the page: Chrome answers the first restore never.
				if (restores === 1) await stalled.promise;
			},
		});
		const scope = prepareBackgroundPage(page);
		await scope.ready;
		const closing = scope.close();
		emit("framenavigated", { parentFrame: () => null, url: () => "https://example.com/signed-in" });
		await closing;
		// Restored once the navigation committed, and nothing was poisoned.
		expect(restores).toBe(2);
		const next = prepareBackgroundPage(page);
		await next.ready;
		await next.close();
		expect(restores).toBe(3);
		stalled.resolve();
	},
	15_000,
);

it(
	"tells the caller to observe again, never to release the handle, on a genuine restore failure",
	async () => {
		const { page } = fakePage({
			emulateFocusedPage: async (enabled: boolean) => {
				if (!enabled) throw new Error("connection lost");
			},
		});
		const failed = await withBackgroundInput(page, undefined, async () => undefined).catch((error: unknown) =>
			String(error),
		);
		expect(failed).toContain("The page navigated or is busy; observe again");
		expect(failed).not.toContain("release this handle");
	},
	15_000,
);

type ExtRpc<Op extends RelayRpcRequest["op"]> = { t: "rpc"; id: number } & Extract<RelayRpcRequest, { op: Op }>;

class FakeExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	readonly #acked = new Set<number>();
	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}
	close(): void {}
	pending<Op extends RelayRpcRequest["op"]>(op: Op): Array<ExtRpc<Op>> {
		return this.messages.filter(
			(msg): msg is ExtRpc<Op> => msg.t === "rpc" && msg.op === op && !this.#acked.has(msg.id),
		);
	}
	ack(bridge: RelayBridge, op: RelayRpcRequest["op"], result: unknown = {}): void {
		for (const rpc of this.pending(op)) {
			this.#acked.add(rpc.id);
			bridge.extMessage(this, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: true, result }));
		}
	}
}

class FakeCdpSocket implements RelaySocket {
	readonly messages: Array<Record<string, unknown>> = [];
	send(text: string): void {
		this.messages.push(JSON.parse(text) as Record<string, unknown>);
	}
	close(): void {}
	sessionFor(commandId: number): string | undefined {
		const msg = this.messages.find(m => m.id === commandId);
		const result = msg && typeof msg.result === "object" ? (msg.result as Record<string, unknown>) : undefined;
		return typeof result?.sessionId === "string" ? result.sessionId : undefined;
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 16; i++) await Promise.resolve();
}

interface SentCommand {
	method: string;
	params?: Record<string, unknown>;
}

interface LeasedPage {
	bridge: RelayBridge;
	ext: FakeExtSocket;
	cdp: FakeCdpSocket;
	connection: number;
	/** The page session a worker's puppeteer connection would hold. */
	sessionId: string;
	/** Attach a second page session to the same tab, as `page.createCDPSession()` does. */
	attachSession(): Promise<string>;
	nextId(): number;
}

/** A claimed tab with an attached debugger and one downstream page session. */
async function leasedPage(): Promise<LeasedPage> {
	const bridge = new RelayBridge();
	const ext = new FakeExtSocket();
	bridge.extConnected(ext);
	bridge.extMessage(
		ext,
		JSON.stringify({
			t: "hello",
			userAgent: "test",
			browserVersion: "Chrome/151.0.0.0",
			attachedTabIds: [],
			tabs: [
				{
					tabId: 1,
					url: "https://example.com/",
					title: "Example",
					active: false,
					windowId: 1,
					pinned: false,
					groupId: -1,
				},
			],
		}),
	);
	const lease = bridge.managed.claim(bridge.managed.discover()[0]!.id, "owner");
	const cdp = new FakeCdpSocket();
	const connection = bridge.cdpConnected(cdp, lease.id);
	let seq = 100;
	const attachSession = async (): Promise<string> => {
		const attachId = ++seq;
		bridge.cdpMessage(
			connection,
			JSON.stringify({
				id: attachId,
				method: "Target.attachToTarget",
				params: { targetId: "PAGE1", flatten: true },
			}),
		);
		ext.ack(bridge, "attach");
		await flush();
		const sessionId = cdp.sessionFor(attachId);
		if (!sessionId) throw new Error("attachToTarget did not produce a page session");
		return sessionId;
	};
	return { bridge, ext, cdp, connection, sessionId: await attachSession(), attachSession, nextId: () => ++seq };
}

/**
 * Send `commands` on a leased tab's page session, force the idle detach, then poke the
 * tab again and return the commands the bridge replayed on reattach.
 */
async function replayedAfterDetach(commands: SentCommand[]): Promise<SentCommand[]> {
	const { bridge, ext, connection, sessionId, nextId } = await leasedPage();
	for (const command of commands) {
		bridge.cdpMessage(connection, JSON.stringify({ id: nextId(), sessionId, ...command }));
		await flush();
		ext.ack(bridge, "send");
		await flush();
	}
	const detached = bridge.detachDebuggers({ owner: "owner" });
	await flush();
	ext.ack(bridge, "detachAll", { detached: [1] });
	await detached;
	bridge.cdpMessage(connection, JSON.stringify({ id: nextId(), sessionId, method: "Page.captureScreenshot" }));
	await flush();
	ext.ack(bridge, "attach");
	await flush();
	const replayed = ext.pending("send").map(request => ({ method: request.method, params: request.params }));
	bridge.cdpClosed(connection);
	return replayed;
}

it("lets a second page session on a leased tab navigate the tab", async () => {
	// `goto` drives `Page.navigate` on its own `page.createCDPSession()` session, so the
	// relay has to forward it from a session other than the worker's primary one.
	const { bridge, ext, cdp, connection, attachSession, nextId } = await leasedPage();
	const sessionId = await attachSession();
	const navigateId = nextId();
	bridge.cdpMessage(
		connection,
		JSON.stringify({
			id: navigateId,
			sessionId,
			method: "Page.navigate",
			params: { url: "https://example.com/next" },
		}),
	);
	await flush();
	expect(ext.pending("send").map(request => request.method)).toEqual(["Page.navigate"]);
	ext.ack(bridge, "send", { frameId: "FRAME1", loaderId: "LOADER2" });
	await flush();
	expect(cdp.messages.find(message => message.id === navigateId)).toHaveProperty("result.loaderId", "LOADER2");
	bridge.cdpClosed(connection);
});

it("replays the lifecycle-event switch after the idle detach", async () => {
	const replayed = await replayedAfterDetach([
		{ method: "Page.enable" },
		{ method: "Page.setLifecycleEventsEnabled", params: { enabled: true } },
	]);
	expect(replayed).toContainEqual({ method: "Page.setLifecycleEventsEnabled", params: { enabled: true } });
	// Order still puts the domain enable before the switch that needs it.
	const methods = replayed.map(request => request.method);
	expect(methods.indexOf("Page.enable")).toBeLessThan(methods.indexOf("Page.setLifecycleEventsEnabled"));
});

it.skipIf(!CHROMIUM_AVAILABLE)(
	"replays every init switch a real puppeteer attach sends",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 10_000,
		});
		const sent: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
		try {
			const socket = new WebSocket(browser.wsEndpoint());
			const opened = Promise.withResolvers<void>();
			socket.addEventListener("open", () => opened.resolve());
			await opened.promise;
			const transport: ConnectionTransport = {
				send: message => {
					sent.push(JSON.parse(message) as { method: string });
					socket.send(message);
				},
				close: () => socket.close(),
			};
			socket.addEventListener("message", event => transport.onmessage?.(String(event.data)));
			socket.addEventListener("close", () => transport.onclose?.());
			const client = await puppeteer.connect({ transport, protocolTimeout: 10_000 });
			const page = await client.newPage();
			await page.goto("about:blank");
			await page.close();
			client.disconnect();
		} finally {
			await browser.close();
		}
		// Session-scoped switches are exactly the root-session state the relay's idle
		// detach throws away, so every one of them has to come back on reattach.
		const switches = new Map<string, Record<string, unknown> | undefined>();
		for (const message of sent) {
			if (!message.sessionId || !/^\w+\.set\w*Enabled$/.test(message.method)) continue;
			switches.set(message.method, message.params);
		}
		expect([...switches.keys()]).toContain("Page.setLifecycleEventsEnabled");
		const replayed = await replayedAfterDetach([
			{ method: "Page.enable" },
			...[...switches].map(([method, params]) => ({ method, params })),
		]);
		for (const [method, params] of switches) expect(replayed).toContainEqual({ method, params });
	},
	120_000,
);
