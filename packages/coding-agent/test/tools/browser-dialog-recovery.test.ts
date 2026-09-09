import { expect, it, spyOn } from "bun:test";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import {
	ensureChromePage,
	type ManagedChromeHandle,
	releaseChromeTabsForOwner,
	releaseDeferredChromeTabsForOwner,
	requireChromeHandle,
} from "@oh-my-pi/pi-coding-agent/tools/browser/managed-chrome";
import * as daemon from "@oh-my-pi/pi-coding-agent/tools/browser/relay/daemon";
import type { InstanceLease } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/instances";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { DialogState } from "@oh-my-pi/pi-coding-agent/tools/browser/dialogs";
import * as registry from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as access from "@oh-my-pi/pi-coding-agent/tools/browser/relay/access";

const tabSnapshot = {
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
	ownership: "available" as const,
};

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
		lease: {
			id: "exact-lease",
			targetId: "PAGE7",
			created: false,
			browserId: "profile",
			browserLabel: "Work",
			tab: { ...tabSnapshot, id: "discovery-7", ownership: "this_actor" },
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
		const first = ensureChromePage(handle, session, 1000, controller.signal).catch((error: unknown) => error);
		await entered.promise;
		controller.abort();
		expect(await first).toBeInstanceOf(Error);
		const next = ensureChromePage(handle, session, 1000).catch((error: unknown) => error);
		pending.reject(new Error("Initialization stopped"));
		expect(String(await next)).toContain("Initialization stopped");
		// The aborted caller left the in-flight initialization in place instead of
		// starting a second worker for the same handle.
		expect(attempts).toBe(1);
		expect(requests).toHaveLength(1);
		state = { status: "unobserved", dialog: null };
		await expect(ensureChromePage(handle, session, 1000)).rejects.toThrow("outcome is unknown");
		expect(attempts).toBe(1);
		state = {
			status: "open",
			dialog: { id: "next", type: "confirm", message: "Approve?", url: "https://fixture.test", defaultPrompt: "" },
		};
		await expect(ensureChromePage(handle, session, 1000)).rejects.toThrow("open dialog");
		expect(attempts).toBe(1);
	} finally {
		pending.reject(new Error("Test cleanup"));
		acquire.mockRestore();
		credential.mockRestore();
		server.stop(true);
	}
});

/**
 * A claim on a tab whose renderer is blocked by a JavaScript dialog is an
 * ordinary claim: it succeeds, exposes the dialog, and holds no side channel
 * of its own (Chrome never hands out the page while a modal is up, so there
 * is no worker and no CDP socket). The only thing that unblocks the page is
 * answering the dialog.
 */
it("claims a dialog-blocked tab without renderer setup or a side connection, and hands it back unclosed", async () => {
	const requests: Array<Record<string, unknown>> = [];
	const lease: InstanceLease = {
		id: "pending-lease",
		targetId: "PAGE7",
		created: false,
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
		tab: tabSnapshot,
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/health") return Response.json({ service: "omp-browser", protocol: 2 });
			if (path !== "/managed") throw new Error(`Unexpected relay connection behind the dialog: ${path}`);
			const body = (await request.json()) as Record<string, unknown>;
			requests.push(body);
			if (body.action === "claim") return Response.json(lease);
			if (body.action === "dialog") return Response.json(lease.dialog);
			if (body.action === "releaseTab" || body.action === "closeTab") return Response.json({});
			throw new Error(`Unexpected operation ${String(body.action)}`);
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
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.relay": true,
			"browser.relayUrl": `http://127.0.0.1:${server.port}`,
		}),
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
		// The turn-settle sweep finds it even though no page worker names it.
		expect(await releaseChromeTabsForOwner("dialog-dispose")).toBe(1);
		expect(() => requireChromeHandle(details.handle, session)).toThrow("stale");
		const release = requests.find(request => request.action === "releaseTab");
		// A tab claimed from the user is handed back, never closed.
		expect(release).toMatchObject({ id: "pending-lease", close: false });
		expect(requests.map(request => request.action)).toEqual(["claim", "dialog", "releaseTab"]);
	} finally {
		await releaseDeferredChromeTabsForOwner("dialog-dispose");
		token.mockRestore();
		ensure.mockRestore();
		server.stop(true);
	}
});

