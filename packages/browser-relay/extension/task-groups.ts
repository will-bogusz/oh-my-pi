/** Group identity is task/window scoped; a human group with the same label is unrelated. */
export async function groupTabs(tabIds: number[], title: string, color: string, taskId = "legacy"): Promise<{ grouped: Record<string, number> }> {
	const stored = await chrome.storage.session.get({ taskGroups: {}, taskLabels: {} });
	const groups = (stored.taskGroups && typeof stored.taskGroups === "object" ? stored.taskGroups : {}) as Record<string, number>;
	const labels = (stored.taskLabels && typeof stored.taskLabels === "object" ? stored.taskLabels : {}) as Record<string, string>;
	const taskTitle = typeof labels[taskId] === "string" ? labels[taskId]! : title;
	labels[taskId] = taskTitle;
	const byWindow = new Map<number, number[]>();
	for (const tabId of tabIds) {
		try {
			const tab = await chrome.tabs.get(tabId);
			// Grouping silently unpins; never touch pinned tabs.
			if (tab.pinned || tab.id === undefined) continue;
			const bucket = byWindow.get(tab.windowId) ?? [];
			bucket.push(tab.id);
			byWindow.set(tab.windowId, bucket);
		} catch {
			// Tab already closed.
		}
	}
	const grouped: Record<string, number> = {};
	for (const [windowId, ids] of byWindow) {
		const key = JSON.stringify([taskId, windowId]);
		const existing = (await chrome.tabGroups.query({ windowId })).find(group => group.id === groups[key]);
		let groupId: number;
		if (existing) {
			groupId = existing.id;
			await chrome.tabs.group({ tabIds: ids, groupId });
		} else {
			groupId = await chrome.tabs.group({ tabIds: ids });
			await chrome.tabGroups.update(groupId, { title: taskTitle, color });
		}
		groups[key] = groupId;
		for (const id of ids) grouped[String(id)] = groupId;
	}
	await chrome.storage.session.set({ taskGroups: groups, taskLabels: labels });
	return { grouped };
}

