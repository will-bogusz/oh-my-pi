/**
 * One tab group per owner per window, created on first use and reused by every
 * later claim; a human group with the same title is unrelated. Group identity
 * lives in session storage so a service-worker restart rejoins the same group
 * instead of minting a second one.
 */
export async function groupTab(tabId: number, owner: string, label: string): Promise<{ groupId?: number }> {
	let tab: ChromeTab | undefined;
	try {
		tab = await chrome.tabs.get(tabId);
	} catch {
		// Tab already closed.
	}
	// Grouping silently unpins; never touch pinned tabs.
	if (!tab || tab.pinned || tab.id === undefined) return {};
	const stored = await chrome.storage.session.get({ ownerGroups: {} });
	const groups = (stored.ownerGroups && typeof stored.ownerGroups === "object" ? stored.ownerGroups : {}) as Record<
		string,
		number
	>;
	const key = JSON.stringify([owner, tab.windowId]);
	const existing = (await chrome.tabGroups.query({ windowId: tab.windowId })).find(group => group.id === groups[key]);
	let groupId: number;
	if (existing) {
		groupId = existing.id;
		await chrome.tabs.group({ tabIds: [tab.id], groupId });
	} else {
		groupId = await chrome.tabs.group({ tabIds: [tab.id] });
		await chrome.tabGroups.update(groupId, { title: label, color: "cyan" });
	}
	groups[key] = groupId;
	await chrome.storage.session.set({ ownerGroups: groups });
	return { groupId };
}

/**
 * Take every tab out of the groups this extension created and forget them.
 * Used when relay authority is lost for good: the relay that owned those
 * leases is gone, so nothing else will ever ungroup them, and a tab left in an
 * "Oh My Pi" group looks driven forever (and drags a saved group chip along).
 * Group ids come from our own session-storage memo, so a human group with the
 * same title is never touched.
 */
export async function releaseOwnerGroups(): Promise<number[]> {
	const stored = await chrome.storage.session.get({ ownerGroups: {} });
	const groups = (stored.ownerGroups && typeof stored.ownerGroups === "object" ? stored.ownerGroups : {}) as Record<
		string,
		number
	>;
	await chrome.storage.session.set({ ownerGroups: {} });
	const released: number[] = [];
	for (const groupId of new Set(Object.values(groups))) {
		const tabs = await chrome.tabs.query({ groupId }).catch(() => [] as ChromeTab[]);
		const tabIds = tabs.map(tab => tab.id).filter((id): id is number => id !== undefined);
		if (!tabIds.length) continue;
		await chrome.tabs.ungroup(tabIds).catch(() => {});
		released.push(...tabIds);
	}
	return released;
}
