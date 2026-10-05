import { describe, expect, it } from "bun:test";
import { describeChanges, treeRows } from "@oh-my-pi/pi-coding-agent/tools/computer/change-summary";
import type { DesktopWindow } from "@oh-my-pi/pi-natives";

const reminders: DesktopWindow = {
	id: "7",
	title: "Groceries",
	app: "Reminders",
	pid: 1,
	x: 0,
	y: 0,
	width: 800,
	height: 600,
	focused: true,
};

const before = treeRows(
	[
		'- window "Groceries" [ref=e1] app=Reminders (focused)',
		'  - checkbox "Milk" [ref=e2]: "0"',
		'  - button "Delete" [ref=e3]',
		"… truncated (800 nodes)",
	].join("\n"),
);

describe("computer input change summary", () => {
	it("lists changed, added and removed rows with their refs", () => {
		const after = treeRows(
			[
				'- window "Groceries" [ref=e1] app=Reminders (focused)',
				'  - checkbox "Milk" [ref=e2]: "1"',
				'  - row "Eggs" [ref=e9]',
			].join("\n"),
		);
		expect(
			describeChanges({
				label: "press e2",
				windowsBefore: [reminders],
				windowsAfter: [reminders],
				target: reminders,
				before,
				after,
			}),
		).toBe(
			[
				'press e2 → Reminders "Groceries" [7] (focused):',
				'~ checkbox "Milk" [ref=e2]: "1" (was: checkbox "Milk": "0")',
				'+ row "Eggs" [ref=e9]',
				'- button "Delete" [ref=e3]',
			].join("\n"),
		);
	});

	it("reports opened and closed windows and an unchanged tree", () => {
		const sheet: DesktopWindow = { ...reminders, id: "8", title: "Save", focused: true };
		const background = { ...reminders, focused: false };
		const closed: DesktopWindow = { ...reminders, id: "5", title: "Old", focused: false };
		expect(
			describeChanges({
				label: "press cmd+s",
				windowsBefore: [reminders, closed],
				windowsAfter: [background, sheet],
				target: background,
				before,
				after: before,
			}),
		).toBe(
			[
				'press cmd+s → Reminders "Groceries" [7]:',
				'opened window Reminders "Save" [8] (focused)',
				'closed window Reminders "Old" [5]',
				"no change in its accessibility tree",
			].join("\n"),
		);
	});

	it("counts changes past the line budget instead of listing them", () => {
		const rows = Array.from({ length: 40 }, (_, index) => `  - row "Item ${index}" [ref=e${index + 10}]`);
		const summary = describeChanges({
			label: "click 10,10",
			windowsBefore: [reminders],
			windowsAfter: [reminders],
			target: reminders,
			before: new Map(),
			after: treeRows(rows.join("\n")),
		});
		const lines = summary.split("\n");
		expect(lines).toHaveLength(32);
		expect(lines.at(-1)).toBe("… 10 more changes; ax() shows the whole tree");
	});
});
