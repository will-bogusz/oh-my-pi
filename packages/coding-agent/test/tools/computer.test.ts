import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { prompt } from "@oh-my-pi/pi-utils";
import computerDescription from "../../src/prompts/tools/computer.md" with { type: "text" };
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { computerApproval, createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import type { ComputerBackend } from "@oh-my-pi/pi-coding-agent/tools/computer/backend";
import {
	COMPUTER_HANDLE_VERBS,
	ELEMENT_METHODS,
	handleSignatures,
	isReadOnlyComputerCall,
	renderComputerCall,
	WINDOW_METHODS,
} from "@oh-my-pi/pi-coding-agent/tools/computer/call";
// @ts-expect-error Bun imports this declaration source as text instead of a TypeScript module.
import computerDeclarations from "../../src/tools/computer/declarations.d.ts" with { type: "text" };
import {
	ComputerSupervisor,
	releaseComputerSessionsForOwner,
} from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { cfgComputerEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type {
	ComputerActionResult,
	ComputerCapabilities,
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
import type { DesktopDisplay } from "@oh-my-pi/pi-natives";

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

/** What the session composes for a write it could not call proven, per verdict. */
const WRITE_NOTES: Record<string, string> = {
	not_committed:
		'setValue on e2 AXTextField "Filename": unproven — the app has no end-of-edit gesture here. Read it back (win.observe()): a control showing the value proves the text is in it, not that the app took it — judge that by the app\'s own output, and do not rewrite the control to find out.',
	unproven:
		'setValue on e2 AXTextField "Filename": the value reads back as written, but this field\'s app takes its value at end-of-edit — press Tab or Return on it.',
};
/** Stateful fixture; unsupported operations fail rather than silently succeeding. */
class FakeBackend implements ComputerBackend {
	async drain(): Promise<void> {}
	readonly capabilities = { ...capabilities };
	currentWindow = structuredClone(windowFixture);
	windowAbsent = false;
	/** Windows no selector in these tests matches, for the roster a miss names. */
	extraWindows: ComputerWindowIdentity[] = [];
	readonly pins = new Map<string, number>();
	clickCount = 0;
	closeCount = 0;
	generation = 0;
	complete = true;
	/** The walker's own cause for stopping short; absent when it read the tree whole. */
	truncation?: string;
	/** How many rows the walk answers with. */
	rows = 1;
	/** What the driver reports about background input for this window's process. */
	backgroundInput: unknown = true;
	value = "ready";
	role = "button";
	placeholder?: string;
	subrole?: string;
	actions?: readonly string[];
	readonly bindings = new Map<string, { window: ComputerWindowIdentity; element: ComputerElementSnapshot }>();
	async windows(_context: ComputerOperationContext, selector: WindowSelector = {}) {
		return (this.windowAbsent ? [] : [this.currentWindow, ...this.extraWindows])
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
		// The real backend's shape: the runtime reads this prefix to tell an
		// unresolved acquisition from any other failure.
		if (windows.length !== 1)
			throw new ToolError(`Missing computer window ${JSON.stringify(selector)}: nothing matches it.`);
		const window = windows[0]!;
		if (this.pins.has(window.id) && this.pins.get(window.id) !== window.pid)
			throw new Error("InvalidTarget: owner changed");
		this.pins.set(window.id, window.pid);
		return window;
	}
	async displays() {
		return [display];
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
	/** Pixels per point of the next capture; below 1 is a surface past the frame budget. */
	captureScale = 1;
	/** Window-local point of the capture's top-left; nonzero once it covers more than the window. */
	captureOrigin = { x: 0, y: 0 };
	image(context: ComputerOperationContext, target: string, silent = false) {
		const image = {
			path: "/fixture/capture.png",
			width: Math.round(64 * this.captureScale),
			height: Math.round(32 * this.captureScale),
			sourceWidth: 128,
			sourceHeight: 64,
			surface: target === "desktop" ? ("display" as const) : ("window" as const),
			pointWidth: 64,
			pointHeight: 32,
			originX: this.captureOrigin.x,
			originY: this.captureOrigin.y,
			scale: this.captureScale,
			target,
		};
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
		const elements = Array.from({ length: this.rows }, () => {
			const ref = `e${++this.generation}`;
			const element = {
				ref,
				pid: window.pid,
				windowId: window.id,
				role: this.role,
				label: "Increment",
				value: this.value,
				...(this.subrole !== undefined ? { subrole: this.subrole } : {}),
				...(this.placeholder !== undefined ? { placeholder: this.placeholder } : {}),
				...(this.actions !== undefined ? { actions: this.actions } : {}),
				enabled: true,
				bounds: { x: 7, y: 8, width: 9, height: 10 },
			};
			this.bindings.set(ref, { window: structuredClone(window), element });
			return element;
		});
		return {
			snapshotId: String(this.generation),
			window,
			tree: elements.map(element => `- button [ref=${element.ref}]`).join("\n"),
			elements,
			complete: this.complete,
			backgroundInput: this.backgroundInput,
			...(this.truncation === undefined ? {} : { truncation: this.truncation }),
			...(options.screenshot === true ? { screenshot: this.image(context, window.id, options.silent) } : {}),
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
	/** The rung the driver named when it doubted this one landed; absent when it named none. */
	escalation?: string;
	/** The driver dispatched an app action and cannot say what it did. */
	unverifiable = false;
	async click(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		target: ComputerTarget,
	): Promise<ComputerActionResult> {
		await this.window(context, { id: window.id, pid: window.pid });
		if (typeof target === "string") this.element(target, window);
		this.clickCount++;
		this.value = String(this.clickCount);
		const dispatched = this.unverifiable
			? '✅ Performed AXPress on [40] AXCell "Incomplete, Buy milk".'
			: "✅ Posted click to pid 123.";
		return {
			text:
				this.unverifiable || this.escalation !== undefined
					? [dispatched, this.escalation].filter(line => line !== undefined).join("\n")
					: "",
			effect: this.unverifiable ? "unverifiable" : "verified",
			evidence: { count: this.clickCount },
			delivery: "background",
			...(this.escalation === undefined ? {} : { escalation: this.escalation }),
			// What the reply leaves unproven has to reach the cell even where the
			// cell drops the returned value.
			...(this.unverifiable || this.escalation !== undefined ? { mustShow: true } : {}),
		};
	}
	/** The driver's commit verdict for the write, when it judged one. */
	committed?: ComputerActionResult["committed"];
	async setValue(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		ref: string,
		value: string,
	): Promise<ComputerActionResult> {
		await this.window(context, { id: window.id, pid: window.pid });
		this.element(ref, window);
		this.value = value;
		return {
			text:
				this.committed === undefined || this.committed === "committed"
					? ""
					: `📨 Sent (unverified) AXValue on [1] AXTextField.\n${WRITE_NOTES[this.committed]}`,
			effect: "verified",
			evidence: { value },
			delivery: "background",
			...(this.committed === undefined ? {} : { committed: this.committed }),
			...(this.committed !== undefined && this.committed !== "committed" ? { mustShow: true } : {}),
		};
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
	captureMaxWidth: 1568,
	captureMaxHeight: 1568,
	captureMaxPixels: 1280 * 896,
	display: "all",
	readOnly,
	teach: () => true,
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

function javascriptFixture(createBackend?: () => FakeBackend, session: ToolSession = toolSession()) {
	const backend = new FakeBackend();
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
			// A window that is gone by the time the launch is acquired must not be
			// told to launch again: that is the call it just made.
			const vanished = spyOn(backend, "window").mockRejectedValue(
				new ToolError('Missing computer window {"app":"Code"}: nothing matches it. If "Code" is not running yet…'),
			);
			const failure = await runInContext('computer.window({app:"Code"}, {launch:true})', realm).catch(
				(error: unknown) => error as Error,
			);
			vanished.mockRestore();
			expect(launch).toHaveBeenCalledTimes(2);
			expect(failure.message).toContain('launched "Code" and no window of it could be acquired');
			expect(failure.message).not.toContain("launch: true");
			// What does open a window of an app that opens none by itself is named.
			expect(failure.message).toContain('computer.launch({ name: "Code", urls: [');
		} finally {
			launch.mockRestore();
			await runInContext("computer.close()", realm);
		}
	});

	it("waits for what a launch started by its pid, not by matching the selector's name again", async () => {
		const { backend, realm } = javascriptFixture();
		backend.windowAbsent = true;
		// A bundle id is a name `launch_app` accepts and a window roster never
		// reports: it publishes the display name ("Code") alone. Polling the
		// selector back against the roster therefore cannot hit however long it
		// waits, so the launch worked, the poll ran out its whole timeout, and
		// the call ended in "it opened none". The pid the launch answers with is
		// which process this is.
		const launch = spyOn(backend, "launch").mockImplementation(async () => {
			backend.windowAbsent = false;
			return {
				text: "launched",
				effect: "unverifiable",
				evidence: null,
				delivery: "background",
				data: { pid: 123 },
			};
		});
		const asked: WindowSelector[] = [];
		const roster = backend.windows.bind(backend);
		backend.windows = async (context: ComputerOperationContext, selector: WindowSelector = {}) => {
			asked.push(selector);
			return await roster(context, selector);
		};
		try {
			const acquired = await runInContext(
				'computer.window({app:"com.vendor.Code"}, {launch:true, screenshot:false})',
				realm,
			);
			expect(acquired.id).toBe("42");
			expect(launch.mock.calls[0]![1]).toEqual({ name: "com.vendor.Code" });
			// Before the launch the selector is the caller's; every read after it
			// addresses the process the launch named and never the name again.
			expect(asked[0]).toEqual({ app: "com.vendor.Code" });
			expect(asked.slice(1)).not.toHaveLength(0);
			expect(asked.slice(1).every(selector => selector.app === undefined && selector.pid === 123)).toBe(true);
			// A launch that answers with no pid still has the name to fall back on.
			backend.windowAbsent = true;
			asked.length = 0;
			launch.mockImplementation(async () => {
				backend.windowAbsent = false;
				return { text: "launched", effect: "unverifiable", evidence: null, delivery: "background" };
			});
			expect((await runInContext('computer.window({app:"Code"}, {launch:true, screenshot:false})', realm)).id).toBe(
				"42",
			);
			expect(asked.every(selector => selector.app === "Code" || selector.id === "42")).toBe(true);
		} finally {
			launch.mockRestore();
			await runInContext("computer.close()", realm);
		}
	});

	it("reads an app selector that matches nothing as a launch request unless launching is refused", async () => {
		const { backend, realm } = javascriptFixture();
		backend.windowAbsent = true;
		const launch = spyOn(backend, "launch").mockImplementation(async () => {
			backend.windowAbsent = false;
			return { text: "launched", effect: "unverifiable", evidence: null, delivery: "background" };
		});
		try {
			// No `launch` option: an { app } selector matching nothing names an
			// app that is not running, and acquisition starts it.
			expect((await runInContext('computer.window({app:"Code"}, {screenshot:false})', realm)).id).toBe("42");
			expect(launch.mock.calls[0]![1]).toEqual({ name: "Code" });
			// `{ launch: false }` acquires only what is already open.
			backend.windowAbsent = true;
			await expect(
				runInContext('computer.window({app:"Code"}, {launch:false, screenshot:false})', realm),
			).rejects.toThrow("Missing computer window");
			// An exact id addresses a window that exists; the default launches nothing.
			await expect(runInContext('computer.window("42", {screenshot:false})', realm)).rejects.toThrow(
				"Missing computer window",
			);
			expect(launch).toHaveBeenCalledTimes(1);
		} finally {
			launch.mockRestore();
			await runInContext("computer.close()", realm);
		}
	});

	it("names the open windows when a selector misses, launchable or not", async () => {
		const { backend, realm } = javascriptFixture();
		const launch = spyOn(backend, "launch").mockRejectedValue(
			new ToolError(
				"Failed to launch: 'text editor' is not an executable on PATH and matches no installed .desktop application. Call list_apps and round-trip its launch_path.",
			),
		);
		try {
			// The bench's opening call on a native task: the prompt named a role,
			// not a binary, so the filter matched nothing and the name was not
			// startable. The launch refusal alone said only the second half.
			const missed = await runInContext('computer.window({app:"text editor"}, {screenshot:false})', realm).catch(
				(error: unknown) => error as Error,
			);
			expect(missed.message).toBe(
				'No open window matches {"app":"text editor"} and it is not an installed app. Open windows: [42] Code — "Editor".',
			);
			// Refusing the launch reports the same roster.
			const refused = await runInContext(
				'computer.window({app:"text editor"}, {launch:false, screenshot:false})',
				realm,
			).catch((error: unknown) => error as Error);
			expect(refused.message).toContain('Open windows: [42] Code — "Editor".');
			expect(launch).toHaveBeenCalledTimes(1);
			// Any other launch failure keeps the driver's own reason beside the
			// fact that nothing matched.
			launch.mockRejectedValue(new ToolError("Failed to launch: APP_PATH_CONFLICT"));
			const conflict = await runInContext('computer.window({app:"Absent"}, {screenshot:false})', realm).catch(
				(error: unknown) => error as Error,
			);
			expect(conflict.message).toBe(
				'No open window matches {"app":"Absent"} and launching it failed: Failed to launch: APP_PATH_CONFLICT. Open windows: [42] Code — "Editor".',
			);
			// Ranked the way a person names windows: titled and on screen first,
			// frontmost first, then untitled neighbours collapsed per app. A
			// service owner and anything off screen are left to windows().
			backend.extraWindows = [
				...[7, 8].map(id => ({ ...windowFixture, id: String(id), app: "Finder", title: "Desktop", zIndex: 9 })),
				...Array.from({ length: 4 }, (_, index) => ({
					...windowFixture,
					id: String(200 + index),
					app: "Preview",
					title: "",
				})),
				{ ...windowFixture, id: "300", app: "Open and Save Panel Service", title: "" },
				{ ...windowFixture, id: "301", app: "Cursor", title: "", onScreen: false },
				{ ...windowFixture, id: "302", app: "Safari", title: "Minimized report", onScreen: false },
			];
			const ranked = await runInContext('computer.window({app:"Absent"}, {screenshot:false})', realm).catch(
				(error: unknown) => error as Error,
			);
			expect(ranked.message).toContain(
				'Open windows: [7] Finder — "Desktop" (x 2), [42] Code — "Editor", [200] Preview (x 4).',
			);
			expect(ranked.message).not.toContain("Panel Service");
			expect(ranked.message).not.toContain("Minimized report");
			// Bounded: the roster is spent on orientation, not on a transcript of
			// every document window.
			backend.extraWindows = Array.from({ length: 15 }, (_, index) => ({
				...windowFixture,
				id: String(100 + index),
				app: "Terminal",
				title: `shell ${index}`,
				zIndex: 100 - index,
			}));
			const crowded = await runInContext('computer.window({app:"Absent"}, {screenshot:false})', realm).catch(
				(error: unknown) => error as Error,
			);
			expect(crowded.message).toContain('Open windows: [100] Terminal — "shell 0", [101] Terminal — "shell 1", ');
			expect(crowded.message).toContain('[111] Terminal — "shell 11", and 4 more.');
			expect(crowded.message).not.toContain("shell 12");
			// The display's desktop surface is untitled, so its kind is what names
			// it: listed as a bare app it reads like one of that app's windows.
			backend.extraWindows = [{ ...windowFixture, id: "9814", app: "Finder", title: "", kind: "desktop" }];
			const surface = await runInContext('computer.window({app:"Absent"}, {screenshot:false})', realm).catch(
				(error: unknown) => error as Error,
			);
			expect(surface.message).toContain("[9814] Finder kind=desktop");
			// Nothing a person would name, and the roster still says so.
			backend.extraWindows = [];
			backend.currentWindow = { ...windowFixture, app: "Creative Cloud Core Service", title: "" };
			const plumbing = await runInContext('computer.window({app:"Absent"}, {screenshot:false})', realm).catch(
				(error: unknown) => error as Error,
			);
			expect(plumbing.message).toContain(
				"No app window is on screen; computer.windows() lists 1 service or off-screen row.",
			);
			backend.currentWindow = structuredClone(windowFixture);
			// A driver that cannot list windows still reports the miss itself.
			const blind = spyOn(backend, "windows").mockImplementation(async (_context, selector = {}) => {
				if (selector.app === undefined) throw new ToolError("list_windows failed");
				return [];
			});
			const alone = await runInContext('computer.window({app:"Absent"}, {screenshot:false})', realm).catch(
				(error: unknown) => error as Error,
			);
			blind.mockRestore();
			expect(alone.message).toBe(
				'No open window matches {"app":"Absent"} and launching it failed: Failed to launch: APP_PATH_CONFLICT.',
			);
		} finally {
			launch.mockRestore();
			await runInContext("computer.close()", realm);
		}
	});

	it("observes the tree without a screenshot unless the call asks for one", async () => {
		const { backend, realm } = javascriptFixture();
		const captured = spyOn(backend, "image");
		try {
			// Acquisition still shows the window once.
			await runInContext('computer.window("42").then(win => (globalThis.win = win))', realm);
			expect(await runInContext("win.initialObservation.screenshot.target", realm)).toBe("42");
			expect(captured).toHaveBeenCalledTimes(1);
			// Every observation after it is tree-only until one is asked for.
			expect(await runInContext("win.observe().then(state => state.screenshot === undefined)", realm)).toBe(true);
			expect(await runInContext("win.find({}).then(found => found.length)", realm)).toBe(1);
			expect(captured).toHaveBeenCalledTimes(1);
			expect(
				await runInContext("win.observe({screenshot:true}).then(state => state.screenshot.target)", realm),
			).toBe("42");
			expect(captured).toHaveBeenCalledTimes(2);
		} finally {
			captured.mockRestore();
			await runInContext("computer.close()", realm);
		}
	});

	it("finds elements by case-insensitive substring and by whole value when asked", async () => {
		const { backend, realm } = javascriptFixture();
		backend.value = "555-0100";
		try {
			await runInContext('computer.window("42", {screenshot:false}).then(win => (globalThis.win = win))', realm);
			const hits = (query: string): Promise<string[]> =>
				runInContext(`win.find(${query}).then(found => found.map(element => element.label))`, realm);
			// What the model read in the tree is what it queries with.
			expect(await hits('{value:"555"}')).toEqual(["Increment"]);
			expect(await hits('{label:"increment"}')).toEqual(["Increment"]);
			expect(await hits('{role:"BUTTON", value:"0100"}')).toEqual(["Increment"]);
			// `title` names the same field a window filter calls a title.
			expect(await hits('{title:"Incre"}')).toEqual(["Increment"]);
			expect(await hits('{value:"555", exact:true}')).toEqual([]);
			expect(await hits('{value:"555-0100", exact:true}')).toEqual(["Increment"]);
			expect(await hits('{label:"Missing"}')).toEqual([]);
			// A field the row does not carry never matches.
			backend.value = undefined as unknown as string;
			expect(await hits('{value:"555"}')).toEqual([]);
			// The specific role a control answers to: macOS reports the search
			// field as an `AXTextField` and names it only in `AXSubrole`, so the
			// role a model read in the tree matches either one.
			backend.subrole = "AXSearchField";
			expect(await hits('{role:"AXSearchField"}')).toEqual(["Increment"]);
			expect(await hits('{subrole:"searchfield"}')).toEqual(["Increment"]);
			expect(await hits('{role:"button"}')).toEqual(["Increment"]);
			expect(await hits('{role:"AXSearchField", exact:true}')).toEqual(["Increment"]);
			expect(await hits('{subrole:"AXTextField"}')).toEqual([]);
			backend.subrole = undefined;
			expect(await hits('{subrole:"AXSearchField"}')).toEqual([]);
			expect(await hits('{role:"AXSearchField"}')).toEqual([]);
			// A row's platform spelling and the one the tree prints are the same
			// role, so a model that read either can ask for it.
			backend.role = "AXButton";
			expect(await hits('{role:"button", exact:true}')).toEqual(["Increment"]);
			expect(await hits('{role:"AXButton", exact:true}')).toEqual(["Increment"]);
			expect(await hits('{role:"textfield", exact:true}')).toEqual([]);
		} finally {
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

	it("refuses a missing ref token or a scroll without a direction with what the call needs", async () => {
		const { backend, realm } = javascriptFixture();
		const scroll = spyOn(backend, "scroll");
		try {
			await runInContext('computer.window("42", {screenshot: false}).then(win => globalThis.win = win)', realm);
			// A failed regex hands `undefined` over; it is no stale row to observe again for.
			for (const call of ["win.ref(undefined)", 'win.ref("")', "computer.ref(undefined)"]) {
				const error = await (async () => await runInContext(call, realm))().catch((caught: unknown) => caught);
				expect(String(error)).toContain('ref(token) needs a ref string such as "n24"');
				expect(String(error)).not.toContain("StaleRef");
			}
			for (const call of [
				"win.scroll({ deltaY: 300 })",
				'win.scroll("sideways")',
				"win.ref(win.initialObservation.elements[0].ref).scroll({ deltaY: 300 })",
			]) {
				await expect(runInContext(call, realm)).rejects.toThrow(
					'scroll(direction: "up" | "down" | "left" | "right", { target?, amount?, by?, delivery? })',
				);
			}
			expect(scroll).not.toHaveBeenCalled();
		} finally {
			scroll.mockRestore();
			await runInContext("computer.close()", realm);
		}
	});

	it("names the keyboard route only where the driver refused background keys", async () => {
		const { backend, realm, displays } = javascriptFixture();
		try {
			await runInContext('computer.window("42", {screenshot:false}).then(win => (globalThis.win = win))', realm);
			// A route that works is the header saying nothing: every call takes
			// its default delivery.
			backend.backgroundInput = { routes: [{ route: "pid_keyboard", status: "available" }] };
			displays.length = 0;
			await runInContext("win.observe({screenshot:false})", realm);
			expect(displays.join("\n")).not.toContain("keys:");
			// Refused is the one case a later call has to carry a delivery for.
			backend.backgroundInput = {
				routes: [{ route: "pid_keyboard", status: "refused", reason: "secure input is active" }],
			};
			displays.length = 0;
			await runInContext("win.observe({screenshot:false})", realm);
			expect(displays.join("\n")).toContain(
				"(window 42, PID 123) · keys: foreground only (secure input is active)",
			);
		} finally {
			await runInContext("computer.close()", realm);
		}
	});

	it("calls a tree partial only when the walk named a cause and the tree is worth the words", async () => {
		const { backend, realm, displays } = javascriptFixture();
		try {
			await runInContext('computer.window("42", {screenshot:false}).then(win => (globalThis.win = win))', realm);
			backend.rows = 24;
			backend.truncation = "element budget reached";
			displays.length = 0;
			await runInContext("win.observe({screenshot:false})", realm);
			expect(displays.join("\n")).toContain(
				"Partial tree (element budget reached): omitted controls remain unknown.",
			);
			// A walk that reached everything leaves nothing unknown to say.
			backend.truncation = undefined;
			displays.length = 0;
			await runInContext("win.observe({screenshot:false})", realm);
			expect(displays.join("\n")).not.toContain("Partial tree");
			// A handful of rows is not a window with controls hiding in it.
			backend.truncation = "element budget reached";
			backend.rows = 3;
			displays.length = 0;
			await runInContext("win.observe({screenshot:false})", realm);
			expect(displays.join("\n")).not.toContain("Partial tree");
		} finally {
			await runInContext("computer.close()", realm);
		}
	});

	it("marks what it already rendered so the cell never serializes the same value again", async () => {
		const { realm, displays, presented } = javascriptFixture();
		try {
			await runInContext('computer.window("42", {screenshot:false}).then(win => (globalThis.win = win))', realm);
			const observed = await runInContext(
				"win.observe({screenshot:false}).then(observation => (globalThis.observed = observation))",
				realm,
			);
			expect(displays.join("\n")).toContain("button [ref=e2]");
			expect(presented.at(-1)).toBe(observed);
			// An action says what it did in its own line — and in the cell's
			// summary where the cell is composed — so the JSON behind it is
			// already rendered too.
			const clicked = await runInContext("win.click(observed.elements[0].ref)", realm);
			expect(presented.at(-1)).toBe(clicked);
			// A read this surface renders nothing for stays the cell's to print.
			const found = await runInContext("win.find({})", realm);
			expect(presented).not.toContain(found);
		} finally {
			await runInContext("computer.close()", realm);
		}
	});

	it("pushes a doubted write or route into the cell output instead of a dropped value", async () => {
		const { backend, realm, displays } = javascriptFixture();
		try {
			await runInContext('computer.window("42", {screenshot:false}).then(win => (globalThis.win = win))', realm);
			displays.length = 0;
			// A committed write is ordinary: the cell decides whether to echo it.
			backend.committed = "committed";
			expect(
				(await runInContext('win.setValue(win.initialObservation.elements[0].ref, "kept")', realm)).committed,
			).toBe("committed");
			expect(displays).toEqual([]);
			// An uncommitted one may have lost the edit, so the model reads it
			// even though this cell throws the result away.
			backend.committed = "not_committed";
			await runInContext('win.setValue(win.initialObservation.elements[0].ref, "lost")', realm);
			expect(displays.join("\n")).toContain("unproven — the app has no end-of-edit gesture here");
			// The verdict the dead `committed === false` gate dropped outright: the
			// value was echoed back and nothing observed the app take it.
			displays.length = 0;
			backend.committed = "unproven";
			await runInContext('win.setValue(win.initialObservation.elements[0].ref, "echoed")', realm);
			expect(displays.join("\n")).toContain("press Tab or Return on it");
			// Same shape by a third route: the driver dispatched, doubts the rung
			// landed, and names the one that would. A cell that drops the result
			// still reads it.
			backend.committed = undefined;
			displays.length = 0;
			await runInContext("win.click(win.initialObservation.elements[0].ref)", realm);
			expect(displays).toEqual([]);
			backend.escalation =
				'⚠️ The driver escalates this action (delivery_failed): the route it names is { delivery: "foreground" }.';
			await runInContext("win.click(win.initialObservation.elements[0].ref)", realm);
			expect(displays.join("\n")).toContain('{ delivery: "foreground" }');
			// A dispatched app action the driver cannot judge is the same shape
			// again: `AXPress`/`Performed` appeared 0 times in a whole bench
			// transcript because the reply said `unverifiable` and the cell
			// dropped the only sentence naming what was sent.
			backend.escalation = undefined;
			backend.unverifiable = true;
			displays.length = 0;
			await runInContext("win.click(win.initialObservation.elements[0].ref)", realm);
			expect(displays.join("\n")).toContain('Performed AXPress on [40] AXCell "Incomplete, Buy milk".');
		} finally {
			await runInContext("computer.close()", realm);
		}
	});

	it("prints a must-show reply once, and never again on the observation after it", async () => {
		const { backend, realm, displays } = javascriptFixture();
		try {
			await runInContext('computer.window("42", {screenshot:false}).then(win => (globalThis.win = win))', realm);
			displays.length = 0;
			// A reply that proved itself is the cell's business, so nothing is
			// pushed for it.
			await runInContext("win.click(win.initialObservation.elements[0].ref)", realm);
			expect(displays).toEqual([]);
			// One that did not is pushed exactly once, by the call that made it.
			backend.escalation = 'Not delivered: re-run it with { delivery: "foreground" }.';
			await runInContext("win.click(win.initialObservation.elements[0].ref)", realm);
			expect(displays.filter(line => String(line).includes("Not delivered"))).toHaveLength(1);
			// The next read answers for the window, never for the last action:
			// re-emitting it made every observation replay a sentence the cell
			// had already printed.
			backend.escalation = undefined;
			displays.length = 0;
			await runInContext("win.observe({screenshot:false})", realm);
			expect(displays.join("\n")).not.toContain("Not delivered");
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

	it("JavaScript release and close invalidate retained refs and a later call starts a fresh session; owner teardown is permanent", async () => {
		const owner = `computer-close-${crypto.randomUUID()}`;
		const backends: FakeBackend[] = [];
		const { realm } = javascriptFixture(
			() => {
				const backend = new FakeBackend();
				backends.push(backend);
				return backend;
			},
			{ ...toolSession(), getEvalKernelOwnerId: () => owner },
		);
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
		// `computer.close()` from a cell ends this session, not the conversation's computer use.
		expect(backends[0]?.clickCount).toBe(0);
		expect(backends[1]?.clickCount).toBe(1);
		await runInContext("computer.close()", realm);
		expect(backends[1]?.closeCount).toBe(1);
		expect(await runInContext("(async () => (await computer.windows()).map(window => window.id))()", realm)).toEqual([
			"42",
		]);
		expect(backends).toHaveLength(3);
		// Agent session end is final.
		await releaseComputerSessionsForOwner(owner);
		expect(backends[2]?.closeCount).toBe(1);
		await expect(runInContext("computer.windows()", realm)).rejects.toThrow("closed");
		expect(backends).toHaveLength(3);
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
		cfgComputerEnabled.override(session.settings, false);
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

	it("prints the typed API on demand without starting the driver", async () => {
		const { realm, displays } = javascriptFixture(() => {
			throw new Error("help must never start a driver child");
		});
		await runInContext("computer.help()", realm);
		const printed = displays.join("\n");
		expect(printed).toContain("interface ComputerWindow");
		expect(printed).toContain("interface ComputerElement");
	});

	it("states both handle surfaces once a session and their verbs with every later handle", async () => {
		const { realm, displays } = javascriptFixture();
		const element = handleSignatures(computerDeclarations as string, "ComputerElement", "el handle:");
		try {
			await runInContext('computer.window("42", {screenshot:false}).then(win => (globalThis.win = win))', realm);
			// The first acquisition of the session teaches the API it hands over.
			expect(displays.join("\n")).toContain(
				handleSignatures(computerDeclarations as string, "ComputerWindow", "win handle:"),
			);
			// The element surface is the route several controls advertise in the
			// tree beside it; a run that never writes `.ref(` still needs it.
			expect(displays.join("\n")).toContain(element);
			expect(displays.join("\n")).toContain("perform(action: string)");
			// Every verb the boundary accepts is declared and shown with its types.
			for (const verb of Object.keys(WINDOW_METHODS)) {
				expect(computerDeclarations).toContain(`\n\t${verb}(`);
				expect(displays.join("\n")).toContain(`\n  ${verb}(`);
			}
			for (const verb of Object.keys(ELEMENT_METHODS)) expect(element).toContain(`\n  ${verb}(`);
			displays.length = 0;
			await runInContext(
				"win.observe({screenshot:false}).then(state => (globalThis.ref = state.elements[0].ref))",
				realm,
			);
			// The surface is stated with the handle, not repeated by every read
			// of the same window or by the first ref taken out of it.
			await runInContext("win.ref(ref).click()", realm);
			expect(displays.join("\n")).not.toContain("el handle:");
			expect(displays.join("\n")).not.toContain("computer.help() for signatures");
			displays.length = 0;
			await runInContext('computer.window("42", {screenshot:false})', realm);
			const footers = displays
				.join("\n")
				.split("\n")
				.filter(line => line.startsWith("win: "));
			expect(footers).toEqual([COMPUTER_HANDLE_VERBS]);
			expect(displays.join("\n")).not.toContain("win handle:");
			expect(displays.join("\n")).not.toContain("el handle:");
		} finally {
			await runInContext("computer.close()", realm);
		}
	});

	it("delivers the guide with each conversation's first acquired window, once", async () => {
		const guide = prompt.render(computerDescription as string, { linux: process.platform === "linux" });
		const copies = (text: string) => text.split(guide).length - 1;
		let conversation = "first";
		const { realm, displays } = javascriptFixture(undefined, { ...toolSession(), getSessionId: () => conversation });
		try {
			// Neither a listing nor an acquisition that resolves no window hands over a handle.
			await runInContext("computer.windows()", realm);
			await expect(runInContext('computer.window("7", {screenshot:false})', realm)).rejects.toThrow();
			expect(copies(displays.join("\n"))).toBe(0);
			await runInContext('computer.window("42", {screenshot:false})', realm);
			const first = displays.join("\n");
			expect(copies(first)).toBe(1);
			expect(first.indexOf(guide)).toBeLessThan(first.indexOf("Code: Editor (window 42"));
			displays.length = 0;
			await runInContext('computer.window("42", {screenshot:false})', realm);
			// Releasing the driver ends no conversation.
			await runInContext("computer.release()", realm);
			await runInContext('computer.window("42", {screenshot:false})', realm);
			expect(copies(displays.join("\n"))).toBe(0);
			// `/new` or a session switch keeps the prelude; the new transcript never saw the guide.
			conversation = "second";
			await runInContext('computer.window("42", {screenshot:false})', realm);
			expect(copies(displays.join("\n"))).toBe(1);
			// Switching back finds a transcript that already holds it, and the handle surface.
			displays.length = 0;
			conversation = "first";
			await runInContext('computer.window("42", {screenshot:false})', realm);
			expect(copies(displays.join("\n"))).toBe(0);
			expect(displays.join("\n")).not.toContain("win handle:");
		} finally {
			await runInContext("computer.close()", realm);
		}
		// A session without `read` carries every topic inline in the eval description already.
		const inline = javascriptFixture(undefined, { ...toolSession(), isToolActive: name => name !== "read" });
		try {
			await runInContext('computer.window("42", {screenshot:false})', inline.realm);
			expect(copies(inline.displays.join("\n"))).toBe(0);
		} finally {
			await runInContext("computer.close()", inline.realm);
		}
		// Every real eval cell is composed: the guide leads the cell's reply, and
		// a tree near the output budget is elided to fit beside it, never cut past it.
		const session = toolSession();
		const backend = new FakeBackend();
		backend.rows = 2300;
		const prelude = fixturePrelude(session, backend);
		const acquire = { action: "call", chain: [{ method: "acquireWindow", args: ["42", { screenshot: false }] }] };
		try {
			const cell = { signal: new AbortController().signal };
			prelude.beginCell!(cell);
			await prelude.invoke(acquire, { session, toolCallId: "composed", signal: cell.signal, cell });
			const composed = prelude.settleCell!(cell, { failed: false }) ?? "";
			expect(copies(composed)).toBe(1);
			expect(composed.indexOf(guide)).toBeLessThan(composed.indexOf("Code: Editor (window 42"));
			expect(Buffer.byteLength(composed, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		} finally {
			await prelude.invoke({ action: "close" }, { session, toolCallId: "close" });
		}
	});

	it("keeps a backend's once-only note once per conversation across the per-turn driver release", async () => {
		/** Says its note the way the Cua backend says an app note: only when the conversation has not heard it. */
		class NotingBackend extends FakeBackend {
			override async window(context: ComputerOperationContext, selector: string | WindowSelector) {
				const window = await super.window(context, selector);
				if (context.teach("app-note:dev.omp.code")) context.emitText("APP NOTE");
				return window;
			}
		}
		let backends = 0;
		let conversation = "first";
		const { realm, displays } = javascriptFixture(
			() => {
				backends++;
				return new NotingBackend();
			},
			{ ...toolSession(), getSessionId: () => conversation },
		);
		const notes = () => displays.join("\n").split("APP NOTE").length - 1;
		try {
			// A run that fails after the note was said discards its output with
			// it, so the note is still owed to this conversation.
			await expect(
				runInContext(
					'computer.run(async ({ desktop }) => { await desktop.window("42"); throw new Error("boom"); })',
					realm,
				),
			).rejects.toThrow("boom");
			expect(notes()).toBe(0);
			await runInContext('computer.window("42", {screenshot:false})', realm);
			await runInContext('computer.window("42", {screenshot:false})', realm);
			expect(notes()).toBe(1);
			// Turn settle releases the driver; the next call builds a new backend.
			await runInContext("computer.release()", realm);
			await runInContext('computer.window("42", {screenshot:false})', realm);
			expect(backends).toBe(2);
			expect(notes()).toBe(1);
			// Another conversation's transcript never saw it.
			conversation = "second";
			await runInContext('computer.window("42", {screenshot:false})', realm);
			expect(notes()).toBe(2);
		} finally {
			await runInContext("computer.close()", realm);
		}
	});

	it("teaches an app note again once a compaction replaced the context that held it", async () => {
		class NotingBackend extends FakeBackend {
			override async window(context: ComputerOperationContext, selector: string | WindowSelector) {
				const window = await super.window(context, selector);
				if (context.teach("app-note:dev.omp.code")) context.emitText("APP NOTE");
				return window;
			}
		}
		const branch: { type: string; id: string }[] = [{ type: "message", id: "m1" }];
		const sessionManager = { getBranch: () => branch } as unknown as NonNullable<ToolSession["sessionManager"]>;
		const { realm, displays } = javascriptFixture(() => new NotingBackend(), { ...toolSession(), sessionManager });
		const notes = () => displays.join("\n").split("APP NOTE").length - 1;
		try {
			await runInContext('computer.window("42", {screenshot:false})', realm);
			await runInContext('computer.window("42", {screenshot:false})', realm);
			expect(notes()).toBe(1);
			branch.push({ type: "compaction", id: "c1" }, { type: "message", id: "m2" });
			await runInContext('computer.window("42", {screenshot:false})', realm);
			await runInContext('computer.window("42", {screenshot:false})', realm);
			expect(notes()).toBe(2);
		} finally {
			await runInContext("computer.close()", realm);
		}
	});

	it("prints the same typed API through the Python prelude", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		definitions = [
			fixturePrelude(session, () => {
				throw new Error("help must never start a driver child");
			}),
		];
		const result = await executePython("await computer.help()", {
			cwd: process.cwd(),
			sessionId: `computer-py-help-${crypto.randomUUID()}`,
			toolSession: session,
			kernelMode: "per-call",
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("interface ComputerWindow");
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

	it("says beside each capture which grid its pixels are on", async () => {
		const backend = new FakeBackend();
		const supervisor = new ComputerSupervisor(toolSession(), async () => backend);
		const said = async (): Promise<string> => {
			const run = await runSupervisor(supervisor, "await desktop.screenshot()");
			if (!run.ok) throw run.error;
			return run.payload.displays
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map(block => block.text)
				.join("\n");
		};
		expect(await said()).toContain("screenshot desktop 64×32 (1 px = 1 display point)");
		// A surface too large for the frame budget cannot keep its grid, so the
		// result carries the number the model needs to convert what it reads.
		backend.captureScale = 0.5;
		expect(await said()).toContain(
			"screenshot desktop 32×16 (display 64×32 points at 0.50× — divide image pixels by 0.50 for the display points every action takes)",
		);
		// A capture that reached outside the window it names is not that
		// window's point grid at all: its top-left is somewhere else, and a
		// coordinate read off it needs the origin as well as the scale. The
		// window server draws an open popover or menu into the window's own
		// capture, so this is the ordinary shape, not an exotic one.
		backend.captureScale = 1;
		backend.captureOrigin = { x: -20, y: -8 };
		expect(await said()).toContain(
			"screenshot desktop 64×32 (covers 64×32 points from (-20, -8) in the display at 1.00× — a display point is image pixels ÷ 1.00 plus that origin, so this image holds more than the display)",
		);
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
		for (const absent of ["AT-SPI", "X11", "xdotool", "super"]) expect(darwin).not.toContain(absent);
		for (const absent of ["AppleScript", "TCC", "screencapture", "cmd|", "A write that is not proven"])
			expect(linux).not.toContain(absent);
		expect(linux).toContain("AT-SPI tree");
		expect(linux).toContain("foreground_unavailable");
		expect(darwin).toContain("password/TCC prompt");
	});
});
