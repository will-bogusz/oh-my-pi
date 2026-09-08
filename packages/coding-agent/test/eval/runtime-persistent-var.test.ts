import { expect, it } from "bun:test";
import { JsRuntime, type RuntimeHooks } from "../../src/eval/js/shared/runtime";

const hooks: RuntimeHooks = {
	onText() {},
	onDisplay() {},
	async callTool() {
		throw new Error("No tool calls expected");
	},
};

it("an async cell can read a retained observation before redeclaring its var binding", async () => {
	const runtime = new JsRuntime({ initialCwd: import.meta.dir, sessionId: crypto.randomUUID() });
	runtime.setRunScope({ effects: undefined, obs: undefined });
	try {
		await runtime.run('var effects = []; var obs = await Promise.resolve({ value: "ready" });', undefined, hooks);
		const result = await runtime.run(
			'effects.push(obs.value); var obs = await Promise.resolve({ value: "saved" }); obs.value',
			undefined,
			hooks,
		);
		expect(result).toBe("saved");
		expect(await runtime.run("effects", undefined, hooks)).toEqual(["ready"]);
		await runtime.run("await Promise.resolve(); var obs;", undefined, hooks);
		expect(await runtime.run("obs.value", undefined, hooks)).toBe("saved");
	} finally {
		runtime.dispose();
	}
});

it("seeding retained vars preserves a same-cell hoisted function and fresh undefined bindings", async () => {
	const runtime = new JsRuntime({ initialCwd: import.meta.dir, sessionId: crypto.randomUUID() });
	runtime.setRunScope({ handler: undefined, fresh: undefined });
	try {
		await runtime.run('var handler = () => "old";', undefined, hooks);
		expect(
			await runtime.run(
				'var handler; function handler() { return "new"; } await Promise.resolve(); handler()',
				undefined,
				hooks,
			),
		).toBe("new");
		expect(await runtime.run("await Promise.resolve(); var fresh; fresh", undefined, hooks)).toBeUndefined();
	} finally {
		runtime.dispose();
	}
});

it("retained-var initialization does not disable a cell's strict directive", async () => {
	const runtime = new JsRuntime({ initialCwd: import.meta.dir, sessionId: crypto.randomUUID() });
	const leak = `__ompStrictProbe_${crypto.randomUUID().replaceAll("-", "")}`;
	runtime.setRunScope({ fresh: undefined });
	try {
		await expect(
			runtime.run(`"use strict"; await Promise.resolve(); var fresh; ${leak} = 1;`, undefined, hooks),
		).rejects.toBeInstanceOf(ReferenceError);
	} finally {
		Reflect.deleteProperty(globalThis, leak);
		runtime.dispose();
	}
});
