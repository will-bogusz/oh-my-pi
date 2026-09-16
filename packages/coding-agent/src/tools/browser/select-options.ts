import { ToolError } from "../tool-errors";

/**
 * How model code names one `<option>`: the text it reads off the page, or
 * Playwright's `{ label }` / `{ value }` object — the form models reach for
 * from muscle memory, which used to fail with "matched no option" against a
 * label printed verbatim in the offered list.
 */
export type BrowserSelectOption = string | { label?: string; value?: string };

/** One option matcher, normalized once host-side so the page function stays a pure comparison. */
export interface SelectOptionSpec {
	/** The caller's own form, echoed back verbatim when nothing matched. */
	given: BrowserSelectOption;
	/** String form: matches the value, the label or the trimmed text. */
	any?: string;
	/** Object form: matches the value only. */
	value?: string;
	/** Object form: matches the label or the trimmed text. */
	label?: string;
}

function rejectedOption(given: unknown): ToolError {
	const rendered = (() => {
		try {
			return JSON.stringify(given) ?? String(given);
		} catch {
			return String(given);
		}
	})();
	return new ToolError(
		`select() cannot match the option ${rendered}: pass the option's text or value as a string, or one of { label: "…" }, { value: "…" }, { label: "…", value: "…" }.`,
	);
}

/** Turn the caller's option names into matcher specs, rejecting shapes no option could match. */
export function normalizeSelectOptions(values: readonly BrowserSelectOption[]): SelectOptionSpec[] {
	return values.map(given => {
		if (typeof given === "string") return { given, any: given };
		if (given === null || typeof given !== "object" || Array.isArray(given)) throw rejectedOption(given);
		const { label, value } = given as { label?: unknown; value?: unknown };
		if (label === undefined && value === undefined) throw rejectedOption(given);
		if ((label !== undefined && typeof label !== "string") || (value !== undefined && typeof value !== "string")) {
			throw rejectedOption(given);
		}
		const spec: SelectOptionSpec = { given };
		if (typeof label === "string") spec.label = label;
		if (typeof value === "string") spec.value = value;
		return spec;
	});
}

/**
 * Page-side matcher, shared by every transport so a label match cannot mean one
 * thing over CDP and another over cmux. Assign the full selection first, then
 * read back: on a single `<select>`, un-selecting the current option mid-loop
 * leaves the browser reporting it selected until another option takes over,
 * which double-counted the old value.
 */
export const SELECT_OPTIONS_SOURCE = `function (select, specs) {
	if (select.tagName !== "SELECT") throw new Error("select() requires a <select> element");
	const options = Array.from(select.options);
	// A caller reading the page names an option by the label it shows; the
	// value is a page-internal key that often differs from it.
	const matches = (option, spec) => {
		const text = (option.textContent || "").trim();
		if (spec.any !== undefined) return option.value === spec.any || option.label === spec.any || text === spec.any;
		if (spec.value !== undefined && option.value !== spec.value) return false;
		if (spec.label !== undefined && option.label !== spec.label && text !== spec.label) return false;
		return true;
	};
	const missing = specs.filter(spec => !options.some(option => matches(option, spec)));
	if (missing.length) {
		const shown = options.slice(0, 30).map(option =>
			option.label === option.value
				? JSON.stringify(option.value)
				: JSON.stringify(option.label) + "=" + JSON.stringify(option.value));
		throw new Error(
			"select() matched no option for " + missing.map(spec => JSON.stringify(spec.given)).join(", ") +
			"; this <select> offers " + (shown.join(", ") + (options.length > 30 ? ", …" : "")));
	}
	for (const option of options) option.selected = specs.some(spec => matches(option, spec));
	const selected = [];
	for (const option of options) if (option.selected) selected.push(option.value);
	select.dispatchEvent(new Event("input", { bubbles: true }));
	select.dispatchEvent(new Event("change", { bubbles: true }));
	return selected;
}`;
