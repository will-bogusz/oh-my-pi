/**
 * Contract tests for the computer tool's inline byte cap: an over-cap
 * observation loses its least load-bearing parts (long `value=` text, rows with
 * neither text nor an action, the deepest subtrees) instead of a contiguous
 * band of lines. The fixture is the bench T7 run's real 188 kB print-pane
 * observation, whose controls sat inside the band the middle cut removed
 * (`research/bench-set-20260911/after-fixes-20260913.md` §4.5).
 */
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_BYTES, enforceInlineByteCap } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import { elideObservationTree } from "@oh-my-pi/pi-coding-agent/tools/computer/tree-elide";

const MIDDLE_CUT_MARKER = /\[…\d+B elided…\]/;
const NOTICE = /^\[elided: (?:\d+ rows?)(?:, \d+ values?)?\]$/m;

const fixture = await Bun.file(
	path.join(import.meta.dirname, "../fixtures/computer-print-pane-observation.txt"),
).text();

describe("computer observation inline cap", () => {
	it("keeps the print pane's actionable rows when the observation is elided under budget", async () => {
		expect(Buffer.byteLength(fixture, "utf-8")).toBeGreaterThan(DEFAULT_MAX_BYTES);

		const capped = await enforceInlineByteCap(fixture, {
			elide: elideObservationTree,
			saveArtifact: () => "7",
		});

		expect(Buffer.byteLength(capped, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(capped).not.toMatch(MIDDLE_CUT_MARKER);
		expect(capped).toMatch(NOTICE);
		expect(capped).toContain("[raw output: artifact://7]");

		// The controls the model had to go hunting for, with their actions intact.
		expect(capped).toContain('- [n3830] AXButton "More settings" enabled=true selected=false actions=');
		expect(capped).toContain('- [n3833] AXButton "Save" enabled=true selected=false actions=');
		expect(capped).toContain('- [n3831] AXButton "Cancel"');
		// A short value still answers "what is the destination?".
		expect(capped).toContain('- [n3824] AXPopUpButton "Destination" value="Save as PDF"');
		// The window header and the completeness notice are not tree rows and survive.
		expect(capped).toContain("Google Chrome: Untitled window (window 6116, PID 588)");
		expect(capped).toContain("Partial accessibility tree; omitted controls remain unknown.");
	});

	it("elides page prose before controls and leaves a valid pruned tree", () => {
		const elided = elideObservationTree(fixture, DEFAULT_MAX_BYTES - 192);
		if (!elided) throw new Error("expected the fixture to elide structurally");
		const lines = elided.text.split("\n");

		// The 8.5 kB article paragraph is gone; no surviving row carries a value
		// longer than the largest limit the elider tried.
		for (const line of lines) {
			const value = / value="((?:[^"\\]|\\.)*)"/.exec(line);
			if (value) expect(value[1]?.length).toBeLessThanOrEqual(513);
		}

		// Rows are dropped with their whole subtree, so indentation never gains
		// more than one level between consecutive rows the input did not already
		// jump (the driver's own render jumps once, at n4217).
		let previous = -1;
		const jumps: string[] = [];
		for (const line of lines) {
			const row = /^((?:  )*)- \[/.exec(line);
			if (!row) continue;
			const depth = (row[1]?.length ?? 0) / 2;
			if (previous >= 0 && depth > previous + 1) jumps.push(line);
			previous = depth;
		}
		expect(jumps).toHaveLength(1);
		expect(jumps[0]).toContain("[n4217]");
	});

	it("leaves a sub-cap observation untouched", async () => {
		const text = [
			"Preview: Untitled window (window 1, PID 2)",
			'- [n1] AXWindow "Preview"',
			'  - [n2] AXButton "Save" enabled=true actions=["press"]',
		].join("\n");
		expect(await enforceInlineByteCap(text, { elide: elideObservationTree })).toBe(text);
	});

	it("falls back to the middle cut for results that are not rendered trees", async () => {
		const json = `${JSON.stringify({ rows: Array.from({ length: 4000 }, (_, index) => ({ index })) }, null, 2)}\n`;
		expect(Buffer.byteLength(json, "utf-8")).toBeGreaterThan(DEFAULT_MAX_BYTES);

		expect(elideObservationTree(json, DEFAULT_MAX_BYTES - 192)).toBeUndefined();

		const capped = await enforceInlineByteCap(json, { elide: elideObservationTree });
		expect(capped).toMatch(MIDDLE_CUT_MARKER);
		expect(capped).not.toMatch(NOTICE);
		expect(Buffer.byteLength(capped, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	it("drops decorative rows and separators before rows carrying help text or an action", () => {
		const rows = [
			'- [n1] AXWindow "Export"',
			'  - [n2] AXButton "Export" enabled=true actions=["press"]',
			'  - [n3] AXImage "" help="Progress spinner"',
			// The T4 shape: the context menu is this row's only route, so the row
			// is as load-bearing as one advertising `press`.
			'  - [n4] AXTextField "Buy milk" value="Buy milk" actions=["show_menu"]',
			'  - [n5] AXPopover "" actions=["cancel"]',
			...Array.from({ length: 400 }, (_, index) => `  - [d${index}] AXImage "" value=""`),
			...Array.from({ length: 400 }, (_, index) => `  - [s${index}] AXMenuItem "" actions=["press","pick"]`),
		];
		const text = rows.join("\n");
		// Stripping the empty values alone saves ~3.6 kB, so this budget forces
		// rows out; the separators go even though they advertise `press`.
		const elided = elideObservationTree(text, Buffer.byteLength(text, "utf-8") - 12_000);
		if (!elided) throw new Error("expected the tree to elide structurally");

		expect(elided.text).toContain('- [n2] AXButton "Export" enabled=true actions=["press"]');
		expect(elided.text).toContain('- [n3] AXImage "" help="Progress spinner"');
		// Its value repeats the label, so only that redundancy goes.
		expect(elided.text).toContain('- [n4] AXTextField "Buy milk" actions=["show_menu"]');
		expect(elided.text).not.toContain("[n5]");
		expect(elided.text).not.toMatch(/\[d\d+\]/);
		expect(elided.text).not.toMatch(/\[s\d+\]/);
	});

	it("reports failure instead of over-budget text when a tree cannot be pruned enough", () => {
		// Two roots, each a single row far over the budget: nothing is droppable
		// (pass 4 never drops depth 0) and value clamping cannot save enough.
		const wide = `- [n1] AXStaticText "${"a".repeat(4000)}"\n- [n2] AXStaticText "${"b".repeat(4000)}"`;
		expect(elideObservationTree(wide, 1024)).toBeUndefined();
	});
});
