import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const NON_SERIALIZABLE_RUN_ARGUMENT = "Run argument is not JSON-serializable; pass plain data";

/** Marker that renders a serialized function as an executable run argument. */
export interface FnArgMarker {
	__omp_fn: string;
}

/** Marker that renders a serialized regular expression as an executable run argument. */
export interface RegExpArgMarker {
	__omp_re: {
		source: string;
		flags?: string;
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasSoleOwnKey(value: Record<string, unknown>, key: string): boolean {
	const keys = Reflect.ownKeys(value);
	return keys.length === 1 && keys[0] === key;
}

/** Renders one host value as a JavaScript argument for an evaluated run. */
export function renderRunArg(value: unknown): string {
	if (value === undefined) return "undefined";

	if (isPlainObject(value) && hasSoleOwnKey(value, "__omp_fn") && typeof value.__omp_fn === "string") {
		return `(${value.__omp_fn})`;
	}

	if (isPlainObject(value) && hasSoleOwnKey(value, "__omp_re")) {
		const marker = value.__omp_re;
		if (
			isPlainObject(marker) &&
			typeof marker.source === "string" &&
			(marker.flags === undefined || typeof marker.flags === "string")
		) {
			return `new RegExp(${JSON.stringify(marker.source)}, ${JSON.stringify(marker.flags ?? "")})`;
		}
	}

	let rendered: string | undefined;
	try {
		rendered = JSON.stringify(value);
	} catch {
		throw new ToolError(NON_SERIALIZABLE_RUN_ARGUMENT);
	}
	if (rendered === undefined) throw new ToolError(NON_SERIALIZABLE_RUN_ARGUMENT);
	return rendered;
}

/** Renders a helper call chain (`id(5).click()`) with arguments as JavaScript literals. */
export function renderCallChain(chain: readonly { method: string; args: readonly unknown[] }[]): string {
	return chain.map(step => `${step.method}(${step.args.map(renderRunArg).join(", ")})`).join(".");
}

/** Steps that hop to an element handle; their argument names what the verb acted on. */
const ELEMENT_HOPS: Record<string, true> = { ref: true, id: true };
/** Verbs whose first argument is text the user would recognise quoted. */
const QUOTED_ARGUMENT: Record<string, true> = { type: true, fill: true, setValue: true };
/** Object-argument fields that name what a lookup selected (`acquireWindow({ app: "Notes" })`). */
const NAMING_FIELDS = ["app", "title", "query", "url", "name"] as const;
const SUMMARY_ARGUMENT_MAX = 48;

function summaryArgument(verb: string, value: unknown): string | undefined {
	let text: string | undefined;
	if (typeof value === "string") text = QUOTED_ARGUMENT[verb] ? JSON.stringify(value) : value;
	else if (typeof value === "number") text = String(value);
	else if (Array.isArray(value) && value.every(item => typeof item === "string")) text = value.join(" › ");
	else if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const field = NAMING_FIELDS.find(key => typeof record[key] === "string" && record[key] !== "");
		text = field === undefined ? undefined : (record[field] as string);
	}
	if (text === undefined || text.length === 0) return undefined;
	return text.length > SUMMARY_ARGUMENT_MAX ? `${text.slice(0, SUMMARY_ARGUMENT_MAX - 1)}…` : text;
}

/**
 * A helper call chain said verb first, for a person scanning a transcript:
 * `[window(3), ref("n12"), click()]` → `click n12`; `type("hi")` on `ref("n5")`
 * → `type "hi" in n5`. Window hops are left to the caller, which knows the
 * window's title; `undefined` for an empty chain.
 */
export function summarizeCallChain(chain: readonly { method: string; args: readonly unknown[] }[]): string | undefined {
	const last = chain.at(-1);
	if (!last) return undefined;
	const hop = chain.slice(0, -1).findLast(step => ELEMENT_HOPS[step.method]);
	const subject = hop && typeof hop.args[0] !== "object" ? String(hop.args[0]) : undefined;
	const argument = summaryArgument(last.method, last.args[0]);
	return [last.method, argument, subject && (argument ? `in ${subject}` : subject)].filter(Boolean).join(" ");
}

/** Renders a function invocation with the requested run scope and positional arguments. */
export function renderFunctionRun(fnSource: string, scopeNames: readonly string[], args: readonly unknown[]): string {
	const scope = scopeNames.join(", ");
	const renderedArgs = args.map(value => `, ${renderRunArg(value)}`).join("");
	return `return await (${fnSource})({ ${scope} }${renderedArgs});`;
}
