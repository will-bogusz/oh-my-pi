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

function harness(orphanGraceMs?: number, close?: (tabId: number) => Promise<void>) {
	const closed: number[] = [];
	const revealed: number[] = [];
	const invalidated: string[] = [];
	const groups: Array<[number, string, string]> = [];
	let nextTab = 10;
	const tabs = new ManagedChromeTabs(
		{
			create: async () => tab(nextTab++),
			group: async (tabId, task, label) => {
				groups.push([tabId, task, label]);
			},
			close: async tabId => {
				closed.push(tabId);
				await close?.(tabId);
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
	return { tabs, closed, revealed, invalidated, groups };
}

describe("managed Chrome physical tab ownership", () => {
	it("closes an exact unclaimed tab without altering an identical sibling or grouping and revealing it", async () => {
		const { tabs, closed, groups, revealed } = harness();
		tabs.upsert(tab(1));
		tabs.upsert(tab(2));
		const [first, sibling] = tabs.discover();
		await tabs.closeTab(first!.id, "owner");
		expect(closed).toEqual([1]);
		expect(tabs.discover()).toEqual([sibling!]);
		expect(groups).toEqual([]);
		expect(revealed).toEqual([]);
		await expect(tabs.closeTab(first!.id, "owner")).rejects.toThrow("stale");
	});

	it("explicitly closes adopted and retained tabs while rejecting another actor's authority", async () => {
		const { tabs, closed } = harness();
		tabs.upsert(tab(1));
		const adopted = tabs.claim(tabs.discover()[0]!.id, "owner");
		await expect(tabs.closeTab(adopted.tab.id, "other")).rejects.toThrow("another actor");
		expect(tabs.get(adopted.id, "owner").tab.tabId).toBe(1);
		await tabs.close(adopted.id, "owner");
		const retained = await tabs.create("https://example.com", "owner", "task", "Result");
		tabs.retain(retained.id, "owner");
		await tabs.release(retained.id, "owner");
		await tabs.closeTab(retained.tab.id, "owner");
		expect(closed).toEqual([1, retained.tab.tabId]);
		expect(tabs.discover()).toEqual([]);
	});

	it("drains accepted work before closure and prevents late actions or competing claims", async () => {
		const { tabs, closed } = harness();
		tabs.upsert(tab(1));
		const lease = tabs.claim(tabs.discover()[0]!.id, "owner");
		const finish = tabs.beginOperation(lease.id);
		const closing = tabs.closeTab(lease.tab.id, "owner");
		expect(closed).toEqual([]);
		expect(() => tabs.beginOperation(lease.id)).toThrow("no longer valid");
		expect(() => tabs.claim(lease.tab.id, "other")).toThrow("already owned");
		finish();
		await closing;
		expect(closed).toEqual([1]);
		expect(tabs.discover()).toEqual([]);
	});

	it("never closes a replacement that reused the tab number while accepted work drained", async () => {
		const { tabs, closed } = harness();
		tabs.upsert(tab(1));
		const lease = tabs.claim(tabs.discover()[0]!.id, "owner");
		const finish = tabs.beginOperation(lease.id);
		const closing = tabs.close(lease.id, "owner");
		tabs.reset();
		tabs.upsert(tab(1));
		const replacement = tabs.claim(tabs.discover()[0]!.id, "other");
		finish();
		await expect(closing).rejects.toThrow("changed during closure");
		expect(closed).toEqual([]);
		expect(tabs.get(replacement.id, "other").tab.tabId).toBe(1);
	});

	it("cancels closure before dispatch and leaves the page available for rediscovery", async () => {
		const { tabs, closed } = harness();
		tabs.upsert(tab(1));
		const lease = tabs.claim(tabs.discover()[0]!.id, "owner");
		const finish = tabs.beginOperation(lease.id);
		const controller = new AbortController();
		const closing = tabs.close(lease.id, "owner", controller.signal);
		controller.abort();
		finish();
		await expect(closing).rejects.toThrow();
		expect(closed).toEqual([]);
		expect(tabs.discover()[0]!.ownership).toBe("available");
		expect(tabs.claim(lease.tab.id, "next").tab.tabId).toBe(1);
	});

	it("reports extension closure failure without pretending the page disappeared or locking it indefinitely", async () => {
		const { tabs, closed } = harness(undefined, async () => {
			throw new Error("Browser refused closure");
		});
		tabs.upsert(tab(1));
		const found = tabs.discover()[0]!;
		await expect(tabs.closeTab(found.id, "owner")).rejects.toThrow("Browser refused closure");
		expect(closed).toEqual([1]);
		expect(tabs.discover()).toEqual([found]);
		expect(tabs.claim(found.id, "next").tab.tabId).toBe(1);
	});

	it("returns metadata observed during creation and refreshes it without changing lease identity", async () => {
		const tabs = new ManagedChromeTabs({
			create: async () => ({ ...tab(1), url: "", title: "" }),
			group: async () => tabs.upsert({ ...tab(1), title: "Ready", groupId: 42 }),
			close: async () => {},
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

	it("keeps a releasing tab unavailable until admitted CDP work has settled", async () => {
		const { tabs, closed } = harness();
		tabs.upsert(tab(1));
		const found = tabs.discover()[0]!;
		const lease = tabs.claim(found.id, "owner");
		const finish = tabs.beginOperation(lease.id);
		let released = false;
		const releasing = tabs.release(lease.id, "owner").then(() => {
			released = true;
		});
		await Promise.resolve();
		expect(released).toBe(false);
		expect(() => tabs.claim(found.id, "another actor")).toThrow("already owned");
		expect(() => tabs.beginOperation(lease.id)).toThrow("no longer valid");
		finish();
		await releasing;
		expect(tabs.claim(found.id, "another actor").targetId).toBe("PAGE1");
		expect(closed).toEqual([]);
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

	it("requires matching actor for reveal, retention and release without closing adopted tabs", async () => {
		const { tabs, closed, revealed } = harness();
		tabs.upsert(tab(1));
		const lease = tabs.claim(tabs.discover()[0]!.id, "owner");
		await expect(tabs.reveal(lease.id, "other")).rejects.toThrow("another actor");
		expect(() => tabs.retain(lease.id, "other")).toThrow("another actor");
		await expect(tabs.release(lease.id, "other")).rejects.toThrow("another actor");
		expect(revealed).toEqual([]);
		await tabs.reveal(lease.id, "owner");
		await tabs.release(lease.id, "owner");
		expect(revealed).toEqual([1]);
		expect(closed).toEqual([]);
	});

	it("retains task results and groups by task identity even when labels match", async () => {
		const { tabs, closed, groups } = harness();
		const first = await tabs.create("about:blank", "actor A", "task A", "Research");
		const second = await tabs.create("about:blank", "actor B", "task B", "Research");
		tabs.retain(first.id, "actor A");
		await tabs.release(first.id, "actor A");
		await tabs.release(second.id, "actor B");
		expect(closed).toEqual([11]);
		expect(groups).toEqual([
			[10, "task A", "Research"],
			[11, "task B", "Research"],
		]);
	});

	it("invalidates discovery and ownership across removal and transport generations", async () => {
		const { tabs, invalidated, closed } = harness();
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
		expect(closed).toEqual([]);
	});
});

it("recovers a dead actor after the last connection closes, without closing its page", async () => {
	const { tabs, closed } = harness(10);
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
	expect(closed).toEqual([]);
});

it("allows reconnection during recovery grace and handles never-connected acquisitions", async () => {
	const { tabs, closed } = harness(20);
	const lease = await tabs.create("https://example.com", "owner", "task", "Work");
	tabs.connected(lease.id, 1);
	tabs.disconnected(lease.id, 1);
	tabs.connected(lease.id, 2);
	await Bun.sleep(35);
	expect(tabs.tabForLease(lease.id)).toBe(lease.tab.tabId);
	const abandoned = await tabs.create("about:blank", "other", "task", "Work");
	await Bun.sleep(35);
	expect(tabs.tabForLease(abandoned.id)).toBeUndefined();
	expect(closed).toEqual([]);
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

it("preserving release drains work and makes a created page recoverable without a retention round trip", async () => {
	const { tabs, closed } = harness();
	const lease = await tabs.create("https://example.test/draft", "owner", "task", "Draft");
	await expect(tabs.releasePreserving(lease.id, "other")).rejects.toThrow("another actor");
	const finish = tabs.beginOperation(lease.id);
	const releasing = tabs.releasePreserving(lease.id, "owner");
	expect(() => tabs.beginOperation(lease.id)).toThrow("no longer valid");
	expect(() => tabs.claim(lease.tab.id, "next")).toThrow("already owned");
	finish();
	await releasing;
	expect(closed).toEqual([]);
	const resumed = tabs.claim(lease.tab.id, "next");
	expect(resumed.targetId).toBe(lease.targetId);
	await tabs.release(resumed.id, "next");
	expect(closed).toEqual([]);
});
