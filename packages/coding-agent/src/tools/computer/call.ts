import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

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

/**
 * The verbs an acquired handle answers to, for the footer of an acquisition
 * result. Derived from the tables that gate every handle call, so the list a
 * model reads cannot drift from the list the boundary accepts.
 */
export const COMPUTER_HANDLE_VERBS = `win: ${Object.keys(WINDOW_METHODS).join(" · ")} — el: ${Object.keys(ELEMENT_METHODS).join(" · ")} — computer.help() for signatures`;

/** A member line that declares a call, not a field. */
const SIGNATURE_MEMBER = /^[A-Za-z_$][\w$]*\(/;

/**
 * One handle's verbs with their types, read out of the declaration file
 * `computer.help()` prints so the two can never disagree. Comments and
 * fields are dropped and a signature spread over several lines becomes one,
 * because this is read beside a tree, not instead of the help output.
 */
export function handleSignatures(declarations: string, name: string, lead: string): string {
	const body = new RegExp(`^interface ${name}(?: extends [^{]+)?\\s*\\{\\n([\\s\\S]*?)^\\}$`, "m").exec(
		declarations,
	)?.[1];
	if (body === undefined) throw new ToolError(`Computer declarations declare no ${name}`);
	const lines: string[] = [lead];
	let pending = "";
	let depth = 0;
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("*") || line.startsWith("/*") || line.startsWith("//")) continue;
		pending = pending ? `${pending} ${line}` : line;
		depth += (line.match(/\(/g)?.length ?? 0) - (line.match(/\)/g)?.length ?? 0);
		if (depth > 0) continue;
		if (SIGNATURE_MEMBER.test(pending))
			lines.push(
				`  ${pending
					.replace(/\(\s+/g, "(")
					.replace(/,\s*\)/g, ")")
					.replace(/;\s*\}/g, " }")}`,
			);
		pending = "";
		depth = 0;
	}
	return lines.join("\n");
}

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
			const launch = options !== null && typeof options === "object" ? Reflect.get(options, "launch") : undefined;
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
