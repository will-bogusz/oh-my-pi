import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBrowserRelayCommand } from "@oh-my-pi/pi-coding-agent/cli/browser-relay-cli";
import type { InstanceTab } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/instances";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { clickInBackground } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer, { type Browser } from "puppeteer-core";

// Keep stock timer/occlusion scheduling and popup blocking in real-extension qualification.
const stockBackgroundPolicy = [
	"--disable-background-timer-throttling",
	"--disable-backgrounding-occluded-windows",
	"--disable-renderer-backgrounding",
	"--disable-popup-blocking",
];

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
			const parent = await relay.instances.create(fixture.url.toString(), "actor", "task", "Workshop");
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
			await clickInBackground(link, {}, AbortSignal.timeout(5000));
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
			// …and the tab the user was looking at is the visible one again.
			for (let attempt = 0; attempt < 200; attempt++) {
				const active = (await relay.instances.refresh("actor")).filter(candidate => candidate.active);
				if (active.length === 1 && active[0]!.tabId === visibleBefore[0]!.tabId) break;
				await Bun.sleep(25);
			}
			expect((await relay.instances.refresh("actor")).filter(candidate => candidate.active)).toMatchObject([
				{ tabId: visibleBefore[0]!.tabId },
			]);
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
			await expect(relay.instances.create("about:blank", "actor", "task", "Ambiguous")).rejects.toThrow(
				"Multiple browsers",
			);
			const second = await relay.instances.create(
				fixture.url.toString(),
				"actor",
				"task",
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
			const pdf = await relay.instances.create(`${fixture.url}doc.pdf`, "actor", "task", "Reading");
			const pdfBrowser = await connect(pdf.id);
			const pdfPage = await pdfBrowser
				.targets()
				.find(target => target.type() === "page")
				?.page();
			if (!pdfPage) throw new Error("Missing PDF page");
			for (let attempt = 0; attempt < 40; attempt++) {
				if ((await pdfPage.evaluate("document.contentType")) === "application/pdf") break;
				await Bun.sleep(50);
			}
			expect(await pdfPage.evaluate("document.contentType")).toBe("application/pdf");
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

			const lease = await relay.instances.create(fixture.url.toString(), "actor", "task", "Detach task");
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

			const bridge = relay.instances.select(browserId).bridge;
			expect(await bridge.detachDebuggers({ owner: "actor" })).toEqual([lease.tab.tabId]);
			// Chrome allows one debugger per tab, so the reattach this command
			// forces would fail outright if the extension had not really detached.
			expect(await page.evaluate("document.querySelector('p').textContent")).toBe("page");
			expect(await bridge.detachDebuggers({ owner: "actor" })).toEqual([lease.tab.tabId]);

			// Losing the relay must cost the attachment too: a fresh server's
			// handshake reports what the extension still holds, probed in Chrome.
			await page.evaluate("1");
			relay.stop();
			await Bun.sleep(3000);
			// Marking off in the revived relay: claiming the orphan below must read
			// the strip the dead relay left, not a mark this one just added.
			relay = startRelayServer({ port, access, group: false });
			const reconnected = await connected(relay);
			expect(await relay.instances.select(reconnected).bridge.detachDebuggers()).toEqual([]);
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
			const revived = await relay.instances.create(fixture.url.toString(), "actor", "task", "Revived");
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

			const lease = await relay.instances.create(fixture.url.toString(), "actor", "task", "Idle task");
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
			// Chrome confirms it holds nothing: a second release finds no attachment.
			expect(await relay.instances.select(browserId).bridge.detachDebuggers({ owner: "actor" })).toEqual([]);
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
			await clickInBackground(link, {}, AbortSignal.timeout(8000));
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
