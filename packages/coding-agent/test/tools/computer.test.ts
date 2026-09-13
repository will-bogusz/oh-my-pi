import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { prompt } from "@oh-my-pi/pi-utils";
import computerSafetyPrompt from "../../src/prompts/system/computer-safety.md" with { type: "text" };
import computerDescription from "../../src/prompts/tools/computer.md" with { type: "text" };
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { computerApproval, createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import type { ComputerBackend } from "@oh-my-pi/pi-coding-agent/tools/computer/backend";
import { isReadOnlyComputerCall, renderComputerCall } from "@oh-my-pi/pi-coding-agent/tools/computer/call";
import { ComputerSupervisor } from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import type {
	ComputerActionResult,
	ComputerElementSnapshot,
	ComputerObservation,
	ComputerOperationContext,
	ComputerRunOk,
	ComputerSessionSnapshot,
	ComputerTarget,
	ComputerWindowIdentity,
	ObserveOptions,
	WindowSelector,
} from "@oh-my-pi/pi-coding-agent/tools/computer/types";
import type { DesktopCapabilities, DesktopDisplay } from "@oh-my-pi/pi-natives";

const capabilities: DesktopCapabilities = {
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

const display: DesktopDisplay = {
	id: "display-1",
	name: "Primary",
	x: 0,
	y: 0,
	width: 64,
	height: 32,
	scale: 1,
	pixelX: 0,
	pixelY: 0,
	pixelWidth: 64,
	pixelHeight: 32,
	isPrimary: true,
};

const windowFixture: ComputerWindowIdentity = {
	id: "42",
	title: "Editor",
	app: "Code",
	pid: 123,
	bounds: { x: 4, y: 5, width: 40, height: 20 },
	onScreen: true,
};

/** Stateful fixture; unsupported operations fail rather than silently succeeding. */
class FakeBackend implements ComputerBackend {
	async drain(): Promise<void> {}
	readonly capabilities = { ...capabilities };
	currentWindow = structuredClone(windowFixture);
	windowAbsent = false;
	readonly pins = new Map<string, number>();
	clickCount = 0;
	closeCount = 0;
	generation = 0;
	complete = true;
	value = "ready";
	placeholder?: string;
	actions?: readonly string[];
	readonly bindings = new Map<string, { window: ComputerWindowIdentity; element: ComputerElementSnapshot }>();
	async windows(_context: ComputerOperationContext, selector: WindowSelector = {}) {
		return (this.windowAbsent ? [] : [this.currentWindow])
			.filter(
				w =>
					(selector.id === undefined || w.id === selector.id) &&
					(selector.pid === undefined || w.pid === selector.pid) &&
					(selector.app === undefined || w.app.includes(selector.app)) &&
					(selector.title === undefined || w.title.includes(selector.title)),
			)
			.map(w => structuredClone(w));
	}
	async window(context: ComputerOperationContext, selector: string | WindowSelector) {
		const windows = await this.windows(context, typeof selector === "string" ? { id: selector } : selector);
		if (windows.length !== 1) throw new Error("Missing window identity");
		const window = windows[0]!;
		if (this.pins.has(window.id) && this.pins.get(window.id) !== window.pid)
			throw new Error("InvalidTarget: owner changed");
		this.pins.set(window.id, window.pid);
		return window;
	}
	async displays() {
		return [display];
	}
	async focusedWindow(context: ComputerOperationContext) {
		return this.windowAbsent
			? null
			: this.window(context, { id: this.currentWindow.id, pid: this.currentWindow.pid });
	}
	async screenshot(context: ComputerOperationContext, options: { silent?: boolean } = {}) {
		return this.image(context, "desktop", options.silent);
	}
	async captureWindow(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		options: { silent?: boolean } = {},
	) {
		await this.window(context, { id: window.id, pid: window.pid });
		return this.image(context, window.id, options.silent);
	}
	image(context: ComputerOperationContext, target: string, silent = false) {
		const image = { path: "/fixture/capture.png", width: 64, height: 32, sourceWidth: 64, sourceHeight: 32, target };
		context.emitImage(image, { type: "image", data: "iVBORw==", mimeType: "image/png" }, silent);
		return image;
	}
	async observe(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		options: ObserveOptions = {},
	): Promise<ComputerObservation> {
		await this.window(context, { id: window.id, pid: window.pid });
		this.bindings.clear();
		const ref = `e${++this.generation}`;
		const element = {
			ref,
			pid: window.pid,
			windowId: window.id,
			role: "button",
			label: "Increment",
			value: this.value,
			...(this.placeholder !== undefined ? { placeholder: this.placeholder } : {}),
			...(this.actions !== undefined ? { actions: this.actions } : {}),
			enabled: true,
			bounds: { x: 7, y: 8, width: 9, height: 10 },
		};
		this.bindings.set(ref, { window: structuredClone(window), element });
		return {
			snapshotId: String(this.generation),
			window,
			tree: `- button [ref=${ref}]`,
			elements: [element],
			complete: this.complete,
			backgroundInput: true,
			...(options.screenshot === false ? {} : { screenshot: this.image(context, window.id, options.silent) }),
		};
	}
	element(ref: string, window?: ComputerWindowIdentity) {
		const binding = this.bindings.get(ref);
		if (!binding) throw new Error("StaleRef");
		if (window && (window.id !== binding.window.id || window.pid !== binding.window.pid))
			throw new Error("InvalidTarget");
		return binding.element;
	}
	elementWindow(ref: string) {
		this.element(ref);
		return this.bindings.get(ref)!.window;
	}
	async click(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		target: ComputerTarget,
	): Promise<ComputerActionResult> {
		await this.window(context, { id: window.id, pid: window.pid });
		if (typeof target === "string") this.element(target, window);
		this.clickCount++;
		this.value = String(this.clickCount);
		return { text: "", effect: "verified", evidence: { count: this.clickCount }, delivery: "background" };
	}
	async setValue(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		ref: string,
		value: string,
	): Promise<ComputerActionResult> {
		await this.window(context, { id: window.id, pid: window.pid });
		this.element(ref, window);
		this.value = value;
		return { text: "", effect: "verified", evidence: { value }, delivery: "background" };
	}
	unsupported = async (): Promise<never> => {
		throw new Error("Unsupported fixture operation");
	};
	apps = this.unsupported;
	type = this.unsupported;
	press = this.unsupported;
	scroll = this.unsupported;
	async verify(
		context: ComputerOperationContext,
		identity: Pick<ComputerWindowIdentity, "id" | "pid">,
		predicates: Record<string, unknown>[],
	) {
		const exists = (await this.windows(context, identity)).length !== 0;
		const outcomes = predicates.map((predicate, index) => {
			const expected = predicate.window as { exists?: boolean } | undefined;
			if (typeof expected?.exists !== "boolean") throw new Error("Unsupported fixture predicate");
			return {
				index,
				status: expected.exists === exists ? ("satisfied" as const) : ("unsatisfied" as const),
				unknown_reason: null,
				observed_json: JSON.stringify({ exists }),
			};
		});
		const status = outcomes.every(outcome => outcome.status === "satisfied")
			? ("satisfied" as const)
			: ("unsatisfied" as const);
		return { status, stable: status === "satisfied", samples: 1, elapsed_ms: 0, predicates: outcomes };
	}
	setFrame = this.unsupported;
	menu = this.unsupported;
	clipboardRead = this.unsupported;
	clipboardWrite = this.unsupported;
	launch: ComputerBackend["launch"] = this.unsupported;
	raise = this.unsupported;
	drag = this.unsupported;
	perform = this.unsupported;
	hover = this.unsupported;
	desktopClick = this.unsupported;
	desktopMove = this.unsupported;
	desktopDrag = this.unsupported;
	desktopScroll = this.unsupported;
	desktopType = this.unsupported;
	desktopPress = this.unsupported;
	async close() {
		this.closeCount++;
	}
}

const snapshot = (readOnly = false): ComputerSessionSnapshot => ({
	cwd: import.meta.dir,
	sessionId: crypto.randomUUID(),
	captureMaxWidth: 1280,
	captureMaxHeight: 896,
	display: "all",
	readOnly,
});

type SupervisorRun = { ok: true; payload: ComputerRunOk } | { ok: false; error: Error };

/** Runs desktop code on a real supervisor, reporting its failure as data. */
async function runSupervisor(
	supervisor: ComputerSupervisor,
	code: string,
	readOnly = false,
	timeoutMs = 2_000,
	signal?: AbortSignal,
): Promise<SupervisorRun> {
	try {
		return { ok: true, payload: await supervisor.run(code, timeoutMs, snapshot(readOnly), signal) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
	}
}

function toolSession(): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		settings: Settings.isolated({ "computer.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

afterAll(async () => {
	await disposeAllKernelSessions();
});

function fixturePrelude(session: ToolSession, backend: FakeBackend | (() => FakeBackend)) {
	return createComputerPrelude(
		session,
		currentSession =>
			new ComputerSupervisor(
				currentSession,
				async () => (typeof backend === "function" ? backend() : backend),
				callSessionTool,
			),
	);
}

function javascriptFixture(createBackend?: () => FakeBackend) {
	const backend = new FakeBackend();
	const session = toolSession();
	const prelude = fixturePrelude(session, createBackend ?? backend);
	const displays: unknown[] = [];
	const presented: unknown[] = [];
	const realm = createContext({
		__omp_display__: (value: unknown) => displays.push(value),
		__omp_presented__: (value: unknown) => presented.push(value),
		__omp_prelude__: async (_name: string, parameters: unknown) => {
			const result = await prelude.invoke(parameters, { session, toolCallId: "fixture" });
			return {
				details: result.details,
				text: result.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join("\n"),
			};
		},
	});
	runInContext(prelude.javascript, realm);
	return { backend, realm, displays, presented };
}

describe("computer preludes through the session", () => {
	it("normalizes launch shorthand and rejects malformed or read-only launch before driver dispatch", async () => {
		const { backend, realm } = javascriptFixture();
		const launch = spyOn(backend, "launch").mockResolvedValue({
			text: "requested",
			effect: "unverifiable",
			evidence: null,
			delivery: "background",
		});
		try {
			await runInContext('computer.launch("/Applications/App With Spaces.app")', realm);
			expect(launch.mock.calls[0]![1]).toEqual({ name: "/Applications/App With Spaces.app" });
			for (const value of [
				null,
				{},
				[],
				42,
				"",
				{ name: "App", foreground: true },
				{ name: "App", urls: [3] },
				{ name: "App", newInstance: "false" },
			]) {
				await expect(runInContext(`computer.launch(${JSON.stringify(value)})`, realm)).rejects.toThrow(
					/launch|Launch/,
				);
			}
			await expect(
				runInContext('computer.run(({desktop}) => desktop.launch("App"), {read_only:true})', realm),
			).rejects.toThrow("read-only");
			expect(launch).toHaveBeenCalledTimes(1);
		} finally {
			launch.mockRestore();
			await runInContext("computer.close()", realm);
		}
	});

	it("launches the app its selector names and acquires the window in the same call", async () => {
		const { backend, realm, displays } = javascriptFixture();
		backend.windowAbsent = true;
		const launch = spyOn(backend, "launch").mockImplementation(async () => {
			backend.windowAbsent = false;
			return { text: "launched", effect: "unverifiable", evidence: null, delivery: "background" };
		});
		try {
			const acquired = await runInContext('computer.window({app:"Code"}, {launch:true, screenshot:false})', realm);
			expect(launch.mock.calls[0]![1]).toEqual({ name: "Code" });
			expect(acquired.id).toBe("42");
			expect(displays.join("\n")).toContain("button [ref=e1]");
			// Nothing is launched while a window already matches the selector.
			await runInContext('computer.window({app:"Code"}, {launch:true, screenshot:false})', realm);
			expect(launch).toHaveBeenCalledTimes(1);
			// An exact id/pid addresses a window that exists; there is nothing to launch.
			await expect(runInContext('computer.window("42", {launch:true})', realm)).rejects.toThrow("launch: true");
			// Launching is a mutation, whatever tier the acquisition itself is.
			backend.windowAbsent = true;
			await expect(
				runInContext(
					'computer.run(({desktop}) => desktop.acquireWindow({app:"Code"},{launch:true}), {read_only:true})',
					realm,
				),
			).rejects.toThrow("read-only");
			expect(launch).toHaveBeenCalledTimes(1);
		} finally {
			launch.mockRestore();
			await runInContext("computer.close()", realm);
		}
	});

	it("launches through Python shorthand and keyword options using the same guarded session", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const backend = new FakeBackend();
		const launch = spyOn(backend, "launch").mockResolvedValue({
			text: "requested",
			effect: "unverifiable",
			evidence: null,
			delivery: "background",
		});
		definitions = [fixturePrelude(session, backend)];
		try {
			const result = await executePython(
				[
					'await computer.launch("/Applications/App With Spaces.app")',
					'await computer.launch(bundleId="dev.omp.fixture", newInstance=False)',
					"await computer.release()",
				].join("\n"),
				{
					cwd: process.cwd(),
					sessionId: `computer-py-launch-${crypto.randomUUID()}`,
					toolSession: session,
					kernelMode: "per-call",
				},
			);
			expect(result.exitCode).toBe(0);
			expect(launch.mock.calls.map(call => call[1])).toEqual([
				{ name: "/Applications/App With Spaces.app" },
				{ bundleId: "dev.omp.fixture", newInstance: false },
			]);
		} finally {
			launch.mockRestore();
		}
	});

	it("acquires readable initial state in one read-approved call and acts on its current exact reference", async () => {
		const { backend, realm, displays } = javascriptFixture();
		const inspection = spyOn(backend, "observe");
		const raise = spyOn(backend, "raise");
		try {
			await runInContext('computer.window("42", {screenshot: false}).then(win => globalThis.win = win)', realm);
			expect(inspection).toHaveBeenCalledTimes(1);
			expect(inspection.mock.calls[0]![0].readOnly).toBe(true);
			expect(inspection.mock.calls[0]![1]).toMatchObject({ id: "42", pid: 123 });
			expect(await runInContext("win.initialObservation.elements[0].value", realm)).toBe("ready");
			expect(displays.join("\n")).toContain("button [ref=e1]");
			await runInContext("win.click(win.initialObservation.elements[0].ref)", realm);
			expect(backend.clickCount).toBe(1);
			expect(backend.value).toBe("1");
			displays.length = 0;
			backend.complete = false;
			const observed = await runInContext("win.observe({screenshot:false})", realm);
			expect(observed.elements[0].value).toBe("1");
			expect(displays.join("\n")).toContain("button [ref=e2]");
			expect(displays.join("\n")).toContain("omitted controls remain unknown");
			expect(observed.complete).toBe(false);
			expect(displays.join("\n")).not.toContain("button [ref=e1]");
			await expect(runInContext("win.click(win.initialObservation.elements[0].ref)", realm)).rejects.toThrow(
				"StaleRef",
			);
			expect(raise).not.toHaveBeenCalled();
		} finally {
			inspection.mockRestore();
			raise.mockRestore();
			await runInContext("computer.close()", realm);
		}
	});

	it("marks the observation it rendered so the cell never serializes the same tree again", async () => {
		const { realm, displays, presented } = javascriptFixture();
		try {
			await runInContext('computer.window("42", {screenshot:false}).then(win => (globalThis.win = win))', realm);
			const observed = await runInContext(
				"win.observe({screenshot:false}).then(observation => (globalThis.observed = observation))",
				realm,
			);
			expect(displays.join("\n")).toContain("button [ref=e2]");
			expect(presented.at(-1)).toBe(observed);
			// An action renders no tree of its own, so its result is still the
			// cell's to echo.
			await runInContext("win.click(observed.elements[0].ref)", realm);
			expect(presented.at(-1)).toBe(observed);
		} finally {
			await runInContext("computer.close()", realm);
		}
	});

	it("preserves the acquired identity and independent image when initial accessibility fails", async () => {
		const { backend, realm, displays } = javascriptFixture();
		const inspection = spyOn(backend, "observe").mockRejectedValueOnce(new Error("AX unavailable"));
		const capture = spyOn(backend, "captureWindow");
		try {
			await runInContext('computer.window("42").then(win => globalThis.win = win)', realm);
			expect(
				await runInContext(
					"[win.id, win.pid, win.initialObservation, win.inspectionError, win.initialScreenshot.target]",
					realm,
				),
			).toEqual(["42", 123, undefined, "AX unavailable", "42"]);
			expect(capture).toHaveBeenCalledTimes(1);
			expect(displays.join("\n")).toContain("AX unavailable");
			await runInContext("win.observe({screenshot:false})", realm);
			expect(backend.generation).toBe(1);
		} finally {
			inspection.mockRestore();
			capture.mockRestore();
			await runInContext("computer.close()", realm);
		}
	});

	it("does not capture on AX-only acquisition failure or permit reveal under read-only execution", async () => {
		const { backend, realm } = javascriptFixture();
		const inspection = spyOn(backend, "observe").mockRejectedValueOnce(new Error("AX unavailable"));
		const capture = spyOn(backend, "captureWindow");
		const raise = spyOn(backend, "raise");
		try {
			await runInContext('computer.window("42", {screenshot:false}).then(win => globalThis.win = win)', realm);
			expect(capture).not.toHaveBeenCalled();
			await expect(
				runInContext(
					'computer.run(async ({desktop}) => (await desktop.window("42")).reveal(), {read_only:true})',
					realm,
				),
			).rejects.toThrow("read-only");
			expect(raise).not.toHaveBeenCalled();
			expect(
				computerApproval({
					action: "call",
					chain: [
						{ method: "window", args: [{ id: "42", pid: 123 }] },
						{ method: "reveal", args: [] },
					],
				}),
			).toBe("exec");
		} finally {
			inspection.mockRestore();
			capture.mockRestore();
			raise.mockRestore();
			await runInContext("computer.close()", realm);
		}
	});

	it("normalizes numeric JavaScript IDs without weakening exact PID identity and rejects invalid selectors", async () => {
		const { backend, realm } = javascriptFixture();
		expect(
			await runInContext(
				"(async () => [(await computer.window(42)).id, (await computer.window({ id: 42, pid: 123 })).id, (await computer.windows({ id: 42 }))[0].id])()",
				realm,
			),
		).toEqual(["42", "42", "42"]);
		await expect(runInContext("computer.window({ id: 42, pid: 456 })", realm)).rejects.toThrow("Missing");
		for (const invalid of [
			"null",
			"[]",
			"true",
			"-1",
			"1.5",
			"9007199254740992",
			"{ id: false }",
			"{ pid: '123' }",
			"{ app: 1 }",
		])
			await expect(runInContext(`computer.window(${invalid})`, realm)).rejects.toThrow("Invalid window");
		expect(backend.clickCount).toBe(0);
	});

	it("normalizes Python numeric IDs and preserves exact PID filtering", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		definitions = [fixturePrelude(session, new FakeBackend())];
		const result = await executePython(
			[
				"win = await computer.window(42)",
				"print(type(win.id).__name__, win.id)",
				"print((await computer.window(id=42, pid=123)).id)",
				"try:",
				"    await computer.window(id=42, pid=456)",
				"except Exception:",
				'    print("wrong PID rejected")',
				"try:",
				"    await computer.window(-1)",
				"except Exception:",
				'    print("invalid ID rejected")',
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `computer-py-id-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual(
			expect.arrayContaining(["str 42", "42", "wrong PID rejected", "invalid ID rejected"]),
		);
	});

	it("JavaScript release invalidates retained refs, permits fresh work, and preserves permanent close", async () => {
		const backends: FakeBackend[] = [];
		const { realm } = javascriptFixture(() => {
			const backend = new FakeBackend();
			backends.push(backend);
			return backend;
		});
		await runInContext(
			'(async () => { const win = await computer.window("42"); const state = await win.observe(); globalThis.oldElement = await win.ref(state.elements[0].ref); })()',
			realm,
		);
		await runInContext("computer.release()", realm);
		expect(backends[0]?.closeCount).toBe(1);
		await expect(runInContext("oldElement.click()", realm)).rejects.toThrow("StaleRef");
		expect(
			await runInContext(
				'(async () => { const win = await computer.window("42"); const state = await win.observe({ screenshot: false }); await win.click(state.elements[0].ref); return (await win.observe({ screenshot: false })).elements[0].value; })()',
				realm,
			),
		).toBe("1");
		expect(backends[0]?.clickCount).toBe(0);
		expect(backends[1]?.clickCount).toBe(1);
		await runInContext("computer.close()", realm);
		await runInContext("computer.release()", realm);
		await expect(runInContext("computer.windows()", realm)).rejects.toThrow("closed");
		expect(backends).toHaveLength(2);
		expect(computerApproval({ action: "release" })).toBe("read");
	});

	it("Python release starts a fresh backend and rejects a retained element without closing application state", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const backends: FakeBackend[] = [];
		definitions = [
			fixturePrelude(session, () => {
				const backend = new FakeBackend();
				backends.push(backend);
				return backend;
			}),
		];
		const result = await executePython(
			[
				'win = await computer.window("42")',
				"state = await win.observe(screenshot=False)",
				'old = await win.ref(state["elements"][0]["ref"])',
				"await computer.release()",
				"try:",
				"    await old.click()",
				"except Exception:",
				'    print("stale rejected")',
				'fresh = await computer.window("42")',
				"state = await fresh.observe(screenshot=False)",
				'await fresh.click(state["elements"][0]["ref"])',
				'print((await fresh.observe(screenshot=False))["elements"][0]["value"])',
				"await computer.close()",
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `computer-py-release-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);
		expect(result).toMatchObject({ exitCode: 0 });
		expect(result.output.trim().split("\n")).toEqual(
			expect.arrayContaining(["Released computer resources", "stale rejected", "1", "Closed computer session"]),
		);
		expect(backends.map(backend => [backend.clickCount, backend.closeCount, backend.windowAbsent])).toEqual([
			[0, 1, false],
			[1, 1, false],
		]);
	});

	it("rejects malformed requests and fails closed when approval cannot classify them", async () => {
		const session = toolSession();
		const prelude = fixturePrelude(session, new FakeBackend());
		const context = { session, toolCallId: "invalid-computer" };
		await expect(prelude.invoke({ action: "run", code: "1", fn: "() => 1" }, context)).rejects.toThrow();
		await expect(prelude.invoke({ action: "run", code: "1", unexpected: true }, context)).rejects.toThrow();
		await expect(prelude.invoke({ action: "call", chain: [] }, context)).rejects.toThrow();
		expect(computerApproval({ action: "call", chain: [null] })).toBe("exec");
		expect(computerApproval({ action: "run", code: "1", read_only: true })).toBe("read");
	});

	it("reflects a live enabled-setting change", () => {
		const session = toolSession();
		const prelude = fixturePrelude(session, new FakeBackend());
		expect(prelude.enabled?.()).toBe(true);
		session.settings.override("computer.enabled", false);
		expect(prelude.enabled?.()).toBe(false);
	});

	it("initializes capabilities before any other helper and preserves function returns and inner display", async () => {
		const { realm, displays } = javascriptFixture();
		expect(await runInContext("computer.capabilities().then(value => value.backend)", realm)).toBe("fake");
		expect(
			await runInContext(
				'computer.run(({ assert }, n) => { assert(n === 7); display("inner"); return n * 6; }, { args: [7] })',
				realm,
			),
		).toBe(42);
		expect(displays).toContain("inner");
	});

	it("preserves distinct placeholders in JavaScript observation, element handles and inner computer returns", async () => {
		const { backend, realm } = javascriptFixture();
		backend.value = "";
		backend.placeholder = "Hint Ω café";
		backend.actions = ["confirm", "open"];
		expect(
			await runInContext(
				`(async () => {
			const win = await computer.window("42");
			const state = await win.observe({ screenshot: false });
			const el = await win.ref(state.elements[0].ref);
			return [state.elements[0].value, state.elements[0].placeholder, el.value, el.placeholder, JSON.parse(JSON.stringify(el)).placeholder, el.actions, Object.isFrozen(el.actions)];
		})()`,
				realm,
			),
		).toEqual(["", "Hint Ω café", "", "Hint Ω café", "Hint Ω café", ["confirm", "open"], true]);
		expect(
			await runInContext(
				`computer.run(async ({ desktop }) => {
			const win = await desktop.window("42");
			const elements = await win.find({});
			return { value: elements[0].value, placeholder: elements[0].placeholder };
		})`,
				realm,
			),
		).toEqual({ value: "", placeholder: "Hint Ω café" });
	});

	it("preserves distinct placeholders in Python observation and immutable element handles", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const backend = new FakeBackend();
		backend.value = "";
		backend.placeholder = "Hint Ω café";
		backend.actions = ["confirm", "open"];
		definitions = [fixturePrelude(session, backend)];
		const result = await executePython(
			[
				'win = await computer.window("42")',
				"state = await win.observe(screenshot=False)",
				'el = await win.ref(state["elements"][0]["ref"])',
				'print(repr(state["elements"][0]["value"]), state["elements"][0]["placeholder"])',
				"print(repr(el.value), el.placeholder)",
				"print(el.actions)",
				"try:",
				'    el.placeholder = "changed"',
				"except AttributeError:",
				'    print("immutable")',
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `computer-py-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n").slice(-4)).toEqual([
			"'' Hint Ω café",
			"'' Hint Ω café",
			"('confirm', 'open')",
			"immutable",
		]);
	});

	it("lets a ref handle act without being awaited first, in JavaScript and Python", async () => {
		const { backend, realm } = javascriptFixture();
		expect(
			await runInContext(
				`(async () => {
			const win = await computer.window("42");
			const state = await win.observe({ screenshot: false });
			const ref = state.elements[0].ref;
			await win.ref(ref).click();
			const after = await win.observe({ screenshot: false });
			return [after.elements[0].value, (await win.ref(after.elements[0].ref)).role];
		})()`,
				realm,
			),
		).toEqual(["1", "button"]);
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const pyBackend = new FakeBackend();
		definitions = [fixturePrelude(session, pyBackend)];
		const result = await executePython(
			[
				'win = await computer.window("42")',
				"state = await win.observe(screenshot=False)",
				'await win.ref(state["elements"][0]["ref"]).click()',
				"after = await win.observe(screenshot=False)",
				'print(after["elements"][0]["value"], (await win.ref(after["elements"][0]["ref"])).role)',
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `computer-py-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n").at(-1)).toBe("1 button");
	});

	it("keeps snapshots immutable and never retargets a held window when its ID is reused", async () => {
		const { backend, realm } = javascriptFixture();
		expect(
			await runInContext(
				'(async () => { globalThis.win = await computer.window("42"); const state = await win.observe({ screenshot: false }); globalThis.el = await win.ref(state.elements[0].ref); await el.click(); return (await win.observe({ screenshot: false })).elements[0].value; })()',
				realm,
			),
		).toBe("1");
		expect(
			await runInContext(
				"[Object.isFrozen(win), Object.isFrozen(win.bounds), Object.isFrozen(el), el.value, el.bounds.width]",
				realm,
			),
		).toEqual([true, true, true, "ready", 9]);
		backend.currentWindow.pid = 456;
		await expect(runInContext("win.click([1, 1])", realm)).rejects.toThrow();
		expect(backend.clickCount).toBe(1);
		await expect(runInContext('computer.window("42")', realm)).rejects.toThrow("owner changed");
	});

	it("classifies exact-identity verification as read-only and cannot chain an action from its result", () => {
		const chain = [
			{ method: "verifyWindow", args: [{ id: "42", pid: 123 }, [{ window: { exists: false } }], { timeoutMs: 0 }] },
		];
		expect(computerApproval({ action: "call", chain })).toBe("read");
		expect(() => renderComputerCall([...chain, { method: "click", args: [[1, 1]] }])).toThrow();
	});
	for (const replacement of ["missing", "reused"] as const) {
		it(`verifies ${replacement} exact identities through the direct JavaScript wrapper`, async () => {
			const { backend, realm } = javascriptFixture();
			await runInContext('computer.window("42").then(window => { globalThis.win = window; })', realm);
			if (replacement === "missing") backend.windowAbsent = true;
			else backend.currentWindow.pid = 456;
			expect(
				await runInContext("win.verify([{ window: { exists: false } }], { timeoutMs: 0 })", realm),
			).toMatchObject({ status: "satisfied", predicates: [{ observed_json: '{"exists":false}' }] });
			await expect(runInContext("win.click([1, 1])", realm)).rejects.toThrow();
			expect(backend.clickCount).toBe(0);
		});

		it(`verifies ${replacement} exact identities through the direct Python wrapper`, async () => {
			let definitions: readonly EvalPreludeDefinition[] = [];
			const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
			const backend = new FakeBackend();
			const resolveWindow = backend.window.bind(backend);
			backend.window = async (...args) => {
				const window = await resolveWindow(...args);
				if (replacement === "missing") backend.windowAbsent = true;
				else backend.currentWindow.pid = 456;
				return window;
			};
			definitions = [fixturePrelude(session, backend)];
			const result = await executePython(
				[
					'win = await computer.window("42")',
					'result = await win.verify([{"window": {"exists": False}}], timeoutMs=0)',
					'print(result["status"], result["predicates"][0]["observed_json"])',
					"try:",
					"    await win.click([1, 1])",
					"except Exception:",
					'    print("action rejected")',
				].join("\n"),
				{
					cwd: process.cwd(),
					sessionId: `computer-py-${crypto.randomUUID()}`,
					toolSession: session,
					kernelMode: "per-call",
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.output.trim().split("\n").slice(-2)).toEqual(['satisfied {"exists":false}', "action rejected"]);
			expect(backend.clickCount).toBe(0);
		});
	}

	it("returns real structured values and inner display through the Python kernel", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const backend = new FakeBackend();
		definitions = [fixturePrelude(session, backend)];
		const result = await executePython(
			[
				`value = await computer.run('display("inner python"); return { answer: 42 };', read_only=True)`,
				'print(value["answer"])',
				'win = await computer.window(app="Code")',
				"state = await win.observe(screenshot=False)",
				'el = await win.ref(state["elements"][0]["ref"])',
				'await el.setValue("python")',
				'print((await win.observe(screenshot=False))["elements"][0]["value"])',
				'print(el.value, el.bounds["width"], win.pid)',
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `computer-py-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n").slice(0, 2)).toEqual(["inner python", "42"]);
		expect(result.output.trim().split("\n").slice(-2)).toEqual(["python", "ready 9 123"]);
		expect(backend.value).toBe("python");
	});
});

describe("computer supervisor round trips", () => {
	it("derives exec for a nested element action and blocks dispatch under read-only authority", async () => {
		const backend = new FakeBackend();
		const supervisor = new ComputerSupervisor(toolSession(), async () => backend);
		const observed = await runSupervisor(
			supervisor,
			'(await desktop.window("42")).observe({ screenshot: false })',
			true,
		);
		expect(observed.ok).toBe(true);
		const chain = [
			{ method: "window", args: [{ id: "42", pid: 123 }] },
			{ method: "ref", args: ["e1"] },
			{ method: "click", args: [] },
		];
		expect(computerApproval({ action: "call", chain })).toBe("exec");
		const blocked = await runSupervisor(supervisor, renderComputerCall(chain), true);
		expect(blocked.ok).toBe(false);
		expect(backend.clickCount).toBe(0);
		const clicked = await runSupervisor(supervisor, renderComputerCall(chain), isReadOnlyComputerCall(chain));
		expect(clicked.ok).toBe(true);
		expect(backend.value).toBe("1");
	});

	it("rejects stale and wrong-window refs without changing fixture state", async () => {
		const backend = new FakeBackend();
		const supervisor = new ComputerSupervisor(toolSession(), async () => backend);
		const first = await runSupervisor(
			supervisor,
			'globalThis.win = await desktop.window("42"); await win.observe({ screenshot: false }); globalThis.el = win.ref("e1"); await win.observe({ screenshot: false });',
		);
		expect(first.ok).toBe(true);
		expect((await runSupervisor(supervisor, "await el.click()")).ok).toBe(false);
		backend.currentWindow.id = "43";
		expect((await runSupervisor(supervisor, '(await desktop.window("43")).ref("e2")')).ok).toBe(false);
		expect(backend.clickCount).toBe(0);
	});

	it("binds window handles privately to their original PID", async () => {
		const backend = new FakeBackend();
		const supervisor = new ComputerSupervisor(toolSession(), async () => backend);
		expect(
			(
				await runSupervisor(
					supervisor,
					'globalThis.win = await desktop.window("42"); Reflect.set(win, "pid", 456); Reflect.set(win.bounds, "x", 999);',
				)
			).ok,
		).toBe(true);
		backend.currentWindow.pid = 456;
		expect((await runSupervisor(supervisor, "await win.click([1, 1])")).ok).toBe(false);
		expect(backend.clickCount).toBe(0);
	});

	it("keeps image output and silent capture metadata in their current run", async () => {
		const supervisor = new ComputerSupervisor(toolSession(), async () => new FakeBackend());
		const visible = await runSupervisor(supervisor, "await desktop.screenshot()");
		expect(visible.ok).toBe(true);
		if (visible.ok) {
			expect(visible.payload.displays.filter(block => block.type === "image")).toEqual([
				{ type: "image", data: "iVBORw==", mimeType: "image/png" },
			]);
			expect(visible.payload.screenshots[0].imageIndex).toBe(0);
		}
		const silent = await runSupervisor(supervisor, "await desktop.screenshot({ silent: true })");
		expect(silent.ok).toBe(true);
		if (silent.ok) {
			expect(silent.payload.displays).toEqual([]);
			expect(silent.payload.screenshots).toHaveLength(1);
			expect(silent.payload.screenshots[0].imageIndex).toBeUndefined();
		}
		const mixed = await runSupervisor(
			supervisor,
			'display({ type: "image", data: "AA==", mimeType: "image/png" }); await desktop.screenshot(); await desktop.screenshot({ silent: true }); await desktop.screenshot()',
		);
		expect(mixed.ok).toBe(true);
		if (mixed.ok)
			expect(mixed.payload.screenshots.map(screenshot => screenshot.imageIndex)).toEqual([1, undefined, 2]);
	});

	it("rejects an aborted run with an abort error", async () => {
		const backend = new FakeBackend();
		const entered = Promise.withResolvers<void>();
		backend.displays = async () => {
			entered.resolve();
			return [display];
		};
		const supervisor = new ComputerSupervisor(toolSession(), async () => backend);
		const abort = new AbortController();
		const pending = runSupervisor(
			supervisor,
			"await desktop.displays(); await wait(5_000)",
			false,
			5_000,
			abort.signal,
		);
		await entered.promise;
		abort.abort();
		const result = await pending;
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.name).toBe("ToolAbortError");
	});

	it("serves the next run from the same backend after an aborted run", async () => {
		const backend = new FakeBackend();
		const entered = Promise.withResolvers<void>();
		backend.displays = async () => {
			entered.resolve();
			return [display];
		};
		let created = 0;
		const supervisor = new ComputerSupervisor(toolSession(), async () => {
			created++;
			return backend;
		});
		const abort = new AbortController();
		const aborted = runSupervisor(
			supervisor,
			"await desktop.displays(); await wait(5_000)",
			false,
			5_000,
			abort.signal,
		);
		await entered.promise;
		abort.abort();
		expect((await aborted).ok).toBe(false);
		expect(backend.closeCount).toBe(0);
		const next = await runSupervisor(supervisor, 'await (await desktop.window({id:"42",pid:123})).click([5,5])');
		expect(next.ok).toBe(true);
		expect(backend.clickCount).toBe(1);
		expect(created).toBe(1);
		await supervisor.close();
		expect(backend.closeCount).toBe(1);
	});

	it("withholds cancellation completion and rejects overlapping work until admitted input settles", async () => {
		const backend = new FakeBackend();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const draining = Promise.withResolvers<void>();
		let nativeInput: Promise<ComputerActionResult> | undefined;
		backend.click = () => {
			entered.resolve();
			nativeInput = release.promise.then(() => {
				backend.clickCount++;
				return { text: "", effect: "unverifiable", evidence: null, delivery: "background" };
			});
			return nativeInput;
		};
		backend.drain = async () => {
			draining.resolve();
			await nativeInput;
		};
		const supervisor = new ComputerSupervisor(toolSession(), async () => backend);
		const abort = new AbortController();
		let settled = false;
		const pending = runSupervisor(
			supervisor,
			'await (await desktop.window({id:"42",pid:123})).click([5,5])',
			false,
			2_000,
			abort.signal,
		).finally(() => {
			settled = true;
		});
		try {
			await entered.promise;
			abort.abort();
			await Promise.race([draining.promise, pending]);
			expect(settled).toBe(false);
			const overlapping = await runSupervisor(supervisor, "return 1");
			expect(overlapping.ok).toBe(false);
			if (!overlapping.ok) expect(overlapping.error.message).toContain("busy");
			expect(backend.clickCount).toBe(0);
		} finally {
			release.resolve();
		}
		const cancelled = await pending;
		expect(cancelled.ok).toBe(false);
		if (!cancelled.ok) expect(cancelled.error.name).toBe("ToolAbortError");
		expect(backend.clickCount).toBe(1);
		const next = await runSupervisor(supervisor, "return 2");
		expect(next.ok).toBe(true);
		if (next.ok) expect(next.payload.returnValue).toBe(2);
	});

	it("reports a failed input drain as failure even when cancellation won the language race", async () => {
		const backend = new FakeBackend();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		backend.click = async () => {
			entered.resolve();
			await release.promise;
			return { text: "", effect: "unverifiable", evidence: null, delivery: "background" };
		};
		backend.drain = async () => {
			await release.promise;
			throw new Error("Input transport lost during completion");
		};
		const supervisor = new ComputerSupervisor(toolSession(), async () => backend);
		const abort = new AbortController();
		const pending = runSupervisor(
			supervisor,
			'await (await desktop.window({id:"42",pid:123})).click([5,5])',
			false,
			2_000,
			abort.signal,
		);
		await entered.promise;
		abort.abort();
		release.resolve();
		const result = await pending;
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.name).toBe("ToolError");
			expect(result.error.message).toContain("Input transport lost");
		}
	});

	it("keeps the session usable after a failed input drain and releases the backend once", async () => {
		const backend = new FakeBackend();
		let drains = 0;
		backend.drain = async () => {
			if (++drains === 1) throw new Error("Input transport lost during completion");
		};
		const supervisor = new ComputerSupervisor(toolSession(), async () => backend);
		const failed = await runSupervisor(supervisor, "return 1");
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.error.message).toContain("Input transport lost");
		const retry = await runSupervisor(supervisor, 'await (await desktop.window({id:"42",pid:123})).click([5,5])');
		expect(retry.ok).toBe(true);
		expect(backend.clickCount).toBe(1);
		await supervisor.close();
		expect(backend.closeCount).toBe(1);
		expect((await runSupervisor(supervisor, "return 1")).ok).toBe(false);
	});

	it("reports the run timeout budget explicitly", async () => {
		const supervisor = new ComputerSupervisor(toolSession(), async () => new FakeBackend());
		const result = await runSupervisor(supervisor, "await wait(5_000)", false, 10);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.name).toBe("ToolError");
		expect(result.error.message).toContain("timed out after 10ms");
	});

	it("round-trips tool calls and resolves the in-script promise", async () => {
		const echo = {
			name: "echo",
			label: "echo",
			description: "echo fixture",
			parameters: type({}),
			concurrency: "parallel",
			execute: async (_id: string, args: unknown) => ({
				content: [{ type: "text", text: JSON.stringify(args) }],
				details: {},
			}),
		} as unknown as AgentTool;
		const session: ToolSession = {
			...toolSession(),
			getToolByName: name => (name === "echo" ? echo : undefined),
		};
		const supervisor = new ComputerSupervisor(session, async () => new FakeBackend(), callSessionTool);
		const result = await runSupervisor(supervisor, "await tool.echo({ value: 7 })");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const returned = result.payload.returnValue as { text: string; details: unknown };
		expect(JSON.parse(returned.text)).toMatchObject({ value: 7 });
		expect(returned.details).toEqual({});
	});

	it("captures without accessibility while preserving current element refs", async () => {
		const backend = new FakeBackend();
		const supervisor = new ComputerSupervisor(toolSession(), async () => backend);
		const first = await runSupervisor(
			supervisor,
			'globalThis.retainedWin = await desktop.window("42"); globalThis.retainedElement = await retainedWin.ref((await retainedWin.observe({ screenshot: false })).elements[0].ref)',
		);
		expect(first.ok).toBe(true);
		backend.observe = async () => {
			throw new Error("Accessibility is unavailable");
		};
		const second = await runSupervisor(
			supervisor,
			"await globalThis.retainedWin.screenshot({ silent: true }); await globalThis.retainedElement.click()",
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.payload.screenshots).toHaveLength(1);
		expect(second.payload.screenshots[0]).toMatchObject({
			target: "42",
		});
		expect(backend.clickCount).toBe(1);
	});

	it("applies the current read-only policy to a retained writable window", async () => {
		const native = new FakeBackend();
		const supervisor = new ComputerSupervisor(toolSession(), async () => native);
		const first = await runSupervisor(supervisor, 'globalThis.retainedWin = await desktop.window("42")');
		expect(first.ok).toBe(true);
		const second = await runSupervisor(supervisor, "await globalThis.retainedWin.click([1, 1])", true);
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.error.name).toBe("ToolError");
		expect(native.clickCount).toBe(0);
	});

	it("allows a retained read-only window to mutate in a later exec run", async () => {
		const native = new FakeBackend();
		const supervisor = new ComputerSupervisor(toolSession(), async () => native);
		const first = await runSupervisor(supervisor, 'globalThis.retainedWin = await desktop.window("42")', true);
		expect(first.ok).toBe(true);
		const second = await runSupervisor(
			supervisor,
			"await globalThis.retainedWin.screenshot({ silent: true }); await globalThis.retainedWin.click([1, 1])",
		);
		expect(second.ok).toBe(true);
		expect(native.clickCount).toBe(1);
	});

	it("denies async continuations leaked from an ended run the next run's authority", async () => {
		const native = new FakeBackend();
		const supervisor = new ComputerSupervisor(toolSession(), async () => native);

		// Run 1 (exec) leaks a promise continuation that clicks once triggered.
		// The continuation is registered inside run 1's async context, so it must
		// retain run 1's (aborted) context even when it executes during run 2.
		const first = await runSupervisor(
			supervisor,
			[
				'globalThis.leakWin = await desktop.window("42");',
				"globalThis.leakErr = null;",
				"const { promise: trigger, resolve: fireLeak } = Promise.withResolvers(); globalThis.fireLeak = fireLeak;",
				"globalThis.leakDone = trigger.then(() => globalThis.leakWin.click([1, 1])).catch(err => { globalThis.leakErr = String(err); });",
				'"armed"',
			].join("\n"),
		);
		expect(first.ok).toBe(true);
		// Run 2 (exec) fires the leaked continuation and awaits its settlement; the
		// click must fail with run 1's abort instead of borrowing run 2's policy.
		const second = await runSupervisor(
			supervisor,
			"globalThis.fireLeak(); await globalThis.leakDone; globalThis.leakErr",
		);
		expect(second.ok).toBe(true);
		if (second.ok) expect(String(second.payload.returnValue)).toContain("Computer run ended");
		expect(native.clickCount).toBe(0);
	});
});

describe("computer prompt variants", () => {
	const render = (template: string, linux: boolean): string => prompt.render(template, { linux });
	it("states each backend's own routes and never the other's vocabulary", () => {
		const darwin = render(computerDescription, false);
		const linux = render(computerDescription, true);
		for (const absent of ["AT-SPI", "X11", "xdotool", "AT-SPI tree"]) expect(darwin).not.toContain(absent);
		for (const absent of ["AppleScript", "TCC", "screencapture", "Apple Silicon"])
			expect(linux).not.toContain(absent);
		// The Linux backend's own contract, stated where the model reads it.
		expect(linux).toContain("AT-SPI tree");
		expect(linux).toContain("`background_unavailable` refusal means nothing was dispatched");
		expect(linux).toContain("foreground_unavailable");
		expect(linux).toContain("window manager");
		expect(linux).toContain("`computer.displays()` and desktop-root input");
		expect(linux).toContain('effect: "unverifiable"');
		expect(darwin).toContain("password/TCC prompt");
		expect(linux).toContain("`interruptedBy` is never set");
	});
	it("scopes the never-escalate rule to unverified deliveries on both backends", () => {
		for (const linux of [false, true]) {
			const safety = render(computerSafetyPrompt, linux);
			expect(safety).toContain("An unverified or doubted delivery is never a reason to escalate");
			expect(safety).toContain("intended retry, not an escalation");
		}
		expect(render(computerSafetyPrompt, true)).not.toContain("AppleScript");
	});
	it("renders the host's variant into the live prelude documentation", () => {
		const session = toolSession();
		const prelude = fixturePrelude(session, new FakeBackend());
		expect(prelude.documentation).toBe(render(computerDescription, process.platform === "linux"));
	});
});
