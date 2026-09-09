import { expect, it } from "bun:test";
import { groupTab, releaseOwnerGroups } from "../extension/tab-groups";

it("reuses one group per owner and window, never re-titling it or adopting a human's same-title group", async () => {
	let stored: Record<string, unknown> = {};
	const groups = [{ id: 20, windowId: 1, title: "Reservation" }]; // A human's same-title group.
	const tabs = new Map([
		[1, { id: 1, windowId: 1 }],
		[2, { id: 2, windowId: 1 }],
		[3, { id: 3, windowId: 2 }],
		[4, { id: 4, windowId: 1, pinned: true }],
	]);
	const updates: Array<{ id: number; title: string }> = [];
	const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: {
			storage: {
				session: {
					get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...stored }),
					set: async (values: Record<string, unknown>) => {
						stored = { ...stored, ...values };
					},
				},
			},
			tabs: {
				get: async (id: number) => tabs.get(id),
				group: async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
					if (groupId !== undefined) return groupId;
					const id = 20 + groups.length;
					groups.push({ id, windowId: tabs.get(tabIds[0]!)!.windowId, title: "" });
					return id;
				},
			},
			tabGroups: {
				query: async ({ windowId }: { windowId: number }) => groups.filter(group => group.windowId === windowId),
				update: async (id: number, { title }: { title: string }) => {
					updates.push({ id, title });
					groups.find(group => group.id === id)!.title = title;
				},
			},
		},
	});
	try {
		expect(await groupTab(1, "owner", "Reservation")).toEqual({ groupId: 21 });
		groups.find(group => group.id === 21)!.title = "My saved reservation"; // The human renames it.
		// Same owner and window: the remembered group is reused, not re-titled.
		expect(await groupTab(2, "owner", "Reservation")).toEqual({ groupId: 21 });
		// Same owner, second window: its own group.
		expect(await groupTab(3, "owner", "Reservation")).toEqual({ groupId: 22 });
		// Another actor never lands in this owner's group.
		expect(await groupTab(2, "other-owner", "Reservation")).toEqual({ groupId: 23 });
		// Grouping silently unpins, so pinned tabs are left alone.
		expect(await groupTab(4, "owner", "Reservation")).toEqual({});
		expect(await groupTab(99, "owner", "Reservation")).toEqual({}); // Closed tab.
		expect(groups.find(group => group.id === 20)!.title).toBe("Reservation");
		expect(groups.find(group => group.id === 21)!.title).toBe("My saved reservation");
		expect(updates).toEqual([
			{ id: 21, title: "Reservation" },
			{ id: 22, title: "Reservation" },
			{ id: 23, title: "Reservation" },
		]);
	} finally {
		if (original) Object.defineProperty(globalThis, "chrome", original);
		else Reflect.deleteProperty(globalThis, "chrome");
	}
});

it("ungroups only the groups it created when relay authority is lost for good", async () => {
	let stored: Record<string, unknown> = { ownerGroups: { '["owner",1]': 21, '["owner",2]': 22 } };
	const grouped: Record<number, number[]> = { 20: [9], 21: [1, 2], 22: [3] }; // 20 is a human's group.
	const ungrouped: number[] = [];
	const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: {
			storage: {
				session: {
					get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...stored }),
					set: async (values: Record<string, unknown>) => {
						stored = { ...stored, ...values };
					},
				},
			},
			tabs: {
				query: async ({ groupId }: { groupId: number }) => (grouped[groupId] ?? []).map(id => ({ id })),
				ungroup: async (tabIds: number[]) => {
					ungrouped.push(...tabIds);
				},
			},
		},
	});
	try {
		expect((await releaseOwnerGroups()).sort()).toEqual([1, 2, 3]);
		expect(ungrouped.sort()).toEqual([1, 2, 3]);
		// The human's group is untouched, and a second loss finds nothing of ours.
		expect(ungrouped).not.toContain(9);
		expect(await releaseOwnerGroups()).toEqual([]);
	} finally {
		if (original) Object.defineProperty(globalThis, "chrome", original);
		else Reflect.deleteProperty(globalThis, "chrome");
	}
});
