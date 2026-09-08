import { expect, it } from "bun:test";
import type { RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import type { RelayToExtMessage } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import {
	acquireBrowser,
	type BrowserHandle,
	holdBrowser,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import puppeteer, { type Browser } from "puppeteer-core";

it("publishes the leased page to both real Puppeteer connections", async () => {
	const relay = startRelayServer({ port: 0 });
	const extension: RelaySocket = {
		send(raw) {
			const message = JSON.parse(raw) as RelayToExtMessage;
			if (message.t !== "rpc") return;
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
	relay.instances.extMessage(
		extension,
		JSON.stringify({
			t: "hello",
			userAgent: "test",
			browserVersion: "Chrome/150.0.0.0",
			attachedTabIds: [],
			tabs: [
				{
					tabId: 31,
					url: "https://example.com/",
					title: "Exact target",
					active: false,
					windowId: 1,
					pinned: false,
					groupId: -1,
				},
			],
		}),
	);
	const lease = relay.instances.claim(relay.instances.discover()[0]!.id, "owner");
	const browsers: Browser[] = [];
	let supervisor: BrowserHandle | undefined;
	try {
		supervisor = await acquireBrowser(
			{ kind: "connected", cdpUrl: `http://127.0.0.1:${relay.port}/managed/${lease.id}` },
			{ cwd: process.cwd() },
		);
		holdBrowser(supervisor);
		if (!("browser" in supervisor)) throw new Error("Expected Puppeteer browser");
		expect(supervisor.browser.wsEndpoint()).toBe(`ws://127.0.0.1:${relay.port}/cdp?lease=${lease.id}`);
		const worker = await puppeteer.connect({
			browserWSEndpoint: supervisor.browser.wsEndpoint(),
			defaultViewport: null,
			protocolTimeout: 2000,
		});
		browsers.push(worker);
		for (const browser of [supervisor.browser, worker]) {
			expect(
				browser.targets().map(target => ({
					id: (target as unknown as { _targetId: string })._targetId,
					type: String(target.type()),
				})),
			).toContainEqual({ id: "PAGE31", type: "page" });
		}
	} finally {
		for (const browser of browsers) browser.disconnect();
		if (supervisor) await releaseBrowser(supervisor, { kill: false });
		relay.stop();
	}
});
