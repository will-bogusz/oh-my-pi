import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ComputerLaunchOptions, WindowSelector } from "./types";

/**
 * The route by which a running app opens a window it does not have: a
 * launch that reuses the running process opens nothing by itself, while one
 * that carries `urls` hands the app those documents or folders to open.
 */
export function reopenRoute(app: string): string {
	return `computer.launch({ name: ${JSON.stringify(app)}, urls: ["<document or folder path>"] }) hands the running app a document or folder to open`;
}

/** Launch accepts the same name/path shorthand as explicit launch options. */
export function normalizeLaunchOptions(value: unknown): ComputerLaunchOptions {
	if (typeof value === "string") value = { name: value };
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ToolError("Invalid launch target: use an app name/path or { name, bundleId, urls, newInstance }");
	const fields = value as Record<string, unknown>;
	for (const key of Object.keys(fields))
		if (!["name", "bundleId", "urls", "newInstance"].includes(key))
			throw new ToolError(`Invalid launch option: ${key}`);
	const options: ComputerLaunchOptions = {};
	for (const key of ["name", "bundleId"] as const) {
		if (fields[key] !== undefined) {
			if (typeof fields[key] !== "string" || !fields[key].trim() || fields[key].includes("\0"))
				throw new ToolError(`Invalid launch ${key}: use a nonempty string`);
			options[key] = fields[key];
		}
	}
	if (!options.name && !options.bundleId) throw new ToolError("Launch requires an app name/path or bundleId");
	if (fields.urls !== undefined) {
		if (!Array.isArray(fields.urls) || fields.urls.some(url => typeof url !== "string" || !url || url.includes("\0")))
			throw new ToolError("Invalid launch urls: use an array of nonempty paths or URLs");
		options.urls = [...fields.urls];
	}
	if (fields.newInstance !== undefined) {
		if (typeof fields.newInstance !== "boolean") throw new ToolError("Invalid launch newInstance: use a boolean");
		options.newInstance = fields.newInstance;
	}
	return options;
}

/** Normalize public selectors once, before any platform driver sees them. */
export function normalizeWindowSelector(value: unknown, allowId = false): WindowSelector {
	if (allowId && (typeof value === "string" || typeof value === "number")) value = { id: value };
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ToolError("Invalid window selector: use a window ID or an { id, pid, app, title, kind } filter");
	const fields = value as Record<string, unknown>;
	for (const key of Object.keys(fields))
		if (!["id", "pid", "app", "title", "kind"].includes(key))
			throw new ToolError(`Invalid window selector field: ${key}`);
	const selector: WindowSelector = {};
	if (fields.id !== undefined) {
		if (typeof fields.id === "number") {
			if (!Number.isSafeInteger(fields.id) || fields.id <= 0)
				throw new ToolError("Invalid window ID: numeric IDs must be positive safe integers");
			selector.id = String(fields.id);
		} else if (typeof fields.id === "string" && fields.id.trim().length) selector.id = fields.id;
		else throw new ToolError("Invalid window ID: use a nonempty string or positive safe integer");
	}
	if (fields.pid !== undefined) {
		if (typeof fields.pid !== "number" || !Number.isSafeInteger(fields.pid) || fields.pid <= 0)
			throw new ToolError("Invalid window PID: use a positive safe integer");
		selector.pid = fields.pid;
	}
	for (const key of ["app", "title"] as const) {
		if (fields[key] !== undefined) {
			if (typeof fields[key] !== "string") throw new ToolError(`Invalid window ${key}: use a string`);
			selector[key] = fields[key];
		}
	}
	if (fields.kind !== undefined) {
		if (fields.kind !== "desktop") throw new ToolError('Invalid window kind: the only selectable kind is "desktop"');
		selector.kind = "desktop";
	}
	return selector;
}

/**
 * The literals an observe query searches for: a string is one case-insensitive
 * substring, taken literally, and an array is any-of. Splitting the string on
 * `|` instead made two things of one parameter — a row whose own text carries
 * a pipe was unaskable ("Order Status | Peptaura" named a Chrome tab in the
 * corpus), and 476 rendered rows in one leg print a literal `|` — while the
 * alternation it bought is expressible as what it is.
 */
export function normalizeQuery(value: unknown): string[] {
	const entries = typeof value === "string" ? [value] : Array.isArray(value) ? (value as unknown[]) : undefined;
	const query = entries?.length
		? entries.map(entry => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
		: undefined;
	if (query === undefined || query.some(literal => !literal.length))
		throw new ToolError(
			'Invalid observe query: use a non-empty string or an array of non-empty strings. An empty query ("", [] or a blank entry) has nothing to filter by — omit query to read the whole window.',
		);
	return query;
}
