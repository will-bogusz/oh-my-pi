import { expect, test } from "bun:test";
import { DialogJournal, parseDialogRequest } from "@oh-my-pi/pi-coding-agent/tools/browser/dialogs";

test("dialog generations prevent stale responses and a late acknowledgement cannot clear the next dialog", async () => {
	const journal = new DialogJournal();
	expect(journal.snapshot().status).toBe("unobserved");
	journal.opened({ type: "prompt", message: "Name", defaultPrompt: "Draft" });
	const first = journal.snapshot().dialog!;
	let sent = 0;
	await expect(
		journal.resolve({ action: "dismiss", id: "foreign" }, async () => {
			sent++;
		}),
	).rejects.toThrow("stale");
	await expect(
		journal.resolve({ action: "dismiss", id: first.id, promptText: "Wrong" }, async () => {
			sent++;
		}),
	).rejects.toThrow("promptText");
	expect(sent).toBe(0);
	const pending = Promise.withResolvers<void>();
	const response = journal.resolve({ action: "accept", id: first.id, promptText: "café Ω" }, async params => {
		expect(params).toEqual({ accept: true, promptText: "café Ω" });
		await pending.promise;
	});
	await expect(journal.resolve({ action: "accept", id: first.id }, async () => {})).rejects.toThrow(
		"already in flight",
	);
	journal.closed();
	journal.opened({ type: "confirm", message: "Approve?" });
	const next = journal.snapshot().dialog!;
	pending.resolve();
	await response;
	expect(journal.snapshot().dialog?.id).toBe(next.id);
	expect(next.id).not.toBe(first.id);
	await expect(
		journal.resolve({ action: "accept", id: next.id }, async () => {
			throw new Error("Reply lost");
		}),
	).rejects.toThrow("uncertain");
	expect(journal.snapshot()).toEqual({ status: "unobserved", dialog: null });
	await expect(journal.resolve({ action: "accept", id: next.id }, async () => {})).rejects.toThrow("stale");
	expect(() => parseDialogRequest({ action: "inspect", promptText: "Unrequested" })).toThrow("Inspect");
	expect(() => parseDialogRequest({ action: "accept" })).toThrow("current dialog id");
});
