import { describe, expect, it, spyOn } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { browserActorId } from "@oh-my-pi/pi-coding-agent/tools/browser/managed-chrome";
import * as supervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

import { cfgBrowserEnabled } from "@oh-my-pi/pi-coding-agent/tools/browser/settings";

function makeSession(settings = Settings.isolated({ "browser.enabled": true })): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

describe("browser prelude", () => {
	it("separates actors sharing an Eval kernel and keeps stable identified ownership across session wrappers", () => {
		const first = {
			...makeSession(),
			getSessionId: () => "task",
			getAgentId: () => "actor-a",
			getEvalSessionId: () => "shared-kernel",
		};
		const second = { ...first, getAgentId: () => "actor-b" };
		expect(browserActorId(first)).not.toBe(browserActorId(second));
		expect(browserActorId({ ...first })).toBe(browserActorId(first));
	});

	it("isolates embedding sessions without identity getters while keeping a live session stable", () => {
		const first = makeSession();
		expect(browserActorId(first)).toBe(browserActorId(first));
		expect(browserActorId(first)).not.toBe(browserActorId(makeSession()));
	});

	it("tracks the live browser capability setting", () => {
		const settings = Settings.isolated();
		cfgBrowserEnabled.set(settings, false);
		const prelude = createBrowserPrelude(makeSession(settings));

		expect(prelude.enabled?.()).toBe(false);
		cfgBrowserEnabled.set(settings, true);
		expect(prelude.enabled?.()).toBe(true);
	});

	it("validates host arguments before dispatch", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-invalid-arguments" };

		await expect(prelude.invoke({ action: "run", name: "x", code: 42 }, context)).rejects.toThrow(
			/browser received invalid arguments/,
		);
		await expect(prelude.invoke({ action: "run", name: "x" }, context)).rejects.toThrow(
			"Action 'run' requires exactly one of 'code' or 'fn'.",
		);
		await expect(
			prelude.invoke({ action: "run", name: "x", code: "return 1", fn: "() => 1" }, context),
		).rejects.toThrow("Action 'run' requires exactly one of 'code' or 'fn'.");
		await expect(prelude.invoke({ action: "run", name: "x", code: "   " }, context)).rejects.toThrow(
			"Action 'run' requires exactly one of 'code' or 'fn'.",
		);
		await expect(prelude.invoke({ action: "call", name: "x", chain: [] }, context)).rejects.toThrow(
			"Action 'call' requires a non-empty 'chain'.",
		);
		for (const invalid of [
			{ init_scripts: ["valid", 1] },
			{ downloads: false },
			{ user_agent: 1 },
			{ ignore_https_errors: "yes" },
			{ allow_file_access: 1 },
			{ headed: "yes" },
		]) {
			await expect(prelude.invoke({ action: "open", ...invalid }, context)).rejects.toThrow(
				/browser received invalid arguments/,
			);
		}
	});

	it("closes through the real host for an absent named tab", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const result = await prelude.invoke(
			{ action: "close", name: `missing-${crypto.randomUUID()}` },
			{ session, toolCallId: "browser-close-missing" },
		);

		expect(result.content).toEqual([
			{
				type: "text",
				text: expect.stringMatching(/^No tab named "missing-/),
			},
		]);
	});

	it("owns actions and exposes tab handles instead of browser.run", async () => {
		const calls: unknown[] = [];
		const displayed: unknown[] = [];
		const context = createContext({
			__omp_display__: (value: unknown) => displayed.push(value),
			__omp_prelude__: async (name: string, parameters: unknown) => {
				calls.push({ name, parameters });
				if (parameters === null || typeof parameters !== "object") return { text: "", details: {} };
				const action = Reflect.get(parameters, "action");
				const tabName = Reflect.get(parameters, "name");
				return {
					text: action === "open" ? "Opened tab" : "",
					details: {
						name: typeof tabName === "string" ? tabName : "main",
						value: action === "call" ? "page title" : undefined,
					},
				};
			},
		});
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		runInContext(prelude.javascript, context);
		const browser = runInContext("browser", context);

		const tab = await browser.open({ action: "close", name: "docs", url: "https://example.com" });
		expect(tab.name).toBe("docs");
		expect(String(tab)).toBe("<tab docs>");
		expect(String(tab.id(5))).toBe("<element tab.id(5) on docs>");
		expect(await tab.title()).toBe("page title");
		expect(browser.run).toBeUndefined();
		await browser.close({ action: "run", all: true });
		await expect(browser.open(null)).rejects.toThrow(/expects an options object/);
		expect(displayed).toEqual(["Opened tab"]);
		expect(calls).toEqual([
			{
				name: "browser",
				parameters: { action: "open", name: "docs", url: "https://example.com" },
			},
			{
				name: "browser",
				parameters: { action: "call", name: "docs", chain: [{ method: "title", args: [] }] },
			},
			{
				name: "browser",
				parameters: { action: "close", all: true },
			},
		]);
	});

	// `String(observation).match(…)` searched "[object Object]" and always missed.
	it("reads an observation value as its tree in both preludes", async () => {
		const tree = 'url: https://example.test/ | title: Example\ne1 button "Go"';
		const observation = { snapshot: "s1", url: "https://example.test/", tree, elements: [] };
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = createContext({
			__omp_display__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const created = Reflect.get(Object(parameters), "action") === "create";
				return {
					text: "",
					details: created
						? { name: "Fixture", handle: "fixture-handle", value: { initialObservation: { ...observation } } }
						: { value: { ...observation }, rendered: true },
				};
			},
		});
		runInContext(prelude.javascript, context);
		const javascript = await runInContext(
			`(async () => {
				const tab = await browser.create();
				const observation = await tab.observe();
				return { initial: String(tab.initialObservation), observed: \`\${observation}\`, json: JSON.stringify(observation) };
			})()`,
			context,
		);
		expect(javascript.initial).toBe(tree);
		expect(javascript.observed).toBe(tree);
		// The tree string is how it reads, not another field it carries.
		expect(JSON.parse(javascript.json)).toEqual(observation);

		const run = spyOn(supervisor, "runInTab").mockResolvedValue({
			displays: [],
			returnValue: { ...observation },
			screenshots: [],
			rendered: true,
		});
		try {
			session.getEvalPreludes = () => [prelude];
			const python = await executePython(
				`obs = await browser.tab("fixture").observe()\nprint(str(obs) == obs["tree"], f"{obs}" == obs["tree"])`,
				{
					cwd: import.meta.dir,
					sessionId: `observation-string-${crypto.randomUUID()}`,
					toolSession: session,
					kernelMode: "per-call",
				},
			);
			expect(python.exitCode).toBe(0);
			expect(python.output.trim().split("\n").at(-1)).toBe("True True");
		} finally {
			run.mockRestore();
		}
	}, 15_000);

	// Models reached for `tab.id` — the element helper — and passed it to claim.
	it("shows a Chrome tab's identity as tab.target.id and points a wrong id at it", async () => {
		const target = { id: "tab-7", browserId: "work", tabId: 7 };
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = createContext({
			__omp_display__: () => {},
			__omp_prelude__: async () => ({ text: "", details: { name: "Oh My Pi", handle: "h-1", value: { target } } }),
		});
		runInContext(prelude.javascript, context);
		const result = await runInContext(
			`(async () => {
				const tab = await browser.create({ url: "https://example.test/" });
				const refused = await browser.claim(tab.id).then(() => "claimed", error => error.message);
				return { text: String(tab), id: tab.target.id, element: String(tab.id(3)), refused };
			})()`,
			context,
		);
		expect(result).toEqual({
			text: '<tab Oh My Pi target.id="tab-7">',
			id: "tab-7",
			element: "<element tab.id(3) on Oh My Pi>",
			refused: expect.stringContaining("tab.target.id"),
		});
	});
});
