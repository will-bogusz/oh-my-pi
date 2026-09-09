import { expect, it } from "bun:test";
import { DebuggerAttachments, ownedDebuggerTabs } from "../extension/debugger-ownership";

/** Records detach calls; `failing` tabs refuse to detach, as a closed tab would. */
function chromeDebugger(failing: readonly number[] = []): {
	detached: number[];
	detach: (tabId: number) => Promise<void>;
} {
	const detached: number[] = [];
	return {
		detached,
		detach: async (tabId: number): Promise<void> => {
			if (failing.includes(tabId)) throw new Error(`cannot detach ${tabId}`);
			detached.push(tabId);
		},
	};
}

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

it("releases every attachment when the relay socket stays closed past the grace window", async () => {
	const chrome = chromeDebugger();
	const attachments = new DebuggerAttachments({ ...chrome, graceMs: 0 });
	attachments.attached(1);
	attachments.attached(2);
	const released = attachments.scheduleRelease();
	// Nothing is given up before the window elapses.
	expect(chrome.detached).toEqual([]);
	expect((await released).sort()).toEqual([1, 2]);
	expect(attachments.tabs()).toEqual([]);
});

it("keeps attachments across a relay reconnect inside the grace window", async () => {
	const chrome = chromeDebugger();
	const attachments = new DebuggerAttachments({ ...chrome, graceMs: 0 });
	attachments.attached(7);
	const released = attachments.scheduleRelease();
	attachments.hold();
	expect(await released).toEqual([]);
	expect(chrome.detached).toEqual([]);
	expect(attachments.tabs()).toEqual([7]);
});

it("hands the tabs back before the attachments go, and never when the relay reconnects", async () => {
	const chrome = chromeDebugger();
	const order: string[] = [];
	const attachments = new DebuggerAttachments({
		detach: async tabId => {
			order.push(`detach ${tabId}`);
			await chrome.detach(tabId);
		},
		graceMs: 0,
		surrender: async held => {
			// The badge restore rides the attachment, so it has to run first.
			order.push(`surrender ${[...held].sort().join(",")}`);
		},
	});
	attachments.attached(1);
	attachments.attached(2);
	expect((await attachments.scheduleRelease()).sort()).toEqual([1, 2]);
	expect(order[0]).toBe("surrender 1,2");
	expect(order.slice(1).sort()).toEqual(["detach 1", "detach 2"]);

	const kept = new DebuggerAttachments({
		...chromeDebugger(),
		graceMs: 0,
		surrender: async () => order.push("surrender-after-hold"),
	});
	kept.attached(3);
	const released = kept.scheduleRelease();
	kept.hold();
	expect(await released).toEqual([]);
	expect(order).not.toContain("surrender-after-hold");
});

it("still releases the attachments when handing the tabs back fails", async () => {
	const chrome = chromeDebugger();
	const attachments = new DebuggerAttachments({
		...chrome,
		graceMs: 0,
		surrender: () => Promise.reject(new Error("page is gone")),
	});
	attachments.attached(6);
	expect(await attachments.scheduleRelease()).toEqual([6]);
	expect(chrome.detached).toEqual([6]);
});

it("detaches only the requested tabs and reports what Chrome confirmed", async () => {
	const chrome = chromeDebugger([2]);
	const attachments = new DebuggerAttachments({ ...chrome });
	for (const tabId of [1, 2, 3]) attachments.attached(tabId);
	expect(await attachments.detachAll([1, 2, 9])).toEqual([1]);
	// A refused detach is forgotten too: the next hello re-seeds the truth.
	expect(attachments.tabs()).toEqual([3]);
});

it("forgets attachments Chrome tore down itself, so a later release cannot double-detach", async () => {
	const chrome = chromeDebugger();
	const attachments = new DebuggerAttachments({ ...chrome, graceMs: 0 });
	attachments.attached(4);
	attachments.attached(5);
	attachments.detached(4);
	expect(await attachments.scheduleRelease()).toEqual([5]);
	expect(chrome.detached).toEqual([5]);
});

it("fires detaches synchronously on worker unload and settles the pending release", async () => {
	const chrome = chromeDebugger();
	const attachments = new DebuggerAttachments({ ...chrome, graceMs: 0 });
	attachments.attached(8);
	const released = attachments.scheduleRelease();
	attachments.releaseNow();
	expect(attachments.tabs()).toEqual([]);
	// The armed window must not fire a second detach for the same tab.
	expect(await released).toEqual([]);
	expect(chrome.detached).toEqual([8]);
});
