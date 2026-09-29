import { afterEach, describe, expect, it } from "bun:test";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { Settings } from "../../src/config/settings";
import { disposeVmContextsByOwner } from "../../src/eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../../src/eval/py/executor";
import type { EvalPreludeDefinition } from "../../src/eval/preludes";
import type { ToolSession } from "../../src/tools";
import { createComputerPrelude } from "../../src/tools/computer";
import type { ComputerBackend } from "../../src/tools/computer/backend";
import { ComputerSupervisor } from "../../src/tools/computer/supervisor";
import type {
	ComputerActionResult,
	ComputerCapabilities,
	ComputerObservation,
	ComputerWindowIdentity,
} from "../../src/tools/computer/types";
import { EvalTool } from "../../src/tools/eval";

const capabilities: ComputerCapabilities = {
	backend: "fake",
	displayServer: "memory",
	capture: true,
	input: true,
	ax: true,
	backgroundWindowInput: true,
	deliveryModes: ["background", "foreground"],
	capturePermission: "granted",
	inputPermission: "granted",
	axPermission: "granted",
	displayCount: 1,
};

const WINDOW: ComputerWindowIdentity = {
	id: "7",
	pid: 42,
	app: "Fake",
	title: "Main",
	bounds: { x: 0, y: 0, width: 400, height: 300 },
};
const PROBE = "🔎 Delivered: the window changed after the dispatch — check the postcondition you wanted.";

/** One window, one row; `click` doubts its own delivery (so it prints) or refuses. */
class FakeBackend {
	readonly capabilities = capabilities;
	refuse = false;
	async window(): Promise<ComputerWindowIdentity> {
		return WINDOW;
	}
	async observe(): Promise<ComputerObservation> {
		return {
			snapshotId: "s1",
			window: WINDOW,
			tree: 'n1 button "Add"',
			elements: [],
			complete: true,
			backgroundInput: null,
		};
	}
	async click(): Promise<ComputerActionResult> {
		if (this.refuse) throw new ToolError("element_disabled: refused before dispatch", { code: "element_disabled" });
		return {
			text: `Pressed n1.\n${PROBE}`,
			effect: "unverifiable",
			evidence: null,
			route: "accessibility",
			delivery: "background",
			mustShow: true,
		};
	}
	async drain(): Promise<void> {}
	async close(): Promise<void> {}
}

const owners: string[] = [];
afterEach(async () => {
	for (const owner of owners.splice(0)) {
		await disposeVmContextsByOwner(owner);
		await disposeKernelSessionsByOwner(owner);
	}
});

function harness(): { tool: EvalTool; backend: FakeBackend; definition: EvalPreludeDefinition } {
	const owner = `computer-cell-reply-${crypto.randomUUID()}`;
	owners.push(owner);
	const backend = new FakeBackend();
	const session: ToolSession = {
		cwd: import.meta.dir,
		hasUI: false,
		settings: Settings.isolated({ "computer.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => owner,
		getEvalKernelOwnerId: () => owner,
		getEvalPreludes: () => [definition],
	};
	const definition = createComputerPrelude(
		session,
		currentSession => new ComputerSupervisor(currentSession, async () => backend as unknown as ComputerBackend),
	);
	return { tool: new EvalTool(session), backend, definition };
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.flatMap(block => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}

describe("one computer reply per eval cell", () => {
	it("drops an action's probe line when the same cell reads that window afterwards", async () => {
		const { tool } = harness();
		const result = await tool.execute("read-after", {
			language: "js",
			code: 'const w = await computer.window({ id: "7", pid: 42 }); await w.click("n1"); await w.observe();',
		});
		const output = text(result);
		expect(output).toContain("? click n1");
		expect(output).toContain("Pressed n1.");
		expect(output).toContain('n1 button "Add"');
		expect(output).not.toContain(PROBE);
	}, 20_000);

	it("keeps the probe line when nothing in the cell read the window again", async () => {
		const { tool } = harness();
		const result = await tool.execute("no-read", {
			language: "js",
			code: 'const w = await computer.window({ id: "7", pid: 42 }); await w.click("n1");',
		});
		expect(text(result)).toContain(PROBE);
	}, 20_000);

	it("leads a cell that failed mid-way with what ran and where it stopped", async () => {
		const { tool, backend } = harness();
		backend.refuse = true;
		const result = await tool.execute("mid-cell", {
			language: "js",
			code: 'const w = await computer.window({ id: "7", pid: 42 }); await w.click("n1"); await w.observe();',
		});
		const output = text(result);
		const summary = output.split("\n").find(line => line.includes("click n1"));
		expect(summary).toContain("✗ click n1 (element_disabled)");
		expect(summary).toContain("the rest of the cell did not run");
		// Only the acquisition's tree: the observe behind the refusal never ran.
		expect(output.split('n1 button "Add"').length - 1).toBe(1);
		expect(output).toContain("element_disabled: refused before dispatch");
	}, 20_000);

	it("composes a Python cell the same way", async () => {
		const { tool } = harness();
		const result = await tool.execute("py-cell", {
			language: "py",
			code: 'w = await computer.window({"id": "7", "pid": 42})\nawait w.click("n1")\nawait w.observe()',
		});
		const output = text(result);
		expect(output).toContain("? click n1");
		expect(output).not.toContain(PROBE);
	}, 30_000);
});
