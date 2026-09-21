import { expect, it } from "bun:test";
import { normalizeSelectOptions, SELECT_OPTIONS_SOURCE } from "@oh-my-pi/pi-coding-agent/tools/browser/select-options";

/**
 * The matcher as the page runs it: `cdp.ts` and `cmux-tab.ts` both evaluate
 * this one source string, so the option semantics have a single
 * implementation — and, until this file, no assertion a machine without
 * Chromium could run. The `<option>` shape the source touches is small
 * enough to stand in for: a value, a label that falls back to the element's
 * text, that text, and a selected flag.
 */
const match = new Function(`return ${SELECT_OPTIONS_SOURCE}`)() as (
	select: unknown,
	specs: readonly unknown[],
) => string[];

interface StubOption {
	value: string;
	label: string;
	textContent: string;
	selected: boolean;
}
function option(text: string, value: string, label = text): StubOption {
	return { value, label, textContent: text, selected: false };
}
function select(...options: StubOption[]) {
	return { tagName: "SELECT", options, dispatchEvent: () => true };
}
/** The collision: the first option's label is the second option's value. */
function tiers() {
	return select(option("gold", "silver"), option("platinum", "gold"));
}

it("refuses a bare string that names two options with different values and leaves the page as it was", () => {
	const element = tiers();
	element.options[0]!.selected = true;
	expect(() => match(element, normalizeSelectOptions(["gold"]))).toThrow(
		'select() cannot tell which option "gold" names: it is the label of <option value="silver"> and the value of <option>platinum</option>. Name the one you mean with { label: "gold" } or { value: "gold" }; this <select> offers "gold"="silver", "platinum"="gold".',
	);
	// Refused before anything was assigned: the page still holds the
	// selection it had, and no input/change event was dispatched over it.
	expect(element.options.map(row => row.selected)).toEqual([true, false]);
});

it("keeps selecting the one option a { label }, a { value } or an unambiguous string names", () => {
	expect(match(tiers(), normalizeSelectOptions([{ label: "gold" }]))).toEqual(["silver"]);
	expect(match(tiers(), normalizeSelectOptions([{ value: "gold" }]))).toEqual(["gold"]);
	// Two options that submit the same value name no ambiguity a caller
	// could resolve, and which of them is selected is unobservable in the
	// result and in the form submission.
	const fuel = select(option("Petrol", "pet"), option("Petrol (E10)", "pet"));
	expect(new Set(match(fuel, normalizeSelectOptions(["pet"])))).toEqual(new Set(["pet"]));
});

it("names the options it offers when a string matched none of them", () => {
	expect(() => match(tiers(), normalizeSelectOptions(["bronze"]))).toThrow(
		'select() matched no option for "bronze"; this <select> offers "gold"="silver", "platinum"="gold"',
	);
});
