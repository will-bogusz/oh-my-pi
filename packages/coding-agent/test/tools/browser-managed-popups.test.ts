import { expect, it, spyOn } from "bun:test";
import { ManagedPopupPolicy } from "@oh-my-pi/pi-coding-agent/tools/browser/managed-popups";
import { ManagedChromeTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/managed-tabs";
import type { DiscoveredChromeTab } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/managed-tabs";
import type { RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import type { RelayToExtMessage } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { localBrowserRequest } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/local-http";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import puppeteer from "puppeteer-core";

it("reserves popup ownership before navigation and inherits source window and task group", async () => {
	const events: unknown[] = [];
	let id = 10;
	const tabs = new ManagedChromeTabs({
		create: async (url, opener) => {
			events.push({ url, opener });
			return { tabId: id++, url, title: "", active: false, windowId: 3, pinned: false, groupId: -1 };
		},
		navigate: async (tabId, url) => {
			const child = tabs.discover("actor").find(tab => tab.tabId === tabId)!;
			expect(child.ownership).toBe("this_actor");
			expect(() => tabs.claim(child.id, "other actor")).toThrow("already owned");
			events.push({ navigate: tabId, url });
		},
		group: async (tabId, taskId, label) => {
			events.push({ tabId, taskId, label });
		},
		reveal: async () => {
			throw new Error("must never reveal");
		},
		close: async () => {},
		invalidate: () => {},
	});
	const parent = await tabs.create("https://example.com", "actor", "task", "Research");
	const child = await tabs.popup(parent.id, "https://example.com/child");
	expect(child).toMatchObject({ ownership: "this_actor", popupOf: parent.tab.id, active: false });
	expect(events.slice(2)).toEqual([
		{ url: "about:blank", opener: { windowId: 3, openerTabId: 10 } },
		{ tabId: 11, taskId: "task", label: "Research" },
		{ navigate: 11, url: "https://example.com/child" },
	]);
	const claimed = tabs.claim(child.id, "actor");
	expect(claimed.created).toBe(true);
	expect(() => tabs.claim(child.id, "actor")).toThrow("already owned");
	await expect(tabs.popup(parent.id, "file:///private/secret")).rejects.toThrow("HTTP(S)");
});

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"finishes a closed parent without losing an already accepted child or reporting a page error",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
			headless: true,
			protocolTimeout: 5000,
		});
		try {
			const page = await browser.newPage();
			const requested = Promise.withResolvers<void>();
			const created = Promise.withResolvers<DiscoveredChromeTab>();
			const policy = new ManagedPopupPolicy(page, async () => {
				requested.resolve();
				return await created.promise;
			});
			await policy.install();
			await policy.begin(new AbortController().signal, 5000);
			await page.mainFrame().mainRealm().evaluate('window.open("https://example.com/child")');
			await requested.promise;
			await page.close();
			const child: DiscoveredChromeTab = {
				id: "child",
				tabId: 2,
				url: "https://example.com/child",
				title: "Child",
				active: false,
				windowId: 1,
				pinned: false,
				groupId: -1,
			};
			created.resolve(child);
			expect(await policy.finish()).toEqual([child]);
			await policy.dispose();
			expect(browser.targets().some(target => target === page.target())).toBe(false);
		} finally {
			await browser.close();
		}
	},
	10_000,
);

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"only tolerates finalization failure when the page really closed during cleanup",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
			headless: true,
			protocolTimeout: 5000,
		});
		try {
			const page = await browser.newPage();
			const policy = new ManagedPopupPolicy(page, async () => {
				throw new Error("No popup expected");
			});
			await policy.install();
			await policy.begin(new AbortController().signal, 5000);
			const install = spyOn(page, "evaluateOnNewDocument");
			try {
				install.mockRejectedValueOnce(new Error("configuration channel failed"));
				await expect(policy.finish()).rejects.toThrow("configuration channel failed");
				expect(page.isClosed()).toBe(false);
				await policy.begin(new AbortController().signal, 5000);
				install.mockImplementationOnce(async () => {
					await page.close();
					throw new Error("target closed during finalization");
				});
				expect(await policy.finish()).toEqual([]);
				expect(page.isClosed()).toBe(true);
				await policy.dispose();
			} finally {
				install.mockRestore();
			}
		} finally {
			await browser.close();
		}
	},
	10_000,
);

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"reports failed child creation even after the parent closes",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
			headless: true,
			protocolTimeout: 5000,
		});
		try {
			const page = await browser.newPage();
			const requested = Promise.withResolvers<void>();
			const created = Promise.withResolvers<DiscoveredChromeTab>();
			const policy = new ManagedPopupPolicy(page, async () => {
				requested.resolve();
				return await created.promise;
			});
			await policy.install();
			await policy.begin(new AbortController().signal, 5000);
			await page.mainFrame().mainRealm().evaluate('window.open("https://example.com/child")');
			await requested.promise;
			await page.close();
			created.reject(new Error("child navigation failed"));
			await expect(policy.finish()).rejects.toThrow("child navigation failed");
			await policy.dispose();
		} finally {
			await browser.close();
		}
	},
	10_000,
);

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"contains agent popups before native creation and restores ordinary browser behavior",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
			headless: true,
			protocolTimeout: 5000,
		});
		try {
			const page = await browser.newPage();
			const created: string[] = [];
			const pageErrors: string[] = [];
			page.on("pageerror", error => pageErrors.push(String(error)));
			const policy = new ManagedPopupPolicy(page, async url => {
				created.push(url);
				return { id: url } as DiscoveredChromeTab;
			});
			await page.setContent(
				'<a target="_blank" href="https://example.com/link">child</a><form target="_blank" method="post" action="https://example.com/post"><button>Submit</button></form>',
			);
			await policy.install();
			const before = browser.targets().filter(target => target.type() === "page").length;
			await policy.begin(new AbortController().signal, 5000);
			await page.click("a");
			await page
				.mainFrame()
				.mainRealm()
				.evaluate('window.open("https://example.com/script");window.open("https://example.com/empty", "")');
			const children = await policy.finish();
			expect(created).toEqual([
				"https://example.com/link",
				"https://example.com/script",
				"https://example.com/empty",
			]);
			expect(children).toHaveLength(3);
			expect(browser.targets().filter(target => target.type() === "page")).toHaveLength(before);
			await policy.begin(new AbortController().signal, 5000);
			await page.click("button");
			await expect(policy.finish()).rejects.toThrow("new-window form submission is unsupported");
			expect(browser.targets().filter(target => target.type() === "page")).toHaveLength(before);
			await policy.begin(new AbortController().signal, 5000);
			await page.goto(
				`data:text/html,<script>window.open("https://example.com/navigation")</script><iframe srcdoc='<script>window.open("https://example.com/frame")</script>'></iframe>`,
			);
			const navigated = await policy.finish();
			expect(pageErrors).toEqual([]);
			expect(navigated.map(child => child.id).sort()).toEqual([
				"https://example.com/frame",
				"https://example.com/navigation",
			]);
			expect(browser.targets().filter(target => target.type() === "page")).toHaveLength(before);
			const cancel = new AbortController();
			await policy.begin(cancel.signal, 5000);
			cancel.abort();
			await page.mainFrame().mainRealm().evaluate('window.open("https://example.com/late")');
			expect(await policy.finish()).toEqual([]);
			const target = browser.waitForTarget(target => target.opener() === page.target());
			await page.mainFrame().mainRealm().evaluate('window.open("about:blank")');
			await target;
			expect(browser.targets().filter(target => target.type() === "page")).toHaveLength(before + 1);
			await policy.dispose();
		} finally {
			await browser.close();
		}
	},
	20_000,
);

