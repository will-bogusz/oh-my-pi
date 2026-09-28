import { expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { runBrowserRelayCommand } from "@oh-my-pi/pi-coding-agent/cli/browser-relay-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import {
	browserActorId,
	releaseChromeTabsForOwner,
	requireChromeHandle,
} from "@oh-my-pi/pi-coding-agent/tools/browser/managed-chrome";
import * as relayAccess from "@oh-my-pi/pi-coding-agent/tools/browser/relay/access";
import * as daemon from "@oh-my-pi/pi-coding-agent/tools/browser/relay/daemon";
import type { InstanceTab } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/instances";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { clickNode } from "@oh-my-pi/pi-coding-agent/tools/browser/cdp";
import { withBackgroundInput } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { ElementHandle, Page } from "puppeteer-core";
import puppeteer, { type Browser } from "puppeteer-core";
import type { InitialBrowserState } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";

// Keep stock timer/occlusion scheduling and popup blocking in real-extension qualification.
const stockBackgroundPolicy = [
	"--disable-background-timer-throttling",
	"--disable-backgrounding-occluded-windows",
	"--disable-renderer-backgrounding",
	"--disable-popup-blocking",
];

/** Trusted click on a handle's node, on the session that owns it. */
async function clickHandle(page: Page, handle: ElementHandle, timeoutMs: number): Promise<void> {
	const session = page.mainFrame().client;
	const { node } = (await session.send("DOM.describeNode", { objectId: handle.id! })) as {
		node: { backendNodeId: number };
	};
	const signal = AbortSignal.timeout(timeoutMs);
	await withBackgroundInput(page, signal, () =>
		clickNode({ session, backendNodeId: node.backendNodeId, label: "link" }, 1, signal),
	);
}

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"leases a tab the browser opens from an owned tab, through the real extension",
	async () => {
		const fixture = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				const route = new URL(request.url).pathname;
				// Chrome's PDF viewer keeps a favicon it is given, so the badge must
				// never reach it; a real PDF is the only way to prove that.
				if (route === "/doc.pdf")
					return new Response(
						"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>",
						{ headers: { "content-type": "application/pdf" } },
					);
				return new Response(
					route === "/details"
						? "<title>Workshop details</title><p>45 minutes, 8 places</p>"
						: '<title>Popup parent</title><a href="/details" target="_blank">Open details</a>',
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		const root = await mkdtemp(path.join(tmpdir(), "omp-real-extension-"));
		const relay = startRelayServer({ port: 0 });
		const extension = path.join(root, "extension");
		const clients: Browser[] = [];
		const setups: Browser[] = [];
		try {
			await runBrowserRelayCommand({ action: "install", dir: extension, port: relay.port });
			const installedBuild = (await Bun.file(path.join(extension, "build-info.json")).json()) as { buildId: string };
			const launchProfile = async (label: string): Promise<string> => {
				const setup = await puppeteer.launch({
					executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
					headless: true,
					pipe: true,
					enableExtensions: true,
					ignoreDefaultArgs: stockBackgroundPolicy,
					userDataDir: path.join(root, label),
					defaultViewport: null,
				});
				setups.push(setup);
				for (const flag of stockBackgroundPolicy) expect(setup.process()?.spawnargs).not.toContain(flag);
				const extensionId = await setup.installExtension(extension);
				const options = await setup.newPage();
				await options.goto(`chrome-extension://${extensionId}/options.html`);
				await options.type("#label", label);
				await options.type("#code", relay.access.issueCode().code);
				expect(await options.$eval("#port", element => (element as unknown as { value: string }).value)).toBe(
					String(relay.port),
				);
				await options.click("#save");
				for (
					let i = 0;
					i < 200 && !relay.instances.list().some(browser => browser.connected && browser.label === label);
					i++
				)
					await Bun.sleep(25);
				expect(relay.instances.list().some(browser => browser.connected && browser.label === label)).toBe(true);
				expect(relay.instances.list().find(browser => browser.label === label)?.extension).toEqual({
					loadedBuildId: installedBuild.buildId,
					expectedBuildId: installedBuild.buildId,
					status: "matching",
				});
				await options.close();
				const instanceId = relay.instances.list().find(instance => instance.label === label)!.id;
				const refreshed = await relay.instances.refresh(undefined, instanceId);
				expect(refreshed.filter(tab => tab.active)).toHaveLength(1);
				expect(refreshed.every(tab => !tab.url.startsWith("chrome-extension:"))).toBe(true);
				// This is the actual browser-level SETUP connection, not a newly created
				// session's own auto-attach configuration. PipeTransport.close leaves the
				// underlying streams alive, so disconnect alone does not disarm Chrome.
				const setupSession = await setup.target().createCDPSession();
				const connection = setupSession.connection();
				if (!connection) throw new Error("Missing setup connection");
				await connection.send("Target.setAutoAttach", {
					autoAttach: false,
					waitForDebuggerOnStart: false,
					flatten: true,
				});
				await setupSession.detach();
				await setup.disconnect();
				return relay.instances.list().find(browser => browser.label === label)!.id;
			};
			const firstId = await launchProfile("Work Chrome");
			const parent = await relay.instances.create(fixture.url.toString(), "actor", "Workshop");
			const connect = async (leaseId: string): Promise<Browser> => {
				const info = (await (
					await fetch(`http://127.0.0.1:${relay.port}/managed/${leaseId}/json/version`)
				).json()) as { webSocketDebuggerUrl: string };
				const browser = await puppeteer.connect({
					browserWSEndpoint: info.webSocketDebuggerUrl,
					defaultViewport: null,
					protocolTimeout: 3000,
				});
				clients.push(browser);
				return browser;
			};
			const browser = await connect(parent.id);
			const page = await browser
				.targets()
				.find(target => target.type() === "page")
				?.page();
			if (!page) throw new Error("Missing parent page");
			// No page-script interception: Chrome opens the child itself, the
			// extension reports its opener, and the relay leases the child to the
			// opener's owner in the opener's group.
			const link = await page.waitForSelector("a");
			if (!link) throw new Error("Missing popup link");
			const visibleBefore = (await relay.instances.refresh("actor")).filter(candidate => candidate.active);
			expect(visibleBefore).toHaveLength(1);
			await clickHandle(page, link, 5000);
			const parentTab = relay.instances.get(parent.id, "actor").tab;
			// The child appears, is adopted and is grouped over several Chrome
			// round trips; wait for the settled state rather than the first sight.
			let opened: InstanceTab | undefined;
			for (let attempt = 0; attempt < 200; attempt++) {
				await Bun.sleep(25);
				opened = (await relay.instances.refresh("actor")).find(
					candidate => candidate.tabId !== parentTab.tabId && candidate.url.endsWith("/details"),
				);
				if (opened?.ownership === "this_actor" && opened.groupId === parentTab.groupId) break;
			}
			// Chrome opens the child itself, active, and blames its own active tab
			// for the synthesized click. The relay still recognises the opener, so
			// the child is leased and grouped with it before anyone claims it…
			expect(opened).toMatchObject({
				groupId: parentTab.groupId,
				ownership: "this_actor",
				popupOf: parentTab.id,
			});
			// …and Chrome's own selection stands: the child it raised and selected
			// stays the visible tab, which is what a new tab is supposed to look
			// like. Nothing selects the tab the child displaced.
			for (let attempt = 0; attempt < 200; attempt++) {
				const active = (await relay.instances.refresh("actor")).filter(candidate => candidate.active);
				if (active.length === 1 && active[0]!.tabId === opened!.tabId) break;
				await Bun.sleep(25);
			}
			expect((await relay.instances.refresh("actor")).filter(candidate => candidate.active)).toMatchObject([
				{ tabId: opened!.tabId },
			]);
			// The click also placed the in-page arrow, in a closed shadow root the
			// page cannot read, on the tab OMP drove.
			for (let attempt = 0; attempt < 40; attempt++) {
				if (await page.evaluate("!!document.querySelector('[data-omp-cursor]')")) break;
				await Bun.sleep(25);
			}
			expect(await page.evaluate("document.querySelector('[data-omp-cursor]')?.shadowRoot ?? 'closed'")).toBe(
				"closed",
			);
			const child = relay.instances.claim(opened!.id, "actor");
			const childBrowser = await connect(child.id);
			const childPage = await childBrowser
				.targets()
				.find(target => target.type() === "page")
				?.page();
			if (!childPage) throw new Error("Missing child page");
			await childPage.waitForSelector("p");
			expect(await childPage.title()).toBe("Workshop details");
			expect(await childPage.$eval("p", element => element.textContent)).toBe("45 minutes, 8 places");
			expect(relay.instances.get(child.id, "actor").tab).toMatchObject({ groupId: parentTab.groupId });
			const secondId = await launchProfile("Personal Chrome");
			expect(relay.instances.list().filter(instance => instance.connected)).toHaveLength(2);
			await expect(relay.instances.create("about:blank", "actor", "Ambiguous")).rejects.toThrow(
				"Multiple browsers",
			);
			const second = await relay.instances.create(
				fixture.url.toString(),
				"actor",
				"Personal task",
				secondId,
			);
			expect(second.browserId).toBe(secondId);
			expect(relay.instances.get(parent.id, "actor").browserId).toBe(firstId);
			expect(relay.instances.discover("actor", firstId).every(tab => tab.browserId === firstId)).toBe(true);
			const secondBrowser = await connect(second.id);
			const secondPage = await secondBrowser
				.targets()
				.find(target => target.type() === "page")
				?.page();
			if (!secondPage) throw new Error("Missing second profile page");
			await secondPage.waitForSelector("a");
			expect(await secondPage.title()).toBe("Popup parent");
			relay.instances.unpair(secondId);
			expect(relay.instances.forLease(second.id)).toBeUndefined();
			expect(relay.instances.get(parent.id, "actor").browserId).toBe(firstId);
			expect(await childPage.title()).toBe("Workshop details");
			// A PDF is driven like any page but never badged: Chrome's viewer takes
			// the glyph and then keeps it, so the tab would look driven forever.
			const pdf = await relay.instances.create(`${fixture.url}doc.pdf`, "actor", "Reading");
			const pdfBrowser = await connect(pdf.id);
			const pdfPage = await pdfBrowser
				.targets()
				.find(target => target.type() === "page")
				?.page();
			if (!pdfPage) throw new Error("Missing PDF page");
			// A freshly leased target has no frame tree for a beat, and the PDF
			// viewer swaps documents once more on top of that: poll through both.
			let contentType: unknown;
			for (let attempt = 0; attempt < 100; attempt++) {
				contentType = await pdfPage.evaluate("document.contentType").catch(() => undefined);
				if (contentType === "application/pdf") break;
				await Bun.sleep(50);
			}
			expect(contentType).toBe("application/pdf");
			expect(await pdfPage.evaluate("document.querySelectorAll('link[data-omp-badge]').length")).toBe(0);
		} finally {
			for (const client of clients) await client.disconnect();
			for (const setup of setups) {
				await setup.disconnect();
				setup.process()?.kill("SIGTERM");
			}
			relay.stop();
			fixture.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	20_000,
);

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"does not dial an older broker's extension socket during setup",
	async () => {
		let healthChecks = 0;
		let extensionDials = 0;
		const older = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				const route = new URL(request.url).pathname;
				if (route === "/health") healthChecks++;
				if (route === "/ext") extensionDials++;
				return new Response("Older service", { status: 404 });
			},
		});
		const root = await mkdtemp(path.join(tmpdir(), "omp-extension-upgrade-"));
		let browser: Browser | undefined;
		try {
			const extension = path.join(root, "extension");
			if (!older.port) throw new Error("Older endpoint did not bind a port");
			await runBrowserRelayCommand({ action: "install", dir: extension, port: older.port });
			browser = await puppeteer.launch({
				executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
				headless: true,
				pipe: true,
				enableExtensions: true,
				ignoreDefaultArgs: stockBackgroundPolicy,
				userDataDir: path.join(root, "profile"),
				defaultViewport: null,
			});
			for (const flag of stockBackgroundPolicy) expect(browser.process()?.spawnargs).not.toContain(flag);
			const extensionId = await browser.installExtension(extension);
			for (let index = 0; index < 100 && !healthChecks; index++) await Bun.sleep(25);
			expect(healthChecks).toBeGreaterThan(0);
			const options = await browser.newPage();
			await options.goto(`chrome-extension://${extensionId}/options.html`);
			await options.waitForFunction(
				`document.querySelector('#status').textContent.includes('older browser service')`,
			);
			expect(extensionDials).toBe(0);
		} finally {
			await browser?.close();
			older.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	10_000,
);

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"gives Chrome its debugger back on host request and on relay loss, then reattaches lazily",
	async () => {
		const fixture = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response("<title>Detach fixture</title><p>page</p>", { headers: { "content-type": "text/html" } }),
		});
		const root = await mkdtemp(path.join(tmpdir(), "omp-detach-"));
		let relay = startRelayServer({ port: 0 });
		const port = relay.port;
		const access = relay.access;
		let setup: Browser | undefined;
		let client: Browser | undefined;
		const connected = async (server: typeof relay): Promise<string> => {
			for (let i = 0; i < 400 && !server.instances.list().some(browser => browser.connected); i++)
				await Bun.sleep(25);
			const instance = server.instances.list().find(browser => browser.connected);
			if (!instance) throw new Error("extension never reached the relay");
			return instance.id;
		};
		try {
			const extension = path.join(root, "extension");
			await runBrowserRelayCommand({ action: "install", dir: extension, port });
			setup = await puppeteer.launch({
				executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
				headless: true,
				pipe: true,
				enableExtensions: true,
				ignoreDefaultArgs: stockBackgroundPolicy,
				userDataDir: path.join(root, "profile"),
				defaultViewport: null,
			});
			const extensionId = await setup.installExtension(extension);
			const options = await setup.newPage();
			await options.goto(`chrome-extension://${extensionId}/options.html`);
			await options.type("#label", "Detach fixture");
			await options.type("#code", access.issueCode().code);
			await options.click("#save");
			const browserId = await connected(relay);
			await options.close();
			// Disarm the launch pipe's auto-attach, as the setup connection is not
			// a driver: otherwise it owns every new target's debugger.
			const setupSession = await setup.target().createCDPSession();
			const connection = setupSession.connection();
			if (!connection) throw new Error("Missing setup connection");
			await connection.send("Target.setAutoAttach", {
				autoAttach: false,
				waitForDebuggerOnStart: false,
				flatten: true,
			});
			await setupSession.detach();
			await setup.disconnect();

			const lease = await relay.instances.create(fixture.url.toString(), "actor", "Detach task");
			const version = (await (await fetch(`http://127.0.0.1:${port}/managed/${lease.id}/json/version`)).json()) as {
				webSocketDebuggerUrl: string;
			};
			client = await puppeteer.connect({
				browserWSEndpoint: version.webSocketDebuggerUrl,
				defaultViewport: null,
				protocolTimeout: 8000,
			});
			const page = await client
				.targets()
				.find(target => target.type() === "page")
				?.page();
			if (!page) throw new Error("Missing leased page");
			await page.waitForSelector("p");
			expect(await page.title()).toBe("Detach fixture");

			// Losing the relay must cost the attachment too: the extension hands
			// the tabs back itself when the socket stays down past its grace.
			await page.evaluate("1");
			relay.stop();
			await Bun.sleep(3000);
			// Marking off in the revived relay: claiming the orphan below must read
			// the strip the dead relay left, not a mark this one just added.
			relay = startRelayServer({ port, access, group: false });
			await connected(relay);
			// The dead relay's leases can never be released, so the extension gave
			// the tabs back itself: out of the group, with their own favicon.
			const orphan = (await relay.instances.refresh()).find(candidate => candidate.tabId === lease.tab.tabId);
			expect(orphan).toMatchObject({ groupId: -1, ownership: "available" });
			const reclaimed = relay.instances.claim(orphan!.id, "actor");
			const reclaimedVersion = (await (
				await fetch(`http://127.0.0.1:${port}/managed/${reclaimed.id}/json/version`)
			).json()) as { webSocketDebuggerUrl: string };
			const reclaimedClient = await puppeteer.connect({
				browserWSEndpoint: reclaimedVersion.webSocketDebuggerUrl,
				defaultViewport: null,
				protocolTimeout: 8000,
			});
			try {
				const reclaimedPage = await reclaimedClient
					.targets()
					.find(target => target.type() === "page")
					?.page();
				if (!reclaimedPage) throw new Error("Missing reclaimed page");
				expect(await reclaimedPage.evaluate("document.querySelectorAll('link[data-omp-badge]').length")).toBe(0);
			} finally {
				await reclaimedClient.disconnect();
			}
			// Ownership was reset with the socket; a new lease still drives fine.
			const revived = await relay.instances.create(fixture.url.toString(), "actor", "Revived");
			const revivedVersion = (await (
				await fetch(`http://127.0.0.1:${port}/managed/${revived.id}/json/version`)
			).json()) as { webSocketDebuggerUrl: string };
			const revivedClient = await puppeteer.connect({
				browserWSEndpoint: revivedVersion.webSocketDebuggerUrl,
				defaultViewport: null,
				protocolTimeout: 8000,
			});
			try {
				const revivedPage = await revivedClient
					.targets()
					.find(target => target.type() === "page")
					?.page();
				if (!revivedPage) throw new Error("Missing revived page");
				await revivedPage.waitForSelector("p");
				expect(await revivedPage.title()).toBe("Detach fixture");
			} finally {
				await revivedClient.disconnect();
			}
		} finally {
			await client?.disconnect().catch(() => {});
			setup?.process()?.kill("SIGTERM");
			relay.stop();
			fixture.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	60_000,
);

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"gives Chrome its debugger back ten seconds after the last step and picks it up again on the next one",
	async () => {
		const fixture = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response('<title>Idle fixture</title><p id="p">page</p><a id="lnk" href="/">link</a>', {
					headers: { "content-type": "text/html" },
				}),
		});
		const root = await mkdtemp(path.join(tmpdir(), "omp-idle-detach-"));
		const started = Date.now();
		const events: { at: number; message: string }[] = [];
		const relay = startRelayServer({ port: 0, log: message => events.push({ at: Date.now() - started, message }) });
		let setup: Browser | undefined;
		let client: Browser | undefined;
		try {
			const extension = path.join(root, "extension");
			await runBrowserRelayCommand({ action: "install", dir: extension, port: relay.port });
			setup = await puppeteer.launch({
				executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
				headless: true,
				pipe: true,
				enableExtensions: true,
				ignoreDefaultArgs: stockBackgroundPolicy,
				userDataDir: path.join(root, "profile"),
				defaultViewport: null,
			});
			const extensionId = await setup.installExtension(extension);
			const options = await setup.newPage();
			await options.goto(`chrome-extension://${extensionId}/options.html`);
			await options.type("#label", "Idle fixture");
			await options.type("#code", relay.access.issueCode().code);
			await options.click("#save");
			for (let i = 0; i < 400 && !relay.instances.list().some(browser => browser.connected); i++)
				await Bun.sleep(25);
			const browserId = relay.instances.list().find(browser => browser.connected)?.id;
			if (!browserId) throw new Error("extension never reached the relay");
			await options.close();
			// The launch pipe is not a driver: disarm its auto-attach.
			const setupSession = await setup.target().createCDPSession();
			await setupSession
				.connection()
				?.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
			await setupSession.detach();
			await setup.disconnect();

			const lease = await relay.instances.create(fixture.url.toString(), "actor", "Idle task");
			const version = (await (
				await fetch(`http://127.0.0.1:${relay.port}/managed/${lease.id}/json/version`)
			).json()) as { webSocketDebuggerUrl: string };
			client = await puppeteer.connect({
				browserWSEndpoint: version.webSocketDebuggerUrl,
				defaultViewport: null,
				protocolTimeout: 15_000,
			});
			const page = await client
				.targets()
				.find(target => target.type() === "page")
				?.page();
			if (!page) throw new Error("Missing leased page");
			const handleBeforeIdle = await page.waitForSelector("#p");
			expect(await page.$eval("#p", element => element.textContent)).toBe("page");
			const lastStep = Date.now() - started;
			// Nobody drives the tab. The infobar's lifetime is this window, and
			// the real timer is the thing under test, so this waits it out.
			for (let i = 0; i < 600 && !events.some(event => event.message === "idle detach"); i++) await Bun.sleep(25);
			const detach = events.find(event => event.message === "idle detach");
			expect(detach).toBeDefined();
			expect(detach!.at - lastStep).toBeGreaterThan(8_000);
			expect(detach!.at - lastStep).toBeLessThan(14_000);
			expect(relay.instances.get(lease.id, "actor").tab.tabId).toBe(lease.tab.tabId);
			// The next step reattaches under the driver, which never saw a target go
			// away. The evaluate goes first: its reply cannot overtake the
			// context-cleared frame on the same socket, so by the time it resolves
			// the driver has dropped the handles it minted before the detach and the
			// query below has to re-acquire them.
			expect(await page.evaluate("document.title")).toBe("Idle fixture");
			expect(await page.$eval("#p", element => element.textContent)).toBe("page");
			const link = await page.waitForSelector("#lnk");
			if (!link) throw new Error("Missing link");
			await clickHandle(page, link, 8000);
			expect(events.filter(event => event.message === "debugger attached").length).toBeGreaterThanOrEqual(2);
			// A handle minted before the detach is the one casualty: its object id
			// died with the attachment, which is why the detach announces the loss.
			await expect(handleBeforeIdle!.evaluate(element => element.textContent)).rejects.toThrow();
		} finally {
			await client?.disconnect().catch(() => {});
			setup?.process()?.kill("SIGTERM");
			relay.stop();
			fixture.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	90_000,
);

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"keeps a handle through a password manager's frame: one reattach per call, a refusal that names the frame, then resumes",
	async () => {
		let menu = "open";
		const dismissed = Promise.withResolvers<void>();
		const fixture = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				const route = new URL(request.url).pathname;
				if (route === "/menu") return new Response(menu);
				if (route === "/menu-removed") dismissed.resolve();
				if (route === "/signed-in")
					return new Response("<title>Signed in</title><p>done</p>", { headers: { "content-type": "text/html" } });
				return new Response('<title>Sign in</title><form><input type="password"></form>', {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const root = await mkdtemp(path.join(tmpdir(), "omp-password-manager-"));
		const events: string[] = [];
		const relay = startRelayServer({ port: 0, log: message => events.push(message) });
		const token = spyOn(relayAccess, "readRelayControlToken").mockReturnValue(relay.access.controlToken);
		const daemonReady = spyOn(daemon, "ensureRelayDaemon").mockResolvedValue({ service: "omp-browser", protocol: 2 });
		const session: ToolSession = {
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => "password-manager",
			getAgentId: () => "agent",
			settings: Settings.isolated({
				"browser.enabled": true,
				"browser.relay": true,
				"browser.relayUrl": `http://127.0.0.1:${relay.port}`,
			}),
		};
		let setup: Browser | undefined;
		try {
			const extension = path.join(root, "extension");
			await runBrowserRelayCommand({ action: "install", dir: extension, port: relay.port });
			// An inline autofill menu is another extension's page in an iframe, and
			// Chrome detaches every other extension's debugger when one commits.
			// A flash is gone once it has loaded; a pinned menu stays until the user
			// dismisses it or signs in, which navigates the page, and replaces its
			// frame whenever OMP's extension empties it, so the refusal stays reachable.
			const passwordManager = path.join(root, "password-manager");
			await mkdir(passwordManager);
			await writeFile(
				path.join(passwordManager, "manifest.json"),
				JSON.stringify({
					manifest_version: 3,
					name: "Fake password manager",
					version: "1.0",
					content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_idle" }],
					web_accessible_resources: [{ resources: ["menu.html"], matches: ["http://127.0.0.1/*"] }],
				}),
			);
			await writeFile(path.join(passwordManager, "menu.html"), "<p>Fill password</p>");
			await writeFile(
				path.join(passwordManager, "content.js"),
				`const show = pinned => {
					const open = () => {
						const next = document.createElement("iframe");
						next.src = chrome.runtime.getURL("menu.html");
						document.body.append(next);
						return next;
					};
					let frame = open();
					if (!pinned) return frame.addEventListener("load", () => frame.remove(), { once: true });
					const replace = new MutationObserver(() => {
						if (!frame.hasAttribute("srcdoc")) return;
						frame.remove();
						frame = open();
						replace.observe(frame, { attributeFilter: ["srcdoc"] });
					});
					replace.observe(frame, { attributeFilter: ["srcdoc"] });
					const poll = setInterval(async () => {
						const state = await (await fetch("/menu")).text();
						if (state === "open") return;
						clearInterval(poll);
						replace.disconnect();
						if (state === "signed-in") return location.assign("/signed-in");
						frame.remove();
						await fetch("/menu-removed");
					}, 50);
				};
				document.addEventListener("pm-flash", () => show(false));
				document.addEventListener("pm-pin", () => show(true));`,
			);
			setup = await puppeteer.launch({
				executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
				headless: true,
				pipe: true,
				enableExtensions: true,
				ignoreDefaultArgs: stockBackgroundPolicy,
				userDataDir: path.join(root, "profile"),
				defaultViewport: null,
			});
			const extensionId = await setup.installExtension(extension);
			await setup.installExtension(passwordManager);
			const options = await setup.newPage();
			await options.goto(`chrome-extension://${extensionId}/options.html`);
			await options.type("#label", "Password manager fixture");
			await options.type("#code", relay.access.issueCode().code);
			await options.click("#save");
			for (let i = 0; i < 400 && !relay.instances.list().some(browser => browser.connected); i++)
				await Bun.sleep(25);
			await options.close();
			// The launch pipe is not a driver: disarm its auto-attach.
			const setupSession = await setup.target().createCDPSession();
			await setupSession
				.connection()
				?.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
			await setupSession.detach();
			await setup.disconnect();

			const prelude = createBrowserPrelude(session);
			const context = { session, toolCallId: "password-manager" };
			const detail = (result: AgentToolResult<unknown>, key: string): unknown =>
				result.details && typeof result.details === "object" && key in result.details
					? Reflect.get(result.details, key)
					: undefined;
			const text = (result: AgentToolResult<unknown>) =>
				result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
			const handle = detail(
				await prelude.invoke({ action: "create", url: fixture.url.toString(), timeout: 20 }, context),
				"handle",
			);
			if (typeof handle !== "string") throw new Error("create returned no handle");
			const leaseId = requireChromeHandle(handle, session).lease.id;
			const run = (code: string) => prelude.invoke({ action: "run", handle, code, timeout: 20 }, context);
			// The step in flight when the menu appears: half a second in the page keeps
			// the command open when Chrome detaches. It shows the menu once per `key`,
			// so running it again shows nothing and returns the title.
			const showMenu = (event: string, key = event) =>
				`return await page.evaluate(() => {
					if (!window["${key}"]) {
						window["${key}"] = true;
						document.dispatchEvent(new Event("${event}"));
					}
					return new Promise(resolve => setTimeout(() => resolve(document.title), 500));
				});`;
			const count = (message: string) => events.filter(event => event === message).length;

			// Gone before OMP is back: the call attaches once more, runs again, and says so.
			const flashed = await run(showMenu("pm-flash"));
			expect(detail(flashed, "value")).toBe("Sign in");
			expect(text(flashed)).toContain("OMP reattached and ran it again");
			expect(count("tab detached")).toBe(1);

			// Still there, and back as soon as it is emptied: exactly one fresh attach, then Chrome's refusal naming the frame.
			const failedAttaches = count("attach failed");
			const refusal = await run(showMenu("pm-pin")).then(
				() => "no refusal",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			expect(refusal).toStartWith(`Chrome revoked OMP's control of "Sign in": another extension`);
			expect(refusal).toContain("has embedded its UI in this page");
			expect(refusal).toContain("the next call on this tab tries again");
			expect(count("attach failed") - failedAttaches).toBe(1);

			// The user dismisses the menu; the next call drives the same handle and lease.
			menu = "closed";
			await dismissed.promise;
			const resumed = await run("return await page.title()");
			expect(detail(resumed, "value")).toBe("Sign in");
			expect(text(resumed)).not.toContain("ran it again");
			expect(requireChromeHandle(handle, session).lease.id).toBe(leaseId);

			// Or the user signs in, which navigates the page and lifts the relay's ban
			// on its own. The page's dialog journal is still the detach's blank one;
			// the next call attaches anyway, with no claim from the model.
			menu = "open";
			expect(await run(showMenu("pm-pin", "pinned again")).then(() => "no refusal", String)).toContain(
				"the next call on this tab tries again",
			);
			menu = "signed-in";
			const owner = browserActorId(session);
			// The extension reports the navigation on its own schedule; wait for the relay to hear it.
			for (let i = 0; i < 400 && !relay.instances.get(leaseId, owner).tab.url.endsWith("/signed-in"); i++)
				await Bun.sleep(25);
			expect(relay.instances.get(leaseId, owner).debugger?.revoked).toBeUndefined();
			const signedIn = await run("return await page.title()");
			expect(detail(signedIn, "value")).toBe("Signed in");
			expect(requireChromeHandle(handle, session).lease.id).toBe(leaseId);
		} finally {
			await releaseChromeTabsForOwner("password-manager").catch(() => 0);
			setup?.process()?.kill("SIGTERM");
			token.mockRestore();
			daemonReady.mockRestore();
			relay.stop();
			fixture.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	90_000,
);

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"observes a created tab's committed page and names it by title and target id from creation through close",
	async () => {
		const fixture = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async () => {
				// A slow first byte keeps the navigation uncommitted when the tab is
				// acquired — the window in which the first observation used to see
				// Chrome's initial empty document. A real server delay is the thing
				// under test, so this cannot be a fake timer.
				await Bun.sleep(800);
				return new Response("<title>Slow fixture</title><h1>Committed</h1>", {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const root = await mkdtemp(path.join(tmpdir(), "omp-create-naming-"));
		const relay = startRelayServer({ port: 0 });
		const token = spyOn(relayAccess, "readRelayControlToken").mockReturnValue(relay.access.controlToken);
		const daemonReady = spyOn(daemon, "ensureRelayDaemon").mockResolvedValue({
			service: "omp-browser",
			protocol: 2,
		});
		const session: ToolSession = {
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => "create-naming",
			getAgentId: () => "agent",
			settings: Settings.isolated({
				"browser.enabled": true,
				"browser.relay": true,
				"browser.relayUrl": `http://127.0.0.1:${relay.port}`,
			}),
		};
		let setup: Browser | undefined;
		try {
			const extension = path.join(root, "extension");
			await runBrowserRelayCommand({ action: "install", dir: extension, port: relay.port });
			setup = await puppeteer.launch({
				executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
				headless: true,
				pipe: true,
				enableExtensions: true,
				ignoreDefaultArgs: stockBackgroundPolicy,
				userDataDir: path.join(root, "profile"),
				defaultViewport: null,
			});
			const extensionId = await setup.installExtension(extension);
			const options = await setup.newPage();
			await options.goto(`chrome-extension://${extensionId}/options.html`);
			await options.type("#label", "Naming fixture");
			await options.type("#code", relay.access.issueCode().code);
			await options.click("#save");
			for (let i = 0; i < 400 && !relay.instances.list().some(browser => browser.connected); i++)
				await Bun.sleep(25);
			await options.close();
			const setupSession = await setup.target().createCDPSession();
			await setupSession
				.connection()
				?.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
			await setupSession.detach();
			await setup.disconnect();

			const prelude = createBrowserPrelude(session);
			const context = { session, toolCallId: "create-naming" };
			const text = (result: AgentToolResult<unknown>) =>
				result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
			const created = await prelude.invoke({ action: "create", url: fixture.url.toString(), timeout: 20 }, context);
			const details = created.details as { handle: string; value: InitialBrowserState };
			const { lease } = requireChromeHandle(details.handle, session);
			// The first observation is of the page asked for, never the empty
			// document Chrome holds until the navigation commits.
			expect(details.value.inspectionError).toBeUndefined();
			expect(details.value.initialObservation?.url).toBe(fixture.url.toString());
			expect(details.value.initialObservation?.title).toBe("Slow fixture");
			// Named by the page, not the tab group's "Oh My Pi", with the identity
			// discover lists and claim takes.
			expect(text(created)).toContain(
				`Created inactive Chrome tab "Slow fixture"\ntab.target.id: ${JSON.stringify(lease.tab.id)}\nURL: ${fixture.url}`,
			);

			await prelude.invoke(
				{
					action: "run",
					handle: details.handle,
					code: 'await page.evaluate(() => { document.title = "Renamed"; });',
				},
				context,
			);
			// The extension reports the title change on its own schedule.
			const owner = browserActorId(session);
			for (let i = 0; i < 400 && relay.instances.get(lease.id, owner).tab.title !== "Renamed"; i++)
				await Bun.sleep(25);
			const closed = await prelude.invoke({ action: "close", handle: details.handle }, context);
			expect(text(closed)).toBe(`close: "Renamed" (tab.target.id ${JSON.stringify(lease.tab.id)})`);
		} finally {
			await releaseChromeTabsForOwner("create-naming").catch(() => 0);
			setup?.process()?.kill("SIGTERM");
			token.mockRestore();
			daemonReady.mockRestore();
			relay.stop();
			fixture.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	90_000,
);

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"reports a leased tab's downloads with state and saved path, only its own",
	async () => {
		const csv = "client_id,secret\n42,s3cr3t\n";
		const slowStarted = Promise.withResolvers<void>();
		const finishSlow = Promise.withResolvers<void>();
		const fixture = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				const route = new URL(request.url).pathname;
				const attachment = (name: string, type: string) => ({
					"content-type": type,
					"content-disposition": `attachment; filename="${name}"`,
				});
				if (route === "/config.csv") return new Response(csv, { headers: attachment("config.csv", "text/csv") });
				if (route === "/other.txt")
					return new Response("other", { headers: attachment("other.txt", "text/plain") });
				if (route === "/slow.bin") {
					// Half now, half once the test has handed the debugger back.
					const body = new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(new Uint8Array(4096).fill(1));
							slowStarted.resolve();
							await finishSlow.promise;
							controller.enqueue(new Uint8Array(4096).fill(2));
							controller.close();
						},
					});
					return new Response(body, {
						headers: { ...attachment("slow.bin", "application/octet-stream"), "content-length": "8192" },
					});
				}
				return new Response(
					`<title>Console</title>
					<a id="csv" href="/config.csv">Download config</a>
					<a id="other" href="/other.txt">Other</a>
					<a id="slow" href="/slow.bin">Slow</a>
					<button id="blob">Download JSON</button>
					<script>
						document.getElementById("blob").onclick = () => {
							const link = document.createElement("a");
							link.href = URL.createObjectURL(new Blob(['{"client_id":42}'], { type: "application/json" }));
							link.download = "client.json";
							link.click();
						};
					</script>`,
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		const root = await mkdtemp(path.join(tmpdir(), "omp-relay-downloads-"));
		const relay = startRelayServer({ port: 0 });
		const token = spyOn(relayAccess, "readRelayControlToken").mockReturnValue(relay.access.controlToken);
		const daemonReady = spyOn(daemon, "ensureRelayDaemon").mockResolvedValue({
			service: "omp-browser",
			protocol: 2,
		});
		const session: ToolSession = {
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => "relay-downloads",
			getAgentId: () => "agent",
			settings: Settings.isolated({
				"browser.enabled": true,
				"browser.relay": true,
				"browser.relayUrl": `http://127.0.0.1:${relay.port}`,
			}),
		};
		let setup: Browser | undefined;
		try {
			const extension = path.join(root, "extension");
			await runBrowserRelayCommand({ action: "install", dir: extension, port: relay.port });
			// The profile's own download folder, as a user sets it; OMP never changes it.
			const saved = path.join(root, "Downloads");
			await mkdir(path.join(root, "profile", "Default"), { recursive: true });
			await mkdir(saved);
			await writeFile(
				path.join(root, "profile", "Default", "Preferences"),
				JSON.stringify({ download: { default_directory: saved, prompt_for_download: false } }),
			);
			setup = await puppeteer.launch({
				executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
				headless: true,
				pipe: true,
				enableExtensions: true,
				ignoreDefaultArgs: stockBackgroundPolicy,
				userDataDir: path.join(root, "profile"),
				defaultViewport: null,
			});
			const extensionId = await setup.installExtension(extension);
			const options = await setup.newPage();
			await options.goto(`chrome-extension://${extensionId}/options.html`);
			await options.type("#label", "Downloads fixture");
			await options.type("#code", relay.access.issueCode().code);
			await options.click("#save");
			for (let i = 0; i < 400 && !relay.instances.list().some(browser => browser.connected); i++)
				await Bun.sleep(25);
			await options.close();
			// The launch pipe is not a driver: disarm its auto-attach.
			const setupSession = await setup.target().createCDPSession();
			await setupSession
				.connection()
				?.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
			await setupSession.detach();
			await setup.disconnect();

			const prelude = createBrowserPrelude(session);
			const context = { session, toolCallId: "relay-downloads" };
			const value = (result: AgentToolResult<unknown>): unknown =>
				result.details && typeof result.details === "object" ? Reflect.get(result.details, "value") : undefined;
			const open = async (): Promise<string> => {
				const created = await prelude.invoke(
					{ action: "create", url: fixture.url.toString(), timeout: 20 },
					context,
				);
				const handle =
					created.details && typeof created.details === "object" && Reflect.get(created.details, "handle");
				if (typeof handle !== "string") throw new Error("create returned no handle");
				return handle;
			};
			const run = async (handle: string, code: string) =>
				value(await prelude.invoke({ action: "run", handle, code, timeout: 20 }, context));
			const main = await open();
			const other = await open();

			// A link download and a script-built blob download, each with the file Chrome saved.
			expect(await run(main, "await page.click('#csv'); return await tab.waitForDownload();")).toEqual({
				suggestedFilename: "config.csv",
				url: `${fixture.url}config.csv`,
				state: "completed",
				bytes: csv.length,
				path: path.join(saved, "config.csv"),
			});
			expect(await Bun.file(path.join(saved, "config.csv")).text()).toBe(csv);
			expect(await run(main, "await page.click('#blob'); return await tab.waitForDownload();")).toMatchObject({
				suggestedFilename: "client.json",
				state: "completed",
				path: path.join(saved, "client.json"),
			});

			// Another leased tab's download is its own.
			expect(await run(other, "await page.click('#other'); return (await tab.waitForDownload()).path;")).toBe(
				path.join(saved, "other.txt"),
			);
			expect(
				((await run(main, "return await tab.downloads();")) as { suggestedFilename: string }[]).map(
					download => download.suggestedFilename,
				),
			).toEqual(["config.csv", "client.json"]);

			// Still in progress, then finished with its path. Chrome reports progress
			// every half second, which is traffic, so the relay's idle detach never
			// takes the debugger from a tab while one of its downloads is running.
			expect(
				await run(
					main,
					`await page.click('#slow');
					for (;;) {
						const slow = (await tab.downloads()).find(download => download.suggestedFilename === "slow.bin");
						if (slow) return slow.state;
						await new Promise(resolve => setTimeout(resolve, 25));
					}`,
				),
			).toBe("inProgress");
			await slowStarted.promise;
			finishSlow.resolve();
			expect(await run(main, "return await tab.waitForDownload();")).toEqual({
				suggestedFilename: "slow.bin",
				url: `${fixture.url}slow.bin`,
				state: "completed",
				bytes: 8192,
				path: path.join(saved, "slow.bin"),
			});
		} finally {
			await releaseChromeTabsForOwner("relay-downloads").catch(() => 0);
			setup?.process()?.kill("SIGTERM");
			token.mockRestore();
			daemonReady.mockRestore();
			relay.stop();
			fixture.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	60_000,
);

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"keeps control of a driven tab through password-manager menus, and leaves the menus to the user's tabs",
	async () => {
		// Every inline menu that loads reports here, tagged with the page that opened it.
		const menus: string[] = [];
		const menuWaiters = new Map<string, () => void>();
		// Resolves when a menu opened by `who` has loaded; the test timeout bounds it.
		const menuFor = (who: string): Promise<void> => {
			if (menus.includes(who)) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			menuWaiters.set(who, resolve);
			return promise;
		};
		const fixture = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				const url = new URL(request.url);
				if (url.pathname === "/menu-loaded") {
					const who = url.searchParams.get("who") ?? "";
					menus.push(who);
					menuWaiters.get(who)?.();
					return new Response(null, { status: 204 });
				}
				const autofocus = url.searchParams.has("autofocus") ? " autofocus" : "";
				return new Response(
					`<title>Sign in</title><form><input id="user"${autofocus}><input type="password" id="pw"></form>`,
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		const root = await mkdtemp(path.join(tmpdir(), "omp-autofill-menus-"));
		const events: string[] = [];
		const relay = startRelayServer({ port: 0, log: message => events.push(message) });
		const token = spyOn(relayAccess, "readRelayControlToken").mockReturnValue(relay.access.controlToken);
		const daemonReady = spyOn(daemon, "ensureRelayDaemon").mockResolvedValue({ service: "omp-browser", protocol: 2 });
		const session: ToolSession = {
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => "autofill-menus",
			getAgentId: () => "agent",
			settings: Settings.isolated({
				"browser.enabled": true,
				"browser.relay": true,
				"browser.relayUrl": `http://127.0.0.1:${relay.port}`,
			}),
		};
		let setup: Browser | undefined;
		try {
			const extension = path.join(root, "extension");
			await runBrowserRelayCommand({ action: "install", dir: extension, port: relay.port });
			// Built like 1Password's inline menu: one closed-shadow host per document
			// whose frame is pointed at the menu on every field focus and hidden on
			// blur. `?pm=honors` pages get a vendor that honours 1Password's
			// `data-1p-ignore`; `?pm=ignores` pages one that honours nothing.
			const passwordManager = path.join(root, "password-manager");
			await mkdir(passwordManager);
			await writeFile(
				path.join(passwordManager, "manifest.json"),
				JSON.stringify({
					manifest_version: 3,
					name: "Fake password manager",
					version: "1.0",
					content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_start" }],
					web_accessible_resources: [{ resources: ["menu.html", "menu.js"], matches: ["http://127.0.0.1/*"] }],
				}),
			);
			await writeFile(
				path.join(passwordManager, "menu.html"),
				'<script src="menu.js"></script><p>Fill password</p>',
			);
			await writeFile(
				path.join(passwordManager, "menu.js"),
				'fetch(new URLSearchParams(location.search).get("report"), { mode: "no-cors" });',
			);
			await writeFile(
				path.join(passwordManager, "content.js"),
				`const params = new URL(location.href).searchParams;
				const ignored = field => params.get("pm") === "honors" && [field, document.body].some(el => "1pIgnore" in el.dataset);
				let host, frame;
				window.addEventListener("focusin", event => {
					if (!(event.target instanceof HTMLInputElement) || ignored(event.target)) return;
					if (!host) {
						host = document.createElement("com-fake-menu");
						frame = document.createElement("iframe");
						host.attachShadow({ mode: "closed" }).append(frame);
					}
					const report = location.origin + "/menu-loaded?who=" + params.get("who");
					frame.src = chrome.runtime.getURL("menu.html") + "?report=" + encodeURIComponent(report) + "&at=" + performance.now();
					document.body.append(host);
				}, true);
				window.addEventListener("focusout", () => host?.remove(), true);`,
			);
			setup = await puppeteer.launch({
				executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
				headless: true,
				pipe: true,
				enableExtensions: true,
				ignoreDefaultArgs: stockBackgroundPolicy,
				userDataDir: path.join(root, "profile"),
				defaultViewport: null,
			});
			const extensionId = await setup.installExtension(extension);
			await setup.installExtension(passwordManager);
			const options = await setup.newPage();
			await options.goto(`chrome-extension://${extensionId}/options.html`);
			await options.type("#label", "Autofill fixture");
			await options.type("#code", relay.access.issueCode().code);
			await options.click("#save");
			for (let i = 0; i < 400 && !relay.instances.list().some(browser => browser.connected); i++)
				await Bun.sleep(25);
			await options.close();
			// The launch pipe stays as the user's hands: it is not an extension, so
			// Chrome's rule never applies to it. Disarm its auto-attach.
			const setupSession = await setup.target().createCDPSession();
			const user = setupSession.connection()!;
			await user.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
			const userSession = async (who: string) => {
				const { targetInfos } = await user.send("Target.getTargets");
				const target = targetInfos.find(info => info.type === "page" && info.url.includes(`who=${who}`));
				if (!target) throw new Error(`no page for ${who}`);
				const { sessionId } = await user.send("Target.attachToTarget", {
					targetId: target.targetId,
					flatten: true,
				});
				const page = user.session(sessionId)!;
				await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
				return async (expression: string) =>
					(await page.send("Runtime.evaluate", { expression, returnByValue: true })).result.value as unknown;
			};
			const prelude = createBrowserPrelude(session);
			const context = { session, toolCallId: "autofill-menus" };
			const detail = (result: AgentToolResult<unknown>, key: string): unknown =>
				result.details && typeof result.details === "object" && key in result.details
					? Reflect.get(result.details, key)
					: undefined;
			const text = (result: AgentToolResult<unknown>) =>
				result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
			const count = (message: string) => events.filter(event => event === message).length;
			const create = async (query: string) => {
				const handle = detail(
					await prelude.invoke({ action: "create", url: `${fixture.url}login?${query}`, timeout: 20 }, context),
					"handle",
				);
				if (typeof handle !== "string") throw new Error("create returned no handle");
				return handle;
			};

			// A vendor with a page opt-out: the menu never opens for the agent.
			const honoring = await create("pm=honors&who=agent");
			const run = (handle: string, code: string) =>
				prelude.invoke({ action: "run", handle, code, timeout: 20 }, context);
			const filled = await run(
				honoring,
				`await page.click("#user"); await page.keyboard.type("will");
				await page.click("#pw"); await page.keyboard.type("secret");
				return await page.evaluate(() => document.querySelector("#user").value + "/" + document.querySelector("#pw").value);`,
			);
			expect(detail(filled, "value")).toBe("will/secret");
			// The next page focuses its field itself, before any command reaches it.
			const next = await run(
				honoring,
				`await page.goto(new URL("/login?pm=honors&who=agent-next&autofocus", page.url()).href);
				await page.keyboard.type("will");
				return await page.$eval("#user", field => field.value);`,
			);
			expect(detail(next, "value")).toBe("will");
			expect(count("tab detached")).toBe(0);
			expect(menus).toEqual([]);
			// The user's own tab, opened while the agent drives: its menu opens as usual.
			await user.send("Target.createTarget", { url: `${fixture.url}login?pm=honors&who=user&autofocus` });
			await menuFor("user");
			// Handed back, the driven tab is the user's again, menu included.
			await prelude.invoke({ action: "release", handle: honoring }, context);
			const handedBack = await userSession("agent-next");
			expect(await handedBack(`document.body.hasAttribute("data-1p-ignore")`)).toBe(false);
			await handedBack(`document.querySelector("#pw").focus()`);
			await menuFor("agent-next");
			expect(menus).toEqual(["user", "agent-next"]);

			// A vendor that honours nothing: Chrome drops the debugger once, the
			// extension empties the menu's frame, and the call goes through on the
			// same handle; focusing again re-shows a frame that now loads nothing.
			const ignoring = await create("pm=ignores&who=agent-ignored");
			const refusals = count("attach failed");
			const first = await run(
				ignoring,
				`await page.click("#user"); await page.keyboard.type("will"); return await page.$eval("#user", field => field.value);`,
			);
			expect(detail(first, "value")).toBe("will");
			expect(text(first)).toContain("OMP reattached and ran it again");
			expect(count("tab detached")).toBe(1);
			const second = await run(
				ignoring,
				`await page.click("#pw"); await page.keyboard.type("secret"); return await page.$eval("#pw", field => field.value);`,
			);
			expect(detail(second, "value")).toBe("secret");
			expect(text(second)).not.toContain("ran it again");
			expect(count("tab detached")).toBe(1);
			expect(count("attach failed")).toBe(refusals);
		} finally {
			await releaseChromeTabsForOwner("autofill-menus").catch(() => 0);
			setup?.process()?.kill("SIGTERM");
			token.mockRestore();
			daemonReady.mockRestore();
			relay.stop();
			fixture.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	90_000,
);

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"drives a sign-in frame from another site through a password manager's menu inside it",
	async () => {
		const fixture = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				const url = new URL(request.url);
				// The sign-in form is served to another site (`localhost`), so it runs in its own process.
				const body =
					url.pathname === "/frame"
						? '<form><label>Password <input type="password" id="pw"></label><button type="button">Next</button></form>'
						: `<title>Sign in</title><h1>Sign in</h1><iframe title="Credentials" src="http://localhost:${url.port}/frame"></iframe>`;
				return new Response(body, { headers: { "content-type": "text/html" } });
			},
		});
		const root = await mkdtemp(path.join(tmpdir(), "omp-frame-signin-"));
		const relay = startRelayServer({ port: 0, log: () => {} });
		const token = spyOn(relayAccess, "readRelayControlToken").mockReturnValue(relay.access.controlToken);
		const daemonReady = spyOn(daemon, "ensureRelayDaemon").mockResolvedValue({ service: "omp-browser", protocol: 2 });
		const session: ToolSession = {
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => "frame-signin",
			getAgentId: () => "agent",
			settings: Settings.isolated({
				"browser.enabled": true,
				"browser.relay": true,
				"browser.relayUrl": `http://127.0.0.1:${relay.port}`,
			}),
		};
		let setup: Browser | undefined;
		try {
			const extension = path.join(root, "extension");
			await runBrowserRelayCommand({ action: "install", dir: extension, port: relay.port });
			// An inline menu in every frame, as password managers draw it: another
			// extension's page in an iframe beside the focused field, honouring no opt-out.
			const passwordManager = path.join(root, "password-manager");
			await mkdir(passwordManager);
			await writeFile(
				path.join(passwordManager, "manifest.json"),
				JSON.stringify({
					manifest_version: 3,
					name: "Fake password manager",
					version: "1.0",
					content_scripts: [
						{ matches: ["http://localhost/*"], js: ["content.js"], all_frames: true, run_at: "document_idle" },
					],
					web_accessible_resources: [{ resources: ["menu.html"], matches: ["http://localhost/*"] }],
				}),
			);
			await writeFile(path.join(passwordManager, "menu.html"), "<p>Fill password</p>");
			await writeFile(
				path.join(passwordManager, "content.js"),
				`document.addEventListener("focusin", event => {
					if (!event.target.matches?.("input[type=password]")) return;
					const menu = document.createElement("iframe");
					menu.src = chrome.runtime.getURL("menu.html");
					document.body.append(menu);
				}, true);`,
			);
			setup = await puppeteer.launch({
				executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
				headless: true,
				pipe: true,
				enableExtensions: true,
				ignoreDefaultArgs: stockBackgroundPolicy,
				userDataDir: path.join(root, "profile"),
				defaultViewport: null,
			});
			const extensionId = await setup.installExtension(extension);
			await setup.installExtension(passwordManager);
			const options = await setup.newPage();
			await options.goto(`chrome-extension://${extensionId}/options.html`);
			await options.type("#label", "Password manager fixture");
			await options.type("#code", relay.access.issueCode().code);
			await options.click("#save");
			for (let i = 0; i < 400 && !relay.instances.list().some(browser => browser.connected); i++)
				await Bun.sleep(25);
			await options.close();
			// The user's own tab, its sign-in frame loaded before OMP is asked to drive it.
			const userTab = await setup.newPage();
			await userTab.goto(fixture.url.toString());
			await userTab.waitForFrame(frame => frame.url().startsWith("http://localhost:"));
			// The launch pipe is not a driver: disarm its auto-attach.
			const setupSession = await setup.target().createCDPSession();
			await setupSession
				.connection()
				?.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
			await setupSession.detach();
			await setup.disconnect();

			const prelude = createBrowserPrelude(session);
			const context = { session, toolCallId: "frame-signin" };
			const text = (result: AgentToolResult<unknown>) =>
				result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
			const value = (result: AgentToolResult<unknown>): unknown =>
				result.details && typeof result.details === "object" && "value" in result.details
					? result.details.value
					: undefined;
			const claimed = await prelude.invoke(
				{ action: "claim", selector: { title: "Sign in" }, timeout: 20 },
				context,
			);
			const handle =
				claimed.details && typeof claimed.details === "object" && "handle" in claimed.details
					? claimed.details.handle
					: undefined;
			if (typeof handle !== "string") throw new Error("claim returned no handle");
			const run = (code: string) => prelude.invoke({ action: "run", handle, code, timeout: 20 }, context);
			const passwordRef = (tree: unknown) => /\b(e\d+) textbox "Password"/.exec(String(tree))?.[1];

			// A frame that loaded before the claim is read like one that loads after it.
			const first = String(value(await run("return String(await tab.observe({ diff: false }))")));
			const ref = passwordRef(first);
			expect(ref).toBeDefined();

			// Focusing the field opens the menu inside the frame: Chrome drops OMP's
			// debugger, and whatever that call reports, the tab is still OMP's.
			await run(`await (await tab.ref(${JSON.stringify(ref)})).fill("Tern-Harbor-4471"); return 1`).catch(
				() => undefined,
			);
			const after = await run("return String(await tab.observe({ diff: false }))");
			expect(text(after)).not.toContain("revoked");
			expect(passwordRef(value(after))).toBeDefined();
		} finally {
			await releaseChromeTabsForOwner("frame-signin").catch(() => 0);
			setup?.process()?.kill("SIGTERM");
			token.mockRestore();
			daemonReady.mockRestore();
			relay.stop();
			fixture.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	90_000,
);

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"hands a tab back unmarked when the extension's socket drops, and shows the driver that reclaims it the cross-site frame",
	async () => {
		const fixture = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				const url = new URL(request.url);
				// The frame is served to another site (`localhost`), so it runs in its own process.
				const body =
					url.pathname === "/frame"
						? "<title>Child</title><p>Frame</p>"
						: `<title>Reconnect</title><iframe src="http://localhost:${url.port}/frame"></iframe>`;
				return new Response(body, { headers: { "content-type": "text/html" } });
			},
		});
		const root = await mkdtemp(path.join(tmpdir(), "omp-frame-reconnect-"));
		const relay = startRelayServer({ port: 0, log: () => {} });
		const extensionSockets = spyOn(relay.instances, "extConnected");
		const extensionMessages = spyOn(relay.instances, "extMessage");
		const clients: Browser[] = [];
		let setup: Browser | undefined;
		try {
			const extension = path.join(root, "extension");
			await runBrowserRelayCommand({ action: "install", dir: extension, port: relay.port });
			setup = await puppeteer.launch({
				executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
				headless: true,
				pipe: false,
				args: ["--use-mock-keychain", "--password-store=basic"],
				enableExtensions: true,
				ignoreDefaultArgs: stockBackgroundPolicy,
				userDataDir: path.join(root, "profile"),
				defaultViewport: null,
			});
			const extensionId = await setup.installExtension(extension);
			const options = await setup.newPage();
			await options.goto(`chrome-extension://${extensionId}/options.html`);
			await options.type("#label", "Reconnect fixture");
			await options.type("#code", relay.access.issueCode().code);
			await options.click("#save");
			for (let i = 0; i < 400 && !relay.instances.list().some(browser => browser.connected); i++)
				await Bun.sleep(25);
			await options.close();
			const userTab = await setup.newPage();
			await userTab.goto(fixture.url.toString());
			await userTab.waitForFrame(frame => frame.url().startsWith("http://localhost:"));
			// The launch pipe is not a driver: disarm its auto-attach.
			const setupSession = await setup.target().createCDPSession();
			await setupSession
				.connection()
				?.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
			await setupSession.detach();
			const nativeEndpoint = setup.wsEndpoint();
			await setup.disconnect();
			// OMP's badge, cursor and autofill opt-out on the tab's current document, read over Chrome's own endpoint.
			const marks = async (): Promise<unknown> => {
				const native = await puppeteer.connect({ browserWSEndpoint: nativeEndpoint, defaultViewport: null });
				try {
					const page = (await native.pages()).find(candidate => candidate.url() === fixture.url.toString());
					if (!page) throw new Error("the fixture tab is gone");
					// A raw evaluation: the page's own world, whichever context puppeteer settled on.
					const session = await page.createCDPSession();
					const { result } = await session.send("Runtime.evaluate", {
						expression: "[!!window.__ompLeaseBadge, !!window.__ompCursor, !!window.__ompAutofillOptOut]",
						returnByValue: true,
					});
					return result.value;
				} finally {
					await native.disconnect();
				}
			};

			// Claim the tab, connect a driver to it, and read its cross-site frame.
			const drive = async (): Promise<unknown> => {
				const found = relay.instances.discover().find(candidate => candidate.title === "Reconnect");
				if (!found) throw new Error("the fixture tab is not discoverable");
				const lease = relay.instances.claim(found.id, "frame-reconnect");
				const version = (await (
					await fetch(`http://127.0.0.1:${relay.port}/managed/${lease.id}/json/version`)
				).json()) as { webSocketDebuggerUrl: string };
				const client = await puppeteer.connect({
					browserWSEndpoint: version.webSocketDebuggerUrl,
					defaultViewport: null,
					protocolTimeout: 10_000,
				});
				clients.push(client);
				const [page] = await client.pages();
				if (!page) throw new Error("the lease exposes no page");
				const frame = await page.waitForFrame(candidate => candidate.url().startsWith("http://localhost:"), {
					timeout: 5_000,
				});
				return await frame.evaluate("document.title");
			};
			expect(await drive()).toBe("Child");
			expect(await marks()).toEqual([true, true, true]);

			// The extension's socket drops, and its worker reconnects within the grace
			// in which Chrome keeps the debugger attached, frame session included.
			const dropped = extensionSockets.mock.calls.at(-1)?.[0];
			if (!dropped) throw new Error("the extension never connected");
			dropped.close();
			for (
				let i = 0;
				i < 400 &&
				!(extensionSockets.mock.calls.length > 1 && relay.instances.list().some(browser => browser.connected));
				i++
			)
				await Bun.sleep(25);
			expect(extensionSockets.mock.calls.length).toBeGreaterThan(1);
			// Within the grace: the reconnect's hello still lists the tab as attached.
			const hellos = extensionMessages.mock.calls
				.map(([, text]) => JSON.parse(String(text)) as { t: string; attachedTabIds?: number[] })
				.filter(message => message.t === "hello");
			const tabId = relay.instances.discover().find(candidate => candidate.title === "Reconnect")?.tabId;
			expect(hellos).toHaveLength(2);
			expect(hellos[1]!.attachedTabIds).toContain(tabId);
			// No lease survived the socket: the relay hands the attachment back, marks off first.
			let left = await marks();
			for (let i = 0; i < 200 && JSON.stringify(left) !== "[false,false,false]"; i++) {
				await Bun.sleep(25);
				left = await marks();
			}
			expect(left).toEqual([false, false, false]);
			expect(await drive()).toBe("Child");
		} finally {
			for (const client of clients) await client.disconnect().catch(() => undefined);
			setup?.process()?.kill("SIGTERM");
			extensionSockets.mockRestore();
			extensionMessages.mockRestore();
			relay.stop();
			fixture.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	90_000,
);
