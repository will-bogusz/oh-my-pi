/**
 * Contract tests for the computer tool's inline byte cap: an over-cap
 * observation loses its least load-bearing parts (long value text, rows with
 * neither text nor an action, the deepest subtrees) instead of a contiguous
 * band of lines. The fixture is the bench T7 run's real print-pane
 * observation, re-rendered in the shared row grammar (77 kB where the old
 * one was 188 kB), whose controls sat inside the band the middle cut removed
 * (`research/bench-set-20260911/after-fixes-20260913.md` §4.5).
 */
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_BYTES, enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
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

		// The controls the model had to go hunting for.
		expect(capped).toContain('n3830 button "More settings"');
		expect(capped).toContain('n3833 button "Save"');
		expect(capped).toContain('n3831 button "Cancel"');
		// A short value still answers "what is the destination?".
		expect(capped).toContain('n3824 popupbutton "Destination" = "Save as PDF"');
		// The window header and the completeness notice are not tree rows and survive.
		expect(capped).toContain("Google Chrome: Untitled window (window 6116, PID 588)");
		expect(capped).toContain("Partial accessibility tree; omitted controls remain unknown.");
	});

	it("elides page prose before controls and leaves a valid pruned tree", () => {
		const elided = elideObservationTree(fixture, DEFAULT_MAX_BYTES - 192);
		if (!elided) throw new Error("expected the fixture to elide structurally");
		const lines = elided.text.split("\n");

		// What the cut takes is the article the print pane is previewing: every
		// row the dialog can be driven by survives it, most of the page's text
		// rows do not.
		const count = (source: string, pattern: RegExp): number =>
			source.split("\n").filter(line => pattern.test(line)).length;
		const controls = /^ *n\d+ (button|popupbutton|textfield|link) /;
		const prose = /^ *n\d+ text /;
		expect(count(elided.text, controls)).toBe(count(fixture, controls));
		expect(count(elided.text, prose)).toBeLessThan(count(fixture, prose) / 2);

		// Rows are dropped with their whole subtree, so indentation never gains
		// more than one level between consecutive rows the input did not already
		// jump (the driver's own render jumps once, at n4217).
		let previous = -1;
		const jumps: string[] = [];
		for (const line of lines) {
			const row = /^((?:  )*)n\d+ /.exec(line);
			if (!row) continue;
			const depth = (row[1]?.length ?? 0) / 2;
			if (previous >= 0 && depth > previous + 1) jumps.push(line);
			previous = depth;
		}
		expect(jumps).toHaveLength(1);
		expect(jumps[0]).toContain("n4217");
	});

	it("leaves a sub-cap observation untouched", async () => {
		const text = [
			"Preview: Untitled window (window 1, PID 2)",
			'n1 window "Preview"',
			'  n2 button "Save"',
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

	it("drops decorative rows and shortens long values before touching rows that carry text or an action", () => {
		const rows = [
			'n1 window "Export"',
			'  n2 button "Export"',
			"  n3 image (Progress spinner)",
			// The T4 shape: a text field is written to, not pressed, so the row
			// is as load-bearing as one offering an action of its own.
			'  n4 textfield "Buy milk" = "2 litres" [settable]',
			`  n6 textfield "Notes" = "${"note ".repeat(160)}" [settable]`,
			// A container that offers nothing and says nothing.
			"  n5 popover",
			...Array.from({ length: 400 }, (_, index) => `  n${100 + index} image = ""`),
			...Array.from({ length: 400 }, (_, index) => `  n${600 + index} menuitem`),
		];
		const text = rows.join("\n");
		// Stripping the empty values alone saves ~2.4 kB, so this budget forces
		// rows out; the unlabelled menu items go even though they are controls.
		const elided = elideObservationTree(text, Buffer.byteLength(text, "utf-8") - 6_000);
		if (!elided) throw new Error("expected the tree to elide structurally");

		expect(elided.text).toContain('n2 button "Export"');
		expect(elided.text).toContain("n3 image (Progress spinner)");
		expect(elided.text).toContain('n4 textfield "Buy milk" = "2 litres" [settable]');
		expect(elided.text).not.toContain("n5 popover");
		expect(elided.text).not.toMatch(/n[1-4]\d\d image/);
		expect(elided.text).not.toMatch(/n[6-9]\d\d menuitem/);

		// The long field keeps its row and the head of its value, not the 800
		// characters of it: a value is shortened before any row is dropped.
		const notes = / = "((?:[^"\\]|\\.)*)\u2026" \[settable\]$/m.exec(elided.text);
		if (!notes) throw new Error(`expected a shortened value, got: ${elided.text.split("\n").slice(0, 8).join("\n")}`);
		expect(notes[1]!.length).toBeLessThan(800);
		expect(notes[1]!.startsWith("note note")).toBe(true);
	});

	it("drops the window's own text rows before the controls they sit beside", () => {
		// Display-only rows carry no ref: the window renders them, nothing can
		// be dispatched on them, and an over-cap observation is mostly made of
		// them. A budget this tight is met by dropping those alone.
		const text = [
			'n1 window "Notes"',
			'  n2 button "New Note"',
			...Array.from({ length: 300 }, (_, index) => `  text "page prose line ${index}"`),
			'  n3 button "Delete"',
		].join("\n");
		const elided = elideObservationTree(text, 400);
		if (!elided) throw new Error("expected the tree to elide structurally");

		// Both controls survive; the prose is cut until the text fits, and only
		// until then — the elider removes what it must, not everything it may.
		expect(elided.text).toContain('n2 button "New Note"');
		expect(elided.text).toContain('n3 button "Delete"');
		expect(elided.text.split("\n").filter(line => line.includes("page prose line")).length).toBeLessThan(30);
		expect(Buffer.byteLength(elided.text, "utf-8")).toBeLessThanOrEqual(400);
	});

	it("reports failure instead of over-budget text when a tree cannot be pruned enough", () => {
		// Two roots, each a single row far over the budget: nothing is droppable
		// (pass 4 never drops depth 0) and value clamping cannot save enough.
		const wide = `n1 text "${"a".repeat(4000)}"\nn2 text "${"b".repeat(4000)}"`;
		expect(elideObservationTree(wide, 1024)).toBeUndefined();
	});
});
