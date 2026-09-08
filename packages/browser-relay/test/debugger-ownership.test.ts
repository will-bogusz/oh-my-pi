import { expect, it } from "bun:test";
import { ownedDebuggerTabs } from "../extension/debugger-ownership";

it("reports only attachments the extension can actually use, without attaching targets", async () => {
	const probes: number[] = [];
	const targets = [
		{ attached: true, tabId: 1 }, // Other CDP client, e.g. browser-launch setup.
		{ attached: true, tabId: 2 }, // This extension's surviving attachment.
		{ attached: false, tabId: 3 },
		{ attached: true }, // Worker without a tab id.
	];
	const owned = await ownedDebuggerTabs(targets, async tabId => {
		probes.push(tabId);
		if (tabId === 1) throw new Error("Debugger is not attached to the tab with id: 1");
		return { targetInfo: { targetId: "page2" } };
	});
	expect(owned).toEqual([2]);
	expect(probes).toEqual([1, 2]);
});
