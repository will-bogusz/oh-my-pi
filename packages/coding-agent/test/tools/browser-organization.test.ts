import { expect, it, spyOn } from "bun:test";
import * as vm from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { acquireChromeTab } from "@oh-my-pi/pi-coding-agent/tools/browser/managed-chrome";
import * as registry from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as access from "@oh-my-pi/pi-coding-agent/tools/browser/relay/access";
import type { RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import type {
	RelayRpcRequest,
	RelayToExtMessage,
	TabSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { startRelayServer, type RelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";

function profile(relay: RelayServer, id: string) {
	const tabs = new Map<number, TabSnapshot>(
		[1, 2].map(tabId => [
			tabId,
			{
				tabId,
				windowId: 1,
				title: "Identical title",
				url: "https://example.test/",
				active: tabId === 2,
				groupId: -1,
				pinned: false,
			},
		]),
	);
	const requests: RelayRpcRequest[] = [];
	const socket: RelaySocket = {
		send(raw) {
			const message = JSON.parse(raw) as RelayToExtMessage;
			if (message.t === "authenticationError") throw new Error(message.error);
			if (message.t !== "rpc") return;
			requests.push(message);
			queueMicrotask(() => {
				let result: unknown = {};
				let error: string | undefined;
				if (message.op === "queryTabs") result = { tabs: [...tabs.values()] };
				else if (message.op === "removeTab") tabs.delete(message.tabId);
				else if (message.op === "taskGroup") {
					const row = tabs.get(message.tabId);
					if (row) row.groupId = 9;
				} else if (message.op === "createTab") {
					const row = { ...tabs.get(1)!, tabId: Math.max(...tabs.keys()) + 1, url: message.url, active: false };
					tabs.set(row.tabId, row);
					result = { tab: row };
				} else error = `Unexpected page-control operation: ${message.op}`;
				relay.instances.extMessage(
					socket,
					JSON.stringify({ t: "rpcResult", id: message.id, ok: !error, result, error }),
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
			auth: { id, label: id, pairingCode: relay.access.issueCode().code },
		}),
	);
	relay.instances.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			userAgent: "fixture",
			browserVersion: "Chrome/150",
			attachedTabIds: [],
			tabs: [...tabs.values()],
		}),
	);
	return { tabs, requests };
}

it("closes discovered tabs through JS and Python without page attachment, across identical profiles", async () => {
	const relay = startRelayServer({ port: 0 });
	const credential = spyOn(access, "readRelayControlToken").mockReturnValue(relay.access.controlToken);
	try {
		const work = profile(relay, "work-profile-fixture");
		const personal = profile(relay, "personal-profile-fixture");
		const session: ToolSession = {
			cwd: import.meta.dir,
			hasUI: false,
			getSessionId: () => "organization-fixture",
			getAgentId: () => "organizer",
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "browser.enabled": true, "browser.relayUrl": `http://127.0.0.1:${relay.port}` }),
		};
		const prelude = createBrowserPrelude(session);
		session.getEvalPreludes = () => [prelude];
		const context = vm.createContext({
			__omp_display__: () => {},
			__omp_prelude__: (name: string, parameters: unknown) =>
				callSessionTool("__prelude__", { name, parameters }, { session }),
		});
		vm.runInContext(prelude.javascript, context);
		await vm.runInContext(
			`(async () => {
			globalThis.target = (await browser.discover({ browserId: "work-profile-fixture" })).find(tab => !tab.active);
			await browser.closeTab(target.id, { browserId: "work-profile-fixture" });
		})()`,
			context,
		);
		expect([...work.tabs.keys()]).toEqual([2]);
		expect([...personal.tabs.keys()]).toEqual([1, 2]);
		expect(work.tabs.get(2)!.active).toBe(true);
		expect(work.requests.map(request => request.op)).toEqual(["queryTabs", "removeTab"]);
		expect(personal.requests).toEqual([]);
		await expect(vm.runInContext("browser.closeTab(target.id)", context)).rejects.toThrow("stale");

		const python = await executePython(
			`tabs = await browser.discover(browserId="personal-profile-fixture")
target = next(tab for tab in tabs if not tab["active"])
await browser.closeTab(target["id"], browserId="personal-profile-fixture")
remaining = await browser.discover(browserId="personal-profile-fixture")
print([tab["tabId"] for tab in remaining])`,
			{
				cwd: import.meta.dir,
				sessionId: `organization-python-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);
		expect(python.exitCode).toBe(0);
		expect(python.output.trim().split("\n").at(-1)).toBe("[2]");
		expect([...personal.tabs.keys()]).toEqual([2]);
		expect(personal.requests.map(request => request.op)).toEqual(["queryTabs", "removeTab", "queryTabs"]);
	} finally {
		credential.mockRestore();
		relay.stop();
	}
}, 15_000);

it("rejects a mismatched profile or another actor before sending a physical close", async () => {
	const relay = startRelayServer({ port: 0 });
	try {
		const work = profile(relay, "work-profile-fixture");
		profile(relay, "personal-profile-fixture");
		const found = relay.instances.discover("owner", "work-profile-fixture")[0]!;
		const request = (action: string, owner: string, id: string, browserId?: string) =>
			fetch(`http://127.0.0.1:${relay.port}/managed`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${relay.access.controlToken}` },
				body: JSON.stringify({ action, owner, id, browserId }),
			});
		expect((await request("closeTab", "owner", found.id, "personal-profile-fixture")).status).toBe(409);
		const lease = relay.instances.claim(found.id, "owner");
		expect((await request("closeTab", "other", found.id)).status).toBe(409);
		expect((await request("close", "other", lease.id)).status).toBe(409);
		expect(work.requests).toEqual([]);
		expect((await request("close", "owner", lease.id)).status).toBe(200);
		expect([...work.tabs.keys()]).toEqual([2]);
		expect(work.requests.map(request => request.op)).toEqual(["removeTab"]);
	} finally {
		relay.stop();
	}
});

