import { describe, expect, it } from "bun:test";
import { ManagedChromeTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/managed-tabs";
import type { TabSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";

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
	let nextTab = 10;
	const tabs = new ManagedChromeTabs(
		{
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
		},
		{ orphanGraceMs },
	);
	return { tabs, released, revealed, invalidated, groups };
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
		await expect(tabs.closeTab(first!.id, "owner")).rejects.toThrow("stale");
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
		expect(() => tabs.beginOperation(lease.id)).toThrow("no longer valid");
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
			create: async () => ({ ...tab(1), url: "", title: "" }),
			group: async () => tabs.upsert({ ...tab(1), title: "Ready", groupId: 42 }),
			release: async () => {},
			reveal: async () => {},
			invalidate: () => {},
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
		expect(() => tabs.beginOperation(lease.id)).toThrow("no longer valid");
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

	it("invalidates discovery and ownership across removal and transport generations", async () => {
		const { tabs, invalidated, released } = harness();
		tabs.upsert(tab(1));
		const original = tabs.discover()[0]!;
		const lease = tabs.claim(original.id, "owner");
		tabs.remove(1);
		tabs.upsert(tab(1));
		expect(() => tabs.claim(original.id, "owner")).toThrow("stale");
		await expect(tabs.reveal(lease.id, "owner")).rejects.toThrow("stale");
		const rediscovered = tabs.discover()[0]!;
		const replacement = tabs.claim(rediscovered.id, "owner");
		tabs.reset();
		tabs.upsert(tab(1));
		expect(() => tabs.claim(rediscovered.id, "owner")).toThrow("stale");
		expect(invalidated).toEqual([lease.id, replacement.id]);
		expect(released).toEqual([]);
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
