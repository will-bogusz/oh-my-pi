import { describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import * as access from "@oh-my-pi/pi-coding-agent/tools/browser/relay/access";
import * as daemon from "@oh-my-pi/pi-coding-agent/tools/browser/relay/daemon";
import { EXPECTED_EXTENSION_BUILD_ID } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/instances";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function makeSession(settings: Record<string, unknown>): ToolSession {
	const id = crypto.randomUUID();
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => `opened-route-${id}`,
		getAgentId: () => "opened-route-agent",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
			...settings,
		}),
	};
}

/** In-process relay whose one paired profile holds a single tab of the user's own. */
function startUserChrome(tab: { title: string; url: string }) {
	const relay = startRelayServer({ port: 0 });
	const userTab = { tabId: 1, windowId: 1, title: tab.title, url: tab.url, active: true, groupId: -1, pinned: false };
	const socket = {
		send(raw: string) {
			const message = JSON.parse(raw);
			if (message.t !== "rpc") return;
			queueMicrotask(() => {
				const ok = message.op === "queryTabs";
				relay.instances.extMessage(
					socket,
					JSON.stringify({
						t: "rpcResult",
						id: message.id,
						ok,
						result: ok ? { tabs: [userTab] } : {},
						error: ok ? undefined : `unexpected ${message.op}`,
					}),
				);
			});
		},
		close() {},
	};
	relay.instances.extConnected(socket);
	relay.instances.extMessage(
		socket,
		JSON.stringify({
			t: "authenticate",
			auth: { id: "user-profile-fixture", label: "User", pairingCode: relay.access.issueCode().code },
		}),
	);
	relay.instances.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			userAgent: "fixture",
			browserVersion: "Chrome/150",
			extensionBuildId: EXPECTED_EXTENSION_BUILD_ID,
			attachedTabIds: [],
			tabs: [userTab],
		}),
	);
	// Never the machine's relay daemon or its credential.
	const token = spyOn(access, "readRelayControlToken").mockReturnValue(relay.access.controlToken);
	const ensure = spyOn(daemon, "ensureRelayDaemon").mockResolvedValue({ service: "omp-browser", protocol: 2 });
	return {
		url: `http://127.0.0.1:${relay.port}`,
		stop() {
			token.mockRestore();
			ensure.mockRestore();
			relay.stop?.();
		},
	};
}

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected a refusal");
}

describe("getTab and claim on a tab this session opened", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"name the browser.tab route instead of a relay restart, with the user's Chrome paired and with it off",
		async () => {
			const name = `opened-${crypto.randomUUID().slice(0, 8)}`;
			const url = `data:text/html,${encodeURIComponent("<title>Order status</title><h1>Order</h1>")}`;
			const chrome = startUserChrome({ title: "Inbox (3) - mail", url: "https://mail.example/inbox" });
			const paired = makeSession({ "browser.relay": true, "browser.relayUrl": chrome.url });
			const prelude = createBrowserPrelude(paired);
			const invoke = (parameters: Record<string, unknown>, session = paired) =>
				prelude.invoke(parameters, { session, toolCallId: `route-${crypto.randomUUID()}` });
			try {
				await invoke({ action: "open", name, url, app: { relay: false } });
				const listed = (await invoke({ action: "tabs" })).details as { value: Array<{ name: string; targetId: string }> };
				const targetId = listed.value.find(tab => tab.name === name)!.targetId;
				const route = `browser.tab(${JSON.stringify(name)})`;

				const bySelector = await refusal(invoke({ action: "claim", selector: { title: "order status" } }));
				expect(bySelector).toStartWith("No Chrome tab matches this selector");
				expect(bySelector).toContain(route);

				const byId = await refusal(invoke({ action: "claim", id: targetId }));
				expect(byId).toContain(route);
				expect(byId).not.toContain("restarted");
				// The route is the name; the page's URL is not repeated into the error.
				expect(byId).not.toContain("data:text/html");

				// Chrome answers whenever its own tabs are in question: a selector that
				// matches the user's tab (and the opened one), a miss, a Chrome window.
				expect(
					((await invoke({ action: "discover" })).details as { value: unknown[] }).value,
				).toHaveLength(1);
				const both = await refusal(invoke({ action: "claim", selector: { title: "o" } }));
				expect(both).not.toContain("browser.tab(");
				const chromeMiss = await refusal(invoke({ action: "claim", selector: { title: "no such page" } }));
				expect(chromeMiss).not.toContain("browser.tab(");
				const inWindow = await refusal(invoke({ action: "claim", selector: { title: "order status", windowId: 1 } }));
				expect(inWindow).not.toContain("browser.tab(");
				// The tab's name is asked of Chrome first; once Chrome refuses it, the
				// refusal names the route instead of a relay restart.
				const byName = await refusal(invoke({ action: "claim", id: name }));
				expect(byName).toContain(route);
				expect(byName).not.toContain("restarted");

				// With existing-Chrome control off, the refusal still names the route.
				const unpaired = makeSession({ "browser.relay": false });
				const offByUrl = await refusal(invoke({ action: "claim", selector: { url: "data:text/html" } }, unpaired));
				// Another conversation's tab is not offered.
				expect(offByUrl).not.toContain(route);
				const offById = await refusal(invoke({ action: "claim", id: targetId }, unpaired));
				expect(offById).not.toContain(route);
			} finally {
				await invoke({ action: "close", name }).catch(() => undefined);
				chrome.stop();
			}
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"names the route when existing-Chrome control is off",
		async () => {
			const name = `opened-${crypto.randomUUID().slice(0, 8)}`;
			const url = `data:text/html,${encodeURIComponent("<title>Order status</title><h1>Order</h1>")}`;
			const session = makeSession({ "browser.relay": false });
			const prelude = createBrowserPrelude(session);
			const invoke = (parameters: Record<string, unknown>) =>
				prelude.invoke(parameters, { session, toolCallId: `route-${crypto.randomUUID()}` });
			try {
				await invoke({ action: "open", name, url });
				const listed = (await invoke({ action: "tabs" })).details as { value: Array<{ name: string; targetId: string }> };
				const targetId = listed.value.find(tab => tab.name === name)!.targetId;
				const route = `browser.tab(${JSON.stringify(name)})`;
				expect(await refusal(invoke({ action: "claim", selector: { url: "data:text/html" } }))).toContain(route);
				expect(await refusal(invoke({ action: "claim", id: targetId }))).toContain(route);
				expect(await refusal(invoke({ action: "claim", id: name }))).toContain(route);
			} finally {
				await invoke({ action: "close", name }).catch(() => undefined);
			}
		},
		60_000,
	);
});
