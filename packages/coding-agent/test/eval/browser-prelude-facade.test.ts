import { afterAll, describe, expect, it } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { BROWSER_TAB_VERBS } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-call";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { chromiumAvailable } from "../tools/chromium-probe";

interface FacadeResponse {
	text: string;
	details: Record<string, unknown>;
}

function field(value: unknown, name: string): unknown {
	return value !== null && typeof value === "object" ? Reflect.get(value, name) : undefined;
}

function firstChainMethod(parameters: unknown): string | undefined {
	const chain = field(parameters, "chain");
	if (!Array.isArray(chain) || chain.length === 0) return undefined;
	const method = field(chain[0], "method");
	return typeof method === "string" ? method : undefined;
}

function responseFor(parameters: unknown): FacadeResponse {
	const action = field(parameters, "action");
	if (action === "open") {
		const requestedName = field(parameters, "name");
		return {
			text: "opened display text",
			details: { name: typeof requestedName === "string" ? requestedName : "main" },
		};
	}
	if (action === "run") {
		return {
			text: "",
			details: { value: typeof field(parameters, "fn") === "string" ? 8 : { ok: true } },
		};
	}
	if (action === "call") {
		const method = firstChainMethod(parameters);
		const values: Record<string, unknown> = {
			title: "page title",
			observe: { elements: [{ id: 5, role: "button", name: "Save" }] },
			fill: true,
			evaluate: 9,
			waitFor: true,
			waitForSelector: true,
			id: true,
			ref: true,
		};
		return { text: "", details: { value: method === undefined ? undefined : values[method] } };
	}
	return { text: "", details: { name: "main" } };
}

function makeSession(getPreludes?: () => readonly EvalPreludeDefinition[]): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.relay": false,
			"browser.cmux": false,
		}),
		...(getPreludes === undefined ? {} : { getEvalPreludes: getPreludes }),
	};
}

function recorderDefinition(session: ToolSession, calls: unknown[]): EvalPreludeDefinition {
	const shipped = createBrowserPrelude(session);
	return {
		...shipped,
		async invoke(parameters) {
			calls.push(parameters);
			const response = responseFor(parameters);
			return {
				content: response.text.length > 0 ? [{ type: "text", text: response.text }] : [],
				details: response.details,
			};
		},
	};
}

afterAll(async () => {
	await Promise.all([disposeAllVmContexts(), disposeAllKernelSessions()]);
});

