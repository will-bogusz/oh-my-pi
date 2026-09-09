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
		const response = await globalThis.__omp_prelude__("browser", { ...options, action });
		if (response && typeof response.text === "string" && response.text.length > 0) {
			globalThis.__omp_display__(response.text);
		}
		return response && typeof response.details === "object" && response.details !== null ? response.details : {};
	};
	const callValue = async (name, chain, handle) => {
		const details = await invoke("call", { name, chain, ...(handle ? { handle } : {}) });
		return details.value;
	};
	const directMethods = [
		"url",
		"title",
		"goto",
		"observe",
		"ariaSnapshot",
		"screenshot",
		"extract",
		"click",
		"type",
		"fill",
		"press",
		"scroll",
		"drag",
		"scrollIntoView",
		"select",
		"uploadFile",
		"downloads",
		"waitForUrl",
		"evaluate",
		"waitFor",
		"waitForSelector",
	];
	const elementMethods = [
		"click",
		"type",
		"fill",
		"press",
		"hover",
		"focus",
		"select",
		"uploadFile",
		"scrollIntoView",
		"boundingBox",
		"isVisible",
		"isHidden",
		"evaluate",
	];
	const makeElement = (name, handleMethod, handleArgs, handle) => {
		const element = {};
		const renderedArgs = handleArgs.map(value => JSON.stringify(value)).join(", ");
		element.toString = () => `<element tab.${handleMethod}(${renderedArgs}) on ${name}>`;
		for (const method of elementMethods) {
			element[method] = (...args) =>
				callValue(
					name,
					[
						{ method: handleMethod, args: handleArgs },
						{ method, args: encodeArgs("tab helper argument", args) },
					],
					handle,
				);
		}
		return Object.freeze(element);
	};
	/** Name -> { handle, target } of a managed Chrome tab, so `browser.tab(name)` keeps its identity. */
	const identitiesByName = new Map();
	const makeTab = (name, handle, initial = {}) => {
		const tab = {};
		let snapshot = initial.initialObservation?.snapshot;
		const target = initial.target
			? Object.freeze({ id: initial.target.id, browserId: initial.target.browserId, tabId: initial.target.tabId })
			: identitiesByName.get(name)?.target;
		if (handle) {
			Object.defineProperty(tab, "handle", { value: handle, enumerable: true });
			identitiesByName.set(name, { handle, target });
		}
		if (target) Object.defineProperty(tab, "target", { value: target, enumerable: true });
		for (const field of [
			"initialObservation",
			"initialDialog",
			"initialTree",
			"initialScreenshot",
			"inspectionError",
			"treeError",
			"screenshotError",
		]) {
			if (initial[field] !== undefined) Object.defineProperty(tab, field, { value: initial[field] });
		}
		Object.defineProperty(tab, "name", { value: name, enumerable: true });
		tab.toString = () => `<tab ${name}${tab.target ? ` target=${tab.target.id}` : ""}>`;
		for (const method of directMethods) {
			tab[method] = async (...args) => {
				const value = await callValue(name, [{ method, args: encodeArgs("tab helper argument", args) }], handle);
				if (method === "observe") snapshot = value?.snapshot;
				if (method === "goto") snapshot = undefined;
				return value;
			};
		}
		tab.id = id =>
			makeElement(
				name,
				snapshot ? "ref" : "id",
				encodeArgs("tab helper argument", [snapshot ? `${snapshot}:${id}` : id]),
				handle,
			);
		tab.ref = id => makeElement(name, "ref", encodeArgs("tab helper argument", [id]), handle);
		tab.dialog = async options => {
			if (!handle) throw new Error("Dialog inspection requires an existing managed Chrome handle");
			return (await invoke("dialog", { handle, dialog: validateOptions("tab.dialog", options) })).value;
		};
		tab.popups = async () => {
			if (!handle) throw new Error("Popup discovery requires an existing managed Chrome handle");
			return (await invoke("popups", { handle })).value;
		};
		tab.run = async (fnOrCode, options) => {
			if (typeof fnOrCode !== "function" && typeof fnOrCode !== "string") {
				throw new TypeError("tab.run() expects a function or code string");
			}
			const opts = validateOptions("tab.run", options);
			const parameters = { name, ...(handle ? { handle } : {}) };
			if (opts.timeout !== undefined) parameters.timeout = opts.timeout;
			if (typeof fnOrCode === "function") {
				parameters.fn = serializeFunction("tab.run()", fnOrCode);
				parameters.args = encodeArgs("tab helper argument", Array.isArray(opts.args) ? opts.args : []);
			} else {
				parameters.code = fnOrCode;
			}
			const details = await invoke("run", parameters);
			return details.value;
		};
		tab.close = async options => {
			const opts = validateOptions("tab.close", options);
			if (identitiesByName.get(name)?.handle === handle) identitiesByName.delete(name);
			await invoke("close", { ...opts, name, ...(handle ? { handle } : {}) });
		};
		for (const action of ["reveal", "release"]) {
			tab[action] = async () => {
				if (!handle) throw new Error(`${action} requires a Chrome tab returned by create or claim`);
				if (action === "release" && identitiesByName.get(name)?.handle === handle) identitiesByName.delete(name);
				await invoke(action, { handle });
			};
		}
		for (const key of Object.keys(tab)) {
			if (typeof tab[key] === "function") Object.defineProperty(tab, key, { enumerable: false });
		}
		return Object.freeze(tab);
	};
	globalThis.browser = Object.freeze({
		async open(options) {
			const opts = validateOptions("browser.open", options);
			const details = await invoke("open", opts);
			return makeTab(
				typeof details.name === "string" ? details.name : (opts.name ?? "main"),
				details.handle,
				details.value,
			);
		},
		async instances() {
			return (await invoke("instances", {})).value;
		},
		async discover(options) {
			return (await invoke("discover", validateOptions("browser.discover", options))).value;
		},
		async closeTab(id, options) {
			if (typeof id !== "string" || !id.length)
				throw new TypeError("browser.closeTab expects an exact discovered tab id");
			await invoke("closeTab", { ...validateOptions("browser.closeTab", options), id });
		},
		async create(options) {
			const details = await invoke("create", validateOptions("browser.create", options));
			return makeTab(details.name, details.handle, details.value);
		},
		async claim(id, options) {
			if (typeof id !== "string" || !id.length)
				throw new TypeError("browser.claim expects an exact discovered tab id");
			const details = await invoke("claim", { ...validateOptions("browser.claim", options), id });
			return makeTab(details.name, details.handle, details.value);
		},
		async getTab(selector, options) {
			const target =
				typeof selector === "string" ? { id: selector } : { selector: validateOptions("browser.getTab", selector) };
			const details = await invoke("claim", { ...validateOptions("browser.getTab", options), ...target });
			return makeTab(details.name, details.handle, details.value);
		},
		tab(name = "main") {
			if (typeof name !== "string" || name.length === 0) {
				throw new TypeError("browser.tab() expects a tab name");
			}
			// Managed Chrome tabs are addressed by their immutable handle, never by
			// the display label, so a name lookup has to carry the handle across.
			return makeTab(name, identitiesByName.get(name)?.handle);
		},
		async close(options) {
			await invoke("close", validateOptions("browser.close", options));
		},
	});
}
