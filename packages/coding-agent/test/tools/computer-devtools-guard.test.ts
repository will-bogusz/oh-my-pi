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
		compositor?: string | null;
		editable?: boolean;
		electron?: boolean;
		safePress?: boolean;
		failAt?: string;
		kinds?: string[];
		advanceAfterSend?: Record<string, number>;
		advanceOnBegin?: number[];
	} = {},
) {
	const events: string[] = [];
	const calls: Array<{ target: string; method: string; params: Params }> = [];
	const reported: DesktopWindowOpened[][] = [];
	const clock = { value: 0 };
	const advanced = new Set<string>();
	let begins = 0;
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
			if (!advanced.has(event)) {
				clock.value += options.advanceAfterSend?.[event] ?? 0;
				advanced.add(event);
			}
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
		now: () => clock.value,
		async beginFocusGuard(pid) {
			events.push(`begin:${pid}`);
			const index = begins++;
			let finished = false;
			clock.value += options.advanceOnBegin?.[index] ?? 0;
			await Promise.resolve();
			events.push("armed");
			return {
				kind: options.kinds?.[index] ?? options.kind ?? "compositorHook",
				compositor: options.compositor === undefined ? "hyprland" : options.compositor,
				async finish() {
					expect(finished).toBe(false);
					finished = true;
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
	return { route, guards, events, calls, reported, opened, failure, clock };
}

function throwIfUnexpected(method: string): void {
	if (!["Input.dispatchMouseEvent", "Input.dispatchDragEvent", "Input.setInterceptDrags"].includes(method)) {
		throw new Error(`Unexpected CDP command: ${method}`);
	}
}

function expectReported(f: GuardReport, count = 1): void {
	expect(f.reported).toEqual(Array.from({ length: count }, () => f.opened));
	expect(f.reported.every(outcomes => outcomes === f.opened)).toBe(true);
	expect(f.events.slice(-3)).toEqual(["finish", "settled", "report"]);
	expect(f.events.filter(event => event.startsWith("begin:"))).toEqual(Array(count).fill(`begin:${PID}`));
	for (const event of ["finish", "settled", "report"]) {
		expect(f.events.filter(value => value === event)).toHaveLength(count);
	}
}

describe("DevTools focus guard", () => {
	it("lifts browser press refusal only for an actual Hyprland hook on Hyprland", () => {
		for (const onHyprland of [false, true]) {
			for (const kind of ["compositorHook", "socketWatcher", "none"]) {
				for (const compositor of ["hyprland", "sway", null, undefined]) {
					expect(canGuardDevToolsPress(onHyprland, kind, compositor)).toBe(
						onHyprland && kind === "compositorHook" && compositor === "hyprland",
					);
				}
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
			"finish",
			"settled",
			"report",
			`begin:${PID}`,
			"armed",
			"mousePressed",
			"mouseReleased",
			"finish",
			"settled",
			"report",
			`begin:${PID}`,
			"armed",
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
		expectReported(f, 3);
	});

	it.each([
		{ kind: "socketWatcher", compositor: "hyprland" },
		{ kind: "none", compositor: "hyprland" },
		{ kind: "compositorHook", compositor: "sway" },
	])("$kind/$compositor preserves browser refusal and editable-field focus", async guard => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const refused = fixture(guard);
		expect(String(await rejectionOf(refused.route.click(40, 60, "left", 1, 0, refused.guards)))).toContain(
			"BackgroundUnavailable",
		);
		expect(refused.calls.map(call => call.method)).toEqual(["Runtime.evaluate"]);
		expectReported(refused);

		const editable = fixture({ ...guard, editable: true });
		expect(await editable.route.click(40, 60, "left", 1, 0, editable.guards)).toEqual({
			x: 20,
			y: 30,
			focused: true,
		});
		expect(editable.calls.map(call => call.method)).toEqual(["Runtime.evaluate"]);
		expectReported(editable);

		const drag = fixture(guard);
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
		expect(f.events).toEqual([
			`begin:${PID}`,
			"armed",
			"mouseMoved",
			"finish",
			"settled",
			"report",
			`begin:${PID}`,
			"armed",
			"mousePressed",
			"finish",
			"settled",
			"report",
		]);
		expectReported(f, 2);
	});

	it.each([false, true])("finishes every drag guard after interception cleanup, CDP failure=%s", async fails => {
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
		expectReported(f, 2);
	});

	it("rearms immediately before a press after a mouse move stalls for 13 seconds", async () => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const f = fixture({ advanceAfterSend: { mouseMoved: 13_000 } });
		await f.route.click(40, 60, "left", 1, 0, f.guards);
		const move = f.events.indexOf("mouseMoved");
		expect(f.events.slice(move + 1, move + 8)).toEqual([
			"finish",
			"settled",
			"report",
			`begin:${PID}`,
			"armed",
			"mousePressed",
			"mouseReleased",
		]);
		expectReported(f, 2);
	});

	it.each([12_999, 13_000])("renews before a release exactly at the 13-second boundary, age=%s", async age => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const f = fixture({ advanceAfterSend: { mousePressed: age } });
		await f.route.click(40, 60, "left", 1, 0, f.guards);
		const press = f.events.indexOf("mousePressed");
		expect(f.events.slice(press + 1, f.events.indexOf("mouseReleased") + 1)).toEqual(
			age < 13_000 ? ["mouseReleased"] : ["finish", "settled", "report", `begin:${PID}`, "armed", "mouseReleased"],
		);
		expectReported(f, age < 13_000 ? 2 : 3);
	});

	it.each([
		{ stalled: "dragOver", next: "dragOver" },
		{ stalled: "drop", next: "mouseReleased" },
	])("renews after stalled $stalled before dispatching $next", async ({ stalled, next }) => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const f = fixture({ advanceAfterSend: { [stalled]: 13_000 } });
		expect(
			await f.route.drag(
				[
					[40, 60],
					[42, 62],
				],
				0,
				f.guards,
			),
		).toBe("html");
		const at = f.events.indexOf(stalled);
		expect(f.events.slice(at + 1, at + 7)).toEqual(["finish", "settled", "report", `begin:${PID}`, "armed", next]);
		expectReported(f, 3);
	});

	it.each(["socketWatcher", "none"])("refuses a refreshed %s before the next press, not earlier input", async kind => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const f = fixture({ kinds: ["compositorHook", "compositorHook", kind] });
		const error = String(await rejectionOf(f.route.click(40, 60, "left", 2, 0, f.guards)));
		expect(error).toContain("BackgroundUnavailable");
		expect(error).toContain("next");
		expect(error).not.toContain("nothing was sent");
		expect(f.calls.map(call => call.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
		expectReported(f, 3);
	});

	it("allows release cleanup when an age-triggered refresh returns a watcher", async () => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const f = fixture({
			kinds: ["compositorHook", "compositorHook", "socketWatcher"],
			advanceAfterSend: { mousePressed: 13_000 },
		});
		await f.route.click(40, 60, "left", 1, 0, f.guards);
		expect(f.calls.map(call => call.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
		expectReported(f, 3);
	});

	it.each([0, 1])("fails closed when native begin delay consumes the handle lifetime, arm=%s", async arm => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const f = fixture({ advanceOnBegin: arm === 0 ? [13_000] : [0, 13_000] });
		expect(String(await rejectionOf(f.route.click(40, 60, "left", 1, 0, f.guards)))).toContain(
			"BackgroundUnavailable",
		);
		expect(f.calls.map(call => call.params.type)).toEqual(arm === 0 ? [] : ["mouseMoved"]);
		expectReported(f, arm + 1);
	});

	it("retains the editable-focus fallback after a slow non-hook acquisition", async () => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const f = fixture({ kind: "socketWatcher", editable: true, advanceOnBegin: [13_000] });
		expect(await f.route.click(40, 60, "left", 1, 0, f.guards)).toEqual({ x: 20, y: 30, focused: true });
		expect(f.calls.map(call => call.method)).toEqual(["Runtime.evaluate"]);
		expectReported(f);
	});

	it.each(["electron", "safe browser"])("also reports outcomes for an already-safe %s press", async mode => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-hyprland";
		const f = fixture({
			kind: "socketWatcher",
			electron: mode === "electron",
			safePress: mode === "safe browser",
		});
		expect(await f.route.click(40, 60, "left", 1, 0, f.guards)).toEqual({ x: 20, y: 30 });
		expect(f.events.filter(event => event.startsWith("mouse"))).toEqual([
			"mouseMoved",
			"mousePressed",
			"mouseReleased",
		]);
		const press = f.events.indexOf("mousePressed");
		expect(f.events.slice(press - 2, press)).toEqual([`begin:${PID}`, "armed"]);
		expectReported(f, f.events.filter(event => event === "armed").length);
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
				compositor: watch.compositor,
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
		expectReported(f, 4);
		const firstRelease = f.events.indexOf("mouseReleased");
		const secondMove = f.events.lastIndexOf("mouseMoved");
		expect(f.events.slice(firstRelease + 1, secondMove)).toEqual([
			"finish",
			"settled",
			"report",
			`begin:${PID}`,
			"armed",
		]);
	});

	it("does not arm or lift browser refusal outside Hyprland, even with a supplied hook", async () => {
		delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
		const f = fixture({ kind: "compositorHook" });
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
