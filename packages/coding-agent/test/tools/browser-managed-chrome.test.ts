import { describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import {
	acquireChromeTab,
	browserActorId,
	explainRevokedChromeControl,
	type ManagedChromeHandle,
	releaseDeferredChromeTabsForOwner,
	requireChromeHandle,
} from "@oh-my-pi/pi-coding-agent/tools/browser/managed-chrome";
import * as access from "@oh-my-pi/pi-coding-agent/tools/browser/relay/access";
import type { RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import * as daemon from "@oh-my-pi/pi-coding-agent/tools/browser/relay/daemon";
import {
	EXPECTED_EXTENSION_BUILD_ID,
	type InstanceLease,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/instances";
import { ManagedChromeTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/managed-tabs";
import type { RelayToExtMessage, TabSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";

const tab = (tabId: number): TabSnapshot => ({
	tabId,
	title: "Same title",
	url: "https://example.com",
	active: false,
	windowId: 1,
	groupId: -1,
	pinned: false,
});

function harness(orphanGraceMs?: number, onRelease?: (tabId: number, close: boolean) => Promise<void>) {
	/** Every hand-back the extension is asked to perform, as `[tabId, close]`. */
	const released: Array<[number, boolean]> = [];
	const revealed: number[] = [];
	const invalidated: string[] = [];
	const groups: Array<[number, string, string]> = [];
	/** Tabs an explicit claim cleared to try the debugger again. */
	const attachAllowed: number[] = [];
	let nextTab = 10;
	const tabs = new ManagedChromeTabs(
		{
			targetId: tabId => `PAGE${tabId}`,
			create: async () => tab(nextTab++),
			group: async (tabId, owner, label) => {
				groups.push([tabId, owner, label]);
			},
			release: async (tabId, close) => {
				released.push([tabId, close]);
				await onRelease?.(tabId, close);
			},
			reveal: async tabId => {
				revealed.push(tabId);
			},
			invalidate: lease => {
				invalidated.push(lease);
			},
			allowAttach: tabId => {
				attachAllowed.push(tabId);
			},
		},
		{ orphanGraceMs },
	);
	return { tabs, released, revealed, invalidated, groups, attachAllowed };
}

describe("managed Chrome physical tab ownership", () => {
	it("closes an exact unclaimed tab without altering an identical sibling or grouping and revealing it", async () => {
		const { tabs, released, groups, revealed } = harness();
		tabs.upsert(tab(1));
		tabs.upsert(tab(2));
		const [first, sibling] = tabs.discover();
		await tabs.closeTab(first!.id, "owner");
		expect(released).toEqual([[1, true]]);
		expect(tabs.discover()).toEqual([sibling!]);
		expect(groups).toEqual([]);
		expect(revealed).toEqual([]);
		await expect(tabs.closeTab(first!.id, "owner")).rejects.toThrow("was closed by its owner. Discover tabs again.");
	});

	it("closes adopted and created tabs on request while rejecting another actor's authority", async () => {
		const { tabs, released } = harness();
		tabs.upsert(tab(1));
		const adopted = tabs.claim(tabs.discover()[0]!.id, "owner");
		await expect(tabs.closeTab(adopted.tab.id, "other")).rejects.toThrow("another actor");
		expect(tabs.get(adopted.id, "owner").tab.tabId).toBe(1);
		await tabs.releaseTab(adopted.id, "owner", true);
		const created = await tabs.create("https://example.com", "owner", "task", "Result");
		await expect(tabs.releaseTab(created.id, "other", true)).rejects.toThrow("another actor");
		await tabs.releaseTab(created.id, "owner", true);
		expect(released).toEqual([
			[1, true],
			[created.tab.tabId, true],
		]);
		expect(tabs.discover()).toEqual([]);
	});

	it("drains accepted work before closure and prevents late actions or competing claims", async () => {
		const { tabs, released } = harness();
		tabs.upsert(tab(1));
		const lease = tabs.claim(tabs.discover()[0]!.id, "owner");
		const finish = tabs.beginOperation(lease.id);
		const closing = tabs.closeTab(lease.tab.id, "owner");
		expect(released).toEqual([]);
		expect(() => tabs.beginOperation(lease.id)).toThrow("being released");
		expect(() => tabs.claim(lease.tab.id, "other")).toThrow("already owned");
		finish();
		await closing;
		expect(released).toEqual([[1, true]]);
		expect(tabs.discover()).toEqual([]);
	});

	it("never closes a replacement that reused the tab number while accepted work drained", async () => {
		const { tabs, released } = harness();
		tabs.upsert(tab(1));
		const lease = tabs.claim(tabs.discover()[0]!.id, "owner");
		const finish = tabs.beginOperation(lease.id);
		const closing = tabs.releaseTab(lease.id, "owner", true);
		tabs.reset();
		tabs.upsert(tab(1));
		const replacement = tabs.claim(tabs.discover()[0]!.id, "other");
		finish();
		await expect(closing).rejects.toThrow("changed during closure");
		expect(released).toEqual([]);
		expect(tabs.get(replacement.id, "other").tab.tabId).toBe(1);
	});

	it("cancels closure before dispatch and leaves the page available for rediscovery", async () => {
		const { tabs, released } = harness();
		tabs.upsert(tab(1));
		const lease = tabs.claim(tabs.discover()[0]!.id, "owner");
		const finish = tabs.beginOperation(lease.id);
		const controller = new AbortController();
		const closing = tabs.releaseTab(lease.id, "owner", true, controller.signal);
		controller.abort();
		finish();
		await expect(closing).rejects.toThrow();
		expect(released).toEqual([]);
		expect(tabs.discover()[0]!.ownership).toBe("available");
		expect(tabs.claim(lease.tab.id, "next").tab.tabId).toBe(1);
	});

	it("reports extension closure failure without pretending the page disappeared or locking it indefinitely", async () => {
		const { tabs, released } = harness(undefined, async () => {
			throw new Error("Browser refused closure");
		});
		tabs.upsert(tab(1));
		const found = tabs.discover()[0]!;
		await expect(tabs.closeTab(found.id, "owner")).rejects.toThrow("Browser refused closure");
		expect(released).toEqual([[1, true]]);
		expect(tabs.discover()).toEqual([found]);
		expect(tabs.claim(found.id, "next").tab.tabId).toBe(1);
	});

	it("returns metadata observed during creation and refreshes it without changing lease identity", async () => {
		const tabs = new ManagedChromeTabs({
			targetId: tabId => `PAGE${tabId}`,
			create: async () => ({ ...tab(1), url: "", title: "" }),
			group: async () => tabs.upsert({ ...tab(1), title: "Ready", groupId: 42 }),
			release: async () => {},
			reveal: async () => {},
			invalidate: () => {},
			allowAttach: () => {},
		});
		const lease = await tabs.create("https://example.com", "owner", "task", "Research");
		expect(lease.tab).toMatchObject({ url: "https://example.com", title: "Ready", groupId: 42 });
		tabs.upsert({ ...tab(1), title: "Updated", groupId: 42 });
		const updated = tabs.get(lease.id, "owner");
		expect(updated.id).toBe(lease.id);
		expect(updated.tab.id).toBe(lease.tab.id);
		expect(updated.tab.title).toBe("Updated");
		expect(() => tabs.get(lease.id, "other actor")).toThrow("another actor");
	});

	it("keeps a known location through partial metadata but accepts a real blank navigation", () => {
		const { tabs } = harness();
		tabs.upsert(tab(1));
		const lease = tabs.claim(tabs.discover()[0]!.id, "owner");
		tabs.upsert({ ...tab(1), url: "", title: "New title" });
		expect(tabs.get(lease.id, "owner").tab).toMatchObject({ url: "https://example.com", title: "New title" });
		tabs.upsert({ ...tab(1), url: "about:blank", title: "" });
		expect(tabs.get(lease.id, "owner").tab).toMatchObject({ url: "about:blank", title: "" });
	});

	it("keeps a releasing tab unavailable until admitted CDP work has settled, then hands the page back", async () => {
		const { tabs, released } = harness();
		tabs.upsert(tab(1));
		const found = tabs.discover()[0]!;
		const lease = tabs.claim(found.id, "owner");
		const finish = tabs.beginOperation(lease.id);
		let done = false;
		const releasing = tabs.releaseTab(lease.id, "owner", false).then(() => {
			done = true;
		});
		await Promise.resolve();
		expect(done).toBe(false);
		expect(() => tabs.claim(found.id, "another actor")).toThrow("already owned");
		expect(() => tabs.beginOperation(lease.id)).toThrow("being released");
		finish();
		await releasing;
		expect(released).toEqual([[1, false]]);
		expect(tabs.claim(found.id, "another actor").targetId).toBe("PAGE1");
	});

	it("distinguishes identical pages and rejects two actors claiming one physical tab", () => {
		const { tabs } = harness();
		tabs.upsert(tab(1));
		tabs.upsert(tab(2));
		const [first, second] = tabs.discover();
		expect(first!.id).not.toBe(second!.id);
		const lease = tabs.claim(first!.id, "actor A");
		expect(() => tabs.claim(first!.id, "actor B")).toThrow("already owned");
		expect(tabs.claim(second!.id, "actor B").targetId).not.toBe(lease.targetId);
	});

	it("requires matching actor for reveal and release", async () => {
		const { tabs, released, revealed } = harness();
		tabs.upsert(tab(1));
		const lease = tabs.claim(tabs.discover()[0]!.id, "owner");
		await expect(tabs.reveal(lease.id, "other")).rejects.toThrow("another actor");
		await expect(tabs.releaseTab(lease.id, "other", false)).rejects.toThrow("another actor");
		expect(revealed).toEqual([]);
		expect(released).toEqual([]);
		await tabs.reveal(lease.id, "owner");
		await tabs.releaseTab(lease.id, "owner", false);
		expect(revealed).toEqual([1]);
		expect(released).toEqual([[1, false]]);
	});

	it("groups created tabs by owning actor even when labels match, and keeps the pages it is asked to keep", async () => {
		const { tabs, released, groups } = harness();
		const first = await tabs.create("about:blank", "actor A", "task A", "Research");
		const second = await tabs.create("about:blank", "actor B", "task B", "Research");
		await tabs.releaseTab(first.id, "actor A", false);
		await tabs.releaseTab(second.id, "actor B", true);
		expect(released).toEqual([
			[10, false],
			[11, true],
		]);
		expect(groups).toEqual([
			[10, "actor A", "Research"],
			[11, "actor B", "Research"],
		]);
		expect(tabs.discover().map(row => row.tabId)).toEqual([10]);
	});

	it("names why a lease or discovered tab went away, and how to get it back", async () => {
		const { tabs, invalidated, released } = harness();
		tabs.upsert(tab(1));
		const original = tabs.discover()[0]!;
		const lease = tabs.claim(original.id, "owner");
		tabs.remove(1);
		tabs.upsert(tab(1));
		expect(() => tabs.claim(original.id, "owner")).toThrow(
			'Chrome tab "Same title" was closed in Chrome. Discover tabs again.',
		);
		await expect(tabs.reveal(lease.id, "owner")).rejects.toThrow("was closed in Chrome. Discover tabs again.");
		const rediscovered = tabs.discover()[0]!;
		const kept = tabs.claim(rediscovered.id, "owner");
		await tabs.releaseTab(kept.id, "owner", false);
		// The page outlived the lease, so the answer is the way back to it.
		expect(() => tabs.get(kept.id, "owner")).toThrow(
			`was released by its owner. Claim ${JSON.stringify(rediscovered.id)} again to drive it.`,
		);
		const replacement = tabs.claim(rediscovered.id, "owner");
		tabs.reset();
		tabs.upsert(tab(1));
		expect(() => tabs.claim(rediscovered.id, "owner")).toThrow(
			"was dropped when the OMP extension in Chrome disconnected. Discover tabs again.",
		);
		expect(() => tabs.get(replacement.id, "owner")).toThrow("was dropped when the OMP extension");
		expect(() => tabs.claim("never-issued", "owner")).toThrow("unknown to this relay");
		expect(invalidated).toEqual([lease.id, kept.id, replacement.id]);
		expect(released).toEqual([[1, false]]);
	});

	it("gives the owner its own lease back on a repeat claim, and lets each claim try the debugger again", () => {
		const { tabs, attachAllowed } = harness();
		tabs.upsert(tab(1));
		const found = tabs.discover()[0]!;
		const lease = tabs.claim(found.id, "owner");
		expect(tabs.claim(found.id, "owner")).toEqual(lease);
		expect(() => tabs.claim(found.id, "other")).toThrow("already owned");
		expect(attachAllowed).toEqual([1, 1]);
	});

	it("moves a popup up to the driving tab when the window that opened it closes", async () => {
		const consentReleased = Promise.withResolvers<void>();
		const { tabs, released } = harness(undefined, async tabId => {
			if (tabId === 3) consentReleased.resolve();
		});
		tabs.upsert(tab(1));
		const driving = tabs.claim(tabs.discover()[0]!.id, "owner");
		// The driving tab opens a sign-in window, which opens the consent page, then closes.
		await tabs.adoptChild(tab(2), 1);
		await tabs.adoptChild(tab(3), 2);
		expect(tabs.discover().find(row => row.tabId === 3)!.popupOf).toBe(
			tabs.discover().find(row => row.tabId === 2)!.id,
		);
		tabs.remove(2);
		expect(tabs.childTabs(driving.id, "owner")).toMatchObject([{ tabId: 3, popupOf: driving.tab.id }]);
		expect(tabs.discover("owner").find(row => row.tabId === 3)).toMatchObject({
			ownership: "this_actor",
			popupOf: driving.tab.id,
		});
		expect(released).toEqual([]);
		// With no opener left above it, an unclaimed popup goes back with the driving tab.
		await tabs.releaseTab(driving.id, "owner", false);
		await consentReleased.promise;
		expect(released).toEqual([
			[1, false],
			[3, false],
		]);
	});
});

// The idle-reclaim path is a real `setTimeout` inside the authority: the tests below
// inject a few-millisecond grace and wait on the platform clock, because faking timers
// would also fake the awaits the reclaim races against.

it("recovers a dead actor after the last connection closes, without closing its page", async () => {
	const { tabs, released } = harness(10);
	const lease = await tabs.create("https://example.com", "owner", "task", "Work");
	tabs.connected(lease.id, 1);
	tabs.connected(lease.id, 2);
	tabs.disconnected(lease.id, 1);
	await Bun.sleep(25);
	expect(tabs.tabForLease(lease.id)).toBe(lease.tab.tabId);
	tabs.disconnected(lease.id, 2);
	await Bun.sleep(25);
	expect(tabs.tabForLease(lease.id)).toBeUndefined();
	expect(() => tabs.get(lease.id, "owner")).toThrow(
		`with no OMP connection. Claim ${JSON.stringify(lease.tab.id)} again to drive it.`,
	);
	expect(tabs.claim(lease.tab.id, "new actor").created).toBe(false);
	expect(released).toEqual([[lease.tab.tabId, false]]);
});

it("allows reconnection during recovery grace and handles never-connected acquisitions", async () => {
	const { tabs, released } = harness(20);
	const lease = await tabs.create("https://example.com", "owner", "task", "Work");
	tabs.connected(lease.id, 1);
	tabs.disconnected(lease.id, 1);
	tabs.connected(lease.id, 2);
	await Bun.sleep(35);
	expect(tabs.tabForLease(lease.id)).toBe(lease.tab.tabId);
	const abandoned = await tabs.create("about:blank", "other", "task", "Work");
	await Bun.sleep(35);
	expect(tabs.tabForLease(abandoned.id)).toBeUndefined();
	expect(released).toEqual([[abandoned.tab.tabId, false]]);
});

it("keeps orphan authority unavailable while admitted work drains", async () => {
	const { tabs, invalidated } = harness(10);
	const lease = await tabs.create("https://example.com", "owner", "task", "Work");
	const finish = tabs.beginOperation(lease.id);
	await Bun.sleep(25);
	expect(invalidated).toContain(lease.id);
	expect(() => tabs.claim(lease.tab.id, "other")).toThrow("already owned");
	finish();
	await Bun.sleep(0);
	expect(tabs.claim(lease.tab.id, "other").created).toBe(false);
});

function toolSession(sessionId: string, settings = Settings.isolated({})): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => sessionId,
		getAgentId: () => "agent",
		settings,
	};
}

it("explains a raw TargetCloseError with Chrome's reason, and a closed tab with why it went away", async () => {
	const relay = startRelayServer({ port: 0 });
	const credential = spyOn(access, "readRelayControlToken").mockReturnValue(relay.access.controlToken);
	const signIn: TabSnapshot = {
		tabId: 1,
		windowId: 1,
		title: "Sign in",
		url: "https://accounts.example.com/signin?continue=https%3A%2F%2Fmail.example.com%2F&flowName=GlifWebSignIn",
		active: false,
		groupId: -1,
		pinned: false,
	};
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
	try {
		relay.instances.extConnected(extension);
		relay.instances.extMessage(
			extension,
			JSON.stringify({
				t: "authenticate",
				auth: { id: "work-profile-fixture", label: "Work", pairingCode: relay.access.issueCode().code },
			}),
		);
		relay.instances.extMessage(
			extension,
			JSON.stringify({
				t: "hello",
				userAgent: "fixture",
				browserVersion: "Chrome/150",
				extensionBuildId: EXPECTED_EXTENSION_BUILD_ID,
				attachedTabIds: [],
				tabs: [signIn],
			}),
		);
		const session = toolSession("explain-fixture");
		const owner = browserActorId(session);
		const found = relay.instances.discover(owner)[0]!;
		const handle: ManagedChromeHandle = {
			id: "explain-handle",
			label: "Oh My Pi",
			owner,
			url: `http://127.0.0.1:${relay.port}`,
			lease: relay.instances.claim(found.id, owner),
		};
		// What puppeteer throws once Chrome drops the debugger under a call.
		const sessionClosed = Object.assign(
			new Error("Protocol error (Runtime.callFunctionOn): Session closed. Most likely the page has been closed."),
			{ name: "TargetCloseError" },
		);
		relay.instances.extMessage(extension, JSON.stringify({ t: "detached", tabId: 1, reason: "target_closed" }));
		const revoked = (await explainRevokedChromeControl(handle, sessionClosed))!.message;
		// Chrome's reason comes before the address, which keeps only origin and path.
		expect(revoked).toStartWith(`Chrome revoked OMP's control of "Sign in": `);
		expect(revoked.indexOf("password manager")).toBeLessThan(revoked.indexOf("https://accounts.example.com/signin"));
		expect(revoked).not.toContain("continue=");
		expect(revoked).toContain(`claim ${JSON.stringify(found.id)} again`);
		// What headless Chrome for Testing produced when a real extension frame landed:
		// the call in flight, then the next call on the page.
		for (const inFlight of [
			Object.assign(new Error("Protocol error (Runtime.evaluate): Detached while handling command."), {
				name: "ProtocolError",
			}),
			new Error("Attempted to use detached Frame '6F2802E97123F398ECC824571324075B'."),
		])
			expect((await explainRevokedChromeControl(handle, inFlight))?.message).toBe(revoked);
		// The user closes the tab: the same failure now says the lease is over, and why.
		relay.instances.extMessage(extension, JSON.stringify({ t: "tabRemoved", tabId: 1 }));
		const gone = 'Chrome tab "Sign in" was closed in Chrome. Discover tabs again.';
		expect((await explainRevokedChromeControl(handle, sessionClosed))?.message).toBe(gone);
		expect(() => requireChromeHandle(handle.id, session)).toThrow(gone);
	} finally {
		credential.mockRestore();
		relay.stop();
	}
});

it("replaces the handle of a tab its actor claims again instead of refusing the claim", async () => {
	// A tab claimed across an open dialog needs no page worker, which keeps this to the relay wire.
	const lease: InstanceLease = {
		id: "held-lease",
		targetId: "PAGE7",
		created: false,
		browserId: "profile",
		browserLabel: "Work",
		dialog: {
			status: "open",
			dialog: { id: "pending", type: "alert", message: "Wait", url: "https://fixture.test", defaultPrompt: "" },
		},
		tab: {
			...tab(7),
			title: "Review",
			id: "page-7",
			browserId: "profile",
			browserLabel: "Work",
			ownership: "this_actor",
		},
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname === "/health") return Response.json({ service: "omp-browser", protocol: 2 });
			const body = (await request.json()) as { action?: string };
			// The relay answers a repeat claim by the same actor with the lease it already holds.
			if (body.action === "claim") return Response.json(lease);
			return Response.json({});
		},
	});
	const ensure = spyOn(daemon, "ensureRelayDaemon").mockResolvedValue(true);
	const token = spyOn(access, "readRelayControlToken").mockReturnValue("fixture-token");
	const session = toolSession(
		"reclaim-fixture",
		Settings.isolated({
			"browser.enabled": true,
			"browser.relay": true,
			"browser.relayUrl": `http://127.0.0.1:${server.port}`,
		}),
	);
	try {
		const first = await acquireChromeTab(session, { action: "claim", id: "page-7", timeoutMs: 1000 });
		const second = await acquireChromeTab(session, { action: "claim", id: "page-7", timeoutMs: 1000 });
		expect(second.lease.id).toBe(first.lease.id);
		expect(requireChromeHandle(second.id, session)).toBe(second);
		expect(() => requireChromeHandle(first.id, session)).toThrow(
			'Chrome tab "Review" was claimed again, which replaced this handle. Claim "page-7" again to drive it.',
		);
	} finally {
		await releaseDeferredChromeTabsForOwner("reclaim-fixture");
		token.mockRestore();
		ensure.mockRestore();
		server.stop(true);
	}
});
