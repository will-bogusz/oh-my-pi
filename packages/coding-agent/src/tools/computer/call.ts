import { ToolError } from "../tool-errors";

/** One allowlisted method invocation in a computer call chain. */
export interface ComputerCallStep {
	method: string;
	args: unknown[];
}

export type ComputerCallPolicy = "read" | "exec";
type MethodPolicies = Readonly<Record<string, ComputerCallPolicy>>;

export const DESKTOP_METHODS: MethodPolicies = {
	capabilities: "read",
	apps: "read",
	displays: "read",
	windows: "read",
	window: "read",
	acquireWindow: "read",
	verifyWindow: "read",
	focusedWindow: "read",
	screenshot: "read",
	launch: "exec",
	click: "exec",
	doubleClick: "exec",
	move: "exec",
	drag: "exec",
	scroll: "exec",
	type: "exec",
	press: "exec",
	ref: "read",
	"clipboard.read": "read",
	"clipboard.write": "exec",
};

export const WINDOW_METHODS: MethodPolicies = {
	observe: "read",
	screenshot: "read",
	find: "read",
	ref: "read",
	click: "exec",
	doubleClick: "exec",
	hover: "exec",
	drag: "exec",
	scroll: "exec",
	type: "exec",
	press: "exec",
	setValue: "exec",
	setFrame: "exec",
	menu: "exec",
	verify: "read",
	reveal: "exec",
};

export const ELEMENT_METHODS: MethodPolicies = {
	click: "exec",
	doubleClick: "exec",
	setValue: "exec",
	type: "exec",
	press: "exec",
	scroll: "exec",
	perform: "exec",
};

/** Validate the entire chain before rendering any caller-controlled method name. */
function validateChain(chain: readonly ComputerCallStep[]): ComputerCallPolicy {
	if (!Array.isArray(chain) || chain.length === 0) {
		throw new ToolError("Action 'call' requires a non-empty 'chain'.");
	}
	if (chain.length > 3) {
		throw new ToolError(
			"Call chains support a window and element hop at most; use computer.run(fn) for longer sequences.",
		);
	}
	let methods = DESKTOP_METHODS;
	let label = "desktop";
	let policy: ComputerCallPolicy = "read";
	for (let index = 0; index < chain.length; index++) {
		const step = chain[index];
		if (!step || typeof step.method !== "string" || !Array.isArray(step.args)) {
			throw new ToolError("Each computer call step requires a method string and args array.");
		}
		if (!Object.hasOwn(methods, step.method)) {
			throw new ToolError(
				`Unknown ${label} method "${step.method}". ${label} helpers support: ${Object.keys(methods).join(", ")}.`,
			);
		}
		if (methods[step.method] === "exec") policy = "exec";
		// `acquireWindow` inspects, except where it may start an application:
		// that is an exec effect behind a read-tier method name. `launch`
		// defaults to true for an `{ app }` selector, so the tier follows the
		// same rule the acquisition itself does.
		if (methods === DESKTOP_METHODS && step.method === "acquireWindow") {
			const selector = step.args[0];
			const options = step.args[1];
			const launch =
				options !== null && typeof options === "object" ? Reflect.get(options, "launch") : undefined;
			const launchable =
				selector !== null &&
				typeof selector === "object" &&
				Reflect.get(selector, "app") !== undefined &&
				Reflect.get(selector, "id") === undefined &&
				Reflect.get(selector, "pid") === undefined;
			if (launch === true || (launch === undefined && launchable)) policy = "exec";
		}
		if (index === chain.length - 1) continue;
		if (methods === DESKTOP_METHODS && step.method === "window") {
			methods = WINDOW_METHODS;
			label = "window";
		} else if ((methods === DESKTOP_METHODS || methods === WINDOW_METHODS) && step.method === "ref") {
			methods = ELEMENT_METHODS;
			label = "element";
		} else {
			throw new ToolError(
				`Only desktop.window(...), desktop.ref(...) and window.ref(...) results accept a chained call; got ${label}.${step.method}().`,
			);
		}
	}
	return policy;
}

/** Inspection-only chains receive read approval and execute under the read-only facade guard. */
export function isReadOnlyComputerCall(chain: readonly ComputerCallStep[]): boolean {
	return validateChain(chain) === "read";
}

/** Render a validated desktop/window/element invocation without exposing arbitrary property access. */
export function renderComputerCall(chain: readonly ComputerCallStep[]): string {
	validateChain(chain);
	let expression = "desktop";
	for (let index = 0; index < chain.length; index++) {
		const step = chain[index]!;
		// Direct helpers accept data, never executable run-argument markers.
		// JSON.parse also preserves "__proto__" as data rather than a literal setter.
		const args = step.args.map(arg =>
			arg === undefined ? "undefined" : `JSON.parse(${JSON.stringify(JSON.stringify(arg))})`,
		);
		expression = `await ${expression}.${step.method}(${args.join(", ")})`;
		if (index < chain.length - 1) expression = `(${expression})`;
	}
	return `return ${expression};`;
}
