import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	canGuardDevToolsPress,
	type DevToolsFocusGuards,
	DevToolsRoute,
	type DevToolsWindow,
} from "@oh-my-pi/pi-coding-agent/tools/computer/devtools-bridge";
import type { DesktopWindowOpened } from "@oh-my-pi/pi-natives";
import { rejectionOf } from "../helpers/rejection";

let originalHyprland: string | undefined;
beforeEach(() => {
	originalHyprland = process.env.HYPRLAND_INSTANCE_SIGNATURE;
});
afterEach(() => {
	if (originalHyprland === undefined) delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
	else process.env.HYPRLAND_INSTANCE_SIGNATURE = originalHyprland;
});

const PID = 4242;
const TARGET = "front-page";
const SESSION = "page-session";
const REFUSAL = "this desktop may grant window activation";

type Params = Record<string, unknown>;
type Listener = (method: string, params: Params, session: string) => void;

interface GuardReport {
	events: string[];
	reported: DesktopWindowOpened[][];
	opened: DesktopWindowOpened[];
}

function fixture(
	options: {
		kind?: string;
		editable?: boolean;
		electron?: boolean;
		safePress?: boolean;
		failAt?: string;
	} = {},
) {
	const events: string[] = [];
	const calls: Array<{ target: string; method: string; params: Params }> = [];
	const reported: DesktopWindowOpened[][] = [];
	const opened: DesktopWindowOpened[] = [
		{
			app: "chromium",
			pid: PID,
			title: "Opened dialog",
			opened: true,
			afterMs: 12,
			focus: "kept" as DesktopWindowOpened["focus"],
			userWindow: "editor: work",
		},
	];
	const failure = new Error("CDP input failed");
	let listener: Listener | undefined;
	const endpoint = {
		pid: PID,
		electron: options.electron ?? false,
		async connection() {
			return {
				on(callback: Listener) {
					listener = callback;
					events.push("listen");
					return () => {
						listener = undefined;
						events.push("off");
					};
				},
			};
		},
		async session(target: string) {
			expect(target).toBe(TARGET);
			return SESSION;
		},
		async send(target: string, method: string, params: Params = {}) {
			calls.push({ target, method, params });
			const event =
				method === "Input.dispatchMouseEvent" || method === "Input.dispatchDragEvent"
					? String(params.type)
					: method === "Input.setInterceptDrags"
						? `intercept:${params.enabled}`
						: method;
			events.push(event);
			if (event === options.failAt) throw failure;
			if (event === "mousePressed") {
				// Deliver interception synchronously, so drag never waits for an event-loop timer.
				listener?.("Input.dragIntercepted", { data: { items: [], dragOperationsMask: 1 } }, SESSION);
			}
			if (method === "Runtime.evaluate") return { result: { value: options.editable ?? false } };
			throwIfUnexpected(method);
			return {};
		},
	};
	const page = { targetId: TARGET, title: "Page", url: "https://example.com/" };
	const window: DevToolsWindow = {
		endpoint: endpoint as unknown as DevToolsWindow["endpoint"],
		windowId: 7,
		pages: [page],
		front: page,
		bounds: { left: 0, top: 0, width: 800, height: 600 },
	};
	const frames = new Map([["window", { targetId: TARGET, scaleX: 2, scaleY: 2, cssWidth: 800, cssHeight: 600 }]]);
	const route = new DevToolsRoute("window", window, frames, options.safePress ? undefined : REFUSAL);
	const guards: DevToolsFocusGuards = {
		async beginFocusGuard(pid) {
			events.push(`begin:${pid}`);
			await Promise.resolve();
			events.push("armed");
			return {
				kind: options.kind ?? "Hyprland hook",
				async finish() {
					events.push("finish");
					await Promise.resolve();
					events.push("settled");
					return opened;
				},
			};
		},
		report(outcomes) {
			events.push("report");
			reported.push(outcomes);
		},
	};
	return { route, guards, events, calls, reported, opened, failure };
}

function throwIfUnexpected(method: string): void {
	if (!["Input.dispatchMouseEvent", "Input.dispatchDragEvent", "Input.setInterceptDrags"].includes(method)) {
		throw new Error(`Unexpected CDP command: ${method}`);
	}
}

function expectReported(f: GuardReport): void {
	expect(f.reported).toEqual([f.opened]);
	expect(f.reported[0]).toBe(f.opened);
	expect(f.events.slice(-3)).toEqual(["finish", "settled", "report"]);
	expect(f.events.filter(event => event.startsWith("begin:"))).toEqual([`begin:${PID}`]);
}