it("preserves an unclaimed popup when its parent becomes orphaned", async () => {
	let next = 1;
	const closed: number[] = [];
	const tabs = new ManagedChromeTabs(
		{
			create: async url => ({
				tabId: next++,
				url,
				title: "",
				windowId: 1,
				active: false,
				pinned: false,
				groupId: -1,
			}),
			navigate: async () => {},
			group: async () => {},
			reveal: async () => {},
			invalidate: () => {},
			close: async tabId => {
				closed.push(tabId);
			},
		},
		{ orphanGraceMs: 10 },
	);
	const parent = await tabs.create("about:blank", "actor", "task", "Work");
	tabs.connected(parent.id, 1);
	const child = await tabs.popup(parent.id, "https://example.com/child");
	await Bun.sleep(25);
	expect(tabs.discover("actor").find(tab => tab.id === child.id)?.ownership).toBe("this_actor");
	tabs.disconnected(parent.id, 1);
	await Bun.sleep(25);
	expect(tabs.claim(child.id, "new actor").created).toBe(false);
	expect(closed).toEqual([]);
});

it("does not navigate a popup after cancellation during physical creation", async () => {
	const created = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	const controller = new AbortController();
	const navigated: number[] = [];
	const closed: number[] = [];
	let next = 1;
	const tabs = new ManagedChromeTabs({
		create: async (url, opener) => {
			if (opener) {
				created.resolve();
				await proceed.promise;
			}
			return { tabId: next++, url, title: "", windowId: 1, active: false, pinned: false, groupId: -1 };
		},
		navigate: async tabId => {
			navigated.push(tabId);
		},
		group: async () => {},
		reveal: async () => {},
		invalidate: () => {},
		close: async tabId => {
			closed.push(tabId);
		},
	});
	const parent = await tabs.create("about:blank", "actor", "task", "Work");
	const pending = tabs.popup(parent.id, "https://example.com/child", controller.signal).catch(error => String(error));
	await created.promise;
	controller.abort(new Error("popup cancelled"));
	proceed.resolve();
	expect(await pending).toContain("popup cancelled");
	expect(navigated).toEqual([]);
	expect(closed).toEqual([2]);
});

