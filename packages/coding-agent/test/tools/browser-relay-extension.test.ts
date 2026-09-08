import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBrowserRelayCommand } from "@oh-my-pi/pi-coding-agent/cli/browser-relay-cli";
import { ManagedPopupPolicy } from "@oh-my-pi/pi-coding-agent/tools/browser/managed-popups";
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
	"drives an inactive owned popup through the real extension after disarming setup's debugging pipe",
	async () => {
		const fixture = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request =>
				new Response(
					new URL(request.url).pathname === "/details"
						? "<title>Workshop details</title><p>45 minutes, 8 places</p>"
						: '<title>Popup parent</title><a href="/details" target="_blank">Open details</a>',
					{ headers: { "content-type": "text/html" } },
				),
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
			const policy = new ManagedPopupPolicy(page, (url, signal) => relay.instances.popup(parent.id, url, signal));
			await policy.install();
			await policy.begin(AbortSignal.timeout(8000), 8000);
			const link = await page.waitForSelector("a");
			if (!link) throw new Error("Missing popup link");
			await clickInBackground(link, {}, AbortSignal.timeout(5000));
			const children = await policy.finish();
			expect(children).toHaveLength(1);
			const child = relay.instances.claim(children[0]!.id, "actor");
			const childBrowser = await connect(child.id);
			const childPage = await childBrowser
				.targets()
				.find(target => target.type() === "page")
				?.page();
			if (!childPage) throw new Error("Missing child page");
			await childPage.waitForSelector("p");
			expect(await childPage.title()).toBe("Workshop details");
			expect(await childPage.$eval("p", element => element.textContent)).toBe("45 minutes, 8 places");
			expect(relay.instances.get(child.id, "actor").tab).toMatchObject({
				active: false,
				groupId: relay.instances.get(parent.id, "actor").tab.groupId,
				popupOf: parent.tab.id,
			});
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