/**
 * The settle contract, end to end through the relay wire: at turn end every
 * tab OMP holds is handed back open — created or claimed alike. Nothing is
 * auto-closed; the model closes what it opened when it is done with it.
 */
it("hands every tab back open at settle and never closes one on the model's behalf", async () => {
	const requests: Array<Record<string, unknown>> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/health") return Response.json({ service: "omp-browser", protocol: 2 });
			const body = (await request.json()) as Record<string, unknown>;
			requests.push(body);
			if (body.action === "create")
				return Response.json({
					id: `lease-${requests.length}`,
					targetId: "PAGE9",
					created: true,
					browserId: "profile",
					browserLabel: "Work",
					// An open dialog is the one acquisition that needs no renderer, which
					// is what lets this exercise the settle ladder without a browser.
					dialog: {
						status: "open",
						dialog: {
							id: "blocking",
							type: "alert",
							message: "wait",
							url: "https://fixture.test",
							defaultPrompt: "",
						},
					},
					tab: { ...tabSnapshot, id: `page-${requests.length}`, tabId: 90 + requests.length },
				} satisfies InstanceLease);
			if (body.action === "releaseTab") return Response.json({});
			throw new Error(`Unexpected operation ${String(body.action)}`);
		},
	});
	const ensure = spyOn(daemon, "ensureRelayDaemon").mockResolvedValue(true);
	const token = spyOn(access, "readRelayControlToken").mockReturnValue("fixture-token");
	const session: ToolSession = {
		cwd: import.meta.dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => "settle-owner",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.relay": true,
			"browser.relayUrl": `http://127.0.0.1:${server.port}`,
		}),
	};
	try {
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "settle" };
		const first = (await prelude.invoke({ action: "create", timeout: 1 }, context)).details as { handle: string };
		const second = (await prelude.invoke({ action: "create", timeout: 1 }, context)).details as { handle: string };
		expect(requests.map(request => request.action)).toEqual(["create", "create"]);

		expect(await releaseChromeTabsForOwner("settle-owner")).toBe(2);
		const releases = requests.filter(request => request.action === "releaseTab");
		expect(releases.map(request => request.close)).toEqual([false, false]);
		expect(() => requireChromeHandle(first.handle, session)).toThrow("stale");
		expect(() => requireChromeHandle(second.handle, session)).toThrow("stale");
	} finally {
		await releaseDeferredChromeTabsForOwner("settle-owner");
		token.mockRestore();
		ensure.mockRestore();
		server.stop(true);
	}
});

it("refuses managed Chrome access when the browser.relay setting is off unless the call opts in", async () => {
	let served = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			served++;
			if (new URL(request.url).pathname === "/health") return Response.json({ service: "omp-browser", protocol: 2 });
			return Response.json([]);
		},
	});
	const ensure = spyOn(daemon, "ensureRelayDaemon").mockResolvedValue(true);
	const token = spyOn(access, "readRelayControlToken").mockReturnValue("fixture-token");
	const session: ToolSession = {
		cwd: import.meta.dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.relay": false,
			"browser.relayUrl": `http://127.0.0.1:${server.port}`,
		}),
	};
	try {
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "gated" };
		await expect(prelude.invoke({ action: "discover", timeout: 1 }, context)).rejects.toThrow(
			"Control of existing Chrome browsers is off",
		);
		expect(served).toBe(0);
		expect(ensure).not.toHaveBeenCalled();
		// An explicit app.relay on the call still wins over the setting.
		await prelude.invoke({ action: "discover", app: { relay: true }, timeout: 1 }, context);
		expect(served).toBeGreaterThan(0);
	} finally {
		token.mockRestore();
		ensure.mockRestore();
		server.stop(true);
	}
});
