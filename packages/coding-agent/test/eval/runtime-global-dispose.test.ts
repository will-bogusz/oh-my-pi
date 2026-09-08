import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";

const GLOBAL_KEYS = ["__omp_import__", "read"] as const;

type GlobalKey = (typeof GLOBAL_KEYS)[number];

interface GlobalSnapshot {
	exists: boolean;
	value: unknown;
}

function snapshotGlobals(): Record<GlobalKey, GlobalSnapshot> {
	const globals = globalThis as Record<string, unknown>;
	return {
		__omp_import__: { exists: "__omp_import__" in globals, value: globals.__omp_import__ },
		read: { exists: "read" in globals, value: globals.read },
	};
}

function restoreGlobals(snapshot: Record<GlobalKey, GlobalSnapshot>): void {
	const globals = globalThis as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) {
		const state = snapshot[key];
		if (state.exists) globals[key] = state.value;
		else delete globals[key];
	}
}

function expectGlobalsRestored(snapshot: Record<GlobalKey, GlobalSnapshot>): void {
	const globals = globalThis as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) {
		const state = snapshot[key];
		if (state.exists) expect(globals[key]).toBe(state.value);
		else expect(key in globals).toBe(false);
	}
}

const hooks: RuntimeHooks = {
	onText: () => {},
	onDisplay: () => {},
	callTool: async () => undefined,
};

describe("JsRuntime global disposal", () => {
	it("keeps newer same-realm runtime globals after disposing an older runtime", () => {
		const globals = globalThis as Record<string, unknown>;
		const before = snapshotGlobals();
		const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "first" });
		const firstImport = globals.__omp_import__;
		const firstRead = globals.read;
		const second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "second" });
		const secondImport = globals.__omp_import__;

		try {
			expect(typeof firstImport).toBe("function");
			expect(typeof firstRead).toBe("function");
			expect(secondImport).not.toBe(firstImport);
			expect(typeof globals.read).toBe("function");

			first.dispose();

			expect(globals.__omp_import__).toBe(secondImport);
			expect(globals.__omp_helpers__).toBe(second.helpers);
			expect(typeof globals.read).toBe("function");

			second.dispose();
			expectGlobalsRestored(before);
		} finally {
			first.dispose();
			second.dispose();
			restoreGlobals(before);
		}
	});

	it("reactivates older same-realm runtime globals when no other run is active", async () => {
		const globals = globalThis as Record<string, unknown>;
		const before = snapshotGlobals();
		const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "first-reactivated" });
		const second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "second-reactivated" });

		try {
			expect(globals.__omp_helpers__).toBe(second.helpers);
			first.setCwd(process.cwd());
			expect(globals.__omp_helpers__).toBe(first.helpers);
			first.setRunScope({ reactivatedProbe: 7 });
			expect(globals.reactivatedProbe).toBe(7);
			expect(await first.run("1 + 6;", undefined, hooks)).toBe(7);
			second.setCwd(process.cwd());
			expect(globals.__omp_helpers__).toBe(second.helpers);
		} finally {
			delete globals.reactivatedProbe;
			first.dispose();
			second.dispose();
			restoreGlobals(before);
		}
	});

	it("defers cross-runtime setCwd while another same-realm runtime is running", async () => {
		const before = snapshotGlobals();
		const globals = globalThis as Record<string, unknown>;
		const firstCwd = process.cwd();
		const secondCwd = process.cwd();
		const first = new JsRuntime({ initialCwd: firstCwd, sessionId: "first-overlap" });
		const second = new JsRuntime({ initialCwd: secondCwd, sessionId: "second-overlap" });
		const gate = Promise.withResolvers<void>();
		let activeSecond: Promise<unknown> | undefined;
		const pendingCwd = `${firstCwd}/pending-same-realm-cwd`;

		try {
			second.setRunScope({ gate: gate.promise });
			activeSecond = second.run("await gate;", undefined, hooks);
			// Local cwd may be stamped without stealing the active realm.
			first.setCwd(pendingCwd);
			expect(first.cwd).toBe(pendingCwd);
			expect(globals.__omp_helpers__).toBe(second.helpers);
			await first.run("1", undefined, hooks).then(
				() => {
					throw new Error("expected active runtime rejection");
				},
				error =>
					expect(error).toHaveProperty(
						"message",
						"Cannot run code while another same-realm JS runtime is running",
					),
			);
			gate.resolve();
			await activeSecond;
			// The deferred cwd must reach this runtime's next run WITHOUT a second
			// setCwd: the saved __omp_session__ stack entry carries the new value.
			expect(await first.run("__omp_session__.cwd", undefined, hooks)).toBe(pendingCwd);
			expect(first.cwd).toBe(pendingCwd);
			expect(globals.__omp_helpers__).toBe(first.helpers);
			expect(globals.__omp_session__).toMatchObject({ cwd: pendingCwd });
		} finally {
			gate.resolve();
			if (activeSecond) await activeSecond.catch(() => undefined);
			delete globals.gate;
			first.dispose();
			second.dispose();
			restoreGlobals(before);
		}
	});

	it("setCwd on a disposed runtime still throws", () => {
		const before = snapshotGlobals();
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "disposed-setcwd" });
		try {
			runtime.dispose();
			expect(() => runtime.setCwd(process.cwd())).toThrow("Cannot set cwd on a disposed JS runtime");
		} finally {
			restoreGlobals(before);
		}
	});
});

it("preserves a rebound file module across ordinary cells and runtime switches", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-eval-module-persistence-"));
	const file = path.join(directory, "review.txt");
	const text = "Alpine review — café Ω 3147\nApproved for export.\n";
	await Bun.write(file, text);
	const globals = globalThis as Record<string, unknown>;
	const original = { exists: "fs" in globals, value: globals.fs };
	const first = new JsRuntime({ initialCwd: directory, sessionId: "file-alias-first" });
	let second: JsRuntime | undefined;
	try {
		await first.run('var fs = await import("node:fs/promises");', undefined, hooks);
		first.setCwd(directory);
		first.setRunScope({});
		expect(await first.run(`await fs.readFile(${JSON.stringify(file)}, "utf8")`, undefined, hooks)).toBe(text);
		second = new JsRuntime({ initialCwd: directory, sessionId: "file-alias-second" });
		expect(await second.run('fs.readFile === require("node:fs").readFile', undefined, hooks)).toBe(true);
		await second.run('var fs = { ownAlias: "second" };', undefined, hooks);
		expect(await first.run(`await fs.readFile(${JSON.stringify(file)}, "utf8")`, undefined, hooks)).toBe(text);
		expect(await second.run("fs.ownAlias", undefined, hooks)).toBe("second");
		second.dispose();
		expect(await first.run(`await fs.readFile(${JSON.stringify(file)}, "utf8")`, undefined, hooks)).toBe(text);
	} finally {
		second?.dispose();
		first.dispose();
		expect("fs" in globals).toBe(original.exists);
		expect(globals.fs).toBe(original.value);
		await fs.rm(directory, { recursive: true, force: true });
	}
});

it("preserves completed assignments from a failed cell when another runtime is constructed", async () => {
	const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "failed-assignment-first" });
	let second: JsRuntime | undefined;
	try {
		await expect(
			first.run('var fs = { completed: 7 }; throw new Error("after assignment");', undefined, hooks),
		).rejects.toThrow("after assignment");
		second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "failed-assignment-second" });
		expect(await first.run("fs.completed", undefined, hooks)).toBe(7);
		expect(await second.run('fs.readFile === require("node:fs").readFile', undefined, hooks)).toBe(true);
	} finally {
		first.dispose();
		second?.dispose();
	}
});