describe("browser JavaScript facade", () => {
	it("keeps Chrome handles and element references bound when labels and observation slots repeat", async () => {
		const calls: Array<Record<string, unknown>> = [];
		let nextHandle = 0;
		let nextSnapshot = 0;
		const prelude = createBrowserPrelude(makeSession());
		const context = createContext({
			__omp_display__: () => {},
			__omp_prelude__: async (_name: string, parameters: Record<string, unknown>) => {
				calls.push(parameters);
				if (parameters.action === "create")
					return {
						details: {
							name: "Same label",
							handle: `handle-${++nextHandle}`,
							value: {
								target: { id: `discovery-${nextHandle}`, browserId: `profile-${nextHandle}`, tabId: 1 },
								initialObservation: { snapshot: `initial-${nextHandle}`, elements: [{ id: 1 }] },
								initialDialog: { status: "open", dialog: { id: "dialog-first" } },
							},
						},
					};
				if (firstChainMethod(parameters) === "observe")
					return { details: { value: { snapshot: `snapshot-${++nextSnapshot}`, elements: [{ id: 1 }] } } };
				return { details: {} };
			},
		});
		runInContext(prelude.javascript!, context);
		await runInContext(
			`(async () => {
			await browser.instances();
			await browser.discover({browserId:"work-profile"});
			globalThis.first = await browser.create({label: "Same label",browserId:"work-profile"});
			globalThis.savedElement = first.id(1);
			globalThis.second = await browser.create({label: "Same label"});
			await first.observe();
			await savedElement.click();
			await second.reveal();
			globalThis.children = await second.popups();
		})()`,
			context,
		);
		expect(calls[0]).toMatchObject({ action: "instances" });
		expect(calls[1]).toMatchObject({ action: "discover", browserId: "work-profile" });
		expect(calls[2]).toMatchObject({ action: "create", browserId: "work-profile" });
		expect(calls.at(-3)).toMatchObject({
			handle: "handle-1",
			chain: [
				{ method: "ref", args: ["initial-1:1"] },
				{ method: "click", args: [] },
			],
		});
		expect(calls.at(-2)).toMatchObject({ handle: "handle-2", action: "reveal" });
		expect(calls.at(-1)).toMatchObject({ handle: "handle-2", action: "popups" });
		// Both handles share the label, so a name lookup must resolve the tab
		// that owns the name now rather than dropping the handle entirely.
		await runInContext('browser.tab("Same label").reveal()', context);
		expect(calls.at(-1)).toMatchObject({ handle: "handle-2", action: "reveal" });
		// The prompt's identity rule is `tab.target`; a name lookup must carry it.
		expect(runInContext('browser.tab("Same label").target', context)).toEqual({
			id: "discovery-2",
			browserId: "profile-2",
			tabId: 1,
		});
		await runInContext('browser.tab("Same label").release()', context);
		// A released handle stops answering to its name instead of being reused.
		await expect(runInContext('browser.tab("Same label").reveal()', context)).rejects.toThrow(
			"reveal requires a Chrome tab returned by create or claim",
		);
		expect(runInContext("[first.target, second.target]", context)).toEqual([
			{ id: "discovery-1", browserId: "profile-1", tabId: 1 },
			{ id: "discovery-2", browserId: "profile-2", tabId: 1 },
		]);
		expect(() => runInContext('"use strict"; first.target.id = "discovery-2"', context)).toThrow();
		expect(runInContext("first.initialObservation.snapshot", context)).toBe("initial-1");
		await runInContext(
			'first.dialog({action:"accept",id:first.initialDialog.dialog.id,promptText:"café Ω"})',
			context,
		);
		expect(calls.at(-1)).toEqual({
			action: "dialog",
			handle: "handle-1",
			dialog: { action: "accept", id: "dialog-first", promptText: "café Ω" },
		});
	});

	it("builds handles, chains, markers, and direct values against the shipped VM prelude", async () => {
		const calls: unknown[] = [];
		const displays: unknown[] = [];
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = createContext({
			__omp_display__: (value: unknown) => displays.push(value),
			__omp_prelude__: async (name: string, parameters: unknown) => {
				expect(name).toBe("browser");
				calls.push(parameters);
				return responseFor(parameters);
			},
		});
		runInContext(prelude.javascript, context);

		expect(
			await runInContext(
				'(async () => { globalThis.tab = await browser.open({ name: "docs", url: "https://example.test", action: "close" }); return tab.name; })()',
				context,
			),
		).toBe("docs");
		expect(await runInContext("tab.title()", context)).toBe("page title");
		expect(await runInContext("tab.observe()", context)).toEqual({
			elements: [{ id: 5, role: "button", name: "Save" }],
		});
		expect(await runInContext('tab.id(5).fill("Ada", undefined)', context)).toBe(true);
		expect(await runInContext('tab.evaluate(value => value.length, "save", /save/i, undefined)', context)).toBe(9);
		expect(await runInContext("tab.run((_scope, count) => count + 1, { args: [7], timeout: 2 })", context)).toBe(8);
		expect(await runInContext('tab.run("return { ok: true };")', context)).toEqual({ ok: true });
		expect(await runInContext('browser.tab("other").title()', context)).toBe("page title");
		await runInContext('browser.close({ name: "docs", action: "run" })', context);

		expect(displays).toEqual(["opened display text"]);
		expect(runInContext("browser.run", context)).toBeUndefined();
		expect(
			runInContext("Object.isFrozen(browser) && Object.isFrozen(tab) && Object.isFrozen(tab.id(5))", context),
		).toBe(true);
		expect(() => runInContext('browser.tab("")', context)).toThrow("browser.tab() expects a tab name");
		await expect(runInContext("browser.open(null)", context)).rejects.toThrow(
			"browser.open() expects an options object",
		);
		await expect(runInContext("tab.run({ code: 'return 1' })", context)).rejects.toThrow(
			"tab.run() expects a function or code string",
		);
		await expect(runInContext("tab.run(Math.max)", context)).rejects.toThrow(
			"tab.run() cannot serialize a native or bound function; pass an arrow or function expression",
		);
		expect(() => runInContext("tab.evaluate(Math.max)", context)).toThrow(
			"tab helper argument cannot serialize a native or bound function; pass an arrow or function expression",
		);

		expect(calls).toEqual([
			{ action: "open", name: "docs", url: "https://example.test" },
			{ action: "call", name: "docs", chain: [{ method: "title", args: [] }] },
			{ action: "call", name: "docs", chain: [{ method: "observe", args: [] }] },
			{
				action: "call",
				name: "docs",
				chain: [
					{ method: "id", args: [5] },
					{ method: "fill", args: ["Ada"] },
				],
			},
			{
				action: "call",
				name: "docs",
				chain: [
					{
						method: "evaluate",
						args: [{ __omp_fn: "value => value.length" }, "save", { __omp_re: { source: "save", flags: "i" } }],
					},
				],
			},
			{
				action: "run",
				name: "docs",
				fn: "(_scope, count) => count + 1",
				args: [7],
				timeout: 2,
			},
			{ action: "run", name: "docs", code: "return { ok: true };" },
			{ action: "call", name: "other", chain: [{ method: "title", args: [] }] },
			{ action: "close", name: "docs" },
		]);
	});

	it("prints the typed API on demand through the real host action", async () => {
		const displays: unknown[] = [];
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = createContext({
			__omp_display__: (value: unknown) => displays.push(value),
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, { session, toolCallId: "browser-help" });
				return {
					details: result.details,
					text: result.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map(block => block.text)
						.join("\n"),
				};
			},
		});
		runInContext(prelude.javascript, context);

		await runInContext("browser.help()", context);
		expect(displays.join("\n")).toContain("interface BrowserTab");
		expect(typeof prelude.approval === "function" ? prelude.approval({ action: "help" }) : prelude.approval).toBe(
			"read",
		);
	});
});

