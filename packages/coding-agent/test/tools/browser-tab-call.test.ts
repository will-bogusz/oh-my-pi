import { describe, expect, it } from "bun:test";
// @ts-expect-error Bun imports this declaration source as text instead of a TypeScript module.
import browserDeclarations from "../../src/tools/browser/declarations.d.ts" with { type: "text" };
import {
	BROWSER_TAB_VERBS,
	ELEMENT_METHODS,
	FRAME_METHODS,
	renderTabCall,
	TAB_PRESENCE_METHODS,
	TAB_VALUE_METHODS,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-call";

function errorMessage(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof Error) return error.message;
		throw error;
	}
	throw new Error("Expected callback to throw");
}

describe("renderTabCall", () => {
	it("names every allowlisted verb in the acquisition footer and declares each one it names", () => {
		const [tabGroup, elementGroup, frameGroup] = BROWSER_TAB_VERBS.split(" — ")
			.slice(0, 3)
			.map(group => group.replace(/^\w+: /, "").replace(/ \(via .*\)$/, ""));
		const tabVerbs = tabGroup!.split(" · ");
		const elementVerbs = elementGroup!.split(" · ");
		const frameVerbs = frameGroup!.split(" · ");
		// The footer is the allowlist, not a hand-kept copy of it.
		expect(tabVerbs.map(verb => verb.replace(/\(.*$/, ""))).toEqual([...TAB_VALUE_METHODS, ...TAB_PRESENCE_METHODS]);
		expect(elementVerbs.map(verb => verb.replace(/\(.*$/, ""))).toEqual([...ELEMENT_METHODS]);
		expect(frameVerbs).toEqual([...FRAME_METHODS]);
		// Playwright's selectOption cost the bench five failed calls; the shape
		// that replaces it travels with the name on both surfaces.
		expect(tabVerbs).toContain("select(...values)");
		expect(elementVerbs).toContain("select(...values)");
		// Declared as a member of the tab or element interface — `evaluate` and
		// friends open with a type parameter instead of the argument list.
		for (const verb of [...tabVerbs, ...elementVerbs, ...frameVerbs])
			expect(browserDeclarations).toMatch(new RegExp(`\\n\\t${verb.replace(/\(.*$/, "")}[(<]`));
		expect(BROWSER_TAB_VERBS.split("\n")).toHaveLength(1);
	});

	it("renders value, presence, and one-hop element calls byte-for-byte", () => {
		expect(renderTabCall([{ method: "click", args: ["text/Go"] }])).toBe('return await tab.click("text/Go");');
		expect(renderTabCall([{ method: "waitFor", args: ["#x", { timeout: 1_000 }] }])).toBe(
			'return (await tab.waitFor("#x", {"timeout":1000})) !== null;',
		);
		expect(
			renderTabCall([
				{ method: "id", args: [5] },
				{ method: "fill", args: ["Ada"] },
			]),
		).toBe('return await (await tab.id(5)).fill("Ada");');
		expect(
			renderTabCall([
				{ method: "ref", args: ["e2"] },
				{ method: "evaluate", args: [{ __omp_fn: "node => node.textContent" }, /not-a-marker/] },
			]),
		).toBe('return await (await tab.ref("e2")).evaluate((node => node.textContent), {});');
		expect(
			renderTabCall([
				{ method: "id", args: [5] },
				{ method: "evaluate", args: ["node => node.textContent"] },
			]),
		).toBe("return await (await tab.id(5)).evaluate((node => node.textContent));");
	});

	it("rejects invalid call chains with actionable errors", () => {
		expect(errorMessage(() => renderTabCall([]))).toBe("Action 'call' requires a non-empty 'chain'.");
		expect(errorMessage(() => renderTabCall([{ method: "notAHelper", args: [] }]))).toContain(
			'Unknown tab helper "notAHelper".',
		);
		expect(errorMessage(() => renderTabCall([{ method: "id", args: [5] }]))).toBe(
			"tab.id() returns an element handle; call a method on it (tab.id(5).click()) or use tab.run(fn).",
		);
		expect(
			errorMessage(() =>
				renderTabCall([
					{ method: "click", args: ["#x"] },
					{ method: "focus", args: [] },
				]),
			),
		).toMatch(/^Only tab\.id\(n\)\/tab\.ref\(id\).* results accept a chained call; got tab\.click\(\)\.$/);
		expect(
			errorMessage(() =>
				renderTabCall([
					{ method: "ref", args: ["e1"] },
					{ method: "remove", args: [] },
				]),
			),
		).toContain('Unknown element method "remove".');
		expect(
			errorMessage(() =>
				renderTabCall([
					{ method: "id", args: [5] },
					{ method: "click", args: [] },
					{ method: "focus", args: [] },
				]),
			),
		).toBe("Call chains support one element-handle hop at most; use tab.run(fn) for longer sequences.");
	});
});
