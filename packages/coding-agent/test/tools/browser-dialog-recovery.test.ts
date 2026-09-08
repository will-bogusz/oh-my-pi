import { expect, it, spyOn } from "bun:test";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import {
	releaseDeferredChromeTabsForOwner,
	requireChromeHandle,
} from "@oh-my-pi/pi-coding-agent/tools/browser/managed-chrome";
import * as daemon from "@oh-my-pi/pi-coding-agent/tools/browser/relay/daemon";
import type { InstanceLease } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/instances";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { DialogState } from "@oh-my-pi/pi-coding-agent/tools/browser/dialogs";
import { type ManagedChromeHandle, resumeChromePage } from "@oh-my-pi/pi-coding-agent/tools/browser/managed-chrome";
import * as registry from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as access from "@oh-my-pi/pi-coding-agent/tools/browser/relay/access";

it("does not duplicate page initialization after a waiting caller aborts, and refuses unknown dialog outcomes", async () => {
	let state: DialogState = { status: "closed", dialog: null };
	const requests: unknown[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push(await request.json());
			return Response.json(state);
		},
	});
	const credential = spyOn(access, "readRelayControlToken").mockReturnValue("fixture-token");
	const entered = Promise.withResolvers<void>();
	const pending = Promise.withResolvers<registry.BrowserHandle>();
	let attempts = 0;
	const acquire = spyOn(registry, "acquireBrowser").mockImplementation(async () => {
		attempts++;
		entered.resolve();
		return await pending.promise;
	});
	const handle: ManagedChromeHandle = {
		id: "pending-worker",
		label: "Pending review",
		owner: "actor",
		url: `http://127.0.0.1:${server.port}`,
		released: false,
		deferred: true,
		lease: {
			id: "exact-lease",
			targetId: "PAGE7",
			created: false,
			retained: false,
			browserId: "profile",
			browserLabel: "Work",
			tab: {
				id: "discovery-7",
				tabId: 7,
				windowId: 1,
				browserId: "profile",
				browserLabel: "Work",
				url: "https://fixture.test",
				title: "Review",
				active: false,
				pinned: false,
				groupId: -1,
				ownership: "this_actor",
			},
		},
	};
	const session: ToolSession = {
		cwd: import.meta.dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({}),
	};
	const controller = new AbortController();
	try {
		const first = resumeChromePage(handle, session, 1000, controller.signal).catch(error => error);
		await entered.promise;
		controller.abort();
		expect(await first).toBeInstanceOf(Error);
		const next = resumeChromePage(handle, session, 1000).catch(error => error);
		await Bun.sleep(10);
		expect(attempts).toBe(1);
		expect(requests).toHaveLength(1);
		pending.reject(new Error("Initialization stopped"));
		expect(String(await next)).toContain("Initialization stopped");
		state = { status: "unobserved", dialog: null };
		await expect(resumeChromePage(handle, session, 1000)).rejects.toThrow("outcome is unknown");
		expect(attempts).toBe(1);
		state = {
			status: "open",
			dialog: { id: "next", type: "confirm", message: "Approve?", url: "https://fixture.test", defaultPrompt: "" },
		};
		await expect(resumeChromePage(handle, session, 1000)).rejects.toThrow("open dialog");
		expect(attempts).toBe(1);
	} finally {
		pending.reject(new Error("Test cleanup"));
		acquire.mockRestore();
		credential.mockRestore();
		server.stop(true);
	}
});

it("returns an owned pending dialog without renderer setup and disposes it without answering or closing the page", async () => {
	const requests: Array<Record<string, unknown>> = [];
	const closed = Promise.withResolvers<void>();
	const lease: InstanceLease = {
		id: "pending-lease",
		targetId: "PAGE7",
		created: false,
		retained: false,
		browserId: "profile",
		browserLabel: "Work",
		dialog: {
			status: "open",
			dialog: {
				id: "pending-id",
				type: "prompt",
				message: "Draft name",
				url: "https://fixture.test",
				defaultPrompt: "Draft",
			},
		},
		tab: {
			id: "page-7",
			tabId: 7,
			windowId: 1,
			browserId: "profile",
			browserLabel: "Work",
			url: "https://fixture.test",
			title: "Review",
			active: false,
			pinned: false,
			groupId: -1,
			ownership: "available",
		},
	};
	let commands = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, host) {
			const path = new URL(request.url).pathname;
			if (path === "/health") return Response.json({ service: "omp-browser", protocol: 2 });
			if (path === "/cdp") {
				if (host.upgrade(request)) return;
				return new Response("Upgrade required", { status: 426 });
			}
			if (path !== "/managed") throw new Error("Renderer initialization attempted behind the dialog");
			const body = (await request.json()) as Record<string, unknown>;
			requests.push(body);
			if (body.action === "claim") return Response.json(lease);
			if (body.action === "dialog") return Response.json(lease.dialog);
			if (body.action === "releasePreserving") return Response.json({});
			throw new Error("Unexpected operation");
		},
		websocket: {
			message() {
				commands++;
			},
			close() {
				closed.resolve();
			},
		},
	});
	const ensure = spyOn(daemon, "ensureRelayDaemon").mockResolvedValue(true);
	const token = spyOn(access, "readRelayControlToken").mockReturnValue("fixture-token");
	const session: ToolSession = {
		cwd: import.meta.dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => "dialog-dispose",
		settings: Settings.isolated({ "browser.enabled": true, "browser.relayUrl": `http://127.0.0.1:${server.port}` }),
	};
	try {
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "pending" };
		const result = await prelude.invoke({ action: "claim", id: "page-7", timeout: 1 }, context);
		const details = result.details as {
			handle: string;
			value: { initialDialog: DialogState; initialObservation?: unknown };
		};
		expect(details.value.initialDialog.dialog?.id).toBe("pending-id");
		expect(details.value.initialObservation).toBeUndefined();
		requireChromeHandle(details.handle, session);
		expect(() => requireChromeHandle(details.handle, { ...session, getSessionId: () => "another-task" })).toThrow(
			"another actor",
		);
		await expect(
			prelude.invoke({ action: "run", handle: details.handle, code: "await tab.observe()", timeout: 1 }, context),
		).rejects.toThrow("open dialog");
		expect(await releaseDeferredChromeTabsForOwner("dialog-dispose")).toBe(1);
		await closed.promise;
		expect(() => requireChromeHandle(details.handle, session)).toThrow("stale");
		expect(requests.map(request => request.action)).toEqual(["claim", "dialog", "releasePreserving"]);
		expect(commands).toBe(0);
	} finally {
		await releaseDeferredChromeTabsForOwner("dialog-dispose");
		token.mockRestore();
		ensure.mockRestore();
		server.stop(true);
	}
});