describe("browser facade in real Eval runtimes", () => {
	it("unwraps values, displays host text, and preserves JavaScript helper chains", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(() => definitions);
		definitions = [recorderDefinition(session, calls)];
		const result = await executeJs(
			[
				'const tab = await browser.open({ name: "real-js" });',
				"print(await tab.title());",
				"print(JSON.stringify(await tab.observe()));",
				'print(await tab.id(5).fill("Grace"));',
				'print(await tab.evaluate(value => value.length, "abc", /a/i));',
				"print(await tab.run((_scope, count) => count + 1, { args: [7] }));",
			].join("\n"),
			{ cwd: process.cwd(), sessionId: `browser-facade-js-${crypto.randomUUID()}`, session },
		);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual([
			"opened display text",
			"page title",
			'{"elements":[{"id":5,"role":"button","name":"Save"}]}',
			"true",
			"9",
			"8",
		]);
		expect(calls).toContainEqual({
			action: "call",
			name: "real-js",
			chain: [
				{
					method: "evaluate",
					args: [{ __omp_fn: "value => value.length" }, "abc", { __omp_re: { source: "a", flags: "i" } }],
				},
			],
		});
		expect(calls).toContainEqual({
			action: "call",
			name: "real-js",
			chain: [
				{ method: "id", args: [5] },
				{ method: "fill", args: ["Grace"] },
			],
		});
	});

	it("prints a tree the tab already rendered once, whoever the cell's trailing expression is", async () => {
		const tree = 'https://example.test | Docs\n- button "Save" [ref=e5]';
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(() => definitions);
		const shipped = createBrowserPrelude(session);
		definitions = [
			{
				...shipped,
				async invoke(parameters) {
					if (field(parameters, "action") === "open") return { content: [], details: { name: "echo-js" } };
					if (firstChainMethod(parameters) === "title") return { content: [], details: { value: "Docs" } };
					return {
						content: [{ type: "text", text: tree }],
						details: { value: { snapshot: "s1", elements: [{ id: 5 }] }, rendered: true },
					};
				},
			},
		];
		const options = { cwd: process.cwd(), sessionId: `browser-echo-js-${crypto.randomUUID()}`, session };
		const echoed = await executeJs(
			[
				'const tab = await browser.open({ name: "echo-js" });',
				"const observation = await tab.observe();",
				"print(`elements=${observation.elements.length}`);",
				"await tab.observe()",
			].join("\n"),
			options,
		);
		expect(echoed.exitCode).toBe(0);
		expect(echoed.output.trim().split("\n")).toEqual([...tree.split("\n"), "elements=1", ...tree.split("\n")]);
		// The tree reaches the model as the tab's own text. Re-serializing the same
		// observation as the cell's value is what the bench measured as pure waste.
		expect(echoed.displayOutputs.filter(output => output.type === "json")).toEqual([]);
		// Values the host did not render still echo, and an explicit display of a
		// rendered value is the caller's own decision.
		const kept = await executeJs(
			['const tab = await browser.open({ name: "echo-js" });', "await tab.title()"].join("\n"),
			options,
		);
		expect(kept.output.trim()).toBe("Docs");
		const forced = await executeJs(
			['const tab = await browser.open({ name: "echo-js" });', "display(await tab.observe())"].join("\n"),
			options,
		);
		expect(forced.displayOutputs.filter(output => output.type === "json")).toEqual([
			{ type: "json", data: { snapshot: "s1", elements: [{ id: 5 }] } },
		]);
	});

	it("reports a refusal from the browser bridge without the harness stack behind it", async () => {
		const refusal = "fill needs a text input; this node reported no selection range";
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(() => definitions);
		const shipped = createBrowserPrelude(session);
		definitions = [
			{
				...shipped,
				async invoke(parameters) {
					if (field(parameters, "action") === "open") return { content: [], details: { name: "refusing" } };
					throw new ToolError(refusal);
				},
			},
		];
		const options = { cwd: process.cwd(), sessionId: `browser-refusal-js-${crypto.randomUUID()}`, session };
		const refused = await executeJs(
			['const tab = await browser.open({ name: "refusing" });', 'await tab.fill("#email", "a@b.c");'].join("\n"),
			options,
		);
		expect(refused.exitCode).toBe(1);
		expect(refused.output.trim()).toBe(`ToolError: ${refusal}`);
		// The cell's own failure keeps the trace: those frames name the cell.
		const own = await executeJs("throw new Error('cell broke');", options);
		expect(own.exitCode).toBe(1);
		expect(own.output).toContain("cell broke");
		expect(own.output).toContain("at ");
	});

	it("unwraps values, prints host text, and preserves Python helper chains in a real kernel", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(() => definitions);
		definitions = [recorderDefinition(session, calls)];
		const result = await executePython(
			[
				"import re",
				'tab = await browser.open(name="real-py")',
				"print(await tab.title())",
				'print((await tab.observe())["elements"][0]["role"])',
				'print(await tab.id(5).fill("Ada"))',
				'print(await tab.evaluate("abc", matcher=re.compile("a", re.I)))',
				'print(await tab.run("return 42;", timeout=2))',
				"await tab.close()",
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `browser-facade-py-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual([
			"opened display text",
			"page title",
			"button",
			"True",
			"9",
			"{'ok': True}",
		]);
		expect(calls).toContainEqual({
			action: "call",
			name: "real-py",
			chain: [
				{
					method: "evaluate",
					args: ["abc", { matcher: { __omp_re: { source: "a", flags: "i" } } }],
				},
			],
		});
		expect(calls).toContainEqual({
			action: "call",
			name: "real-py",
			chain: [
				{ method: "id", args: [5] },
				{ method: "fill", args: ["Ada"] },
			],
		});
		expect(calls).toContainEqual({ action: "run", name: "real-py", code: "return 42;", timeout: 2 });
	});

	it("forwards Python open timeout and persist side by side (issue #8246 review)", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(() => definitions);
		definitions = [recorderDefinition(session, calls)];
		const result = await executePython(
			[
				'tab = await browser.open(name="py-opts", timeout=7, persist=True)',
				'plain = await browser.open(name="py-plain")',
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `browser-facade-py-open-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(calls).toContainEqual({ action: "open", name: "py-opts", timeout: 7, persist: true });
		expect(calls).toContainEqual({ action: "open", name: "py-plain" });
	});

	it("binds Python's initial controls to their acquisition snapshot and keeps discovery identity immutable", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(() => definitions);
		definitions = [
			{
				...createBrowserPrelude(session),
				async invoke(parameters) {
					calls.push(parameters);
					if (field(parameters, "action") === "claim")
						return {
							content: [],
							details: {
								name: "Same label",
								handle: "py-held-tab",
								value: {
									target: { id: "py-discovery", browserId: "py-profile", tabId: 7 },
									initialObservation: { snapshot: "initial-py", elements: [{ id: 2, role: "button" }] },
									initialDialog: { status: "open", dialog: { id: "dialog-py" } },
								},
							},
						};
					return { content: [], details: { value: { snapshot: "replacement-py", elements: [{ id: 2 }] } } };
				},
			},
		];
		const result = await executePython(
			`tab = await browser.getTab({"title": "Same label"}, observation={"screenshot": False})
element = tab.id(tab.initialObservation["elements"][0]["id"])
await tab.dialog(action="accept", id=tab.initialDialog["dialog"]["id"], promptText="café Ω")
await tab.dialog({"action":"inspect"})
await tab.observe()
await element.click()
await tab.reveal()
await tab.popups()
await browser.tab("Same label").reveal()
try:
    tab.target["id"] = "another-tab"
except TypeError:
    print("immutable")
print(tab.target["id"])
print(tab.initialObservation["snapshot"])
`,
			{
				cwd: process.cwd(),
				sessionId: `browser-initial-py-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual(["immutable", "py-discovery", "initial-py"]);
		expect(calls).toContainEqual({
			action: "dialog",
			handle: "py-held-tab",
			dialog: { action: "accept", id: "dialog-py", promptText: "café Ω" },
		});
		expect(calls).toContainEqual({ action: "dialog", handle: "py-held-tab", dialog: { action: "inspect" } });
		expect(calls).toContainEqual({ action: "reveal", handle: "py-held-tab" });
		expect(calls).toContainEqual({ action: "popups", handle: "py-held-tab" });
		// A name lookup carries the handle: managed Chrome tabs are only
		// addressable by handle, and the label is not unique.
		expect(calls.at(-1)).toMatchObject({ action: "reveal", handle: "py-held-tab" });
		expect(calls.find(call => JSON.stringify(field(call, "chain") ?? "").includes('"ref"'))).toMatchObject({
			handle: "py-held-tab",
			chain: [
				{ method: "ref", args: ["initial-py:2"] },
				{ method: "click", args: [] },
			],
		});
		expect(calls[0]).toMatchObject({
			action: "claim",
			selector: { title: "Same label" },
			observation: { screenshot: false },
		});
	});
});

const CHROMIUM_AVAILABLE = await chromiumAvailable();

describe("browser facade Chromium helper E2E", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"drives a real page through direct helpers, handles, waits, and function and code runs",
		async () => {
			const name = `facade-e2e-${crypto.randomUUID()}`;
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const displayed: unknown[] = [];
			const html = [
				"<!doctype html>",
				"<title>Ready</title>",
				'<button id="go" onclick="document.title = \'Clicked\'">Go</button>',
				'<input aria-label="Name">',
			].join("");
			const context = createContext({
				__name__: name,
				__url__: `data:text/html,${encodeURIComponent(html)}`,
				__omp_display__: (value: unknown) => displayed.push(value),
				__omp_prelude__: async (preludeName: string, parameters: unknown) => {
					expect(preludeName).toBe("browser");
					const result = await prelude.invoke(parameters, {
						session,
						toolCallId: `browser-e2e-${crypto.randomUUID()}`,
					});
					return {
						text: result.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("\n"),
						details: result.details,
					};
				},
			});
			runInContext(prelude.javascript, context);

			try {
				await runInContext(
					"(async () => { globalThis.__e2eTab = await browser.open({ name: __name__, url: __url__ }); })()",
					context,
				);
				// The verbs ride the acquisition, once. Their absence is what the
				// 20260914 bench leg paid for in `selectOption` TypeErrors and
				// 8 KB `browser.help()` recoveries.
				expect(displayed.filter(text => String(text).includes(BROWSER_TAB_VERBS))).toHaveLength(1);
				expect(String(displayed.at(-1)).split("\n").at(-1)).toBe(BROWSER_TAB_VERBS);
				await runInContext('__e2eTab.click("text/Go")', context);
				const title = await runInContext("__e2eTab.title()", context);
				expect(typeof title).toBe("string");
				expect(title).toBe("Clicked");
				expect(await runInContext("__e2eTab.run((_scope, value) => value + 1, { args: [7] })", context)).toBe(8);
				expect(
					await runInContext("__e2eTab.run('display(\"worker display text\"); return { value: 3 };')", context),
				).toEqual({ value: 3 });
				expect(displayed).toContain("worker display text");

				const observation = await runInContext("__e2eTab.observe()", context);
				expect(field(observation, "elements")).toBeArray();
				// The facade prints the tree itself; the model does not wrap observe() in display().
				expect(field(observation, "tree")).toContain('button "Go"');
				expect(displayed.at(-1)).toBe(field(observation, "tree"));
				// Reading the same tab again repeats the tree, never the verbs.
				expect(displayed.filter(text => String(text).includes("browser.help() for signatures"))).toHaveLength(1);
				const buttonId = await runInContext(
					'(async () => { const observation = await __e2eTab.observe(); return observation.elements.find(element => element.name === "Go").id; })()',
					context,
				);
				expect(typeof buttonId).toBe("number");
				expect(await runInContext(`__e2eTab.id(${String(buttonId)}).isVisible()`, context)).toBe(true);
				expect(
					await runInContext(
						`__e2eTab.id(${String(buttonId)}).evaluate("element => element.textContent")`,
						context,
					),
				).toBe("Go");
				expect(await runInContext('__e2eTab.waitFor("text/Go")', context)).toBe(true);
			} finally {
				await prelude
					.invoke({ action: "close", name }, { session, toolCallId: `browser-e2e-cleanup-${crypto.randomUUID()}` })
					.catch(() => undefined);
			}
		},
		30_000,
	);
});
