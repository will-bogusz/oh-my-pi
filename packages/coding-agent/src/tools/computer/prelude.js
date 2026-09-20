{
	const validateOptions = (label, options) => {
		if (options === undefined) return {};
		if (options === null || typeof options !== "object" || Array.isArray(options)) {
			throw new TypeError(`${label}() expects an options object`);
		}
		return options;
	};
	const serializeFunction = (label, fn) => {
		const source = String(fn);
		if (source.includes("[native code]")) {
			throw new TypeError(
				`${label} cannot serialize a native or bound function; pass an arrow or function expression`,
			);
		}
		return source;
	};
	const encodeArg = (label, value) => {
		if (typeof value === "function") return { __omp_fn: serializeFunction(label, value) };
		if (value instanceof RegExp) return { __omp_re: { source: value.source, flags: value.flags } };
		return value;
	};
	const encodeArgs = (label, args) => {
		const trimmed = [...args];
		while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) trimmed.pop();
		return trimmed.map(value => encodeArg(label, value));
	};
	const invoke = async (action, options) => {
		const response = await globalThis.__omp_prelude__("computer", { ...options, action });
		if (response && typeof response.text === "string" && response.text.length > 0) {
			globalThis.__omp_display__(response.text);
		}
		const details =
			response && typeof response.details === "object" && response.details !== null ? response.details : {};
		// The host already rendered this value (an observation tree) into the
		// text above; the cell must not print it a second time as its trailing
		// expression.
		if (details.rendered === true) globalThis.__omp_presented__?.(details.value);
		return details;
	};
	const callValue = async chain => {
		const details = await invoke("call", { chain });
		return details.value;
	};
	const step = (method, args) => ({ method, args: encodeArgs("computer helper argument", args) });
	// Methods stay non-enumerable so handles display and serialize as their identity fields only.
	const defineMethod = (target, name, fn) => Object.defineProperty(target, name, { value: fn });
	const defineValueMethods = (target, methods, chain) => {
		for (const method of methods) {
			defineMethod(target, method, (...args) => callValue(chain(step(method, args))));
		}
	};

	const windowFields = ["id", "app", "title", "pid", "bounds", "onScreen", "layer", "zIndex", "kind"];
	const windowValueMethods = [
		"screenshot",
		"click",
		"doubleClick",
		"hover",
		"drag",
		"scroll",
		"type",
		"press",
		"reveal",
		"observe",
		"setValue",
		"setFrame",
		"menu",
	];
	const elementFields = [
		"ref",
		"role",
		"subrole",
		"label",
		"value",
		"placeholder",
		"help",
		"description",
		"enabled",
		"selected",
		"actions",
		"bounds",
		"pid",
		"windowId",
	];
	const elementValueMethods = ["click", "doubleClick", "setValue", "type", "press", "scroll", "perform"];
	const desktopValueMethods = [
		"capabilities",
		"apps",
		"launch",
		"displays",
		"windows",
		"screenshot",
		"click",
		"doubleClick",
		"move",
		"drag",
		"scroll",
		"type",
		"press",
	];

	const copyFields = (target, fields, snapshot) => {
		for (const field of fields) {
			if (snapshot[field] !== undefined) {
				let value = snapshot[field];
				if (field === "bounds" && value !== null) value = Object.freeze({ ...value });
				if (field === "actions" && Array.isArray(value)) value = Object.freeze([...value]);
				Object.defineProperty(target, field, { value, enumerable: true });
			}
		}
	};
	const makeElement = (snapshot, identity) => {
		const element = {};
		copyFields(element, elementFields, snapshot);
		defineMethod(element, "toString", () => `<element ${snapshot.ref} ${snapshot.role}>`);
		const owner =
			identity ??
			(snapshot.windowId !== undefined && snapshot.pid !== undefined
				? { id: snapshot.windowId, pid: snapshot.pid }
				: undefined);
		const via = next => [...(owner ? [step("window", [owner])] : []), step("ref", [snapshot.ref]), next];
		defineValueMethods(element, elementValueMethods, via);
		return Object.freeze(element);
	};
	const resolveElement = async (chain, identity) => {
		const snapshot = await callValue(chain);
		return snapshot ? makeElement(snapshot, identity) : null;
	};
	/**
	 * A ref handle that acts without a round trip (`win.ref(r).click()`) and
	 * still resolves to the full snapshot when awaited (`await win.ref(r)`).
	 */
	const lazyElement = (chain, ref, identity) => {
		const element = makeElement({ ref }, identity);
		const resolved = () => resolveElement(chain, identity);
		return Object.freeze(
			Object.create(element, {
				then: { value: (onFulfilled, onRejected) => resolved().then(onFulfilled, onRejected) },
			}),
		);
	};
	const makeWindow = snapshot => {
		if (typeof snapshot.id !== "string" || !Number.isInteger(snapshot.pid)) {
			throw new TypeError("computer window snapshot requires an exact id and PID");
		}
		const win = {};
		copyFields(win, windowFields, snapshot);
		for (const field of ["initialObservation", "inspectionError", "initialScreenshot", "screenshotError"]) {
			if (snapshot[field] !== undefined) Object.defineProperty(win, field, { value: snapshot[field] });
		}
		defineMethod(win, "toString", () => `<window ${snapshot.id} ${snapshot.app}>`);
		const identity = { id: snapshot.id, pid: snapshot.pid };
		const via = next => [step("window", [identity]), next];
		defineValueMethods(win, windowValueMethods, via);
		defineMethod(win, "verify", (...args) => callValue([step("verifyWindow", [identity, ...args])]));
		defineMethod(win, "find", async query =>
			(await callValue(via(step("find", [query])))).map(item => makeElement(item, identity)),
		);
		defineMethod(win, "ref", ref => lazyElement(via(step("ref", [ref])), ref, identity));
		// @achieve
		// The chooser sub-loop runs on the host, where the judge and the typed
		// observation live; the handle only names the goal and the bounds.
		defineMethod(win, "achieve", async (goal, options) => {
			if (typeof goal !== "string" || goal.length === 0) {
				throw new TypeError("win.achieve() expects a non-empty goal string");
			}
			const opts = validateOptions("win.achieve", options);
			const parameters = { window: identity, goal };
			if (opts.maxSteps !== undefined) parameters.maxSteps = opts.maxSteps;
			if (opts.confidence !== undefined) parameters.confidence = opts.confidence;
			const details = await invoke("achieve", parameters);
			return details.value;
		});
		// @end achieve
		return Object.freeze(win);
	};
	const resolveWindow = async chain => {
		const snapshot = await callValue(chain);
		return snapshot ? makeWindow(snapshot) : null;
	};

	const computer = {};
	defineValueMethods(computer, desktopValueMethods, next => [next]);
	computer.window = (selector, options) =>
		resolveWindow([step("acquireWindow", [selector, validateOptions("computer.window", options)])]);
	computer.focusedWindow = () => resolveWindow([step("focusedWindow", [])]);
	computer.ref = ref => lazyElement([step("ref", [ref])], ref);
	computer.clipboard = Object.freeze({
		read: () => callValue([step("clipboard.read", [])]),
		write: text => callValue([step("clipboard.write", [text])]),
	});
	computer.run = async (fnOrCode, options) => {
		if (typeof fnOrCode !== "function" && typeof fnOrCode !== "string") {
			throw new TypeError("computer.run() expects a function or code string");
		}
		const opts = validateOptions("computer.run", options);
		const parameters = {};
		if (opts.read_only !== undefined) parameters.read_only = opts.read_only;
		if (opts.timeout !== undefined) parameters.timeout = opts.timeout;
		if (typeof fnOrCode === "function") {
			parameters.fn = serializeFunction("computer.run()", fnOrCode);
			parameters.args = encodeArgs("computer.run() argument", Array.isArray(opts.args) ? opts.args : []);
		} else {
			parameters.code = fnOrCode;
		}
		const details = await invoke("run", parameters);
		return details.value;
	};
	// The host prints the typed API; returning it too would print it twice.
	computer.help = async () => {
		await invoke("help", {});
	};
	computer.release = async () => {
		await invoke("release", {});
	};
	computer.close = async () => {
		await invoke("close", {});
	};
	globalThis.computer = Object.freeze(computer);
}
