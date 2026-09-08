import { expect, it } from "bun:test";
import { groupTabs } from "../extension/task-groups";

it("keeps the first task label across scratch tabs/windows and preserves human group renames", async () => {
	let stored: Record<string, unknown> = {};
	const groups = [{ id: 20, windowId: 1, title: "Reservation" }]; // A human's same-title group.
	const tabs = new Map([
		[1, { id: 1, windowId: 1 }],
		[2, { id: 2, windowId: 1 }],
		[3, { id: 3, windowId: 2 }],
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
		await groupTabs([1], "Reservation", "cyan", "task");
		groups.find(group => group.id === 21)!.title = "My saved reservation";
		await groupTabs([2], "Workshop details scratch", "cyan", "task");
		await groupTabs([3], "Another scratch", "cyan", "task");
		expect(groups.find(group => group.id === 20)!.title).toBe("Reservation");
		expect(groups.find(group => group.id === 21)!.title).toBe("My saved reservation");
		expect(updates).toEqual([
			{ id: 21, title: "Reservation" },
			{ id: 22, title: "Reservation" },
		]);
	} finally {
		if (original) Object.defineProperty(globalThis, "chrome", original);
		else Reflect.deleteProperty(globalThis, "chrome");
	}
});