it("cancels broker popup navigation when the real HTTP caller disconnects", async () => {
	const relay = startRelayServer({ port: 0 });
	const requested = Promise.withResolvers<number>();
	const removed = Promise.withResolvers<void>();
	const commands: string[] = [];
	const extension: RelaySocket = {
		send(raw) {
			const message = JSON.parse(raw) as RelayToExtMessage;
			if (message.t !== "rpc") return;
			commands.push(message.op);
			if (message.op === "createTab") {
				requested.resolve(message.id);
				return;
			}
			if (message.op === "removeTab") removed.resolve();
			queueMicrotask(() =>
				relay.instances.extMessage(
					extension,
					JSON.stringify({ t: "rpcResult", id: message.id, ok: true, result: {} }),
				),
			);
		},
		close() {},
	};
	relay.instances.extConnected(extension);
	relay.instances.extMessage(
		extension,
		JSON.stringify({
			t: "authenticate",
			auth: { id: crypto.randomUUID(), label: "Test Chrome", pairingCode: relay.access.issueCode().code },
		}),
	);
	const snapshot = { tabId: 1, url: "about:blank", title: "", active: false, windowId: 1, pinned: false, groupId: -1 };
	relay.instances.extMessage(
		extension,
		JSON.stringify({
			t: "hello",
			userAgent: "test",
			browserVersion: "Chrome/150",
			attachedTabIds: [],
			tabs: [snapshot],
		}),
	);
	const parent = relay.instances.claim(relay.instances.discover()[0]!.id, "owner");
	try {
		const cancelled = new AbortController();
		const request = localBrowserRequest(`http://127.0.0.1:${relay.port}/managed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			signal: cancelled.signal,
			body: JSON.stringify({ action: "popup", id: parent.id, url: "https://example.com/late" }),
		}).catch(error => String(error));
		const id = await requested.promise;
		cancelled.abort();
		await request;
		await Bun.sleep(10);
		relay.instances.extMessage(
			extension,
			JSON.stringify({ t: "rpcResult", id, ok: true, result: { tab: { ...snapshot, tabId: 2 } } }),
		);
		await Promise.race([removed.promise, Bun.sleep(1000)]);
		expect(commands).toEqual(["createTab", "removeTab"]);
	} finally {
		relay.stop();
	}
});