describe("DevTools focus guard", () => {
	it("lifts browser press refusal only for an actual Hyprland hook on Hyprland", () => {
		for (const onHyprland of [false, true]) {
			for (const kind of ["Hyprland hook", "Hyprland socket watcher", "none", "Sway hook"]) {
				expect(canGuardDevToolsPress(onHyprland, kind)).toBe(onHyprland && kind === "Hyprland hook");
			}
		}
	});

	it("arms the endpoint pid before a browser press and reports after the last release", async () => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const f = fixture();
		expect(await f.route.click(40, 60, "left", 2, 8, f.guards)).toEqual({ x: 20, y: 30 });
		expect(f.events).toEqual([
			`begin:${PID}`,
			"armed",
			"mouseMoved",
			"mousePressed",
			"mouseReleased",
			"mousePressed",
			"mouseReleased",
			"finish",
			"settled",
			"report",
		]);
		expect(f.calls.filter(call => call.method === "Input.dispatchMouseEvent").map(call => call.params)).toEqual([
			{ type: "mouseMoved", x: 20, y: 30, modifiers: 8 },
			{ type: "mousePressed", x: 20, y: 30, button: "left", buttons: 1, clickCount: 1, modifiers: 8 },
			{ type: "mouseReleased", x: 20, y: 30, button: "left", buttons: 0, clickCount: 1, modifiers: 8 },
			{ type: "mousePressed", x: 20, y: 30, button: "left", buttons: 1, clickCount: 2, modifiers: 8 },
			{ type: "mouseReleased", x: 20, y: 30, button: "left", buttons: 0, clickCount: 2, modifiers: 8 },
		]);
		expect(f.calls.every(call => call.target === TARGET)).toBe(true);
		expectReported(f);
	});

	it.each(["Hyprland socket watcher", "none"])("%s preserves browser refusal and editable-field focus", async kind => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const refused = fixture({ kind });
		expect(String(await rejectionOf(refused.route.click(40, 60, "left", 1, 0, refused.guards)))).toContain(
			"BackgroundUnavailable",
		);
		expect(refused.calls.map(call => call.method)).toEqual(["Runtime.evaluate"]);
		expectReported(refused);

		const editable = fixture({ kind, editable: true });
		expect(await editable.route.click(40, 60, "left", 1, 0, editable.guards)).toEqual({
			x: 20,
			y: 30,
			focused: true,
		});
		expect(editable.calls.map(call => call.method)).toEqual(["Runtime.evaluate"]);
		expectReported(editable);

		const drag = fixture({ kind });
		expect(
			String(
				await rejectionOf(
					drag.route.drag(
						[
							[40, 60],
							[80, 100],
						],
						0,
						drag.guards,
					),
				),
			),
		).toContain("BackgroundUnavailable");
		expect(drag.calls).toEqual([]);
		expectReported(drag);
	});

	it("finishes and reports even when a guarded browser click fails in CDP", async () => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const f = fixture({ failAt: "mousePressed" });
		expect(await rejectionOf(f.route.click(40, 60, "left", 1, 0, f.guards))).toBe(f.failure);
		expect(f.events).toEqual([`begin:${PID}`, "armed", "mouseMoved", "mousePressed", "finish", "settled", "report"]);
		expectReported(f);
	});

	it.each([false, true])("one drag guard encloses interception cleanup, CDP failure=%s", async fails => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const f = fixture({ failAt: fails ? "drop" : undefined });
		const action = f.route.drag(
			[
				[40, 60],
				[80, 100],
			],
			8,
			f.guards,
		);
		if (fails) expect(await rejectionOf(action)).toBe(f.failure);
		else expect(await action).toBe("html");
		expect(f.events.slice(0, 3)).toEqual([`begin:${PID}`, "armed", "listen"]);
		expect(f.events.indexOf("intercept:true")).toBeLessThan(f.events.indexOf("mousePressed"));
		expect(f.events.indexOf("mousePressed")).toBeLessThan(f.events.indexOf("drop"));
		if (!fails) {
			expect(f.events.indexOf("drop")).toBeLessThan(f.events.indexOf("mouseReleased"));
			expect(f.events.indexOf("mouseReleased")).toBeLessThan(f.events.indexOf("off"));
		}
		expect(f.events.slice(-5)).toEqual(["off", "intercept:false", "finish", "settled", "report"]);
		expectReported(f);
	});

	it.each(["electron", "safe browser"])("also reports outcomes for an already-safe %s press", async mode => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const f = fixture({
			kind: "Hyprland socket watcher",
			electron: mode === "electron",
			safePress: mode === "safe browser",
		});
		expect(await f.route.click(40, 60, "left", 1, 0, f.guards)).toEqual({ x: 20, y: 30 });
		expect(f.events).toEqual([
			`begin:${PID}`,
			"armed",
			"mouseMoved",
			"mousePressed",
			"mouseReleased",
			"finish",
			"settled",
			"report",
		]);
		expectReported(f);
	});

	it("does not arm another press until the first guard finishes reporting", async () => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const f = fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const begin = f.guards.beginFocusGuard;
		f.guards.beginFocusGuard = async pid => {
			const watch = await begin(pid);
			return {
				kind: watch.kind,
				async finish() {
					entered.resolve();
					await release.promise;
					return watch.finish();
				},
			};
		};
		const first = f.route.click(40, 60, "left", 1, 0, f.guards);
		const second = f.route.click(40, 60, "left", 1, 0, f.guards);
		await entered.promise;
		try {
			expect(f.events.filter(event => event.startsWith("begin:"))).toEqual([`begin:${PID}`]);
		} finally {
			release.resolve();
		}
		await Promise.all([first, second]);
		expect(f.reported).toEqual([f.opened, f.opened]);
		expect(f.events.indexOf("report")).toBeLessThan(f.events.lastIndexOf(`begin:${PID}`));
	});

	it("does not arm or lift browser refusal outside Hyprland, even with a supplied hook", async () => {
		delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
		const f = fixture({ kind: "Hyprland hook" });
		expect(String(await rejectionOf(f.route.click(40, 60, "right", 1, 0, f.guards)))).toContain(
			"BackgroundUnavailable",
		);
		expect(
			String(
				await rejectionOf(
					f.route.drag(
						[
							[40, 60],
							[80, 100],
						],
						0,
						f.guards,
					),
				),
			),
		).toContain("BackgroundUnavailable");
		expect(f.events).toEqual([]);
		expect(f.calls).toEqual([]);
		expect(f.reported).toEqual([]);
	});
});
