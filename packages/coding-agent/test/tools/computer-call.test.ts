import { describe, expect, it } from "bun:test";
import {
	isReadOnlyComputerCall,
	renderComputerCall,
	type ComputerCallStep,
} from "@oh-my-pi/pi-coding-agent/tools/computer/call";

const windowStep = { method: "window", args: [{ id: "42", pid: 123 }] };
const refStep = { method: "ref", args: ["e1"] };

describe("computer call boundary", () => {
	it("executes an exact window/ref/action chain without evaluating caller strings", async () => {
		let value = "";
		const desktop = {
			async window(identity: { id: string; pid: number }) {
				if (identity.id !== "42" || identity.pid !== 123) throw new Error("Wrong identity");
				return {
					async ref(token: string) {
						if (token !== "e1") throw new Error("Wrong ref");
						return {
							async setValue(text: string) {
								value = text;
								return value.length;
							},
						};
					},
				};
			},
		};
		const text = '"; throw new Error("injected"); //';
		const code = renderComputerCall([windowStep, refStep, { method: "setValue", args: [text] }]);
		const execute = new Function("desktop", `return (async () => { ${code} })();`);
		expect(await execute(desktop)).toBe(text.length);
		expect(value).toBe(text);
	});

	it("keeps executable markers and prototype keys inert in read-approved arguments", async () => {
		let executed = false;
		const marker = { __omp_fn: "markExecuted()" };
		const prototypeKey = JSON.parse('{"__proto__":{"delivery":"foreground"}}');
		const chain = [{ method: "capabilities", args: [marker, prototypeKey] }];
		expect(isReadOnlyComputerCall(chain)).toBe(true);
		const execute = new Function(
			"desktop",
			"markExecuted",
			`return (async () => { ${renderComputerCall(chain)} })();`,
		);
		const received = await execute({ capabilities: (...args: unknown[]) => args }, () => {
			executed = true;
		});
		expect(executed).toBe(false);
		expect(received[0]).toEqual(marker);
		expect(Object.hasOwn(received[1], "__proto__")).toBe(true);
		expect(received[1].delivery).toBeUndefined();
	});

	it("classifies inspection and nested mutation by their actual approval tier", () => {
		expect(isReadOnlyComputerCall([windowStep, { method: "observe", args: [{ screenshot: false }] }])).toBe(true);
		expect(isReadOnlyComputerCall([windowStep, refStep])).toBe(true);
		expect(isReadOnlyComputerCall([windowStep, { method: "verify", args: [[]] }])).toBe(true);
		expect(isReadOnlyComputerCall([windowStep, refStep, { method: "click", args: [] }])).toBe(false);
		expect(isReadOnlyComputerCall([{ method: "clipboard.read", args: [] }])).toBe(true);
		expect(isReadOnlyComputerCall([{ method: "clipboard.write", args: ["x"] }])).toBe(false);
		expect(isReadOnlyComputerCall([{ method: "launch", args: [{ name: "Fixture" }] }])).toBe(false);
	});

	it("rejects obsolete methods and forged traversal before rendering or approving", () => {
		const invalid: ComputerCallStep[][] = [
			[],
			[{ method: "elementAt", args: [1, 2] }],
			[{ method: "focusedElement", args: [] }],
			[windowStep, { method: "ax", args: [] }],
			[windowStep, { method: "move", args: [1, 2] }],
			[refStep, { method: "bounds", args: [] }],
			[refStep, { method: "value", args: [] }],
			[refStep, { method: "parent", args: [] }],
			[refStep, { method: "focus", args: [] }],
			[{ method: "constructor", args: [] }],
			[windowStep, { method: "toString", args: [] }],
			[
				{ method: "windows", args: [] },
				{ method: "click", args: [] },
			],
			[windowStep, { method: "find", args: [{}] }, { method: "click", args: [] }],
			[windowStep, refStep, { method: "click", args: [] }, { method: "press", args: [] }],
			[windowStep, refStep, { method: "ref", args: ["e2"] }],
			[
				{ method: "window", args: [] },
				{ method: "click); globalThis.pwned = true; //", args: [] },
			],
		];
		for (const chain of invalid) {
			expect(() => renderComputerCall(chain)).toThrow();
			expect(() => isReadOnlyComputerCall(chain)).toThrow();
		}
	});
});