it("failed page-control attachment preserves a newly created page and exposes failed recovery without closing it", async () => {
	const relay = startRelayServer({ port: 0 });
	const credential = spyOn(access, "readRelayControlToken").mockReturnValue(relay.access.controlToken);
	const connect = spyOn(registry, "acquireBrowser").mockRejectedValue(new Error("Attachment interrupted"));
	try {
		const work = profile(relay, "recovery-profile");
		const session: ToolSession = {
			cwd: import.meta.dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "browser.enabled": true, "browser.relayUrl": `http://127.0.0.1:${relay.port}` }),
		};
		await expect(
			acquireChromeTab(session, { action: "create", url: "https://example.test/result", timeoutMs: 1000 }),
		).rejects.toThrow("Attachment interrupted");
		const created = relay.instances.discover().find(tab => tab.url.endsWith("/result"))!;
		expect(created.ownership).toBe("available");
		expect([...work.tabs.keys()]).toEqual([1, 2, 3]);
		expect(work.requests.map(request => request.op)).toEqual(["createTab", "taskGroup"]);
		const lease = relay.instances.claim(created.id, "next");
		const manager = relay.instances.requireLease(lease.id).bridge.managed;
		await manager.releasePreserving(lease.id, "next");
		const fail = spyOn(manager, "releasePreserving").mockRejectedValue(new Error("Recovery unavailable"));
		try {
			await expect(
				acquireChromeTab(session, { action: "create", url: "https://example.test/uncertain", timeoutMs: 1000 }),
			).rejects.toThrow("Cleanup also failed");
			expect([...work.tabs.keys()]).toEqual([1, 2, 3, 4]);
			expect(work.requests.map(request => request.op)).toEqual(["createTab", "taskGroup", "createTab", "taskGroup"]);
		} finally {
			fail.mockRestore();
		}
	} finally {
		connect.mockRestore();
		credential.mockRestore();
		relay.stop();
	}
});
