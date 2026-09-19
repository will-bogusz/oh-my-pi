import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromJsonSchema, type } from "@oh-my-pi/omptype";
import type { DesktopSystemWindow } from "@oh-my-pi/pi-natives";
import { CuaComputerSession } from "@oh-my-pi/pi-coding-agent/tools/computer/cua-session";
import type { CuaDriver, CuaToolResult } from "@oh-my-pi/pi-coding-agent/tools/computer/driver";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type {
	ComputerImage,
	ComputerOperationContext,
	ComputerPoint,
} from "@oh-my-pi/pi-coding-agent/tools/computer/types";
import type { WindowRosterSample } from "@oh-my-pi/pi-coding-agent/tools/computer/interruption";
/** The fork's generated tool contract at 0d897a672 (`libs/cua-driver/contract/manifest.json`, 0.10.0). */
import contract from "../fixtures/cua-contract-manifest.json";

type Wire = Record<string, unknown>;
/** A `list_windows` row: the fields OMP reads, plus whatever the platform adds. */
type WindowRow = Wire & {
	window_id: number;
	pid: number;
	app_name: string;
	title: string;
	bounds: { x: number; y: number; width: number; height: number };
};
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEklEQVR4nGP4z8DwHxkzoAsAAA8hD/EEN8afAAAAAElFTkSuQmCC";
function reply(data: Wire, images: CuaToolResult["images"] = []): CuaToolResult {
	return { text: "SDK response", structuredJson: JSON.stringify(data), isError: false, images };
}
/** The closed `ActionResult` every input tool answers with, per the manifest. */
const ACTION_RESULT = fromJsonSchema(
	(contract.tools as { name: string; success_output_schema?: unknown }[]).find(tool => tool.name === "type_text")!
		.success_output_schema,
);
/**
 * A structured payload the shipping driver can actually emit. The drift this
 * guards against survived a release: the write tests fed `committed: true`,
 * which no build has published since the verdict became a string, so every
 * test of the write path passed against a shape that does not exist.
 */
function wireResult(data: Wire): Wire {
	const validated = ACTION_RESULT({ route: "accessibility", ...data });
	if (validated instanceof type.errors) throw new Error(`payload no driver emits: ${validated.summary}`);
	return data;
}

/**
 * Recorded from cua-driver 0.28.0 on goliath (Ubuntu 24.04, Xvfb + openbox,
 * Chrome and one xterm on `:99`) and trimmed to the fields OMP reads:
 * `~/tmp/adhoc/2026-09-11-cua-linux-build/probe-run1/{01-check_permissions,02-list_windows}.json`,
 * `probe-run2/{01-get_window_state,04-type_text}.json`.
 */
const LINUX = {
	permissions: {
		atspi: true,
		dbus_session_bus_address: "unix:path=/tmp/dbus-YrSRdOAAUT,guid=7b1cc4071885ba8d2787cf076aa470e1",
		wayland: false,
		wayland_enabled: false,
		x11: true,
		xsend_event: true,
	},
	// No row carries `layer`: X11 has no window-layer concept to report.
	xterm: {
		app_name: "XTerm",
		bounds: { height: 316, width: 484, x: 21, y: 562 },
		height: 316,
		is_on_screen: true,
		pid: 1167787,
		title: "will@goliath: ~",
		width: 484,
		window_id: 4194316,
		x: 21,
		y: 562,
		z_index: 0,
	},
	chrome: {
		app_name: "Google-chrome",
		bounds: { height: 800, width: 1100, x: 40, y: 20 },
		height: 800,
		is_on_screen: true,
		pid: 1167788,
		title: "ClickMatrix - Google Chrome",
		width: 1100,
		window_id: 6291459,
		x: 40,
		y: 20,
		z_index: 1,
	},
	// Contract-shaped, not recorded: `pid` is nullable and X11 reports null for
	// a titled window whose owner set no `_NET_WM_PID`.
	pidless: {
		app_name: "unknown",
		bounds: { height: 24, width: 1440, x: 0, y: 0 },
		height: 24,
		is_on_screen: true,
		pid: null,
		title: "xdg-desktop-portal",
		width: 1440,
		window_id: 8388610,
		x: 0,
		y: 0,
		z_index: 2,
	},
	refusal: {
		text: 'Background delivery is not available: the requested target has no focus-free input backend; the remaining XTest/X11 route can only deliver to the globally focused widget. Retry this action with delivery_mode:"foreground"; Cua Driver will activate the target for the action and restore the previous foreground afterward.',
		code: "background_unavailable",
		detail:
			"the requested target has no focus-free input backend; the remaining XTest/X11 route can only deliver to the globally focused widget",
		escalation: {
			reason: 'background input is unavailable on this surface; retry this action with delivery_mode:"foreground".',
			recommended: "foreground",
		},
		suggestion: 'Retry this action with delivery_mode:"foreground".',
	},
	// The fork's typed shape for the X11 foreground failure upstream still
	// reports untyped; OMP matches the structured code, never the text.
	foregroundRefusal: {
		text: "foreground_unavailable: no EWMH-compliant window manager is running on this display, so the target cannot be activated.",
		code: "foreground_unavailable",
		detail: "no EWMH-compliant window manager is running on this display, so the target cannot be activated",
	},
} as const;

/** A WindowServer roster row; the sample is ordered front to back. */
function systemWindow(row: { id: string; title: string; zIndex?: number }): DesktopSystemWindow {
	return {
		id: row.id,
		pid: 101,
		app: "Fixture",
		title: row.title,
		x: 10,
		y: 20,
		width: 200,
		height: 100,
		layer: 0,
		alpha: 1,
		zIndex: row.zIndex ?? 0,
	};
}

async function fixture(options: { platform?: NodeJS.Platform } = {}) {
	const platform = options.platform ?? "darwin";
	const linux = platform === "linux";
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cua-session-"));
	const calls: { name: string; args: Wire }[] = [];
	/** Structured payload of every non-error reply, for contract conformance. */
	const replies: { name: string; data: Wire }[] = [];
	const images: ComputerImage[] = [];
	const texts: string[] = [];
	const row: WindowRow = linux
		? { ...LINUX.chrome }
		: {
				window_id: 1,
				pid: 101,
				app_name: "Fixture",
				title: "Editor",
				bounds: { x: 10, y: 20, width: 200, height: 100 },
				is_on_screen: true,
				layer: 0,
				z_index: 0,
			};
	const state = {
		sequence: 0,
		/** Overrides the row's platform-default role/label (menu bar rows, etc.). */
		role: undefined as string | undefined,
		/** `AXSubrole`: the specific role, where the provider reports one. */
		subrole: undefined as string | undefined,
		label: undefined as string | undefined,
		value: "" as string | undefined,
		placeholder: "Hint, not value" as string | undefined,
		/** `AXHelp`/AT-SPI description: absent on most rows, "" when the provider has none. */
		help: undefined as string | undefined,
		description: undefined as string | undefined,
		actions: undefined as unknown,
		backgroundActions: undefined as unknown,
		customActions: undefined as unknown,
		elementDoubleClick: undefined as unknown,
		/** `AXEnabled` of the walked row; false, as a not-key window publishes its controls. */
		enabled: false as boolean,
		/** Absent on rows whose provider reported no frame: the ref has no point. */
		elementFrame: { x: 10, y: 20, w: 200, h: 100 } as Wire | undefined,
		relatedWindows: undefined as unknown,
		/** The fork's walker verdict; absent on 0.28.0 and earlier. */
		truncated: undefined as boolean | undefined,
		/** WindowServer sample; absent means macOS reported no roster at all. */
		roster: undefined as WindowRosterSample | undefined,
		failCapture: false,
		wrongIdentity: false,
		kills: 0,
		cancelled: [] as string[],
		displayIdentity: true,
		display: { uuid: "display-uuid", nativeId: 7, x: 0, y: 0, width: 2, height: 1, scale: 2 },
		hook: undefined as ((name: string, args: Wire) => Promise<CuaToolResult | undefined>) | undefined,
	};
	const answer = (name: string, args: Wire): CuaToolResult => {
		if (name === "check_permissions")
			return reply(linux ? LINUX.permissions : { accessibility: true, screen_recording: true });
		if (name === "list_windows") return reply({ windows: linux ? [LINUX.xterm, row, LINUX.pidless] : [row] });
		if (name === "list_apps") return reply({ apps: [] });
		if (name === "get_screen_size" || name === "get_desktop_state") {
			const display = state.display;
			const identity = state.displayIdentity
				? {
						display_identity: { uuid: display.uuid, native_id: display.nativeId },
						screen_origin: { x: display.x, y: display.y },
					}
				: {};
			if (name === "get_screen_size")
				return reply({ width: display.width, height: display.height, scale_factor: display.scale, ...identity });
			return reply(
				{
					display: "primary",
					platform: linux ? "linux" : "macos",
					screen_width: display.width,
					screen_height: display.height,
					scale_factor: display.scale,
					screenshot_width: 4,
					screenshot_height: 2,
					screenshot_mime_type: "image/png",
					...identity,
				},
				[{ dataBase64: PNG, mimeType: "image/png" }],
			);
		}
		if (name === "get_window_state") {
			state.sequence++;
			// Linux sets `screenshot_frame_valid` only to false, only on a
			// capture error; macOS sets it true on success.
			const frameValid = linux
				? state.failCapture
					? { screenshot_frame_valid: false }
					: {}
				: { screenshot_frame_valid: !state.failCapture };
			return reply(
				{
					pid: state.wrongIdentity ? 999 : row.pid,
					window_id: row.window_id,
					snapshot_id: `s${state.sequence}`,
					// Hard-coded false by both 0.28.0 walkers, which also count only
					// what they reached, so neither the flag nor the counts can deny
					// a clip. `truncated` is the fork's verdict.
					elements_complete: false,
					...(linux ? { returned_element_count: 1, total_element_count: 1, element_count: 1 } : {}),
					...(state.truncated === undefined ? {} : { truncated: state.truncated }),
					related_windows: state.relatedWindows,
					element_double_click: state.elementDoubleClick,
					elements: [
						{
							element_index: 1,
							element_token: `s${state.sequence}:1`,
							role: state.role ?? (linux ? "push button" : "AXTextField"),
							subrole: state.subrole,
							label: state.label ?? (linux ? "B3" : "Editor"),
							value: state.value,
							placeholder: state.placeholder,
							help: state.help,
							description: state.description,
							actions: state.actions ?? (linux ? ["press", "showContextMenu"] : undefined),
							background_actions: state.backgroundActions,
							custom_actions: state.customActions,
							enabled: state.enabled,
							selected: false,
							depth: 0,
							frame: state.elementFrame,
						},
					],
					window_bounds: row.bounds,
					...frameValid,
					screenshot_width: 4,
					screenshot_height: 2,
					screenshot_mime_type: "image/png",
				},
				args.include_screenshot && !state.failCapture ? [{ dataBase64: PNG, mimeType: "image/png" }] : [],
			);
		}
		if (name === "set_value") state.value = String(args.value);
		if (name === "type_text") state.value += String(args.text);
		return reply({ effect: "unverifiable", evidence: null, route: "accessibility" });
	};
	/** Cleared by `crash()`; the next `spawn` restores it, as a real respawn would. */
	let live = true;
	const driver: CuaDriver = {
		version: "0.24.0",
		pid: 900,
		get alive() {
			return live && state.kills === 0;
		},
		async callTool(name, args, signal) {
			calls.push({ name, args });
			const settled = state.hook?.(name, args);
			const onAbort = (): void => {
				state.cancelled.push(name);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			let override: CuaToolResult | undefined;
			try {
				override = await settled;
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
			// Mirror the real child: a cancelled call answers with the typed envelope.
			if (signal?.aborted && state.cancelled.includes(name))
				throw new ToolAbortError(`Computer action ${name} cancelled; partial: {}`);
			const result = override ?? answer(name, args);
			if (!result.isError && result.structuredJson)
				replies.push({ name, data: JSON.parse(result.structuredJson) as Wire });
			return result;
		},
		async kill() {
			state.kills++;
		},
	};
	const session = await CuaComputerSession.create({
		platform,
		spawn: async () => {
			live = true;
			return driver;
		},
		sampleRoster: () => state.roster ?? { windows: [], elapsedMs: 0 },
	});
	const context: ComputerOperationContext = {
		signal: new AbortController().signal,
		readOnly: false,
		maxWidth: 3840,
		maxHeight: 2400,
		maxPixels: 0,
		emitImage(image) {
			images.push(image);
		},
		emitText(text) {
			texts.push(text);
		},
	};
	const window = await session.window(context, { id: String(row.window_id), pid: row.pid as number });
	return {
		session,
		context,
		window,
		state,
		row,
		crash: () => {
			live = false;
		},
		calls,
		/** The last call that was not a roster read; every action ends with one. */
		lastDispatch: () => calls.filter(call => call.name !== "list_windows").at(-1),
		replies,
		images,
		texts,
		async close() {
			await session.close();
			await Promise.all(images.map(image => fs.rm(image.path, { force: true })));
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

it("acquires the sole application-declared window without hiding raw helper identities", async () => {
	const f = await fixture();
	const helper = { ...f.row, window_id: 2, title: "", is_on_screen: false };
	try {
		f.state.hook = async (name, args) => {
			if (name !== "list_windows") return undefined;
			return reply({
				windows: [helper, { ...f.row, is_on_screen: false }],
				...(args.include_accessibility_metadata
					? {
							accessibility_windows: {
								pid: 101,
								complete: true,
								windows: [{ window_id: 1, role: "AXWindow", minimized: true }],
							},
						}
					: {}),
			});
		};
		const acquired = await f.session.window(f.context, { app: "Fixture" });
		expect(acquired).toMatchObject({ id: "1", pid: 101, onScreen: false });
		expect((await f.session.windows(f.context, { app: "Fixture" })).map(window => window.id)).toEqual(["2", "1"]);
		f.calls.length = 0;
		expect(await f.session.window(f.context, { id: "2", pid: 101 })).toMatchObject({ id: "2", title: "" });
		expect(f.calls).toEqual([{ name: "list_windows", args: { pid: 101 } }]);
	} finally {
		await f.close();
	}
});

it("keeps the driver's own capture-lease window out of every roster it offers", async () => {
	const f = await fixture();
	const lease = {
		...f.row,
		window_id: 9,
		title: "Window",
		bounds: { x: 0, y: 0, width: 66, height: 20 },
		z_index: 12,
	};
	const named = { ...f.row, window_id: 10, title: "Window", z_index: 3 };
	try {
		f.state.hook = async name => (name === "list_windows" ? reply({ windows: [f.row, lease, named] }) : undefined);
		expect((await f.session.windows(f.context)).map(window => window.id)).toEqual(["1", "10"]);
		// An app window that merely shares the title keeps its place, so the
		// acquisition below is ambiguous between the two real windows only.
		expect(await f.session.window(f.context, { app: "Fixture", title: "Editor" })).toMatchObject({ id: "1" });
		expect(f.texts).toEqual([]);
		// The lease window is the driver's own, so an AXWindows mapping that
		// lists it is still exact: narrowing stands and picks the claimed row
		// over the one stacking order puts in front.
		f.state.hook = async (name, args) =>
			name === "list_windows"
				? reply({
						windows: [f.row, lease, named],
						...(args.include_accessibility_metadata
							? {
									accessibility_windows: {
										pid: 101,
										complete: true,
										windows: [
											{ window_id: 1, role: "AXWindow" },
											{ window_id: 9, role: "AXWindow" },
										],
									},
								}
							: {}),
					})
				: undefined;
		expect(await f.session.window(f.context, { app: "Fixture" })).toMatchObject({ id: "1" });
		expect(f.texts).toEqual([]);
	} finally {
		await f.close();
	}
});

it("reads only the acted pid's windows once a handle names one", async () => {
	const f = await fixture();
	const print = { ...f.row, window_id: 7, title: "Print", z_index: 9 };
	const lease = { ...f.row, window_id: 9, title: "Window", bounds: { x: 0, y: 0, width: 66, height: 20 } };
	const foreign = { ...f.row, pid: 202, window_id: 20, title: "Other app" };
	let printing = false;
	try {
		f.state.hook = async (name, args) => {
			if (name !== "list_windows") return undefined;
			const all = [f.row, lease, foreign, ...(printing ? [print] : [])];
			return reply({ windows: all.filter(row => args.pid === undefined || row.pid === args.pid) });
		};
		await f.session.observe(f.context, f.window);
		printing = true;
		f.calls.length = 0;
		const opened = await f.session.press(f.context, f.window, "cmd+p", undefined, { delivery: "foreground" });
		expect(f.calls.filter(call => call.name === "list_windows").map(call => call.args)).toEqual([
			{ pid: 101 },
			{ pid: 101 },
		]);
		expect(opened.text).toContain('pid 101 gained window 7 ("Print")');
		expect(opened.text).not.toContain("window 9");
		// A pid-scoped read still carries that pid's own capture-lease window,
		// so it is still recognised and never offered as a candidate.
		await expect(f.session.window(f.context, { id: "9", pid: 101 })).rejects.toThrow("Missing computer window");
		// The whole roster is still what a listing with no pid asks for.
		expect((await f.session.windows(f.context)).map(window => window.id)).toEqual(["1", "20", "7"]);
	} finally {
		await f.close();
	}
});

it("names a window the pid opened since the last observation and never rebinds the handle", async () => {
	const f = await fixture();
	const print = { ...f.row, window_id: 7, title: "Print", z_index: 9 };
	const lease = { ...f.row, window_id: 9, title: "Window", bounds: { x: 0, y: 0, width: 66, height: 20 } };
	try {
		await f.session.observe(f.context, f.window);
		const quiet = await f.session.press(f.context, f.window, "cmd+p", undefined, { delivery: "foreground" });
		expect(quiet.text).not.toContain("gained window");
		f.state.hook = async name => (name === "list_windows" ? reply({ windows: [f.row, print, lease] }) : undefined);
		const opened = await f.session.press(f.context, f.window, "cmd+p", undefined, { delivery: "foreground" });
		expect(opened.text).toContain(
			'pid 101 gained window 7 ("Print") since your last observation — acquire it with computer.window("7").',
		);
		expect(opened.text).not.toContain("window 9");
		expect(f.window.id).toBe("1");
		expect(f.lastDispatch()).toMatchObject({ name: "hotkey", args: { pid: 101, window_id: 1 } });
		// Observing the parent adopts the new window into its own baseline.
		await f.session.observe(f.context, f.window);
		const settled = await f.session.press(f.context, f.window, "cmd+p", undefined, { delivery: "foreground" });
		expect(settled.text).not.toContain("gained window");
	} finally {
		await f.close();
	}
});

it("announces what a pid opened on the observe path and nests a sheet under its new parent", async () => {
	const f = await fixture();
	// Chrome's print dialog renders seconds after the invoke that asked for
	// it, so it appears between two observations rather than inside an action.
	const print = { ...f.row, window_id: 7, title: "Print", z_index: 9 };
	const lease = { ...f.row, window_id: 9, title: "Window", bounds: { x: 0, y: 0, width: 66, height: 20 } };
	const document = { ...f.row, window_id: 11, title: "Untitled", bounds: { x: 0, y: 0, width: 400, height: 300 } };
	const sheet = { ...f.row, window_id: 12, title: "", bounds: { x: 100, y: 20, width: 200, height: 120 } };
	let windows: WindowRow[] = [f.row];
	try {
		f.state.hook = async (name, args) =>
			name === "list_windows"
				? reply({
						windows,
						...(args.include_accessibility_metadata
							? {
									accessibility_windows: {
										pid: 101,
										complete: true,
										windows: [
											{ window_id: 1, role: "AXWindow" },
											{ window_id: 7, role: "AXWindow" },
											{ window_id: 11, role: "AXWindow" },
										],
									},
								}
							: {}),
					})
				: undefined;
		await f.session.observe(f.context, f.window);
		windows = [f.row, print, lease];
		f.calls.length = 0;
		const opened = await f.session.observe(f.context, f.window);
		// The diff spends the roster this walk's own closing geometry check read:
		// the two reads are the ones `#state` already made before and after it.
		expect(f.calls.map(call => [call.name, call.args.pid])).toEqual([
			["list_windows", 101],
			["get_window_state", 101],
			["list_windows", 101],
		]);
		expect(opened.tree).toContain(
			'pid 101 gained window 7 ("Print") since your last observation — acquire it with computer.window("7").',
		);
		// The driver's own capture-lease window is nobody's.
		expect(opened.tree).not.toContain("window 9");
		// This read adopted it, so the next one does not say it again.
		expect((await f.session.observe(f.context, f.window)).tree).not.toContain("gained window");
		// A sheet and the window it is attached to appear together: the parent
		// is the line to follow, and its own tree renders the sheet.
		windows = [f.row, print, lease, document, sheet];
		const nested = await f.session.observe(f.context, f.window);
		expect(nested.tree.split("\n").filter(line => line.includes("gained") || line.includes("attached"))).toEqual([
			'pid 101 gained window 11 ("Untitled") since your last observation — acquire it with computer.window("11").',
			'  window 12 ("") is attached to it — no accessibility window of its own — and renders inside its parent\'s tree; observe window 11, not this id.',
		]);
	} finally {
		await f.close();
	}
});

it("declines the driver's post-action window poll on the actions that offer one", async () => {
	const f = await fixture();
	try {
		const ref = (await f.session.observe(f.context, f.window, { screenshot: true, silent: true })).elements[0]!.ref;
		f.calls.length = 0;
		await f.session.click(f.context, f.window, [1, 0]);
		await f.session.click(f.context, f.window, ref, { count: 2 });
		await f.session.perform(f.context, f.window, ref, "press");
		await f.session.type(f.context, f.window, "hi");
		await f.session.setValue(f.context, f.window, ref, "typed");
		await f.session.press(f.context, f.window, "Return");
		await f.session.press(f.context, f.window, "cmd+p");
		await f.session.scroll(f.context, f.window, "down");
		await f.session.drag(f.context, f.window, [0, 0], [1, 0], { delivery: "foreground" });
		await f.session.menu(f.context, f.window, ["File"], { delivery: "foreground" });
		await f.session.setFrame(f.context, f.window, { x: 0, y: 0, width: 200, height: 100 });
		await f.session.raise(f.context, f.window);
		await f.session.clipboardWrite(f.context, "copied");
		const declined: Record<string, true> = {
			click: true,
			drag: true,
			hotkey: true,
			press_key: true,
			scroll: true,
			set_value: true,
			type_text: true,
		};
		const dispatched = f.calls.filter(call => call.name !== "list_windows" && call.name !== "get_window_state");
		expect([...new Set(dispatched.map(call => call.name))].sort()).toEqual(
			[...Object.keys(declined), "invoke_menu", "set_window_frame", "bring_to_front", "clipboard_write"].sort(),
		);
		for (const call of dispatched)
			expect([call.name, call.args.detect_window_change]).toEqual([
				call.name,
				declined[call.name] === true ? false : undefined,
			]);
	} finally {
		await f.close();
	}
});

it("acquires the front document window and names the windows it passed over", async () => {
	const f = await fixture();
	try {
		// One app, two restored documents: the front one is what the user is
		// working in, and the others are named with the ids that pick them.
		const second = { ...f.row, window_id: 2, title: "Second", z_index: 3 };
		f.state.hook = async name => (name === "list_windows" ? reply({ windows: [f.row, second] }) : undefined);
		expect(await f.session.window(f.context, { app: "Fixture" })).toMatchObject({ id: "2", zIndex: 3 });
		expect(f.texts.join("\n")).toBe(
			'Ambiguous computer window {"app":"Fixture"}: 2 windows match; acquired the front document window, id "2" "Second"; also open: [1] "Editor" — acquire one by its exact id to work on it instead.',
		);
		// The WindowServer roster orders what the driver reports no stacking for.
		f.state.roster = {
			windows: [systemWindow({ id: "1", title: "Editor" }), systemWindow({ id: "2", title: "Second", zIndex: 1 })],
			elapsedMs: 0,
		};
		f.state.hook = async name =>
			name === "list_windows"
				? reply({
						windows: [
							{ ...f.row, z_index: null },
							{ ...second, z_index: null },
						],
					})
				: undefined;
		f.texts.length = 0;
		expect(await f.session.window(f.context, { app: "Fixture" })).toMatchObject({ id: "1" });
		expect(f.texts.join("\n")).toContain('acquired the front document window, id "1" "Editor"');
		// Neither source orders them: stacking is unknown and nothing is picked.
		f.state.roster = undefined;
		await expect(f.session.window(f.context, { app: "Fixture" })).rejects.toThrow("Ambiguous");
	} finally {
		await f.close();
	}
});

it("passes over an app's panels, off-screen windows and attached sheets to reach its document", async () => {
	const f = await fixture();
	// Automator's own doing: the document the user is working in, a second
	// document behind it, an untitled floating library panel, a minimized
	// document and the Save sheet the front document itself owns.
	const rows = [
		{ ...f.row, window_id: 2, title: "T10Name.workflow", z_index: 4 },
		{ ...f.row, window_id: 3, title: "", z_index: 9 },
		{ ...f.row, window_id: 4, title: "T10Old.workflow", z_index: 1, is_on_screen: false },
		{ ...f.row, window_id: 5, title: "Save", z_index: 12 },
		{ ...f.row, window_id: 1, title: "T10Start.workflow", z_index: 6 },
	];
	try {
		f.state.label = "Save as:";
		f.state.relatedWindows = [{ pid: 101, window_id: 5, title: "Save", relation: "sheet" }];
		f.state.hook = async name => (name === "list_windows" ? reply({ windows: rows }) : undefined);
		// Nothing in a window roster says "sheet" and this driver publishes no
		// AXWindows mapping either, so a sheet nobody has observed is the front
		// titled window and is acquired as one.
		expect(await f.session.window(f.context, { app: "Fixture" })).toMatchObject({ id: "5" });
		// The parent's own walk is what names it, and the parent's own rows keep
		// dispatching to the parent however the sheet is rendered beside them.
		const parent = await f.session.observe(f.context, await f.session.window(f.context, { id: "1", pid: 101 }));
		expect(parent.relatedWindows).toEqual([{ pid: 101, id: "5", title: "Save", relation: "sheet" }]);
		await f.session.setValue(f.context, parent.window, parent.elements[0]!.ref, "Project_File_List.txt");
		expect(f.lastDispatch()).toMatchObject({ name: "set_value", args: { window_id: 1, pid: 101 } });
		f.texts.length = 0;
		expect(await f.session.window(f.context, { app: "Fixture" })).toMatchObject({ id: "1" });
		expect(f.texts.join("\n")).toBe(
			'Ambiguous computer window {"app":"Fixture"}: 5 windows match; acquired the front document window, id "1" "T10Start.workflow"; also open: [5] "Save", [2] "T10Name.workflow", [4] "T10Old.workflow", [3] "" — acquire one by its exact id to work on it instead.',
		);
		// The sheet is gone: its id stops being excluded the moment the parent
		// that reported it is observed without it.
		f.state.relatedWindows = undefined;
		await f.session.observe(f.context, await f.session.window(f.context, { id: "1", pid: 101 }));
		f.texts.length = 0;
		expect(await f.session.window(f.context, { app: "Fixture" })).toMatchObject({ id: "5" });
		expect(f.texts.join("\n")).toContain('acquired the front document window, id "5" "Save"');
		// An app showing no document window at all is still acquired, at its
		// frontmost window, and the sentence says so.
		f.state.hook = async name =>
			name === "list_windows" ? reply({ windows: [rows[1]!, { ...rows[3]!, title: "" }] }) : undefined;
		f.texts.length = 0;
		expect(await f.session.window(f.context, { app: "Fixture" })).toMatchObject({ id: "5" });
		expect(f.texts.join("\n")).toContain('acquired the frontmost window, id "5" ""; also open: [3] ""');
	} finally {
		await f.close();
	}
});

it("returns exact candidates without inspecting one when asked to refuse an ambiguous selector", async () => {
	const f = await fixture();
	const second = { ...f.row, window_id: 2, title: "Second", is_on_screen: false };
	const axWindow = { window_id: 1, role: "AXWindow" };
	try {
		for (const metadata of [
			undefined,
			{ pid: 101, complete: false, windows: [axWindow] },
			{ pid: 101, complete: true, windows: [axWindow, { window_id: 2, role: "AXWindow", minimized: true }] },
			{ pid: 101, complete: true, windows: [axWindow, { window_id: 3, role: "AXWindow" }] },
		]) {
			f.state.hook = async name =>
				name === "list_windows" ? reply({ windows: [f.row, second], accessibility_windows: metadata }) : undefined;
			f.calls.length = 0;
			const failure = await f.session
				.window(f.context, { app: "Fixture" }, { ambiguous: "throw" })
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			if (!(failure instanceof Error)) throw new Error("Expected ambiguous acquisition to fail");
			expect(failure.message).toContain("Ambiguous");
			expect(failure.message).toContain("2 windows match");
			expect(failure.message).toContain('computer.window("1")');
			expect(failure.message).toContain('- id "1" pid 101 Fixture "Editor" 200×100 at (10,20)');
			expect(failure.message).toContain('- id "2" pid 101 Fixture "Second" 200×100 at (10,20) offscreen');
			expect(f.calls.every(call => call.name === "list_windows")).toBe(true);
		}
	} finally {
		await f.close();
	}
});

/**
 * T10 `long-native-automator/omp-1`: TextEdit pid 758 had 7 CGWindow rows,
 * five of them identical 1728×33 untitled ghosts, and
 * `accessibility_windows: { complete: true, windows: [] }` — no AXWindow
 * behind any of them. Acquisition read the empty roster as "no information",
 * took the highest `z_index`, and handed back a window whose every input
 * route the driver refuses `off_space_or_ax_unresolved`.
 */
it("refuses an acquisition whose every candidate row takes no input", async () => {
	const f = await fixture();
	const ghost = (id: number, zIndex: number) => ({
		...f.row,
		window_id: id,
		title: "",
		is_on_screen: false,
		z_index: zIndex,
		bounds: { x: 0, y: 0, width: 1728, height: 33 },
	});
	try {
		f.state.hook = async name =>
			name === "list_windows"
				? reply({
						windows: [ghost(52, 122), ghost(51, 69), ghost(50, 65)],
						accessibility_windows: { pid: 101, complete: true, windows: [] },
					})
				: undefined;
		f.calls.length = 0;
		const failure = await f.session.window(f.context, { app: "Fixture" }).catch((error: unknown) => error);
		if (!(failure instanceof Error)) throw new Error("Expected the input-dead acquisition to be refused");
		expect(failure.message).toContain(
			"Fixture: pid 101 has 3 WindowServer rows and no accessibility window; every input route to them is refused. Bring it to this Space or reopen its document, then acquire again.",
		);
		expect(failure.message).toContain('- id "52" pid 101 Fixture "" 1728×33 at (0,0) offscreen');
		// Nothing was observed or dispatched on a window that cannot answer.
		expect(f.calls.every(call => call.name === "list_windows")).toBe(true);
		// One AXWindow, and it is not among the rows this selector matched: the
		// recovery is its id, which the refusal hands over.
		f.state.hook = async name =>
			name === "list_windows"
				? reply({
						windows: [
							{ ...ghost(52, 122), title: "Ghost" },
							{ ...ghost(51, 69), title: "Ghost" },
							{ ...f.row, window_id: 12360, title: "Notes.txt" },
						],
						accessibility_windows: {
							pid: 101,
							complete: true,
							windows: [{ window_id: 12360, role: "AXWindow" }],
						},
					})
				: undefined;
		await expect(f.session.window(f.context, { app: "Fixture", title: "Ghost" })).rejects.toThrow(
			'1 accessibility window, none of them among the 2 this selector matched; every input route to them is refused. Acquire one of its accessibility windows by id instead: [12360] "Notes.txt".',
		);
		// An AX-backed row among the ghosts is simply the one acquisition takes.
		await expect(f.session.window(f.context, { app: "Fixture" })).resolves.toMatchObject({
			id: "12360",
			axBacked: true,
		});
	} finally {
		await f.close();
	}
});

it("prefers the app's own main window over stacking order and demotes a minimized one", async () => {
	const f = await fixture();
	try {
		f.state.hook = async name =>
			name === "list_windows"
				? reply({
						windows: [
							{ ...f.row, window_id: 8, title: "", z_index: 30 },
							{ ...f.row, window_id: 9, title: "", z_index: 10 },
						],
						accessibility_windows: {
							pid: 101,
							complete: true,
							windows: [
								{ window_id: 8, role: "AXWindow", minimized: true },
								{ window_id: 9, role: "AXWindow", main: true },
							],
						},
					})
				: undefined;
		// Photos' main window carries no title, so `main` is the only evidence
		// that separates it from the minimized window stacked above it.
		expect(await f.session.window(f.context, { app: "Fixture" })).toMatchObject({ id: "9", main: true });
	} finally {
		await f.close();
	}
});

it("marks the rows of a listed process that no accessibility window claims", async () => {
	const f = await fixture();
	try {
		f.state.hook = async (name, args) =>
			name === "list_windows"
				? reply({
						windows: [{ ...f.row, window_id: 52, title: "" }, f.row],
						...(args.include_accessibility_metadata
							? {
									accessibility_windows: {
										pid: 101,
										complete: true,
										windows: [{ window_id: 1, role: "AXWindow" }],
									},
								}
							: {}),
					})
				: undefined;
		expect(await f.session.windows(f.context, { app: "Fixture" })).toMatchObject([
			{ id: "52", axBacked: false },
			{ id: "1", axBacked: true },
		]);
		// A roster spanning processes is listed as it comes: the answer costs a
		// call per pid and the listing is the cheap read.
		f.state.hook = async name =>
			name === "list_windows" ? reply({ windows: [f.row, { ...f.row, pid: 102, window_id: 2 }] }) : undefined;
		const across = await f.session.windows(f.context);
		expect(across.map(window => window.axBacked)).toEqual([undefined, undefined]);
		expect(f.calls.filter(call => call.args.include_accessibility_metadata === true)).toHaveLength(1);
	} finally {
		await f.close();
	}
});

it("names the launch option and each candidate's document when acquisition resolves no window", async () => {
	const f = await fixture();
	try {
		// Nothing matched: an app selector can be launched in the same call, an
		// exact identity cannot. Neither sends the caller to `windows()` — the
		// runtime appends that roster to the miss it reports.
		await expect(f.session.window(f.context, { app: "Absent" })).rejects.toThrow(
			'If "Absent" is not running yet, launch and acquire it in one call with computer.window({"app":"Absent"}, { launch: true })',
		);
		const exact = await f.session.window(f.context, { id: "7", pid: 101 }).catch((error: unknown) => error);
		if (!(exact instanceof Error)) throw new Error("Expected an exact-identity miss to fail");
		expect(exact.message).toBe('Missing computer window {"id":"7","pid":101}: nothing matches it.');
		// Two restored documents of one app share its name, so the file each
		// window reported when it was last observed is what tells them apart. A
		// window never observed carries no path, and nothing is invented for it.
		f.state.hook = async (name, args) => {
			if (name === "list_windows") return reply({ windows: [f.row, { ...f.row, window_id: 2 }] });
			if (name !== "get_window_state") return undefined;
			return reply({
				pid: f.row.pid,
				window_id: args.window_id,
				snapshot_id: "s-doc",
				elements: [],
				document_path: "file:///Users/will/Desktop/Project%20File%20List.workflow",
			});
		};
		await f.session.observe(f.context, f.window, { screenshot: false });
		const failure = await f.session
			.window(f.context, { app: "Fixture" }, { ambiguous: "throw" })
			.catch((error: unknown) => error);
		const message = (failure as Error).message;
		expect(message).toContain(
			'- id "1" pid 101 Fixture "Editor" 200×100 at (10,20) document=file:///Users/will/Desktop/Project%20File%20List.workflow',
		);
		expect(message.endsWith('- id "2" pid 101 Fixture "Editor" 200×100 at (10,20)')).toBe(true);
	} finally {
		await f.close();
	}
});

it("rejects mismatched or malformed accessibility identities instead of choosing a window", async () => {
	const f = await fixture();
	try {
		for (const metadata of [
			{ pid: 999, complete: true, windows: [{ window_id: 1, role: "AXWindow" }] },
			{ pid: 101, complete: true, windows: [{ window_id: 1.5, role: "AXWindow" }] },
			{ pid: 101, complete: true, windows: [{ window_id: 1, role: "AXButton" }] },
		]) {
			f.state.hook = async name =>
				name === "list_windows"
					? reply({ windows: [f.row, { ...f.row, window_id: 2 }], accessibility_windows: metadata })
					: undefined;
			await expect(f.session.window(f.context, { app: "Fixture" })).rejects.toThrow(/Mismatched|Malformed/);
		}
	} finally {
		await f.close();
	}
});

it("does not resolve across processes or retarget after the requested window disappears", async () => {
	const f = await fixture();
	try {
		f.state.hook = async (name, args) => {
			if (name !== "list_windows") return undefined;
			if (args.include_accessibility_metadata) throw new Error("Must not ask one process to resolve another");
			return reply({ windows: [f.row, { ...f.row, pid: 102, window_id: 2 }] });
		};
		await expect(f.session.window(f.context, { app: "Fixture" }, { ambiguous: "throw" })).rejects.toThrow(
			"Ambiguous",
		);
		f.state.hook = async (name, args) =>
			name === "list_windows"
				? reply({
						windows: args.include_accessibility_metadata
							? [{ ...f.row, window_id: 3, title: "Replacement" }]
							: [f.row, { ...f.row, window_id: 2 }],
						accessibility_windows: { pid: 101, complete: true, windows: [{ window_id: 3, role: "AXWindow" }] },
					})
				: undefined;
		await expect(f.session.window(f.context, { app: "Fixture", title: "Editor" })).rejects.toThrow("Missing");
	} finally {
		await f.close();
	}
});

it("keeps frame changes on the retained window despite extra identity fields", async () => {
	const f = await fixture();
	const sibling = { ...f.row, window_id: 2, pid: 102, bounds: { x: 400, y: 20, width: 200, height: 100 } };
	const siblingBounds = { ...sibling.bounds };
	try {
		f.state.hook = async (name, args) => {
			if (name === "list_windows") return reply({ windows: [f.row, sibling] });
			if (name !== "set_window_frame") return undefined;
			const target = [f.row, sibling].find(row => row.pid === args.pid && row.window_id === args.window_id);
			if (!target) throw new Error("Unknown fixture window");
			target.bounds = {
				x: Number(args.x),
				y: Number(args.y),
				width: Number(args.width),
				height: Number(args.height),
			};
			return reply({ effect: "unverifiable" });
		};
		const frame = { x: 30, y: 40, width: 300, height: 400, pid: sibling.pid, window_id: sibling.window_id };
		await f.session.setFrame(f.context, f.window, frame);
		expect((await f.session.window(f.context, { id: "1", pid: 101 })).bounds).toEqual({
			x: 30,
			y: 40,
			width: 300,
			height: 400,
		});
		expect((await f.session.window(f.context, { id: "2", pid: 102 })).bounds).toEqual(siblingBounds);
	} finally {
		await f.close();
	}
});

it("observes semantics without images and preserves raw empty values and false states", async () => {
	const f = await fixture();
	try {
		const observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]).toMatchObject({
			value: "",
			placeholder: "Hint, not value",
			enabled: false,
			selected: false,
		});
		expect(observation.tree).toContain('value="" placeholder="Hint, not value" enabled=false selected=false');
		expect(observation.elements[0]!.label).toBe("Editor");
		expect(observation.complete).toBe(false);
		expect(f.calls.find(call => call.name === "get_window_state")?.args.include_screenshot).toBe(false);
		expect(f.images).toHaveLength(0);
		await f.session.setValue(f.context, f.window, observation.elements[0]!.ref, "");
		expect(f.lastDispatch()).toEqual({
			name: "set_value",
			args: {
				pid: 101,
				window_id: 1,
				element_token: "s1:1",
				snapshot_id: "s1",
				value: "",
				detect_window_change: false,
			},
		});
	} finally {
		await f.close();
	}
});

it("never calls a budget-capped tree complete without the walker's own verdict", async () => {
	const f = await fixture({ platform: "linux" });
	try {
		// What a capped walk reports: returned === total, because both count the
		// nodes it reached. The request itself is the reason it cannot be proof.
		expect((await f.session.observe(f.context, f.window, { maxElements: 1 })).complete).toBe(false);
		expect((await f.session.observe(f.context, f.window)).complete).toBe(true);
		// A walker that states its verdict is believed either way.
		f.state.truncated = false;
		expect((await f.session.observe(f.context, f.window, { maxElements: 1 })).complete).toBe(true);
		f.state.truncated = true;
		expect((await f.session.observe(f.context, f.window)).complete).toBe(false);
	} finally {
		await f.close();
	}
});

/**
 * The reply NotesTask's dry run got from the real driver: a Notes list of 81
 * rows, 12 of them on screen, the rest skipped by the walker. Trimmed to the
 * two indexed rows either side of the collapsed-row line plus one unindexed
 * child, at the indents and depths the driver reported.
 */
const NOTES_COLLAPSED = {
	markdown: [
		"- [49] AXOutline [id=ICMNoteList actions=[showmenu]]",
		"          - [50] AXCell [id=ICMNoteListCell actions=[showmenu]]",
		'            - AXStaticText = "Meeting 070"',
		"      - 69 of 81 rows are scrolled out of view and were not read",
		"      - [51] AXButton [actions=[press]]",
	].join("\n"),
	elements: [
		{
			element_index: 50,
			element_token: "s1:50",
			role: "AXCell",
			label: "ICMNoteListCell",
			actions: ["AXShowMenu"],
			depth: 5,
		},
		{ element_index: 51, element_token: "s1:51", role: "AXButton", label: "", actions: ["AXPress"], depth: 3 },
	],
};

it("keeps the walker's collapsed-row line under its own container and states the total", async () => {
	const f = await fixture();
	let collapsed = 69;
	try {
		f.state.hook = async name =>
			name === "get_window_state"
				? reply({
						pid: 101,
						window_id: 1,
						snapshot_id: "s1",
						truncated: true,
						elements: NOTES_COLLAPSED.elements,
						tree_markdown: NOTES_COLLAPSED.markdown,
						...(collapsed ? { collapsed_rows: collapsed } : {}),
					})
				: undefined;
		const observation = await f.session.observe(f.context, f.window);
		const lines = observation.tree.split("\n");
		const cell = lines.findIndex(line => line.includes("AXCell"));
		expect(lines[cell + 1]).toBe("      - 69 of 81 rows are scrolled out of view and were not read");
		expect(lines[cell + 2]).toContain("AXButton");
		// No search field in this tree, so the footer names the one route it has.
		expect(observation.tree).toContain(
			"69 row(s) are scrolled out of view and were not read. Scroll the list to reach them.",
		);
		// A skipped row is a clipped walk, whatever the element counts say.
		expect(observation.complete).toBe(false);
		// Nothing was skipped: neither surface says anything about scrolling.
		collapsed = 0;
		const whole = await f.session.observe(f.context, f.window);
		expect(whole.tree).not.toContain("scrolled out of view");
		// A search field in the same tree is the cheaper route, and this
		// observation is the only thing that can name the ref it minted for it.
		collapsed = 69;
		let enabled = true;
		f.state.hook = async name =>
			name === "get_window_state"
				? reply({
						pid: 101,
						window_id: 1,
						snapshot_id: "s2",
						truncated: true,
						elements: [
							...NOTES_COLLAPSED.elements,
							{
								element_index: 52,
								element_token: "s2:52",
								role: "AXTextField",
								subrole: "AXSearchField",
								label: "Search",
								enabled,
								depth: 2,
							},
						],
						tree_markdown: NOTES_COLLAPSED.markdown,
						collapsed_rows: collapsed,
					})
				: undefined;
		const searchable = await f.session.observe(f.context, f.window);
		const field = searchable.elements.at(-1)!.ref;
		expect(searchable.tree).toContain(
			`69 row(s) are scrolled out of view and were not read. Scroll the list, or narrow it with this window's own search field: win.ref("${field}").type("<query>").`,
		);
		// The same control on a window that is not key reads back disabled, and
		// the write it would take is refused — so it is not a route either.
		enabled = false;
		expect((await f.session.observe(f.context, f.window)).tree).toContain(
			"69 row(s) are scrolled out of view and were not read. Scroll the list to reach them.",
		);
	} finally {
		await f.close();
	}
});

it("speaks each backend's own key vocabulary instead of forwarding the caller's", async () => {
	for (const platform of ["darwin", "linux"] as const) {
		const f = await fixture({ platform });
		const mac = platform === "darwin";
		try {
			// An unknown modifier is not refused on the macOS keystroke path: it is
			// dropped and the base key types on its own.
			await f.session.press(f.context, f.window, "super+a", undefined, { delivery: "foreground" });
			expect(f.lastDispatch()).toMatchObject({ name: "hotkey", args: { keys: [mac ? "cmd" : "super", "a"] } });
			await f.session.press(f.context, f.window, "Cmd+Shift+D", undefined, { delivery: "foreground" });
			expect(f.lastDispatch()).toMatchObject({
				name: "hotkey",
				args: { keys: [mac ? "Cmd" : "super", "Shift", "D"] },
			});
			await f.session.press(f.context, f.window, ["ArrowDown"], undefined, { delivery: "foreground" });
			expect(f.lastDispatch()).toMatchObject({ name: "press_key", args: { key: "down" } });
			// Names the driver already knows are passed through untouched.
			await f.session.press(f.context, f.window, "Return", undefined, { delivery: "foreground" });
			expect(f.lastDispatch()).toMatchObject({ name: "press_key", args: { key: "Return" } });
		} finally {
			await f.close();
		}
	}
});

it("preserves absent and whitespace values independently from provider placeholder text", async () => {
	const f = await fixture();
	try {
		f.state.value = undefined;
		let observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]).toMatchObject({ label: "Editor", placeholder: "Hint, not value" });
		expect(observation.elements[0]!.value).toBeUndefined();
		expect(observation.tree).not.toContain(" value=");
		f.state.value = " \tΩ café\n";
		f.state.placeholder = 'Hint "quoted" Ω';
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.value).toBe(f.state.value);
		expect(observation.elements[0]!.placeholder).toBe(f.state.placeholder);
		expect(observation.tree).toContain(
			`value=${JSON.stringify(f.state.value)} placeholder=${JSON.stringify(f.state.placeholder)}`,
		);
		f.state.placeholder = undefined;
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.placeholder).toBeUndefined();
		expect(observation.tree).not.toContain(" placeholder=");
	} finally {
		await f.close();
	}
});

it("renders provider help and description when the row carries them", async () => {
	const f = await fixture();
	try {
		// Neither field is guaranteed: an older driver omits both keys.
		let observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.help).toBeUndefined();
		expect(observation.elements[0]!.description).toBeUndefined();
		expect(observation.tree).not.toContain(" help=");
		expect(observation.tree).not.toContain(" description=");
		f.state.help = 'Send the "draft" Ω';
		f.state.description = "Compose button";
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]).toMatchObject({ help: f.state.help, description: f.state.description });
		expect(observation.tree).toContain(
			`description=${JSON.stringify(f.state.description)} help=${JSON.stringify(f.state.help)}`,
		);
		// A provider that says "none" with an empty string, and a description
		// that only repeats the label, add nothing to the line.
		f.state.help = "";
		f.state.description = "Editor";
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.help).toBeUndefined();
		expect(observation.elements[0]!.description).toBeUndefined();
		expect(observation.tree).not.toContain(" help=");
		expect(observation.tree).not.toContain(" description=");
	} finally {
		await f.close();
	}
});

it("names the menu route when the driver refuses an action on a menu bar row", async () => {
	const f = await fixture();
	const refusal = {
		text: 'refusing AXPress: the target reports AXEnabled=false. Retry this action with delivery_mode:"foreground" or call bring_to_front first',
		structuredJson: JSON.stringify({ error: "ax_action_refused" }),
		isError: true,
		errorCode: "ax_action_refused",
		images: [],
	};
	const refused = async (action: Promise<unknown>): Promise<string> => {
		try {
			await action;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		throw new Error("Expected the driver refusal to surface");
	};
	try {
		f.state.role = "AXMenuBarItem";
		f.state.label = "File";
		// A menu bar row only has a ref at all when the observation asked for one.
		const menuBarRef = (await f.session.observe(f.context, f.window, { menubar: true })).elements[0]!.ref;
		f.state.hook = async name => (name === "click" ? refusal : undefined);
		const failure = await refused(f.session.perform(f.context, f.window, menuBarRef, "press"));
		// The driver's own refusal survives in front of the route it cannot name.
		expect(failure).toContain("refusing AXPress: the target reports AXEnabled=false");
		expect(failure).toContain("That ref is a AXMenuBarItem");
		expect(failure).toContain('win.menu(["File", "<item>"], { delivery: "foreground" })');
		// An ordinary control's refusal is left exactly as the driver wrote it.
		f.state.role = "AXTextField";
		f.state.label = "Editor";
		const ordinaryRef = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		const plain = await refused(f.session.click(f.context, f.window, ordinaryRef));
		expect(plain).toContain("refusing AXPress");
		expect(plain).not.toContain("win.menu");
	} finally {
		await f.close();
	}
});

it("keeps the menu bar out of observations and names the route that drives it", async () => {
	const f = await fixture();
	const elements = [
		{ element_index: 1, element_token: "s:1", role: "AXWindow", label: "Editor", depth: 0 },
		{ element_index: 2, element_token: "s:2", role: "AXMenuBar", label: "", depth: 1 },
		{
			element_index: 3,
			element_token: "s:3",
			role: "AXMenuBarItem",
			label: "File",
			depth: 2,
			enabled: true,
			actions: ["press"],
		},
		{ element_index: 4, element_token: "s:4", role: "AXMenu", label: "", depth: 3 },
		{ element_index: 5, element_token: "s:5", role: "AXButton", label: "Save", depth: 1 },
	];
	try {
		f.state.hook = async name =>
			name === "get_window_state"
				? reply({ pid: 101, window_id: 1, snapshot_id: "s", truncated: false, elements })
				: undefined;
		const hidden = await f.session.observe(f.context, f.window);
		expect(hidden.elements.map(element => element.role)).toEqual(["AXWindow", "AXButton"]);
		// The whole subtree goes, not just the rows that carry the role.
		expect(hidden.tree).not.toContain("AXMenu");
		expect(hidden.tree).toContain("Menu bar hidden (3 rows)");
		expect(hidden.tree).toContain('win.menu(["<menu>", "<item>"], { delivery: "foreground" })');
		// No ref is spent on a row that was never published.
		expect(hidden.elements.map(element => element.ref)).toEqual(["n1", "n2"]);
		const shown = await f.session.observe(f.context, f.window, { menubar: true });
		expect(shown.elements.map(element => element.role)).toEqual([
			"AXWindow",
			"AXMenuBar",
			"AXMenuBarItem",
			"AXMenu",
			"AXButton",
		]);
		expect(shown.tree).not.toContain("Menu bar hidden");
		expect(shown.complete).toBe(true);
	} finally {
		await f.close();
	}
});

/**
 * Contacts' own menu bar as cua-driver 0.28.0 renders it (trimmed), recorded
 * from `get_window_state` on pid 95531. The rows without an element index are
 * the ones a closed menu reports disabled: `New Card` — the item the bench
 * was reaching for — is one of them, so it is in this markdown and in no
 * `elements[]` array.
 */
const CONTACTS_MENU_BAR = `- [1] AXWindow "Contacts"
  - [2] AXButton "Edit" [actions=[press]]
- [703] AXMenuBar [id=_NS:722 actions=[cancel]]
  - [704] AXMenuBarItem "Apple" [actions=[cancel,press,pick]]
    - [705] AXMenu [actions=[cancel]]
      - [706] AXMenuItem "About This Mac" [id=_aboutThisMacRequested: actions=[cancel,press,pick]]
  - [707] AXMenuBarItem "Contacts" [id=_NS:726 actions=[cancel,press,pick]]
    - [708] AXMenu [id=_NS:730 actions=[cancel]]
      - AXMenuItem "Show All"
      - [709] AXMenuItem "Quit Contacts" [id=_NS:249 actions=[cancel,press,pick]]
  - [710] AXMenuBarItem "File" [id=_NS:760 actions=[cancel,press,pick]]
    - [711] AXMenu [id=_NS:764 actions=[cancel]]
      - AXMenuItem "New Card"
      - AXMenuItem "New List"
      - AXMenuItem "Close"
      - [712] AXMenuItem "Close All" [id=closeAll: actions=[cancel,press,pick]]
      - [713] AXMenuItem "Import…" [id=_NS:333 actions=[cancel,press,pick]]
      - [714] AXMenuItem "Export" [id=_NS:770 actions=[cancel,press,pick]]
        - [715] AXMenu [id=_NS:774 actions=[cancel]]
      - AXMenuItem "Print…"
  - [716] AXMenuBarItem "Window" [id=_NS:835 actions=[cancel,press,pick]]
    - [717] AXMenu [id=_NS:839 actions=[cancel]]
      - AXMenuItem "Minimize"

AX tree reached its element/depth limit (2000 nodes, depth 3). This is partial state; omitted controls and values remain unknown.`;

it("names the menus and the matched menu's items when a menu path is refused", async () => {
	const f = await fixture();
	/** The driver's own refusal envelope, and the rendered tree it refused against. */
	const refuses = (message: string, markdown = CONTACTS_MENU_BAR): void => {
		f.state.hook = async name =>
			name === "invoke_menu"
				? {
						text: message,
						structuredJson: JSON.stringify({
							status: "refused",
							refusal: { code: "menu_path_unavailable", message },
						}),
						isError: true,
						images: [],
					}
				: name === "get_window_state"
					? reply({ pid: 101, window_id: 1, snapshot_id: "s", elements: [], tree_markdown: markdown })
					: undefined;
	};
	const refused = async (path: string[]): Promise<string> => {
		try {
			await f.session.menu(f.context, f.window, path, { delivery: "foreground" });
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		throw new Error("Expected the menu refusal to surface");
	};
	try {
		// A ref held across the refusal stays live: naming the menus reads the
		// rendered tree and mints nothing.
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		refuses("invoke_menu: path segment 1 was not found");
		const missing = await refused(["File", "New Contact"]);
		// The driver's own refusal survives in front of what it could not name.
		expect(missing).toContain("invoke_menu: path segment 1 was not found");
		expect(missing).toContain('Menu path ["File","New Contact"] has no "New Contact" under File.');
		expect(missing).toContain("Menus: Apple · Contacts · File · Window.");
		expect(missing).toContain("File: New Card · New List · Close · Close All · Import… · Export · Print….");
		expect(missing).toContain("matched exactly");
		expect(f.session.element(ref).ref).toBe(ref);
		// Pixels are never captured for a listing, and the walk stays shallow:
		// the menu bar is the walker's last sibling, so a deeper request spends
		// the budget inside the window and loses the bar itself.
		expect(f.calls.filter(call => call.name === "get_window_state").at(-1)!.args).toMatchObject({
			include_accessibility_tree: true,
			include_screenshot: false,
			max_depth: 3,
		});
		// A top-level miss has only the menu bar to report.
		refuses("invoke_menu: path segment 0 was not found");
		const unknownMenu = await refused(["Contact", "New Card"]);
		expect(unknownMenu).toContain('Menu path ["Contact","New Card"] has no "Contact" in the menu bar.');
		expect(unknownMenu).not.toContain("New Card ·");
		// Two items of one menu share a title: the listing shows both.
		refuses(
			"invoke_menu: path segment 1 is ambiguous",
			CONTACTS_MENU_BAR.replace('AXMenuItem "New List"', 'AXMenuItem "New Card"'),
		);
		expect(await refused(["File", "New Card"])).toContain(
			'Menu path ["File","New Card"] matches more than one "New Card" under File.',
		);
		// A refusal whose reason is not a path segment is left exactly as
		// written, and costs no walk.
		const walks = f.calls.filter(call => call.name === "get_window_state").length;
		refuses("invoke_menu: target exposes no AXMenuBar");
		const noBar = await refused(["File", "New Card"]);
		expect(noBar).toContain("invoke_menu: target exposes no AXMenuBar");
		expect(noBar).not.toContain("Menus:");
		expect(f.calls.filter(call => call.name === "get_window_state").length).toBe(walks);
	} finally {
		await f.close();
	}
});

/**
 * Nothing in the vendored contract returns an open menu's items: a submenu as
 * the final segment gets `AXPress` (`choose_action(final_segment=true)`) and
 * the reply is one sentence, so the bench guessed leaf names blind. Both
 * shapes of the field are consumed here — the listing a resolved submenu
 * answers with, and the candidates a refused segment names — and neither is
 * required: without them the rendered menu bar stays the source.
 */
it("reads a submenu's items instead of pressing it, from either shape the driver reports", async () => {
	const f = await fixture();
	const items = [
		{ title: "Phone", enabled: true },
		{ title: "Email", enabled: true, shortcut: "⌘E" },
		{ title: "Related People", enabled: true, has_submenu: true },
		{ title: "Job Title", enabled: false },
	];
	try {
		f.state.hook = async name =>
			name === "invoke_menu" ? reply({ items, resolved_path: ["Card", "Add Field"] }, []) : undefined;
		const listed = await f.session.menu(f.context, f.window, ["Card", "Add Field"], { delivery: "foreground" });
		expect(listed.text).toBe(
			'Card › Add Field is a submenu; nothing was invoked. Its items: Phone · Email (⌘E) · Related People › · Job Title (disabled). Invoke one with win.menu(["Card","Add Field","Phone"], { delivery: "foreground" }); a name marked › lists its own items the same way.',
		);
		// A leaf segment still invokes, and its reply is the driver's own.
		f.state.hook = undefined;
		const invoked = await f.session.menu(f.context, f.window, ["Card", "Add Field", "Phone"], {
			delivery: "foreground",
		});
		expect(invoked.text).toContain("SDK response");
		// The refusal path prefers the driver's own listing over a tree walk.
		f.state.hook = async name =>
			name === "invoke_menu"
				? {
						text: "invoke_menu: path segment 2 was not found",
						structuredJson: JSON.stringify({
							status: "refused",
							refusal: {
								code: "menu_path_unavailable",
								message: "invoke_menu: path segment 2 was not found",
								failed_segment: 2,
								items,
							},
						}),
						isError: true,
						images: [],
					}
				: undefined;
		const walks = f.calls.filter(call => call.name === "get_window_state").length;
		await expect(
			f.session.menu(f.context, f.window, ["Card", "Add Field", "Job Ttile"], { delivery: "foreground" }),
		).rejects.toThrow(
			'Menu path ["Card","Add Field","Job Ttile"] has no "Job Ttile" under Card › Add Field. Card › Add Field: Phone · Email (⌘E) · Related People › · Job Title (disabled). Segment titles are matched exactly.',
		);
		expect(f.calls.filter(call => call.name === "get_window_state").length).toBe(walks);
	} finally {
		await f.close();
	}
});

it("says a drag was delivered without evidence and keeps the doubt on the window", async () => {
	const f = await fixture();
	try {
		await f.session.captureWindow(f.context, f.window);
		// The vendored driver's drag reply: no evidence block, no effect verdict.
		const unprobed = await f.session.drag(f.context, f.window, [0, 0], [100, 0], { delivery: "foreground" });
		expect(unprobed.text).toContain(
			"Delivered; the driver reported no effect evidence for this drag — observe the window to confirm it moved anything.",
		);
		expect((await f.session.observe(f.context, f.window)).tree).toContain(
			"a drag was delivered with no effect reported — re-read this window before building on it",
		);
		// Once the driver's probe covers drag, its own verdict is the whole answer.
		f.state.hook = async name =>
			name === "drag"
				? reply({
						effect: "no_observed_change",
						evidence: [{ kind: "observed_change", signal: "window_tree" }],
						route: "cgevent",
						delivery: "foreground",
					})
				: undefined;
		const probed = await f.session.drag(f.context, f.window, [0, 0], [100, 0], { delivery: "foreground" });
		expect(probed.effect).toBe("no_observed_change");
		expect(probed.text).not.toContain("no effect evidence");
	} finally {
		await f.close();
	}
});

it("composes one sentence for each thing a write turns out to be", async () => {
	const f = await fixture();
	try {
		let ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		const write = async (data: Wire, text: string) => {
			const structuredJson = JSON.stringify(wireResult(data));
			f.state.hook = async name =>
				name === "set_value" ? { text, structuredJson, isError: false, images: [] } : undefined;
			return f.session.setValue(f.context, f.window, ref, "Project_File_List");
		};
		const typed = async (data: Wire, text: string) => {
			const structuredJson = JSON.stringify(wireResult(data));
			f.state.hook = async name =>
				name === "type_text" ? { text, structuredJson, isError: false, images: [] } : undefined;
			return f.session.type(f.context, f.window, "Project_File_List", ref);
		};
		const reread = async () => {
			const observation = await f.session.observe(f.context, f.window);
			ref = observation.elements[0]!.ref;
			return observation.tree;
		};
		const readBack = [{ kind: "value_readback" }];
		// Proven: the verdict, a confirmed effect, the driver's own read-back and
		// no better route. Nothing is left to say and nothing is carried.
		const proven = await write(
			{ committed: "committed", effect: "confirmed", evidence: readBack },
			"✅ Set AXValue on [1] AXTextField. Committed via tab.",
		);
		expect(proven.text).toBe("✅ Set AXValue on [1] AXTextField. Committed via tab.");
		expect(await reread()).not.toContain("setValue on");
		// Discarded: the app's own reason, and the one rung where re-reading the
		// field is the wrong instruction.
		const lost = await write(
			{ committed: "not_committed", effect: "confirmed" },
			"📨 Sent (unverified) AXValue on [1] AXTextArea. Not committed: a multi-line AXTextArea has no end-of-edit gesture, so the app may never register the write.",
		);
		expect(lost.text.split("\n").at(-1)).toBe(
			`setValue on ${ref} AXTextField "Editor": not committed — a multi-line AXTextArea has no end-of-edit gesture, so the app may never register the write. The app kept its own value; write it another way.`,
		);
		await reread();
		const bare = await write(
			{ committed: "not_committed", effect: "confirmed" },
			"📨 Sent (unverified) AXValue on [1] AXTextField.",
		);
		expect(bare.text).toContain("not committed — the driver reported no reason.");
		await reread();
		// Echoed but unproven on a binding field: the gesture that would commit
		// it, never a re-read — re-reading returns the same echo.
		const echoed = await write(
			{ committed: "unproven", effect: "confirmed", evidence: readBack },
			"✅ Set AXValue on [1] AXTextField. Commit unproven: the value survived AXConfirm, but the app's own model was not observed.",
		);
		expect(echoed.text.split("\n").at(-1)).toBe(
			`setValue on ${ref} AXTextField "Editor": the value reads back as written, but nothing observed the app take it, and this field's app takes its value at end-of-edit — press Tab or Return on it.`,
		);
		expect(echoed.text).not.toContain("re-read");
		await reread();
		const half = await typed(
			{ committed: "unproven", effect: "confirmed", evidence: readBack },
			"✅ Inserted 17 char(s) via CGEvent.",
		);
		expect(half.text.split("\n").at(-1)).toBe(
			`type on ${ref} AXTextField "Editor": the value reads back as written, but this field's app takes its value at end-of-edit, which typing does not deliver — press Tab or Return, or write it with setValue.`,
		);
		// Same verdict on a search field: its value is a query, so the app's own
		// output is what moved, and the field itself proves nothing either way.
		f.state.subrole = "AXSearchField";
		await reread();
		const query = await typed(
			{ committed: "unproven", effect: "confirmed", evidence: readBack },
			"✅ Inserted 17 char(s) via CGEvent.",
		);
		expect(query.text.split("\n").at(-1)).toBe(
			`type on ${ref} AXSearchField "Editor": the value reads back as written, but a read-back is echoed by the control whether or not the app took it — check the app's own output: the rows this query filtered, not the field.`,
		);
		f.state.subrole = undefined;
		await reread();
		// Nothing could read the value: name a witness that can, and never the
		// field, whose re-read is guaranteed to return nothing.
		const unreadable = await write({ effect: "unverifiable", evidence: null }, "✅ Set AXValue on [1] AXSlider.");
		expect(unreadable.text.split("\n").at(-1)).toBe(
			`setValue on ${ref} AXTextField "Editor": the field publishes no readable value, so nothing read this write back — the app's own output is the only witness.`,
		);
		expect(unreadable.text).not.toContain("read the field back");
		await reread();
		const pixels = await write(
			{ effect: "unverifiable", evidence: null, escalation: { reason: "effect_unconfirmed", target: "pixel" } },
			"✅ Set AXValue on [1] AXSlider.",
		);
		expect(pixels.text).toContain("— capture the window and read the value off its own pixels.");
		await reread();
		const snapshot = await write(
			{ effect: "unverifiable", evidence: null, escalation: { reason: "effect_unconfirmed", target: "snapshot" } },
			"✅ Set AXValue on [1] AXSlider.",
		);
		expect(snapshot.text).toContain(
			"— observe() the window and read the control the app updates instead; this field will publish nothing either way.",
		);
		await reread();
		// A verdict with no read-back behind it, and a driver that judges nothing
		// at all: the field can still be read, so reading it is the instruction.
		const unbacked = await write(
			{ committed: "committed", effect: "confirmed" },
			"✅ Set AXValue on [1] AXTextField.",
		);
		expect(unbacked.text.split("\n").at(-1)).toBe(
			`setValue on ${ref} AXTextField "Editor": the driver judged the value committed but nothing in the reply read it back — read the field back before building on it.`,
		);
		await reread();
		const unjudged = await typed({ effect: "confirmed", evidence: readBack }, "✅ Inserted 17 char(s) via CGEvent.");
		expect(unjudged.text.split("\n").at(-1)).toBe(
			`type on ${ref} AXTextField "Editor": nothing in the reply says whether the app kept this value — read the field back before building on it.`,
		);
		// `observed_change` is not a read-back of the value, and its `signal` is
		// carried for the model without a word of prose keyed on it.
		await reread();
		const signalled = await write(
			{
				committed: "committed",
				effect: "confirmed",
				evidence: [{ kind: "observed_change", signal: "element_state" }],
			},
			"✅ Set AXValue on [1] AXTextField.",
		);
		expect(signalled.evidence).toEqual([{ kind: "observed_change", signal: "element_state" }]);
		expect(signalled.text.split("\n").at(-1)).toBe(
			`setValue on ${ref} AXTextField "Editor": the driver judged the value committed but nothing in the reply read it back — read the field back before building on it.`,
		);
		expect(signalled.text).not.toContain("element_state");
	} finally {
		await f.close();
	}
});

it("reads the commit verdict the driver publishes as a string", async () => {
	const f = await fixture();
	try {
		let ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		const write = async (data: Wire, text: string) => {
			f.state.hook = async name =>
				name === "set_value"
					? { text, structuredJson: JSON.stringify(data), isError: false, images: [] }
					: undefined;
			return f.session.setValue(f.context, f.window, ref, "Project_File_List");
		};
		/** Re-reads the window: mints the next ref and spends any carried doubt. */
		const reread = async () => {
			const observation = await f.session.observe(f.context, f.window);
			ref = observation.elements[0]!.ref;
			return observation.tree;
		};
		// The projected `ActionResult` the shipping driver publishes: the verdict
		// is one of three words. Read as a boolean it is always `undefined`, so
		// the doubt fires on every write whatever the driver judged.
		const kept = await write(
			wireResult({ committed: "committed", effect: "confirmed", evidence: [{ kind: "value_readback" }] }),
			"✅ Set AXValue on [1] AXTextField. Committed via tab.",
		);
		expect(kept.committed).toBe("committed");
		expect(await reread()).not.toContain("setValue on");
		const lost = await write(
			wireResult({ committed: "not_committed", effect: "confirmed" }),
			"📨 Sent (unverified) AXValue on [1] AXTextArea. Not committed: a multi-line AXTextArea has no end-of-edit gesture.",
		);
		expect(lost.committed).toBe("not_committed");
		expect(await reread()).toContain("The app kept its own value");
		const unproven = await write(
			wireResult({ committed: "unproven", effect: "confirmed", evidence: [{ kind: "value_readback" }] }),
			"✅ Set AXValue on [1] AXTextField. Commit unproven: the value survived AXConfirm, but the app's own model was not observed.",
		);
		expect(unproven.committed).toBe("unproven");
		expect(await reread()).toContain("takes its value at end-of-edit");
		// Deliberately off the 0.9.0 contract, which publishes neither: the stock
		// 0.28.0 binary judged the same thing with a boolean, whose two states
		// are the two decided verdicts, and a word no contract spells is no
		// verdict at all.
		expect((await write({ committed: true }, "✅ Set AXValue on [1] AXTextField.")).committed).toBe("committed");
		await reread();
		expect((await write({ committed: false }, "📨 Sent (unverified) AXValue on [1] AXTextField.")).committed).toBe(
			"not_committed",
		);
		// A word the contract does not spell is no verdict at all.
		await reread();
		expect((await write({ committed: "maybe" }, "✅ Set AXValue on [1] AXTextField.")).committed).toBeUndefined();
	} finally {
		await f.close();
	}
});

it("carries a write nothing proved into the next observation of its own window", async () => {
	const f = await fixture();
	const observed = async () => (await f.session.observe(f.context, f.window)).elements[0]!.ref;
	const written = (data: Wire) => {
		const payload = wireResult(data);
		f.state.hook = async name => (name === "set_value" ? reply(payload) : undefined);
	};
	try {
		// The graded loss: `setValue` on a Save panel's filename field, chained
		// behind an `observe` in one cell, so the only reply that could have said
		// the app discarded the name was never displayed.
		const dropped = await observed();
		expect(
			(await f.session.setValue(f.context, f.window, dropped, "Project_File_List.txt")).committed,
		).toBeUndefined();
		expect((await f.session.observe(f.context, f.window)).tree.split("\n")[0]).toBe(
			`setValue on ${dropped} AXTextField "Editor": the field publishes no readable value, so nothing read this write back — the app's own output is the only witness.`,
		);
		// Spent by that read: the write it judged is the one this tree shows.
		expect((await f.session.observe(f.context, f.window)).tree).not.toContain("setValue on");
		// Proof is the driver's own verdict on a reply that read the value back
		// and names no better route.
		written({ committed: "committed", effect: "confirmed", evidence: [{ kind: "value_readback" }] });
		expect((await f.session.setValue(f.context, f.window, await observed(), "Project_File_List.txt")).committed).toBe(
			"committed",
		);
		expect((await f.session.observe(f.context, f.window)).tree).not.toContain("setValue on");
		// Proof is exactly the verdict, the effect, the read-back and no better
		// route: a driver that read the value back, called it committed and still
		// names another route has not proven this one.
		written({
			committed: "committed",
			effect: "confirmed",
			evidence: [{ kind: "value_readback" }],
			escalation: { reason: "delivery_failed", target: "foreground" },
		});
		const escalated = await observed();
		await f.session.setValue(f.context, f.window, escalated, "Project_File_List.txt");
		expect((await f.session.observe(f.context, f.window)).tree.split("\n")[0]).toBe(
			`setValue on ${escalated} AXTextField "Editor": the driver judged the value committed but doubts this route landed and names another — read the field back before building on it.`,
		);
		// `type` reports no commit flag at all, and answered `confirmed` for the
		// one write Automator took and for the three it ignored.
		f.state.hook = undefined;
		const typed = await observed();
		await f.session.type(f.context, f.window, "Project_File_List.txt", typed);
		await f.session.type(f.context, f.window, "Project_File_List.txt", typed);
		const carried = await f.session.observe(f.context, f.window);
		expect(carried.tree.split("\n")[0]).toBe(
			`type on ${typed} AXTextField "Editor": the field publishes no readable value, so nothing read this write back — the app's own output is the only witness.`,
		);
		// One sentence per write, however often the same write is repeated.
		expect(carried.tree.split("\n")[1]).toContain("- [n");
		// A partial delivery is the one refusal that still wrote.
		const partial = await observed();
		f.state.hook = async name =>
			name === "type_text"
				? {
						text: "type_text incomplete: delivered 0 of 21 character(s) via CGEvent (30ms delay); retry only the remaining suffix",
						errorCode: "type_text_incomplete",
						isError: true,
						images: [],
					}
				: undefined;
		await expect(f.session.type(f.context, f.window, "Project_File_List.txt", partial)).rejects.toThrow(
			"type_text_incomplete",
		);
		f.state.hook = undefined;
		// The remainder spelled out: the reply's own "retry only the remaining
		// suffix" left the caller to slice by codepoint, and the model retyped
		// the whole string instead.
		expect((await f.session.observe(f.context, f.window)).tree.split("\n")[0]).toBe(
			`type on ${partial} AXTextField "Editor": 0 of 21 characters landed, so the field holds neither its old value nor the one asked for — type only the remainder: "Project_File_List.txt".`,
		);
	} finally {
		await f.close();
	}
});

it("holds an unproven write against its own window and shows it beside that window's pixels", async () => {
	const f = await fixture();
	const second = { ...f.row, window_id: 2, title: "Second" };
	try {
		f.state.hook = async (name, args) => {
			if (name === "list_windows") return reply({ windows: [f.row, second] });
			if (name !== "get_window_state") return undefined;
			return reply(
				{
					pid: 101,
					window_id: args.window_id,
					snapshot_id: `w${String(args.window_id)}`,
					elements: [
						{
							element_index: 1,
							element_token: `w${String(args.window_id)}:1`,
							role: "AXTextField",
							label: "Save as:",
							depth: 0,
						},
					],
					window_bounds: f.row.bounds,
					screenshot_frame_valid: true,
					screenshot_width: 4,
					screenshot_height: 2,
					screenshot_mime_type: "image/png",
				},
				args.include_screenshot ? [{ dataBase64: PNG, mimeType: "image/png" }] : [],
			);
		};
		const other = await f.session.window(f.context, { id: "2", pid: 101 });
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		await f.session.setValue(f.context, f.window, ref, "Project_File_List.txt");
		// Another window's read answers for its own state and carries nothing.
		expect((await f.session.observe(f.context, other)).tree).not.toContain("setValue on");
		f.texts.length = 0;
		await f.session.captureWindow(f.context, other);
		expect(f.texts).toEqual([]);
		// A capture has no text of its own, so the doubt is pushed into the cell.
		await f.session.captureWindow(f.context, f.window);
		expect(f.texts).toEqual([
			`setValue on ${ref} AXTextField "Save as:": the field publishes no readable value, so nothing read this write back — the app's own output is the only witness.`,
		]);
		f.texts.length = 0;
		await f.session.captureWindow(f.context, f.window);
		expect(f.texts).toEqual([]);
		// With this window's pixels in hand, they are the witness the sentence
		// names — the route is read off the session's state, not off a table.
		const captured = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		await f.session.setValue(f.context, f.window, captured, "Project_File_List.txt");
		f.texts.length = 0;
		await f.session.captureWindow(f.context, f.window);
		expect(f.texts).toEqual([
			`setValue on ${captured} AXTextField "Save as:": the field publishes no readable value, so nothing read this write back — capture the window and read the value off its own pixels.`,
		]);
	} finally {
		await f.close();
	}
});

it("names the rung a dispatched action's own escalation points at", async () => {
	const f = await fixture();
	const pressed = async (data: Wire, text: string) => {
		f.state.hook = async name =>
			name === "hotkey" ? { text, structuredJson: JSON.stringify(data), isError: false, images: [] } : undefined;
		return f.session.press(f.context, f.window, "cmd+n");
	};
	try {
		// Recorded from cua-driver 0.28.0: a background chord answers as if it
		// landed and names its route in the structured payload alone. The bench
		// read the sentence, saw no new contact, and never learned the rung.
		const dropped = await pressed(
			{
				delivery: { mode: "background" },
				effect: "unverifiable",
				escalation: { reason: "delivery_failed", target: "foreground" },
				route: "synthetic_events",
			},
			"Pressed cmd+n on pid 101.",
		);
		expect(dropped.text).toContain("Pressed cmd+n on pid 101.");
		expect(dropped.text).toContain("(delivery_failed)");
		expect(dropped.escalation).toBe(
			"⚠️ The driver escalates this action (delivery_failed): re-run it as-is; this window's keystrokes now take the foreground route.",
		);
		expect(dropped.text).not.toContain('{ delivery: "foreground" }');
		expect(dropped.escalation).toBe(dropped.text.split("\n")[1]);
		// The driver's wire vocabulary never survives as advice, and a reply
		// that spells the rung itself is instructing the bypass, so the
		// remembered route corrects it rather than staying quiet. Acquiring the
		// window again is the caller starting over on it, so the rung is the
		// background one this case is about.
		await f.session.acquire(f.context, { id: "1", pid: 101 });
		const named = await pressed(
			{ effect: "unverifiable", escalation: { recommended: "foreground" } },
			'⚠️ Unverified. To deliver a real click, click this control\'s pixel center with delivery_mode:"foreground".',
		);
		expect(named.text).toContain('{ delivery: "foreground" }');
		expect(named.text).not.toContain("delivery_mode");
		expect(named.escalation).toContain("now take the foreground route");
		// A rung this surface cannot type is not turned into advice.
		await f.session.acquire(f.context, { id: "1", pid: 101 });
		const elsewhere = await pressed(
			{ effect: "unverifiable", escalation: { target: "session", reason: "permission_required" } },
			"Pressed cmd+n on pid 101.",
		);
		expect(elsewhere.text.split("\n")[0]).toBe("Pressed cmd+n on pid 101.");
		expect(elsewhere.text).not.toContain("escalates");
		expect(elsewhere.escalation).toBeUndefined();
		// A rung the session cannot take over for the caller still names itself:
		// only a keyboard tool's route is remembered per window.
		f.state.hook = async name =>
			name === "bring_to_front"
				? {
						text: "Raised window 1 on pid 101.",
						structuredJson: JSON.stringify({
							effect: "unverifiable",
							escalation: { reason: "delivery_failed", target: "foreground" },
						}),
						isError: false,
						images: [],
					}
				: undefined;
		const raised = await f.session.raise(f.context, f.window);
		expect(raised.text).toContain('{ delivery: "foreground" }');
		expect(raised.text).not.toContain("now take the foreground route");
		// A rung nothing took over is still not restated when the reply spells it.
		f.state.hook = async name =>
			name === "bring_to_front"
				? {
						text: 'Raised window 1 on pid 101. Re-run with delivery_mode:"foreground" to activate it.',
						structuredJson: JSON.stringify({
							effect: "unverifiable",
							escalation: { reason: "delivery_failed", target: "foreground" },
						}),
						isError: false,
						images: [],
					}
				: undefined;
		expect((await f.session.raise(f.context, f.window)).escalation).toBeUndefined();
	} finally {
		await f.close();
	}
});

it("keeps the foreground route the driver escalated to for that window's keystrokes", async () => {
	const f = await fixture();
	// Recorded shape from the T11 leg: the chord reads as delivered and only
	// the structured payload says the background route dropped it.
	const escalated = {
		text: "Pressed cmd+n on pid 101.",
		structuredJson: JSON.stringify({
			delivery: { mode: "background" },
			effect: "unverifiable",
			escalation: { reason: "delivery_failed", target: "foreground" },
			route: "synthetic_events",
		}),
		isError: false,
		images: [],
	};
	const refused = {
		text: "foreground_unavailable: the target cannot be activated.",
		structuredJson: JSON.stringify({ code: "foreground_unavailable" }),
		isError: true,
		errorCode: "foreground_unavailable",
		images: [],
	};
	try {
		f.state.hook = async name => (name === "hotkey" ? escalated : undefined);
		const first = await f.session.press(f.context, f.window, "cmd+n");
		expect(f.lastDispatch()?.args).toMatchObject({ delivery_mode: "background" });
		expect(first.text).toContain("re-run it as-is; this window's keystrokes now take the foreground route");
		// The escalation attaches to the window, not to the callsite: the next
		// keystroke takes the route the driver named without being told again.
		f.state.hook = undefined;
		const second = await f.session.press(f.context, f.window, "Return");
		expect(f.lastDispatch()).toMatchObject({
			name: "press_key",
			args: { key: "Return", delivery_mode: "foreground" },
		});
		expect(second.text.split("\n")).toContain(
			"delivery: foreground (remembered from the driver's escalation on this window)",
		);
		expect(second.delivery).toBe("foreground");
		// Typing is the same route on the same window.
		await f.session.type(f.context, f.window, "hi");
		expect(f.lastDispatch()).toMatchObject({ name: "type_text", args: { delivery_mode: "foreground" } });
		// An explicit rung still wins — the caller may be testing the one the
		// escalation gave up on.
		const asked = await f.session.press(f.context, f.window, "Return", undefined, { delivery: "background" });
		expect(f.lastDispatch()?.args).toMatchObject({ delivery_mode: "background" });
		expect(asked.text).not.toContain("remembered");
		// A foreground keystroke the driver refuses ends the memory.
		f.state.hook = async name => (name === "press_key" ? refused : undefined);
		await expect(f.session.press(f.context, f.window, "Return")).rejects.toThrow("foreground_unavailable");
		f.state.hook = undefined;
		expect((await f.session.press(f.context, f.window, "Return")).text).not.toContain("remembered");
		expect(f.lastDispatch()?.args).toMatchObject({ delivery_mode: "background" });
		// Acquiring the window again is the caller starting over on it.
		f.state.hook = async name => (name === "hotkey" ? escalated : undefined);
		await f.session.press(f.context, f.window, "cmd+n");
		f.state.hook = undefined;
		const reacquired = await f.session.acquire(f.context, { id: "1", pid: 101 });
		const after = await f.session.press(f.context, reacquired, "Return");
		expect(f.lastDispatch()?.args).toMatchObject({ delivery_mode: "background" });
		expect(after.text).not.toContain("remembered");
	} finally {
		await f.close();
	}
});

const REMEMBERED_ROUTE = "delivery: foreground (remembered from the driver's escalation on this window)";

it("keeps the escalated keyboard route across the rehydration step every prelude window method carries", async () => {
	const f = await fixture();
	const escalated = {
		text: `Pressed cmd+b on pid ${f.row.pid}.`,
		structuredJson: JSON.stringify({
			delivery: { mode: "background" },
			effect: "unverifiable",
			escalation: { reason: "delivery_failed", target: "foreground" },
			route: "synthetic_events",
		}),
		isError: false,
		images: [],
	};
	try {
		const handle = () => f.session.window(f.context, { id: String(f.row.window_id), pid: f.row.pid as number });
		f.state.hook = async name => (name === "hotkey" ? escalated : undefined);
		await f.session.press(f.context, await handle(), "cmd+b");
		expect(f.lastDispatch()?.args).toMatchObject({ delivery_mode: "background" });
		f.state.hook = undefined;
		const second = await f.session.press(f.context, await handle(), "Return");
		expect(f.lastDispatch()).toMatchObject({ name: "press_key", args: { delivery_mode: "foreground" } });
		expect(second.text.split("\n")).toContain(REMEMBERED_ROUTE);
		const typed = await f.session.type(f.context, await handle(), "hi");
		expect(f.lastDispatch()).toMatchObject({ name: "type_text", args: { delivery_mode: "foreground" } });
		expect(typed.text.split("\n")).toContain(REMEMBERED_ROUTE);
	} finally {
		await f.close();
	}
});

it("records the foreground rung of a keyboard escalation the driver spells in prose", async () => {
	const f = await fixture();
	const reply = (escalation: Wire, error?: string) => ({
		text: error ?? `Inserted 2 char(s) into AXTextArea "".`,
		structuredJson: JSON.stringify(
			error === undefined ? { effect: "unverifiable", escalation } : { code: "background_unavailable", escalation },
		),
		isError: error !== undefined,
		...(error === undefined ? {} : { errorCode: "background_unavailable" }),
		images: [],
	});
	try {
		f.state.hook = async name =>
			name === "type_text"
				? reply({
						recommended: "foreground",
						reason:
							'background insert could not be confirmed — re-call with delivery_mode:"foreground" if a screenshot shows the text didn\'t land.',
					})
				: undefined;
		await f.session.type(f.context, f.window, "hi");
		f.state.hook = undefined;
		expect((await f.session.press(f.context, f.window, "Return")).text.split("\n")).toContain(REMEMBERED_ROUTE);
		expect(f.lastDispatch()).toMatchObject({ name: "press_key", args: { delivery_mode: "foreground" } });

		const fresh = await f.session.acquire(f.context, { id: String(f.row.window_id), pid: f.row.pid as number });
		f.state.hook = async name =>
			name === "hotkey"
				? reply(
						{
							recommended: "foreground",
							reason:
								"Screen Sharing does not forward modifier state from background PID-routed base-key events.",
							requires: ["window_id"],
						},
						"Background input refused.",
					)
				: undefined;
		await expect(f.session.press(f.context, fresh, "cmd+b")).rejects.toThrow("background_unavailable");
		f.state.hook = undefined;
		expect((await f.session.press(f.context, fresh, "Return")).text.split("\n")).toContain(REMEMBERED_ROUTE);
		expect(f.lastDispatch()).toMatchObject({ name: "press_key", args: { delivery_mode: "foreground" } });
	} finally {
		await f.close();
	}
});

it("corrects the reply's own instruction to qualify the re-run once the route is remembered", async () => {
	const f = await fixture();
	const instructed = {
		text: '📨 Sent (unverified) 22 char(s) via CGEvent (30ms delay). — driver could not confirm the text landed; verify via screenshot, and re-call with delivery_mode:"foreground" if it didn\'t.',
		structuredJson: JSON.stringify({
			effect: "unverifiable",
			escalation: {
				recommended: "foreground",
				reason:
					'background insert could not be confirmed — re-call with delivery_mode:"foreground" if a screenshot shows the text didn\'t land.',
			},
		}),
		isError: false,
		images: [],
	};
	try {
		f.state.hook = async name => (name === "type_text" ? instructed : undefined);
		const typed = await f.session.type(f.context, f.window, "hi");
		expect(typed.text).toContain('{ delivery: "foreground" }');
		// The reply's own doubt is that it could not confirm the insert, so the
		// correction keeps the read in front of the re-run it un-qualifies.
		expect(typed.text).toContain(
			"the keystrokes may have landed: observe the window first (win.observe()) and only if it shows nothing re-run the action — this window's keystrokes now take the foreground route",
		);
		f.state.hook = undefined;
		const next = await f.session.press(f.context, f.window, "Return");
		expect(f.lastDispatch()).toMatchObject({ name: "press_key", args: { delivery_mode: "foreground" } });
		expect(next.text.split("\n")).toContain(REMEMBERED_ROUTE);
	} finally {
		await f.close();
	}
});

it("forgets the route when the caller's own foreground press is refused, even as the refusal escalates to it", async () => {
	const f = await fixture();
	const refused = {
		text: "Background input refused.",
		structuredJson: JSON.stringify({
			code: "background_unavailable",
			escalation: {
				recommended: "foreground",
				reason: "Screen Sharing does not forward modifier state from background PID-routed base-key events.",
				requires: ["window_id"],
			},
		}),
		isError: true,
		errorCode: "background_unavailable",
		images: [],
	};
	const refuseOnce = () => {
		f.state.hook = async name => (name === "press_key" ? refused : undefined);
	};
	try {
		refuseOnce();
		await expect(f.session.press(f.context, f.window, "Return")).rejects.toThrow("background_unavailable");
		f.state.hook = undefined;
		const remembered = await f.session.press(f.context, f.window, "Return");
		expect(f.lastDispatch()).toMatchObject({ name: "press_key", args: { delivery_mode: "foreground" } });
		expect(remembered.text.split("\n")).toContain(REMEMBERED_ROUTE);

		refuseOnce();
		await expect(
			f.session.press(f.context, f.window, "Return", undefined, { delivery: "foreground" }),
		).rejects.toThrow("background_unavailable");
		f.state.hook = undefined;
		const forgotten = await f.session.press(f.context, f.window, "Return");
		expect(f.lastDispatch()).toMatchObject({ name: "press_key", args: { delivery_mode: "background" } });
		expect(forgotten.text).not.toContain("remembered");
	} finally {
		await f.close();
	}
});

it("names an observe before a screenshot as the check for an unverified dispatch", async () => {
	const f = await fixture();
	try {
		await f.session.observe(f.context, f.window, { screenshot: true, silent: true });
		// The sentence every background CGEvent rung ends with — click, drag
		// and scroll all author it, and a screenshot was the only check it named.
		f.state.hook = async name =>
			name === "click"
				? {
						text: "✅ Posted left-click to pid 101 at (2,0) (background CGEvent; not driver-verified — confirm via screenshot).",
						structuredJson: JSON.stringify({ effect: "unverifiable", route: "cgevent" }),
						isError: false,
						images: [],
					}
				: undefined;
		const clicked = await f.session.click(f.context, f.window, [1, 0]);
		expect(clicked.text).toBe(
			"✅ Posted left-click to pid 101 at (2,0) (background CGEvent; not driver-verified — confirm with observe({ query }) or, on a pixel surface, a screenshot).",
		);
		// The keystroke paths name a screenshot for a field whose AXValue they
		// could not read at all. There a capture really is the only witness, so
		// the check stands and only gains the spelling of the call that takes
		// one — an AX read is exactly what cannot answer it.
		f.state.hook = async name =>
			name === "type_text"
				? {
						text: '📨 Sent (unverified) 2 char(s) via CGEvent (30ms delay). — driver could not confirm the text landed; verify via screenshot, and re-call with delivery_mode:"foreground" if it didn\'t.',
						structuredJson: JSON.stringify({ effect: "unverifiable", route: "cgevent_type" }),
						isError: false,
						images: [],
					}
				: undefined;
		const typed = await f.session.type(f.context, f.window, "hi");
		expect(typed.text.split("\n")[0]).toBe(
			'📨 Sent (unverified) 2 char(s) via CGEvent (30ms delay). — driver could not confirm the text landed; confirm with observe({ screenshot: true }), and re-call with { delivery: "foreground" } if it didn\'t.',
		);
		expect(typed.text).not.toContain("observe({ query })");
	} finally {
		await f.close();
	}
});

it("sends a suspected no-op back to observe before it sends it to pixels", async () => {
	const f = await fixture();
	const suspected = {
		delivery: { mode: "background" },
		effect: "suspected_noop",
		escalation: { reason: "suspected_noop", target: "pixel" },
		route: "accessibility",
	};
	const dispatched = async (text: string) => {
		f.state.hook = async name =>
			name === "hotkey"
				? { text, structuredJson: JSON.stringify(suspected), isError: false, images: [] }
				: undefined;
		return f.session.press(f.context, f.window, "cmd+n");
	};
	try {
		// Recorded from the 09-14 Contacts leg: the press had landed and the
		// menu opened a moment after the driver stopped watching, and the
		// coordinate rung the escalation named is the one Contacts swallows.
		const watched = await dispatched(
			'✅ Performed AXPress on [15] AXMenuButton "".\n⚠️ Unverified: no change observed within 505 ms (element state, app focus, window contents, new windows).',
		);
		expect(watched.text).toContain("(suspected_noop)");
		// No capture of this window is live, and a pixel action refuses before
		// dispatch without one, so the capture is part of the route.
		expect(watched.text).toContain(
			"the driver saw no change within 505 ms — observe() once; if the tree is unchanged, capture the window (observe({ screenshot: true })) and click the control's own centre",
		);
		expect(watched.text.indexOf("observe() once")).toBeLessThan(watched.text.indexOf("capture the window"));
		// A driver that says how long it watched is quoted the same way.
		const settled = await dispatched(
			"⚠️ Unverified: the target was watched for 2000 ms after the dispatch and nothing changed.",
		);
		expect(settled.text).toContain("the driver saw no change within 2000 ms — observe() once");
		// No window in the reply: the doubt is still named, without a number.
		const bare = await dispatched('✅ Performed AXPress on [15] AXMenuButton "".');
		expect(bare.text).toContain("the driver could not confirm this landed — observe() once");
		expect(bare.text).not.toContain(" ms");
		// Once the window has a frame, the click is the whole route: the
		// coordinate it names is already in hand.
		await f.session.observe(f.context, f.window, { screenshot: true, silent: true });
		const captured = await dispatched('✅ Performed AXPress on [15] AXMenuButton "".');
		expect(captured.text).toContain(
			"observe() once; if the tree is unchanged, click the control's own centre in the capture this window already has",
		);
		expect(captured.text).not.toContain("observe({ screenshot: true })");
	} finally {
		await f.close();
	}
});

/** The shape DriverText's type path publishes when no focused text element resolved. */
const BLIND_TYPE = {
	text: "📨 Sent (unverified) 2 char(s) via CGEvent (30ms delay). — no focused text element could be resolved in window 1, so the keystrokes were posted blind and no field can be read back. Address the field itself: pass element_index (or element_token) for it on this call, or use set_value.",
	structuredJson: JSON.stringify({
		delivery: { mode: "background" },
		effect: "unverifiable",
		escalation: { reason: "effect_unconfirmed", target: "element" },
		route: "cgevent_type",
	}),
	isError: false,
	images: [],
};

it("names the field a blind keystroke can be written to, from the observation it holds", async () => {
	const f = await fixture();
	try {
		f.state.hook = async name => (name === "type_text" ? BLIND_TYPE : undefined);
		// No observation of this window yet: the route is real, the ref is not.
		const blind = await f.session.type(f.context, f.window, "hi");
		expect(blind.escalation).toBe(
			"⚠️ The driver escalates this action (effect_unconfirmed): address the field itself — this session holds no text row for window 1, so observe it first and write the row that walk mints.",
		);
		// One enabled text row in hand: the route is a call the caller can type.
		f.state.enabled = true;
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		const known = await f.session.type(f.context, f.window, "hi");
		expect(known.escalation).toBe(
			`⚠️ The driver escalates this action (effect_unconfirmed): address the field itself: win.ref("${ref}").type("<text>") or win.ref("${ref}").setValue("<value>").`,
		);
		// The call already addressed a row, so the route is to write it, not to
		// hunt for it again.
		const addressed = await f.session.type(f.context, f.window, "hi", ref);
		expect(addressed.escalation).toBe(
			`⚠️ The driver escalates this action (effect_unconfirmed): write the field instead of posting keystrokes at it: win.ref("${ref}").setValue("<value>").`,
		);
	} finally {
		await f.close();
	}
});

it("never re-offers the foreground rung a keystroke already took", async () => {
	const f = await fixture();
	// The payload measured on Notes' Find chord: the second press runs on the
	// rung the first one's escalation named, and answers with that same
	// escalation. A table keyed on the target alone replied "re-run it as-is".
	const escalated = {
		text: "Pressed cmd+option+f on pid 101.",
		structuredJson: JSON.stringify({
			delivery: { mode: "background" },
			effect: "unverifiable",
			escalation: { reason: "delivery_failed", target: "foreground" },
			route: "key_events_fg",
		}),
		isError: false,
		images: [],
	};
	const menuBar = [
		{ element_index: 1, element_token: "m:1", role: "AXMenuBar", label: "", depth: 0 },
		{ element_index: 2, element_token: "m:2", role: "AXMenuBarItem", label: "Edit", depth: 1, enabled: true },
		{ element_index: 3, element_token: "m:3", role: "AXMenuBarItem", label: "Format", depth: 1, enabled: true },
	];
	try {
		f.state.hook = async name => (name === "hotkey" ? escalated : undefined);
		const first = await f.session.press(f.context, f.window, "cmd+option+f");
		expect(first.escalation).toBe(
			"⚠️ The driver escalates this action (delivery_failed): re-run it as-is; this window's keystrokes now take the foreground route.",
		);
		// Same reply, now on the foreground rung this session took over.
		const second = await f.session.press(f.context, f.window, "cmd+option+f");
		expect(f.lastDispatch()?.args).toMatchObject({ delivery_mode: "foreground" });
		expect(second.escalation).toBe(
			'⚠️ The driver escalates this action (delivery_failed): the foreground rung already carried these keystrokes and the driver still could not verify them, so re-sending them lands nothing new — observe the window (win.observe()) to read what the keystrokes did — a read changes nothing — or observe({ menubar: true }) and drive the command with win.menu([...], { delivery: "foreground" }).',
		);
		expect(second.escalation).not.toContain("re-run");
		// With this window's own menu bar in hand, the route is the one measured
		// to drive a menu command when its chord does not.
		f.state.hook = async (name, args) => {
			if (name === "hotkey") return escalated;
			return name === "get_window_state" && args.window_id === 1
				? reply({ pid: 101, window_id: 1, snapshot_id: "m", truncated: false, elements: menuBar })
				: undefined;
		};
		await f.session.observe(f.context, f.window, { menubar: true });
		const menu = await f.session.press(f.context, f.window, "cmd+option+f");
		expect(menu.escalation).toBe(
			'⚠️ The driver escalates this action (delivery_failed): the foreground rung already carried these keystrokes and the driver still could not verify them, so re-sending them lands nothing new — drive the command from the menu this window\'s observation carries (Edit · Format): win.menu(["<menu>", "<item>"], { delivery: "foreground" }).',
		);
	} finally {
		await f.close();
	}
});

it("tells a keystroke that may have landed to observe first, and only a failed one to re-run", async () => {
	// T7 `native-act-notes`: contract 0.9.0 defaults an unprobed post to
	// `effect_unconfirmed` instead of `delivery_failed`, so the remembered-route
	// sentence started telling a keystroke that may have landed to re-run
	// itself. The caller's own rule forbids exactly that, and the model read the
	// pair as a contradiction and refused the retry: "the active computer-use
	// constraint prohibits following unverified delivery with foreground input".
	const escalatedFor = async (reason: string) => {
		const f = await fixture();
		try {
			f.state.hook = async name =>
				name === "hotkey"
					? {
							text: "Pressed cmd+option+f on pid 101.",
							structuredJson: JSON.stringify({
								delivery: { mode: "background" },
								effect: "unverifiable",
								escalation: { reason, target: "foreground" },
								route: "key_events_fg",
							}),
							isError: false,
							images: [],
						}
					: undefined;
			return (await f.session.press(f.context, f.window, "cmd+option+f")).escalation;
		} finally {
			await f.close();
		}
	};
	// Nothing went out, so re-running it is the whole advice.
	expect(await escalatedFor("delivery_failed")).toBe(
		"⚠️ The driver escalates this action (delivery_failed): re-run it as-is; this window's keystrokes now take the foreground route.",
	);
	// Delivery is unknown, so the read comes first and the re-run is conditional.
	expect(await escalatedFor("effect_unconfirmed")).toBe(
		"⚠️ The driver escalates this action (effect_unconfirmed): the keystrokes may have landed: observe the window first (win.observe()) and only if it shows nothing re-run the action — this window's keystrokes now take the foreground route.",
	);
});

it("names the menu a keyboard no-op can be driven from, and nothing when none was observed", async () => {
	const f = await fixture();
	// ChordProbe rank 1: the probe reports the chord moved nothing, and the
	// reply names no rung at all — there is none left for a chord.
	const inert = {
		text: "Pressed cmd+option+f on pid 101 (delivery_mode:foreground).",
		structuredJson: JSON.stringify({
			delivery: { mode: "foreground" },
			effect: "suspected_noop",
			route: "key_events_fg",
		}),
		isError: false,
		images: [],
	};
	const menuBar = [
		{ element_index: 1, element_token: "m:1", role: "AXMenuBar", label: "", depth: 0 },
		{ element_index: 2, element_token: "m:2", role: "AXMenuBarItem", label: "Edit", depth: 1, enabled: true },
	];
	try {
		f.state.hook = async name => (name === "hotkey" ? inert : undefined);
		const unobserved = await f.session.press(f.context, f.window, "cmd+option+f", undefined, {
			delivery: "foreground",
		});
		// Nothing in hand but a read, which is the recovery the bench took.
		expect(unobserved.escalation).toBe(
			'⚠️ The driver reports no observed change: the foreground rung already carried these keystrokes and the driver still could not verify them, so re-sending them lands nothing new — observe the window (win.observe()) to read what the keystrokes did — a read changes nothing — or observe({ menubar: true }) and drive the command with win.menu([...], { delivery: "foreground" }).',
		);
		f.state.hook = async (name, args) => {
			if (name === "hotkey") return inert;
			return name === "get_window_state" && args.window_id === 1
				? reply({ pid: 101, window_id: 1, snapshot_id: "m", truncated: false, elements: menuBar })
				: undefined;
		};
		await f.session.observe(f.context, f.window, { menubar: true });
		const observed = await f.session.press(f.context, f.window, "cmd+option+f", undefined, {
			delivery: "foreground",
		});
		expect(observed.escalation).toBe(
			'⚠️ The driver reports no observed change: the foreground rung already carried these keystrokes and the driver still could not verify them, so re-sending them lands nothing new — drive the command from the menu this window\'s observation carries (Edit): win.menu(["<menu>", "<item>"], { delivery: "foreground" }).',
		);
	} finally {
		await f.close();
	}
});

it("never points a keyboard no-op at a disabled row, and offers the rung that lands first", async () => {
	const f = await fixture();
	// T11 `native-act-notes/omp-2`: a background cmd+f moved nothing and the
	// route named this window's own `AXTextField "" subrole=AXSearchField
	// enabled=false`, which answered `type_text_incomplete: delivered 0 of 22`.
	const inert = (mode: "background" | "foreground") => ({
		text: `Pressed cmd+f on pid 101${mode === "foreground" ? " (delivery_mode:foreground)" : ""}.`,
		structuredJson: JSON.stringify({
			delivery: { mode },
			effect: "suspected_noop",
			route: mode === "foreground" ? "key_events_fg" : "key_events",
		}),
		isError: false,
		images: [],
	});
	try {
		f.state.label = "";
		f.state.subrole = "AXSearchField";
		f.state.placeholder = undefined;
		const observation = await f.session.observe(f.context, f.window);
		expect(observation.tree.split("\n")[0]).toBe(
			`- [${observation.elements[0]!.ref}] AXTextField "" subrole=AXSearchField value="" enabled=false selected=false`,
		);
		f.state.hook = async name => (name === "hotkey" ? inert("background") : undefined);
		const background = await f.session.press(f.context, f.window, "cmd+f");
		expect(background.escalation).toBe(
			'⚠️ The driver reports no observed change: these keystrokes went out in the background, which leaves this window not the app\'s key window — re-run with { delivery: "foreground" }, which makes it key first.',
		);
		expect(background.escalation).not.toContain("win.ref");
		// On the rung it named, the disabled row is still no route: a read is.
		f.state.hook = async name => (name === "hotkey" ? inert("foreground") : undefined);
		const spent = await f.session.press(f.context, f.window, "cmd+f", undefined, { delivery: "foreground" });
		expect(spent.escalation).toBe(
			'⚠️ The driver reports no observed change: the foreground rung already carried these keystrokes and the driver still could not verify them, so re-sending them lands nothing new — observe the window (win.observe()) to read what the keystrokes did — a read changes nothing — or observe({ menubar: true }) and drive the command with win.menu([...], { delivery: "foreground" }).',
		);
		expect(spent.escalation).not.toContain("win.ref");
		// An enabled row of the same window is the route it always was.
		f.state.enabled = true;
		const enabled = await f.session.observe(f.context, f.window);
		f.state.hook = async name => (name === "hotkey" ? inert("foreground") : undefined);
		const known = await f.session.press(f.context, f.window, "cmd+f", undefined, { delivery: "foreground" });
		expect(known.escalation).toContain(
			`address the field itself: win.ref("${enabled.elements[0]!.ref}").type("<text>")`,
		);
	} finally {
		await f.close();
	}
});
it("stops naming the foreground rung to an action that already ran on it", async () => {
	const f = await fixture();
	// AdviceMatrix: the AXEnabled refusal and its escalation are byte-identical
	// on both rungs, so the advice names the rung that just answered.
	const unverified = {
		text: "✅ Performed AXPress on [1] AXButton.",
		structuredJson: JSON.stringify({
			effect: "unverifiable",
			escalation: { reason: "effect_unconfirmed", target: "foreground" },
			route: "accessibility",
		}),
		isError: false,
		images: [],
	};
	try {
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		f.state.hook = async name => (name === "click" ? unverified : undefined);
		const background = await f.session.click(f.context, f.window, ref);
		expect(background.escalation).toBe(
			'⚠️ The driver escalates this action (effect_unconfirmed): the route it names is { delivery: "foreground" } — re-run the action that way.',
		);
		const foreground = await f.session.click(f.context, f.window, ref, { delivery: "foreground" });
		expect(foreground.escalation).toBe(
			`⚠️ The driver escalates this action (effect_unconfirmed): this action already ran with { delivery: "foreground" }, so the rung it names is the one that just answered — write the field instead of posting keystrokes at it: win.ref("${ref}").setValue("<value>").`,
		);
	} finally {
		await f.close();
	}
});

for (const failedSwitch of [false, true]) {
	it(`requires a new capture after ${failedSwitch ? "a failed" : "a successful"} switch to another window`, async () => {
		const f = await fixture();
		try {
			const secondRow = { ...f.row, window_id: 2, title: "Second editor" };
			f.state.hook = async (name, args) => {
				if (name === "list_windows") return reply({ windows: [f.row, secondRow] });
				if (name !== "get_window_state") return undefined;
				const row = args.window_id === 1 ? f.row : secondRow;
				const failed = failedSwitch && row.window_id === 2 && args.include_screenshot === true;
				return reply(
					{
						pid: row.pid,
						window_id: row.window_id,
						elements: [],
						window_bounds: row.bounds,
						screenshot_frame_valid: !failed,
						screenshot_width: 4,
						screenshot_height: 2,
					},
					args.include_screenshot && !failed ? [{ dataBase64: PNG, mimeType: "image/png" }] : [],
				);
			};
			const second = await f.session.window(f.context, { id: "2", pid: 101 });
			await f.session.captureWindow(f.context, f.window);
			// An AX-only observation of B leaves A's rendering lease and pixel frame intact.
			await f.session.observe(f.context, second, { screenshot: false });
			await f.session.click(f.context, f.window, [1, 0]);
			if (failedSwitch)
				await expect(f.session.captureWindow(f.context, second)).rejects.toThrow("Screenshot unavailable");
			else await f.session.captureWindow(f.context, second);
			const posted = f.calls.filter(call => call.name === "click").length;
			await expect(f.session.click(f.context, f.window, [1, 0])).rejects.toThrow("StaleFrame");
			expect(f.calls.filter(call => call.name === "click")).toHaveLength(posted);
			if (!failedSwitch) await f.session.click(f.context, second, [1, 0]);
			await f.session.captureWindow(f.context, f.window);
			await f.session.click(f.context, f.window, [100, 0]);
			expect(f.lastDispatch()?.args).toMatchObject({ pid: 101, window_id: 1, x: 2, y: 0 });
			await expect(f.session.click(f.context, second, [1, 0])).rejects.toThrow("StaleFrame");
		} finally {
			await f.close();
		}
	});
}

it("rejects expired public refs, wrong-window refs, and recycled window owners", async () => {
	const f = await fixture();
	try {
		const first = await f.session.observe(f.context, f.window);
		expect(() => f.session.element(first.elements[0]!.ref, { ...f.window, pid: 102 })).toThrow("WrongWindow");
		await f.session.observe(f.context, f.window);
		// Every refusal this session composes carries the payload a guarded
		// dispatch needs: a caught StaleRef used to keep only its message.
		const caught = await f.session
			.click(f.context, f.window, first.elements[0]!.ref)
			.catch((error: unknown) => error);
		if (!(caught instanceof ToolError)) throw new Error("Expected the stale ref");
		expect(caught.message).toStartWith("StaleRef:");
		expect(caught.context).toMatchObject({
			code: "stale_element_ref",
			effect: "not_dispatched",
			ref: first.elements[0]!.ref,
			window_id: "1",
			pid: 101,
		});
		f.row.pid = 102;
		await expect(f.session.type(f.context, f.window, "no")).rejects.toThrow("Missing");
		expect(f.calls.some(call => call.name === "click" || call.name === "type_text")).toBe(false);
	} finally {
		await f.close();
	}
});

it("answers a dead ref with the window's own tree instead of throwing it away", async () => {
	const f = await fixture();
	// T4 `native-act-reminders/omp-2` step 4, verbatim. The cell was
	// `await win.ref('n174').click(); await win.observe();` — the throw
	// discarded the tree and the trailing observe never ran, so the next cell
	// spent itself recovering what this reply already knew.
	const dead = {
		text: "Background input refused (element_outside_target_window): the addressed element could not be proven to belong to window 14229; take a fresh get_window_state snapshot and re-address it",
		structuredJson: JSON.stringify({
			code: "element_outside_target_window",
			effect: "refused",
			escalation: {
				reason:
					"the addressed element could not be proven to belong to window 14229; take a fresh get_window_state snapshot and re-address it",
				recommended: "get_window_state",
			},
			pid: 82791,
			reason:
				"the addressed element could not be proven to belong to window 14229; take a fresh get_window_state snapshot and re-address it",
			window_id: 14229,
		}),
		isError: true,
		errorCode: "element_outside_target_window",
		images: [],
	};
	try {
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		f.state.hook = async name => (name === "click" ? dead : undefined);
		// The row the ref named is not in the window any more under any
		// reference: the app renamed it between the two reads.
		f.state.label = "Editor (renamed)";
		const answered = await f.session.click(f.context, f.window, ref);
		expect(answered.effect).toBe("not_dispatched");
		expect(answered.text.split("\n")[0]).toBe(
			`element_outside_target_window: ${ref} (AXTextField "Editor") no longer exists in window 1 and nothing was dispatched — no row of the fresh tree carries its role and label. ${ref} is retired and the tree below carries this window's new refs — address the row you mean by its new ref.`,
		);
		// The tree is in the reply and in the cell, not only in a return value
		// the cell is free to drop.
		expect(answered.text).toContain("- [n2] AXTextField");
		expect(f.texts.at(-1)).toBe(answered.text);
		// One read, and the refusal's own payload survives on the result.
		expect(f.calls.filter(call => call.name === "get_window_state")).toHaveLength(2);
		expect(answered.data).toMatchObject({ code: "element_outside_target_window", window_id: 14229 });
		// The row the walk just minted is addressable without another observe.
		f.state.hook = undefined;
		expect((await f.session.click(f.context, f.window, "n2")).effect).toBe("unverifiable");
		// A recovery walk that returns no rows has no new ref to hand back, and
		// says so rather than pointing at a tree that is not there.
		const empty = await f.session.acquire(f.context, { id: "1", pid: 101 });
		const gone = (await f.session.observe(f.context, empty)).elements[0]!.ref;
		f.state.hook = async name =>
			name === "click"
				? dead
				: name === "get_window_state"
					? reply({ pid: 101, window_id: 1, snapshot_id: "s9", truncated: false, elements: [] })
					: undefined;
		const nothing = await f.session.click(f.context, empty, gone);
		expect(nothing.text.split("\n")[0]).toBe(
			`element_outside_target_window: ${gone} (AXTextField "Editor (renamed)") no longer exists in window 1 and nothing was dispatched — no row of the fresh tree carries its role and label. ${gone} is retired and this walk minted no refs to address — observe the window again (win.observe()) once it has rows.`,
		);
		expect(nothing.text).toContain("No accessibility elements returned");
	} finally {
		await f.close();
	}
});

it("reads the window again only for the refusal a re-read can answer", async () => {
	const f = await fixture();
	// The same code covers three states, and the driver's own `advice` is what
	// separates them. Both payloads below are alive rows in the wrong scope: a
	// tree of this window cannot produce either, so the refusal stands.
	const elsewhere = (advice: string, reason: string) => ({
		text: `Background input refused (element_outside_target_window): ${reason}`,
		structuredJson: JSON.stringify({
			code: "element_outside_target_window",
			effect: "refused",
			advice,
			pid: 101,
			reason,
			window_id: 1,
			...(advice === "acquire_window" ? {} : { escalation: { target: advice, reason: "route_unavailable" } }),
		}),
		isError: true,
		errorCode: "element_outside_target_window",
		images: [],
	});
	const menuRow =
		"this element belongs to pid 42's own menu bar, which is process-scoped and has no window ancestry by construction; a window-stamped pointer event or a process-scoped keystroke would land somewhere other than the menu row that was addressed. A semantic action on the row itself is exactly addressed";
	try {
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		const reads = () => f.calls.filter(call => call.name === "get_window_state").length;
		// A proven menu row: the row is there and the route is an action on it.
		f.state.hook = async name => (name === "click" ? elsewhere("element", menuRow) : undefined);
		const before = reads();
		const proven = await f.session.click(f.context, f.window, ref).catch((error: unknown) => error);
		if (!(proven instanceof ToolError)) throw new Error("Expected the scope refusal");
		expect(proven.message).toContain("A semantic action on the row itself is exactly addressed");
		expect(proven.message).not.toContain("no longer exists");
		expect(reads()).toBe(before);
		// Another window's row: the caller has to address that window, and the
		// reason names it. No escalation target exists for that.
		f.state.hook = async name =>
			name === "click"
				? elsewhere("acquire_window", "the addressed element belongs to window 4231 of pid 101, not window 1")
				: undefined;
		const other = await f.session.click(f.context, f.window, ref).catch((error: unknown) => error);
		if (!(other instanceof ToolError)) throw new Error("Expected the scope refusal");
		expect(other.message).toContain("belongs to window 4231");
		expect(other.message).not.toContain("no longer exists");
		expect(reads()).toBe(before);
		// Unproven ancestry: a fresh walk is exactly what settles it.
		f.state.hook = async name =>
			name === "click"
				? elsewhere("snapshot", "the addressed element could not be proven to belong to window 1")
				: undefined;
		f.state.label = "Editor (renamed)";
		expect((await f.session.click(f.context, f.window, ref)).effect).toBe("not_dispatched");
		expect(reads()).toBe(before + 1);
		// That recovery retired the ref it answered for, so the next two states
		// address the row its own walk minted.
		f.state.hook = undefined;
		const live = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		const mark = reads();
		// The ungated AX route is a tool error payload, not a background
		// refusal: it has no `advice` at all and names the re-read through its
		// escalation target. Verbatim from the -25202 branch.
		f.state.hook = async name =>
			name === "click"
				? {
						text: "The addressed element no longer exists (its accessibility reference is invalid): AXUIElementPerformAction(AXPress) returned -25202 (kAXErrorInvalidUIElement). Nothing was dispatched. Re-observe the window and re-address the element.",
						structuredJson: JSON.stringify({
							code: "element_no_longer_exists",
							effect: "not_dispatched",
							route: "ax",
							action: "AXPress",
							ax_error: -25202,
							ax_error_name: "kAXErrorInvalidUIElement",
							dispatch: "not_dispatched",
							escalation: { target: "snapshot", reason: "route_unavailable" },
						}),
						isError: true,
						errorCode: "element_no_longer_exists",
						images: [],
					}
				: undefined;
		f.state.label = "Editor (renamed again)";
		expect((await f.session.click(f.context, f.window, live, { delivery: "foreground" })).effect).toBe(
			"not_dispatched",
		);
		expect(reads()).toBe(mark + 1);
		// A reply that names a route through that same field and it is not a
		// re-read: the tree cannot answer it either.
		f.state.hook = async name =>
			name === "click"
				? {
						text: "The addressed element belongs to pid 42's own menu bar.",
						structuredJson: JSON.stringify({
							code: "element_outside_target_window",
							effect: "refused",
							escalation: { target: "element", reason: "route_unavailable" },
						}),
						isError: true,
						errorCode: "element_outside_target_window",
						images: [],
					}
				: undefined;
		await expect(f.session.click(f.context, f.window, "n4")).rejects.toThrow("own menu bar");
		expect(reads()).toBe(mark + 1);
	} finally {
		await f.close();
	}
});

it("re-addresses a vanished ref only when one row of the new tree is the same row", async () => {
	const f = await fixture();
	const dead = {
		text: "Background input refused (element_no_longer_exists): the addressed element no longer exists (its accessibility reference is invalid)",
		structuredJson: JSON.stringify({
			code: "element_no_longer_exists",
			effect: "not_dispatched",
			route: "ax",
			reason: "the addressed element no longer exists (its accessibility reference is invalid)",
			window_id: 1,
			pid: 101,
		}),
		isError: true,
		errorCode: "element_no_longer_exists",
		images: [],
	};
	/** Reminders' own shape: one checkbox per row, all with the same role and label. */
	const list = (rows: string[]): Wire[] => [
		{ element_index: 1, element_token: "t:1", role: "AXOutline", label: "", depth: 0 },
		...rows.flatMap((label, index) => [
			{ element_index: 2 + index * 2, element_token: `t:${2 + index * 2}`, role: "AXRow", label, depth: 1 },
			{
				element_index: 3 + index * 2,
				element_token: `t:${3 + index * 2}`,
				role: "AXCheckBox",
				label: "Mark as completed",
				value: "0",
				depth: 2,
			},
		]),
	];
	const walks = (rows: string[]) => {
		let snapshot = 0;
		f.state.hook = async (name, args) => {
			if (name === "click" && args.element_token?.toString().startsWith("t:")) return dead;
			return name === "get_window_state"
				? reply({ pid: 101, window_id: 1, snapshot_id: `w${++snapshot}`, truncated: false, elements: list(rows) })
				: undefined;
		};
	};
	try {
		// Distinct rows: role, label, value, ancestor path and sibling ordinal
		// name exactly one row of the fresh tree, so the action goes there and
		// the substitution is stated.
		walks(["Incomplete, Loaf of bread", "Incomplete, Fresh lettuce"]);
		const observed = await f.session.observe(f.context, f.window);
		const ref = observed.elements[2]!.ref;
		expect(observed.elements[2]!.label).toBe("Mark as completed");
		let dispatched = 0;
		f.state.hook = async name => {
			if (name === "click") return ++dispatched === 1 ? dead : undefined;
			return name === "get_window_state"
				? reply({
						pid: 101,
						window_id: 1,
						snapshot_id: "w9",
						truncated: false,
						elements: list(["Incomplete, Loaf of bread", "Incomplete, Fresh lettuce"]),
					})
				: undefined;
		};
		const remapped = await f.session.click(f.context, f.window, ref);
		expect(remapped.effect).toBe("unverifiable");
		expect(remapped.text.split("\n")[0]).toBe(
			`${ref} (AXCheckBox "Mark as completed"), under AXRow "Incomplete, Loaf of bread", no longer exists in window 1 and nothing was dispatched at it — n8 is the one row of the fresh tree with the same role, label, value and position, so the action was dispatched there instead. That walk re-minted this window's refs: ${ref} is retired, and this row is n8 from here on.`,
		);
		expect(f.calls.filter(call => call.name === "click")).toHaveLength(2);
		expect(f.lastDispatch()?.args).toMatchObject({ element_token: "t:3", snapshot_id: "w9" });

		// Rows an app leaves untitled: role and label match three ways and the
		// position matches two, so no row is that row. Nothing is dispatched.
		const fresh = await f.session.acquire(f.context, { id: "1", pid: 101 });
		walks(["", ""]);
		const ambiguous = (await f.session.observe(f.context, fresh)).elements[2]!.ref;
		const before = f.calls.filter(call => call.name === "click").length;
		const refused = await f.session.click(f.context, fresh, ambiguous);
		expect(refused.effect).toBe("not_dispatched");
		expect(refused.text.split("\n")[0]).toBe(
			`element_no_longer_exists: ${ambiguous} (AXCheckBox "Mark as completed") no longer exists in window 1 and nothing was dispatched — the fresh tree has 2 row(s) with its role and label, 2 of them in the same position under AXRow "". ${ambiguous} is retired and the tree below carries this window's new refs — address the row you mean by its new ref.`,
		);
		expect(f.calls.filter(call => call.name === "click")).toHaveLength(before + 1);
	} finally {
		await f.close();
	}
});

it("numbers element refs compactly and never reissues one a later observation invalidated", async () => {
	const f = await fixture();
	try {
		const first = await f.session.observe(f.context, f.window);
		expect(first.elements.map(element => element.ref)).toEqual(["n1"]);
		expect(first.tree).toStartWith("- [n1] AXTextField");
		const second = await f.session.observe(f.context, f.window);
		expect(second.elements.map(element => element.ref)).toEqual(["n2"]);
		// The dead ref must not resolve to the live element that replaced it.
		expect(() => f.session.element("n1")).toThrow("StaleRef");
		// A replaced child clears the map; a counter that restarted would hand
		// `n1`/`n2` from the dead child a binding in the new one.
		f.crash();
		const third = await f.session.observe(f.context, f.window);
		expect(third.elements.map(element => element.ref)).toEqual(["n3"]);
		expect(() => f.session.element("n2")).toThrow("StaleRef");
		expect(f.session.element("n3").role).toBe("AXTextField");
	} finally {
		await f.close();
	}
});

it("asks for the window's point grid and takes coordinates in it", async () => {
	const f = await fixture();
	try {
		const image = await f.session.captureWindow(f.context, f.window);
		// The driver is asked to deliver the 200x100 pt window's long edge, so
		// the frame the model reads is the grid its coordinates are in.
		const captured = f.calls.filter(call => call.name === "get_window_state").at(-1);
		expect(captured?.args).toMatchObject({ include_screenshot: true, max_dimension: 200 });
		expect(image).toMatchObject({
			width: 4,
			height: 2,
			sourceWidth: 4,
			sourceHeight: 2,
			pointWidth: 200,
			pointHeight: 100,
			target: "1",
			label: "Fixture: Editor",
		});
		// This fixture driver ignores the cap and answers 4x2 px for a 200x100
		// pt window, so a point converts by the frame it actually delivered.
		await f.session.click(f.context, f.window, [100, 0]);
		expect(f.lastDispatch()).toEqual({
			name: "click",
			args: { pid: 101, window_id: 1, x: 2, y: 0, delivery_mode: "background", detect_window_change: false },
		});
		// Both idioms name the same point; the bench wrote `{x, y}` 4 runs out of 4.
		await f.session.click(f.context, f.window, { x: 100, y: 0 });
		expect(f.lastDispatch()).toEqual({
			name: "click",
			args: { pid: 101, window_id: 1, x: 2, y: 0, delivery_mode: "background", detect_window_change: false },
		});
		await expect(f.session.click(f.context, f.window, [200, 0])).rejects.toThrow("InvalidCoordinates");
		await expect(f.session.click(f.context, f.window, { x: 200, y: 0 })).rejects.toThrow("InvalidCoordinates");
		// An element's box is not a point: it would silently click a corner.
		await expect(
			f.session.click(f.context, f.window, { x: 10, y: 10, width: 20, height: 20 } as unknown as ComputerPoint),
		).rejects.toThrow(
			'InvalidCoordinates: a point is [x, y] or { x, y } in points read off the last screenshot, not {"x":10,"y":10,"width":20,"height":20}',
		);
		await expect(
			f.session.click(f.context, f.window, { x: "10", y: 10 } as unknown as ComputerPoint),
		).rejects.toThrow("InvalidCoordinates: a point is [x, y] or { x, y }");
		f.state.failCapture = true;
		await expect(f.session.captureWindow(f.context, f.window)).rejects.toThrow("Screenshot unavailable");
		await expect(f.session.click(f.context, f.window, [100, 0])).rejects.toThrow("StaleFrame");
		expect(f.calls.filter(call => call.name === "click")).toHaveLength(2);
	} finally {
		await f.close();
	}
});

it("delivers a Retina capture at point size and keeps coordinates point-for-point", async () => {
	const f = await fixture();
	try {
		// A 2x capture of a 2x1 pt window: 4x2 px in, the window's own 2x1 grid out.
		f.row.bounds.width = 2;
		f.row.bounds.height = 1;
		const window = await f.session.window(f.context, { id: "1", pid: 101 });
		const image = await f.session.captureWindow(f.context, window);
		expect(f.calls.filter(call => call.name === "get_window_state").at(-1)?.args).toMatchObject({
			max_dimension: 2,
		});
		expect(image).toMatchObject({ width: 2, height: 1, pointWidth: 2, pointHeight: 1, scale: 1 });
		await f.session.click(f.context, window, [1, 0]);
		expect(f.lastDispatch()?.args).toMatchObject({ x: 2, y: 0 });
	} finally {
		await f.close();
	}
});

it("downscales a surface past the frame budget and reports the scale it landed on", async () => {
	const f = await fixture();
	try {
		f.row.bounds.width = 4;
		f.row.bounds.height = 2;
		// Half the area of the 4x2 pt window: the grid cannot be kept, so the
		// capture is smaller than the window and says so.
		f.context.maxPixels = 2;
		const window = await f.session.window(f.context, { id: "1", pid: 101 });
		const image = await f.session.captureWindow(f.context, window);
		expect(f.calls.filter(call => call.name === "get_window_state").at(-1)?.args).toMatchObject({
			max_dimension: 2,
		});
		expect(image).toMatchObject({ width: 2, height: 1, pointWidth: 4, pointHeight: 2, scale: 0.5 });
		// Coordinates stay window points whatever the image cost.
		await f.session.click(f.context, window, [2, 1]);
		expect(f.lastDispatch()?.args).toMatchObject({ x: 2, y: 1 });
	} finally {
		await f.close();
	}
});

it("invalidates pixel frames when the window moves and keeps them across AX-only reads", async () => {
	const f = await fixture();
	try {
		await f.session.captureWindow(f.context, f.window);
		f.row.bounds.x++;
		await expect(f.session.click(f.context, f.window, [1, 0])).rejects.toThrow("StaleFrame");
		expect(f.calls.some(call => call.name === "click")).toBe(false);
		await f.session.captureWindow(f.context, f.window);
		// An AX-only observation or a verify captures nothing and moves nothing,
		// so the frame the last capture bound is still the live one. The explicit
		// flag is the call `find()` makes.
		await f.session.observe(f.context, f.window);
		await f.session.observe(f.context, f.window, { screenshot: false });
		f.state.hook = async name =>
			name === "verify_state"
				? reply({ status: "satisfied", stable: true, elapsed_ms: 1, samples: 1, predicates: [] })
				: undefined;
		await f.session.verify(f.context, f.window, []);
		await f.session.click(f.context, f.window, [100, 0]);
		expect(f.lastDispatch()?.args).toMatchObject({ pid: 101, window_id: 1, x: 2, y: 0 });
	} finally {
		await f.close();
	}
});

it("refuses mismatched observation identities before publishing elements or images", async () => {
	const f = await fixture();
	try {
		f.state.wrongIdentity = true;
		await expect(f.session.observe(f.context, f.window, { screenshot: true })).rejects.toThrow("WrongWindow");
		expect(f.images).toHaveLength(0);
	} finally {
		await f.close();
	}
});

it("keeps visual access for windows with no AX snapshot without inventing element refs", async () => {
	const f = await fixture();
	try {
		f.state.hook = async name =>
			name === "get_window_state"
				? reply(
						{
							pid: 101,
							window_id: 1,
							elements: [],
							elements_complete: false,
							degraded_reason: "AX window unavailable",
							screenshot_frame_valid: true,
							window_bounds: f.row.bounds,
							screenshot_width: 4,
							screenshot_height: 2,
						},
						[{ dataBase64: PNG, mimeType: "image/png" }],
					)
				: undefined;
		const observation = await f.session.observe(f.context, f.window, { screenshot: true });
		expect(observation).toMatchObject({
			snapshotId: "unavailable",
			tree: "AX window unavailable",
			elements: [],
			complete: false,
		});
		expect(observation.screenshot).toBeDefined();
		await f.session.click(f.context, f.window, [100, 0]);
		expect(f.lastDispatch()?.args).toMatchObject({ x: 2, y: 0, pid: 101, window_id: 1 });
	} finally {
		await f.close();
	}
});

it("says what a query searched, read and cut when nothing matched it", async () => {
	const f = await fixture();
	const missed = (data: Wire): CuaToolResult =>
		reply({
			pid: 101,
			window_id: 1,
			snapshot_id: "s1",
			elements: [],
			elements_complete: false,
			truncated: false,
			element_count: 148,
			total_element_count: 148,
			returned_element_count: 0,
			filtered_element_count: 0,
			collapsed_rows: 0,
			window_bounds: f.row.bounds,
			...data,
		});
	try {
		f.state.hook = async name => (name === "get_window_state" ? missed({}) : undefined);
		const observation = await f.session.observe(f.context, f.window, { query: "Repeat" });
		expect(observation.tree).toBe(
			'No row matched query "Repeat" under window 1 "Editor" (Fixture): the walk read 148 actionable rows and reported the tree complete. Next: drop the query to read the whole tree, or widen it to a substring one of those rows carries; observe({ menubar: true }) adds the menu bar.',
		);
		// Rows the walker never read are the cheaper thing to fix than the
		// query, and a walk that clipped says so instead of claiming complete.
		f.state.hook = async name =>
			name === "get_window_state" ? missed({ collapsed_rows: 69, truncated: true }) : undefined;
		const collapsed = await f.session.observe(f.context, f.window, { query: "Repeat", menubar: true });
		expect(collapsed.tree.split("\n")[0]).toBe(
			'No row matched query "Repeat" under window 1 "Editor" (Fixture) and its menu bar: the walk read 148 actionable rows and reported the tree truncated. Next: scroll the list first — 69 row(s) are out of view and were not read — or drop the query to read what is on screen.',
		);
		// A window with no AX tree at all is the driver's own verdict, not a
		// query result, and keeps saying so.
		f.state.hook = async name =>
			name === "get_window_state" ? missed({ degraded_reason: "AX window unavailable" }) : undefined;
		expect((await f.session.observe(f.context, f.window, { query: "Repeat" })).tree).toBe("AX window unavailable");
		f.state.hook = async name => (name === "get_window_state" ? missed({}) : undefined);
		expect((await f.session.observe(f.context, f.window)).tree).toBe(
			"No accessibility elements returned; completeness is unknown.",
		);
	} finally {
		await f.close();
	}
});

it("clicks a ref's own bounds as window points when modifiers or a count leave the element route", async () => {
	const f = await fixture();
	try {
		const observation = await f.session.observe(f.context, f.window, { screenshot: true });
		const ref = observation.elements[0]!.ref;
		// The element covers the whole 200x100 pt window, so its centre is the
		// window centre: (100, 50) pt, (2, 1) in the delivered 4x2 px frame.
		await f.session.click(f.context, f.window, ref, { modifiers: ["shift"], delivery: "foreground" });
		expect(f.lastDispatch()).toEqual({
			name: "click",
			args: {
				pid: 101,
				window_id: 1,
				x: 2,
				y: 1,
				modifier: ["shift"],
				delivery_mode: "foreground",
				detect_window_change: false,
			},
		});
		await f.session.click(f.context, f.window, ref, { count: 3, button: "right" });
		expect(f.lastDispatch()?.args).toMatchObject({ x: 2, y: 1, count: 3, button: "right" });
		expect(f.lastDispatch()?.args.element_token).toBeUndefined();
	} finally {
		await f.close();
	}
});

it("refuses a counted or modified ref click only with no frame or no observed bounds", async () => {
	const f = await fixture();
	try {
		// A tree-only observation drops the window's cached frame, so the ref's
		// global bounds have no pixel space to land in.
		const treeOnly = await f.session.observe(f.context, f.window);
		await expect(f.session.click(f.context, f.window, treeOnly.elements[0]!.ref, { count: 2 })).rejects.toThrow(
			"capture the window again",
		);
		f.state.elementFrame = undefined;
		const boundless = await f.session.observe(f.context, f.window, { screenshot: true });
		expect(boundless.elements[0]!.bounds).toBeUndefined();
		await expect(
			f.session.click(f.context, f.window, boundless.elements[0]!.ref, { modifiers: ["shift"] }),
		).rejects.toThrow("no observed bounds");
		expect(f.calls.some(call => call.name === "click")).toBe(false);
	} finally {
		await f.close();
	}
});

it("prefers the advertised native element double-click over the pixel fallback", async () => {
	const f = await fixture();
	try {
		f.state.elementDoubleClick = "left_center_v1";
		const observation = await f.session.observe(f.context, f.window, { screenshot: true });
		const ref = observation.elements[0]!.ref;
		await f.session.click(f.context, f.window, ref, { count: 2 });
		const clicks = f.calls.filter(call => call.name === "click");
		expect(clicks).toHaveLength(1);
		expect(clicks[0]!.args).toMatchObject({
			pid: 101,
			window_id: 1,
			element_token: "s1:1",
			snapshot_id: "s1",
			count: 2,
			delivery_mode: "background",
		});
		expect(clicks[0]!.args.x).toBeUndefined();
		expect(clicks[0]!.args.y).toBeUndefined();
		// Everything the native route does not advertise takes the bounds route.
		await f.session.click(f.context, f.window, ref, { count: 2, button: "right" });
		expect(f.lastDispatch()?.args).toMatchObject({ x: 2, y: 1, count: 2, button: "right" });
		await f.session.click(f.context, f.window, ref, { count: 2, modifiers: ["shift"] });
		expect(f.lastDispatch()?.args).toMatchObject({ x: 2, y: 1, count: 2, modifier: ["shift"] });
		f.state.elementDoubleClick = undefined;
		const legacy = await f.session.observe(f.context, f.window, { screenshot: true });
		await expect(f.session.click(f.context, f.window, ref, { count: 2 })).rejects.toThrow("StaleRef");
		await f.session.click(f.context, f.window, legacy.elements[0]!.ref, { count: 2 });
		expect(f.lastDispatch()?.args).toMatchObject({ x: 2, y: 1, count: 2 });
		expect(f.lastDispatch()?.args.element_token).toBeUndefined();
	} finally {
		await f.close();
	}
});

it("cancels the driver call on abort, drains admitted input, and keeps the session usable", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const abort = new AbortController();
	try {
		f.state.hook = async (name, args) => {
			if (name === "type_text" && args.text === "first") {
				entered.resolve();
				await release.promise;
			}
			return undefined;
		};
		const action = f.session.type({ ...f.context, signal: abort.signal }, f.window, "first");
		const rejected = action.catch((error: unknown) => error);
		await entered.promise;
		abort.abort();
		let drained = false;
		const drain = f.session.drain().then(() => {
			drained = true;
		});
		const next = f.session.type(f.context, f.window, "second");
		await Bun.sleep(10);
		expect(drained).toBe(false);
		expect(f.calls.filter(call => call.name === "type_text")).toHaveLength(1);
		release.resolve();
		expect(await rejected).toBeInstanceOf(ToolAbortError);
		await drain;
		expect(f.state.cancelled).toEqual(["type_text"]);
		expect(f.state.kills).toBe(0);
		expect((await next).text).toBeString();
		expect(f.state.value).toBe("second");
		expect(f.calls.filter(call => call.name === "type_text")).toHaveLength(2);
	} finally {
		release.resolve();
		await f.close();
	}
});

it("does not dispatch input when cancellation arrives during target validation", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const abort = new AbortController();
	try {
		f.state.hook = async name => {
			if (name === "list_windows") {
				entered.resolve();
				await release.promise;
			}
			return undefined;
		};
		const action = f.session
			.type({ ...f.context, signal: abort.signal }, f.window, "must not appear")
			.catch((error: unknown) => error);
		await entered.promise;
		abort.abort();
		release.resolve();
		expect(await action).toBeInstanceOf(Error);
		expect(f.calls.some(call => call.name === "type_text")).toBe(false);
	} finally {
		release.resolve();
		await f.close();
	}
});

it("close waits for admitted input and ends the driver child exactly once", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	try {
		f.state.hook = async name => {
			if (name === "type_text") {
				entered.resolve();
				await release.promise;
			}
			return undefined;
		};
		const action = f.session.type(f.context, f.window, "complete");
		await entered.promise;
		const first = f.session.close();
		const second = f.session.close();
		expect(first).toBe(second);
		expect(f.state.kills).toBe(0);
		release.resolve();
		await Promise.all([action, first]);
		expect(f.state.value).toBe("complete");
		expect(f.state.kills).toBe(1);
		await expect(f.session.windows(f.context)).rejects.toThrow("closed");
	} finally {
		release.resolve();
		await f.close();
	}
});

it("never replays an SDK error and guards unsupported or read-only mutations", async () => {
	const f = await fixture();
	try {
		f.state.hook = async name =>
			name === "type_text"
				? { text: "delivery unknown", isError: true, images: [], errorCode: "indeterminate" }
				: undefined;
		await expect(f.session.type(f.context, f.window, "once")).rejects.toThrow("indeterminate");
		expect(f.calls.filter(call => call.name === "type_text")).toHaveLength(1);
		const count = f.calls.length;
		await expect(f.session.click({ ...f.context, readOnly: true }, f.window, [0, 0])).rejects.toThrow("read-only");
		await expect(f.session.hover(f.context, f.window, 0, 0)).rejects.toThrow("overlay");
		await expect(f.session.desktopType(f.context, "no")).rejects.toThrow("foreground");
		expect(f.calls).toHaveLength(count);
	} finally {
		await f.close();
	}
});

it("preserves unknown verification and invalidates the SDK traversal's old refs", async () => {
	const f = await fixture();
	try {
		const observed = await f.session.observe(f.context, f.window);
		const outcome = {
			status: "unknown" as const,
			stable: false,
			elapsed_ms: 4,
			samples: 1,
			predicates: [
				{ index: 0, status: "unknown" as const, unknown_reason: "observation_unavailable", observed_json: null },
			],
		};
		f.state.hook = async name => (name === "verify_state" ? reply(outcome) : undefined);
		const expectation = [{ element: { selector: { role: "AXTextField" }, value_equals: "" } }];
		expect(await f.session.verify(f.context, f.window, expectation, { timeoutMs: 0 })).toEqual(outcome);
		expect(f.lastDispatch()?.args).toEqual({
			pid: 101,
			window_id: 1,
			expect: expectation,
			timeout_ms: 0,
			include_screenshot: false,
		});
		expect(() => f.session.element(observed.elements[0]!.ref)).toThrow("StaleRef");
	} finally {
		await f.close();
	}
});

it("binds resized desktop pixels to the primary UUID/native id and routes exact SDK coordinates", async () => {
	const f = await fixture();
	try {
		expect(await f.session.displays(f.context)).toEqual([
			{
				id: "display-uuid",
				name: "Primary display",
				x: 0,
				y: 0,
				width: 2,
				height: 1,
				scale: 2,
				pixelX: 0,
				pixelY: 0,
				pixelWidth: 4,
				pixelHeight: 2,
				isPrimary: true,
			},
		]);
		await f.session.screenshot(f.context);
		await f.session.desktopClick(f.context, 1, 0, { delivery: "foreground", count: 2, modifiers: ["shift"] });
		expect(f.lastDispatch()).toEqual({
			name: "click",
			args: {
				scope: "desktop",
				x: 2,
				y: 0,
				count: 2,
				modifier: ["shift"],
				delivery_mode: "foreground",
				detect_window_change: false,
			},
		});
		const moved = await f.session.desktopMove(f.context, 1, 0, { delivery: "foreground" });
		expect(f.lastDispatch()).toEqual({ name: "move_cursor", args: { scope: "desktop", x: 2, y: 0 } });
		expect(moved.delivery).toBe("foreground");
		await f.session.desktopDrag(
			f.context,
			[
				[0, 0],
				[1, 0],
			],
			{ delivery: "foreground", button: "right" },
		);
		expect(f.lastDispatch()?.args).toEqual({
			scope: "desktop",
			from_x: 0,
			from_y: 0,
			to_x: 2,
			to_y: 0,
			button: "right",
			delivery_mode: "foreground",
			detect_window_change: false,
		});
		await f.session.desktopScroll(f.context, 1, 0, { delivery: "foreground", dy: 240 });
		expect(f.lastDispatch()?.args).toEqual({
			scope: "desktop",
			x: 2,
			y: 0,
			direction: "down",
			amount: 2,
			by: "line",
			delivery_mode: "foreground",
			detect_window_change: false,
		});
		await f.session.desktopScroll(f.context, 1, 0, { delivery: "foreground", dx: -120 });
		expect(f.lastDispatch()?.args.direction).toBe("left");
	} finally {
		await f.close();
	}
});

it("rejects reused dimensions when primary identity, origin, mode size, or scale changes", async () => {
	const f = await fixture();
	try {
		const initial = { ...f.state.display };
		const changes = [
			{ uuid: "replacement-display" },
			{ nativeId: 8 },
			{ x: 1 },
			{ y: 1 },
			{ width: 3 },
			{ height: 2 },
			{ scale: 1 },
		];
		for (const change of changes) {
			f.state.display = { ...initial };
			await f.session.screenshot(f.context);
			Object.assign(f.state.display, change);
			await expect(f.session.desktopClick(f.context, 1, 0, { delivery: "foreground" })).rejects.toThrow(
				"StaleFrame",
			);
			f.state.display = { ...initial };
			await expect(f.session.desktopClick(f.context, 1, 0, { delivery: "foreground" })).rejects.toThrow(
				"MissingFrame",
			);
		}
		expect(f.calls.some(call => call.name === "click")).toBe(false);
	} finally {
		await f.close();
	}
});

it("rejects display changes during capture without emitting or retaining the image", async () => {
	const f = await fixture();
	try {
		await f.session.screenshot(f.context);
		f.state.hook = async name => {
			if (name === "get_desktop_state") f.state.display.uuid = "changed-during-capture";
			return undefined;
		};
		await expect(f.session.screenshot(f.context)).rejects.toThrow("StaleFrame");
		expect(f.images).toHaveLength(1);
		await expect(f.session.desktopMove(f.context, 0, 0, { delivery: "foreground" })).rejects.toThrow("MissingFrame");
	} finally {
		await f.close();
	}
});

it("keeps stock SDK desktop observations visual-only when identity metadata is unavailable", async () => {
	const f = await fixture();
	try {
		f.state.displayIdentity = false;
		expect(await f.session.screenshot(f.context)).toMatchObject({ target: "primary", width: 2, height: 1 });
		await expect(f.session.displays(f.context)).rejects.toThrow("identity is unavailable");
		await expect(f.session.desktopClick(f.context, 0, 0, { delivery: "foreground" })).rejects.toThrow("MissingFrame");
		expect(f.calls.some(call => call.name === "click")).toBe(false);
	} finally {
		await f.close();
	}
});

it("refuses unavailable background drag and invalid timing before SDK dispatch", async () => {
	const f = await fixture();
	try {
		f.calls.length = 0;
		await expect(f.session.drag(f.context, f.window, [0, 0], [1, 0])).rejects.toThrow("background drag");
		for (const durationMs of [-1, 10001, 0.5, Number.NaN]) {
			await expect(
				f.session.drag(f.context, f.window, [0, 0], [1, 0], {
					delivery: "foreground",
					durationMs,
				}),
			).rejects.toThrow("durationMs");
		}
		for (const steps of [0, 201, 1.5]) {
			await expect(
				f.session.drag(f.context, f.window, [0, 0], [1, 0], {
					delivery: "foreground",
					steps,
				}),
			).rejects.toThrow("steps");
		}
		expect(f.calls).toEqual([]);
	} finally {
		await f.close();
	}
});

it("maps requested window drag timing and observed pixels to the SDK wire contract", async () => {
	const f = await fixture();
	try {
		await f.session.captureWindow(f.context, f.window);
		await f.session.drag(f.context, f.window, [0, 0], [100, 0], {
			delivery: "foreground",
			durationMs: 5000,
			steps: 100,
			button: "right",
			modifiers: ["shift"],
		});
		expect(f.calls.filter(call => call.name === "drag")).toEqual([
			{
				name: "drag",
				args: {
					pid: 101,
					window_id: 1,
					from_x: 0,
					from_y: 0,
					to_x: 2,
					to_y: 0,
					duration_ms: 5000,
					steps: 100,
					button: "right",
					modifier: ["shift"],
					delivery_mode: "foreground",
					detect_window_change: false,
				},
			},
		]);
		// The shape T4 reached for 4 runs out of 4, on either end of the gesture.
		await f.session.drag(f.context, f.window, { x: 0, y: 0 }, { x: 100, y: 0 }, { delivery: "foreground" });
		expect(f.lastDispatch()?.args).toMatchObject({ from_x: 0, from_y: 0, to_x: 2, to_y: 0 });
	} finally {
		await f.close();
	}
});

it("renders the specific role a control answers to beside its generic one", async () => {
	const f = await fixture();
	try {
		// Notes' search field, as the driver reports it: an `AXTextField` with
		// no title, description or placeholder of its own, named only by its
		// `AXSubrole`. Without it the row reads `AXTextField ""`.
		f.state.role = "AXTextField";
		f.state.label = "";
		f.state.subrole = "AXSearchField";
		f.state.placeholder = undefined;
		const observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]).toMatchObject({ role: "AXTextField", subrole: "AXSearchField", label: "" });
		expect(observation.tree.split("\n")[0]).toBe(
			`- [${observation.elements[0]!.ref}] AXTextField "" subrole=AXSearchField value="" enabled=false selected=false`,
		);
		// A subrole that only restates its role is 164 of the 173 a Notes window
		// carries, so the row does not print it twice — but the snapshot keeps
		// it, which is what `find` reads.
		f.state.role = "AXRow";
		f.state.subrole = "AXTableRow";
		const listed = await f.session.observe(f.context, f.window);
		expect(listed.elements[0]!.subrole).toBe("AXTableRow");
		expect(listed.tree).not.toContain("subrole=");
		// A provider that reports no subrole says nothing about one.
		f.state.subrole = undefined;
		const plain = await f.session.observe(f.context, f.window);
		expect(plain.elements[0]!.subrole).toBeUndefined();
		expect(plain.tree).not.toContain("subrole=");
	} finally {
		await f.close();
	}
});

it("drags between element refs at their own observed bounds", async () => {
	const f = await fixture();
	try {
		const observation = await f.session.observe(f.context, f.window, { screenshot: true });
		const ref = observation.elements[0]!.ref;
		// The ref's centre: (100, 50) pt of the 200×100 pt window, (2, 1) in SDK pixels.
		await f.session.drag(f.context, f.window, ref, [0, 0], { delivery: "foreground" });
		expect(f.lastDispatch()).toEqual({
			name: "drag",
			args: {
				pid: 101,
				window_id: 1,
				from_x: 2,
				from_y: 1,
				to_x: 0,
				to_y: 0,
				delivery_mode: "foreground",
				detect_window_change: false,
			},
		});
		await f.session.drag(f.context, f.window, ref, ref, { delivery: "foreground", steps: 10 });
		expect(f.lastDispatch()?.args).toMatchObject({ from_x: 2, from_y: 1, to_x: 2, to_y: 1, steps: 10 });
		// No frame and no bounds are the only refusals, and neither dispatches.
		f.calls.length = 0;
		// A failed capture leaves the window with no frame; the tree read that
		// follows it neither restores one nor invalidates anything.
		f.state.failCapture = true;
		await expect(f.session.captureWindow(f.context, f.window)).rejects.toThrow("Screenshot unavailable");
		const treeOnly = await f.session.observe(f.context, f.window);
		f.state.failCapture = false;
		await expect(
			f.session.drag(f.context, f.window, treeOnly.elements[0]!.ref, [0, 0], { delivery: "foreground" }),
		).rejects.toThrow("drag from an element with no observed bounds or no current window screenshot");
		f.state.elementFrame = undefined;
		const boundless = await f.session.observe(f.context, f.window, { screenshot: true });
		await expect(
			f.session.drag(f.context, f.window, [0, 0], boundless.elements[0]!.ref, { delivery: "foreground" }),
		).rejects.toThrow("drag to an element with no observed bounds");
		expect(f.calls.some(call => call.name === "drag")).toBe(false);
	} finally {
		await f.close();
	}
});

it("rejects ungrounded, out-of-bounds, background, and unrepresentable desktop gestures", async () => {
	const f = await fixture();
	try {
		await expect(f.session.desktopMove(f.context, 0, 0, { delivery: "foreground" })).rejects.toThrow("MissingFrame");
		await f.session.screenshot(f.context);
		await expect(f.session.desktopClick(f.context, 0, 0)).rejects.toThrow("foreground");
		await expect(f.session.desktopMove(f.context, 2, 0, { delivery: "foreground" })).rejects.toThrow(
			"InvalidCoordinates",
		);
		await expect(
			f.session.desktopDrag(
				f.context,
				[
					[0, 0],
					[1, 0],
					[0, 0],
				],
				{ delivery: "foreground" },
			),
		).rejects.toThrow("multi-point path");
		await expect(f.session.desktopScroll(f.context, 0, 0, { delivery: "foreground", dy: 1 })).rejects.toThrow(
			"multiples of 120",
		);
		await expect(
			f.session.desktopScroll(f.context, 0, 0, { delivery: "foreground", dx: 120, dy: 120 }),
		).rejects.toThrow("one finite axis");
		expect(f.calls.some(call => ["click", "move_cursor", "drag", "scroll"].includes(call.name))).toBe(false);
	} finally {
		await f.close();
	}
});

it("preserves actionable capture failures with AX and refuses stale pixel input", async () => {
	const f = await fixture();
	try {
		await f.session.captureWindow(f.context, f.window);
		f.state.hook = async name =>
			name === "get_window_state"
				? reply({
						pid: 101,
						window_id: 1,
						elements: [],
						elements_complete: false,
						degraded_reason: "AX window unavailable",
						screenshot_frame_valid: false,
						screenshot_error: { code: "px_capture_unavailable", reason: "rendering lease no complete frame" },
					})
				: undefined;
		const observation = await f.session.observe(f.context, f.window, { screenshot: true });
		expect(observation.screenshotError).toBe("px_capture_unavailable: rendering lease no complete frame");
		expect(observation.screenshot).toBeUndefined();
		expect(observation.tree).toBe("AX window unavailable");
		await expect(f.session.click(f.context, f.window, [1, 0])).rejects.toThrow("StaleFrame");
		await expect(f.session.captureWindow(f.context, f.window)).rejects.toThrow("rendering lease no complete frame");
		expect(f.calls.some(call => call.name === "click")).toBe(false);
	} finally {
		await f.close();
	}
});

it("preserves SDK launch conflict identity and delivery evidence without retrying", async () => {
	const f = await fixture();
	const details = {
		error: "APP_PATH_CONFLICT",
		path: "/Applications/Copy B.app",
		running_instances: [{ pid: 101, launch_path: "/Applications/Copy A.app" }],
		launch_state: { requested: false, process_running: true, window_ready: false },
	};
	try {
		f.state.hook = async name =>
			name === "launch_app"
				? { text: "Different copy is running", isError: true, images: [], structuredJson: JSON.stringify(details) }
				: undefined;
		const failure = await f.session.launch(f.context, { name: details.path }).catch((error: unknown) => error);
		if (!(failure instanceof ToolError)) throw new Error("Expected an SDK tool error");
		expect(failure.message).toContain("APP_PATH_CONFLICT");
		expect(failure.message).toContain(JSON.stringify(details));
		expect(failure.context).toEqual(details);
		expect(f.calls.filter(call => call.name === "launch_app")).toHaveLength(1);
		f.state.hook = async name =>
			name === "launch_app"
				? {
						text: "Delivery remains unknown",
						errorCode: "indeterminate",
						isError: true,
						images: [],
						structuredJson: "{",
					}
				: undefined;
		await expect(f.session.launch(f.context, { name: details.path })).rejects.toThrow(
			"indeterminate: Delivery remains unknown",
		);
		expect(f.calls.filter(call => call.name === "launch_app")).toHaveLength(2);
	} finally {
		await f.close();
	}
});

it("dispatches every action a node advertises and refuses only what its row never printed", async () => {
	const f = await fixture();
	try {
		let observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.actions).toBeUndefined();
		// The T4 row whose only route to the move command is its context menu.
		f.state.role = "AXTextField";
		f.state.label = "Buy milk";
		f.state.value = "Buy milk";
		f.state.actions = ["AXShowMenu", "AXConfirm"];
		observation = await f.session.observe(f.context, f.window);
		expect(observation.tree).toContain('AXTextField "Buy milk" value="Buy milk"');
		expect(observation.tree).toContain('actions=["show_menu","confirm"]');
		await f.session.perform(f.context, f.window, observation.elements[0]!.ref, "show_menu");
		expect(f.lastDispatch()).toMatchObject({
			name: "click",
			args: { action: "show_menu", element_token: "s2:1", window_id: 1, pid: 101 },
		});
		// A verbatim AX name is what the row advertises and what the driver
		// dispatches, so it is accepted exactly as the tree printed it.
		f.state.actions = ["AXConfirm", "AXShowDefaultUI", "AXOpen", "AXConfirm", null, "toString"];
		// macOS ships an app's own actions inside AXUIElementCopyActionNames as
		// "Name:Pin List\nTarget:0x0\nSelector:(null)", so the driver reports the
		// readable name beside the string that invokes it.
		f.state.customActions = [
			{ name: "Add Reminder", raw: "Name:Add Reminder\nTarget:0x0\nSelector:(null)" },
			{ name: "Snooze", raw: "Name:Snooze\nTarget:0x0\nSelector:(null)" },
		];
		observation = await f.session.observe(f.context, f.window);
		const element = observation.elements[0]!;
		expect(element.actions).toEqual(["confirm", "AXShowDefaultUI", "open", "toString", "Add Reminder", "Snooze"]);
		expect(observation.tree).toContain(
			'actions=["confirm","AXShowDefaultUI","open","toString","Add Reminder","Snooze"]',
		);
		// A custom action is invoked by the raw string, never by the label.
		await f.session.perform(f.context, f.window, element.ref, "Snooze");
		expect(f.lastDispatch()).toMatchObject({
			name: "click",
			args: { action: "Name:Snooze\nTarget:0x0\nSelector:(null)" },
		});
		await f.session.perform(f.context, f.window, element.ref, "AXShowDefaultUI");
		expect(f.lastDispatch()).toMatchObject({ name: "click", args: { action: "AXShowDefaultUI" } });
		// An AX spelling of a semantic name is dispatched as that name, whether
		// or not the row's own list carries it.
		await f.session.perform(f.context, f.window, element.ref, "AXPress");
		expect(f.lastDispatch()).toMatchObject({ name: "click", args: { action: "press" } });
		expect(() => f.session.perform(f.context, f.window, element.ref, "AXScrollToVisible")).toThrow(
			`AX action 'AXScrollToVisible' on ${element.ref}; that row advertises confirm · AXShowDefaultUI · open · toString · Add Reminder · Snooze, and perform also dispatches press · show_menu · pick · confirm · cancel · open`,
		);
		f.state.actions = [];
		f.state.customActions = undefined;
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.actions).toBeUndefined();
		expect(observation.tree).not.toContain(" actions=");
		f.state.customActions = "Snooze";
		await expect(f.session.observe(f.context, f.window)).rejects.toThrow("Malformed Cua custom actions");
	} finally {
		await f.close();
	}
});

it("renders a row's press as a secondary action the tree does not offer first", async () => {
	const f = await fixture();
	try {
		// The measured row: a background click at its centre moved the selection
		// and left the reminder incomplete, and the row did not advertise
		// `AXPress` at all — its inner cell did. `press` was still the first verb
		// the tree offered for it, and the bench pressed rows it meant to select.
		f.state.role = "AXRow";
		f.state.label = "Incomplete, Buy milk";
		f.state.value = undefined;
		f.state.actions = ["AXPress", "AXShowMenu", "Move Down"];
		let observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.actions).toEqual(["show_menu", "Move Down"]);
		expect(observation.tree).toContain('actions=["show_menu","Move Down"]');
		// Reachable by the one route that names it explicitly.
		await f.session.perform(f.context, f.window, observation.elements[0]!.ref, "press");
		expect(f.lastDispatch()).toMatchObject({ name: "click", args: { action: "press" } });
		for (const role of ["AXCell", "AXListItem"]) {
			f.state.role = role;
			observation = await f.session.observe(f.context, f.window);
			expect(observation.elements[0]!.actions).toEqual(["show_menu", "Move Down"]);
		}
		// Every other role is pressed by a click, so its own list says so.
		f.state.role = "AXButton";
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.actions).toEqual(["press", "show_menu", "Move Down"]);
	} finally {
		await f.close();
	}
});

it("nests an attached sheet's own tree under its parent and dispatches its refs to the sheet", async () => {
	const f = await fixture();
	const sheet = { ...f.row, window_id: 5, title: "Save", bounds: { x: 30, y: 40, width: 120, height: 80 } };
	try {
		expect((await f.session.observe(f.context, f.window)).relatedWindows).toBeUndefined();
		f.state.relatedWindows = [{ pid: 101, window_id: 5, title: "Save", relation: "sheet" }];
		f.state.hook = async (name, args) => {
			if (name === "list_windows") return reply({ windows: [f.row, sheet] });
			if (name !== "get_window_state" || args.window_id !== 5) return undefined;
			return reply({
				pid: 101,
				window_id: 5,
				snapshot_id: "sheet-1",
				related_windows: [],
				window_bounds: sheet.bounds,
				elements: [
					{ element_index: 1, element_token: "sheet-1:1", role: "AXSheet", label: "save", depth: 0 },
					{ element_index: 2, element_token: "sheet-1:2", role: "AXButton", label: "Cancel", depth: 1 },
				],
			});
		};
		const observation = await f.session.observe(f.context, f.window);
		expect(observation.relatedWindows).toEqual([{ pid: 101, id: "5", title: "Save", relation: "sheet" }]);
		const parentRef = observation.elements[0]!.ref;
		const cancel = observation.elements.find(element => element.label === "Cancel")!;
		// The sheet leads the observation, named where it attaches, with its own
		// rows hanging under it and the window it covers below.
		expect(observation.tree).toBe(
			[
				'sheet "Save" (window 5) — modal over window 1',
				`  - [${observation.elements[1]!.ref}] AXSheet "save"`,
				`    - [${cancel.ref}] AXButton "Cancel"`,
				`- [${parentRef}] AXTextField "Editor" value="" placeholder="Hint, not value" enabled=false selected=false`,
			].join("\n"),
		);
		expect(cancel.windowId).toBe("5");
		expect(cancel.pid).toBe(101);
		// A sheet ref reached through the parent's handle acts on the sheet.
		await f.session.click(f.context, observation.window, cancel.ref);
		expect(f.lastDispatch()).toMatchObject({
			name: "click",
			args: { window_id: 5, pid: 101, element_token: "sheet-1:2", snapshot_id: "sheet-1" },
		});
		await f.session.click(f.context, observation.window, parentRef);
		expect(f.lastDispatch()).toMatchObject({ name: "click", args: { window_id: 1, pid: 101 } });
		expect(Object.isFrozen(observation.relatedWindows)).toBe(true);
		expect(Object.isFrozen(observation.relatedWindows![0])).toBe(true);
		// The sheet went away: the next walk simply lacks it, and the refs it
		// minted say which surface took them.
		f.state.relatedWindows = [];
		const after = await f.session.observe(f.context, f.window);
		expect(after.tree).not.toContain("sheet ");
		expect(() => f.session.element(cancel.ref)).toThrow('StaleRef: sheet "Save" (window 5) is gone');
	} finally {
		await f.close();
	}
});

/**
 * T3 `native-read-calendar/omp-2`: Calendar's "Show" sheet held the keyboard,
 * `press_key` refused with `delivery_failed`, and the reply carried only its
 * code and message — the window id the driver had in hand at the bail and the
 * sheet relation OMP had already printed were both absent from the advice.
 */
it("names the sheet holding keyboard focus when a delivery is refused for it", async () => {
	const f = await fixture();
	const sheet = { ...f.row, window_id: 11151, title: "", bounds: { x: 30, y: 40, width: 120, height: 80 } };
	try {
		f.state.relatedWindows = [{ pid: 101, window_id: 11151, title: "", relation: "sheet" }];
		f.state.hook = async (name, args) => {
			if (name === "list_windows") return reply({ windows: [f.row, sheet] });
			if (name === "get_window_state" && args.window_id === 11151)
				return reply({
					pid: 101,
					window_id: 11151,
					snapshot_id: "sheet-1",
					window_bounds: sheet.bounds,
					elements: [{ element_index: 1, element_token: "sheet-1:1", role: "AXSheet", label: "_NS:25", depth: 0 }],
				});
			return undefined;
		};
		// The observation is how OMP learns the relation at all.
		expect((await f.session.observe(f.context, f.window)).tree).toContain('sheet "" (window 11151)');
		f.state.hook = async name =>
			name === "press_key"
				? {
						text: "press_key delivery failed: exact target window did not become focused for foreground HID delivery",
						structuredJson: JSON.stringify({
							code: "delivery_failed",
							message:
								"press_key delivery failed: exact target window did not become focused for foreground HID delivery",
						}),
						isError: true,
						errorCode: "delivery_failed",
						images: [],
					}
				: undefined;
		await expect(
			f.session.press(f.context, f.window, "right", undefined, { delivery: "foreground" }),
		).rejects.toThrow(
			'window 11151 — a sheet attached to 1 — holds keyboard focus, not window 1; drive it with computer.window("11151") and press its own buttons.',
		);
	} finally {
		await f.close();
	}
});

it("names the sheet holding keyboard focus when the refusal nests its own code", async () => {
	const f = await fixture();
	const sheet = { ...f.row, window_id: 11151, title: "", bounds: { x: 30, y: 40, width: 120, height: 80 } };
	try {
		f.state.relatedWindows = [{ pid: 101, window_id: 11151, title: "", relation: "sheet" }];
		f.state.hook = async (name, args) => {
			if (name === "list_windows") return reply({ windows: [f.row, sheet] });
			if (name === "get_window_state" && args.window_id === 11151)
				return reply({
					pid: 101,
					window_id: 11151,
					snapshot_id: "sheet-1",
					window_bounds: sheet.bounds,
					elements: [{ element_index: 1, element_token: "sheet-1:1", role: "AXSheet", label: "_NS:25", depth: 0 }],
				});
			return undefined;
		};
		expect((await f.session.observe(f.context, f.window)).tree).toContain('sheet "" (window 11151)');
		f.state.hook = async name =>
			name === "press_key"
				? {
						text: "press_key delivery failed: exact target window did not become focused for foreground HID delivery",
						structuredJson: JSON.stringify({
							status: "refused",
							refusal: {
								code: "delivery_failed",
								message:
									"press_key delivery failed: exact target window did not become focused for foreground HID delivery",
							},
						}),
						isError: true,
						errorCode: "delivery_failed",
						images: [],
					}
				: undefined;
		await expect(
			f.session.press(f.context, f.window, "right", undefined, { delivery: "foreground" }),
		).rejects.toThrow(
			'window 11151 — a sheet attached to 1 — holds keyboard focus, not window 1; drive it with computer.window("11151") and press its own buttons.',
		);
	} finally {
		await f.close();
	}
});

it("names the sheet a same-pid keyboard refusal is about, and stays silent when none is attached", async () => {
	const f = await fixture();
	const sheet = { ...f.row, window_id: 4231, title: "New Card", bounds: { x: 30, y: 40, width: 120, height: 80 } };
	const ambiguous = {
		text: "Background input refused (same_pid_keyboard_ambiguity): pid 101 owns 1 other eligible top-level window(s); process-scoped key events cannot be proven to reach window 1",
		structuredJson: JSON.stringify({
			code: "same_pid_keyboard_ambiguity",
			effect: "refused",
			pid: 101,
			window_id: 1,
			reason:
				"pid 101 owns 1 other eligible top-level window(s); process-scoped key events cannot be proven to reach window 1",
		}),
		isError: true,
		errorCode: "same_pid_keyboard_ambiguity",
		images: [],
	};
	try {
		f.state.hook = async name => (name === "press_key" ? ambiguous : undefined);
		let bare = "";
		await f.session.press(f.context, f.window, "escape").catch((error: Error) => {
			bare = error.message;
		});
		expect(bare).toContain("same_pid_keyboard_ambiguity: Background input refused");
		expect(bare).not.toContain("holds keyboard focus");
		f.state.relatedWindows = [{ pid: 101, window_id: 4231, title: "New Card", relation: "sheet" }];
		f.state.hook = async (name, args) => {
			if (name === "press_key") return ambiguous;
			if (name === "list_windows") return reply({ windows: [f.row, sheet] });
			if (name === "get_window_state" && args.window_id === 4231)
				return reply({
					pid: 101,
					window_id: 4231,
					snapshot_id: "sheet-1",
					window_bounds: sheet.bounds,
					elements: [{ element_index: 1, element_token: "sheet-1:1", role: "AXSheet", label: "card", depth: 0 }],
				});
			return undefined;
		};
		expect((await f.session.observe(f.context, f.window)).tree).toContain('sheet "New Card" (window 4231)');
		await expect(f.session.press(f.context, f.window, "escape")).rejects.toThrow(
			'window 4231 — a sheet attached to 1 — holds keyboard focus, not window 1; drive it with computer.window("4231") and press its own buttons.',
		);
	} finally {
		await f.close();
	}
});

it("says what a disabled control's refusal actually leaves open", async () => {
	const f = await fixture();
	/** The pre-0.9.0 string, byte-identical on both rungs and in all four measured states. */
	const untyped = {
		text: 'AX action failed: refusing AXPress: the target reports AXEnabled=false. Retry this action with delivery_mode:"foreground" or call bring_to_front first',
		structuredJson: JSON.stringify({ code: "tool_invocation_failed" }),
		isError: true,
		errorCode: "tool_invocation_failed",
		images: [],
	};
	/** The typed refusal, verbatim from the driver lane's commit. */
	const disabled = (text: string, extra: Wire) => ({
		text,
		structuredJson: JSON.stringify({
			code: "element_disabled",
			effect: "not_dispatched",
			route: "ax",
			action: "AXPress",
			role: "AXButton",
			label: "Back",
			window_id: 1,
			pid: 101,
			foreground: false,
			...extra,
		}),
		isError: true,
		errorCode: "element_disabled",
		images: [],
	});
	/** The app's own panel, as `list_windows` reports it while it is up. */
	const listing = (...ids: number[]) =>
		reply({ windows: [f.row, ...ids.map(id => ({ ...f.row, window_id: id, title: "" }))] });
	try {
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		// The untypeable half of the old advice never reaches the model, whatever
		// else the reply says: there is no bring_to_front on this surface.
		f.state.hook = async name => (name === "click" ? untyped : undefined);
		const legacy = await f.session
			.click(f.context, f.window, ref, { delivery: "foreground" })
			.catch((error: unknown) => error);
		if (!(legacy instanceof ToolError)) throw new Error("Expected the legacy refusal");
		expect(legacy.message).not.toContain("bring_to_front");
		expect(legacy.message).toContain('Retry this action with { delivery: "foreground" }');
		// That reply states no state at all, so the rung the call took is the
		// only fact there is to answer it with.
		expect(legacy.message.split("\n").at(-1)).toBe(
			'That control reports AXEnabled=false with { delivery: "foreground" } already in force, so the rung is not what refused and no activation changes it: satisfy its precondition or choose another control.',
		);

		// The typed refusal states the app's own applicability itself, and no
		// route exists: OMP adds nothing rather than saying it twice.
		f.state.hook = async name =>
			name === "click"
				? disabled(
						'AXPress was not dispatched: AXButton "Back" of window 1 reports AXEnabled=false. Window 1 is already pid 101\'s front window — the application disabled this control, and neither delivery mode nor activation changes that. Satisfy its precondition or choose another control.',
						{ front_in_process: true },
					)
				: undefined;
		const inForce = await f.session.click(f.context, f.window, ref).catch((error: unknown) => error);
		if (!(inForce instanceof ToolError)) throw new Error("Expected the disabled refusal");
		expect(inForce.message.split("\n").at(-1)).toBe("Evidence: route=ax requested=background effect=not_dispatched");

		// The app's own panel in front: the reply names the window, so only the
		// calls for it are added — the one thing a driver cannot spell.
		f.state.hook = async name =>
			name === "click"
				? disabled(
						'AXPress was not dispatched: AXButton "Back" of window 1 reports AXEnabled=false, and window 17018 — pid 101\'s own front window, titleless, AXWindow/AXUnknown — is drawn in front of it. Dismiss that window, or address window 17018 and act on it there.',
						{
							front_in_process: false,
							obscured_by: {
								window_id: 17018,
								title: "",
								layer: 0,
								ax_backed: true,
								role: "AXWindow",
								subrole: "AXUnknown",
							},
						},
					)
				: name === "list_windows"
					? listing(17018)
					: undefined;
		await f.session.windows(f.context);
		const covered = await f.session.click(f.context, f.window, ref).catch((error: unknown) => error);
		if (!(covered instanceof ToolError)) throw new Error("Expected the disabled refusal");
		expect(covered.message.split("\n").at(-1)).toBe(
			'Acquire it with computer.window("17018") and act there, or dismiss it with press("Escape").',
		);

		// A panel with no accessibility surface of its own cannot be acquired,
		// so the call the other arm names is exactly what not to reach for.
		f.state.hook = async name =>
			name === "click"
				? disabled(
						'AXPress was not dispatched: AXButton "Back" of window 1 reports AXEnabled=false, and window 17013 — pid 101\'s own front window, titleless, no AX surface — is drawn in front of it. It publishes no AXWindow, so it cannot become the focused window: dismiss it, or act on it by pixel.',
						{
							front_in_process: false,
							obscured_by: { window_id: 17013, title: "", layer: 0, ax_backed: false },
						},
					)
				: undefined;
		const blind = await f.session.click(f.context, f.window, ref).catch((error: unknown) => error);
		if (!(blind instanceof ToolError)) throw new Error("Expected the disabled refusal");
		expect(blind.message.split("\n").at(-1)).toBe(
			'Dismiss it with press("Escape"); computer.window("17013") cannot acquire a window that publishes no accessibility window of its own.',
		);

		// A menu row on the untyped shape: the ref's own role is the whole
		// decision, and no rung and no window is the answer at all.
		f.state.role = "AXMenuItem";
		f.state.label = "_popUpItemAction:";
		const menuRef = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		f.state.hook = async name => (name === "click" ? untyped : undefined);
		const menu = await f.session.click(f.context, f.window, menuRef).catch((error: unknown) => error);
		if (!(menu instanceof ToolError)) throw new Error("Expected the disabled refusal");
		expect(menu.message.split("\n").at(-1)).toBe(
			"That AXMenuItem is disabled by the app's own current state: a menu row's AXEnabled tracks the command's applicability, not focus or delivery. Satisfy the command's precondition (a selection, a document, a mode) or pick another item.",
		);
	} finally {
		await f.close();
	}
});

it("offers a disabled control the window it can acquire, and the rung a not-key window needs", async () => {
	const f = await fixture();
	// T11 `native-act-notes/omp-2`: the panel named in front of the search
	// field was the capture lease's own 66×20 "Window" indicator, which this
	// roster hides — `computer.window("19083")` answered `Missing computer
	// window {"id":"19083"}`.
	const lease = { ...f.row, window_id: 19083, title: "Window", bounds: { x: 30, y: 40, width: 66, height: 20 } };
	const notKeyText =
		'AXPress was not dispatched: AXTextField "" of window 1 reports AXEnabled=false. Window 1 is not the application\'s key window. A foreground dispatch makes it key first.';
	const disabled = (
		extra: Wire,
		text = 'AXPress was not dispatched: AXTextField "" of window 1 reports AXEnabled=false, and window 19083 — pid 101\'s own front window, titled "Window", AXWindow/AXDialog — is drawn in front of it. Dismiss that window, or address window 19083 and act on it there.',
	) => ({
		text,
		structuredJson: JSON.stringify({
			code: "element_disabled",
			effect: "not_dispatched",
			route: "ax",
			action: "AXPress",
			role: "AXTextField",
			label: "",
			window_id: 1,
			pid: 101,
			foreground: false,
			front_in_process: false,
			key_window: { is_key: false, app_frontmost: true, focused_window_id: 2 },
			...extra,
		}),
		isError: true,
		errorCode: "element_disabled",
		images: [],
	});
	const obscured = {
		obscured_by: {
			window_id: 19083,
			title: "Window",
			layer: 0,
			ax_backed: true,
			role: "AXWindow",
			subrole: "AXDialog",
		},
	};
	const refused = async (extra: Wire, listed: Wire[], options?: { delivery: "foreground" }, text?: string) => {
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		f.state.hook = async name =>
			name === "click"
				? disabled(extra, text)
				: name === "list_windows"
					? reply({ windows: [f.row, ...listed] })
					: undefined;
		await f.session.windows(f.context);
		const error = await f.session.click(f.context, f.window, ref, options).catch((thrown: unknown) => thrown);
		if (!(error instanceof ToolError)) throw new Error("Expected the disabled refusal");
		return error.message;
	};
	try {
		const hidden = await refused(obscured, [lease]);
		expect(hidden).not.toContain("computer.window");
		expect(hidden.split("\n").at(-1)).toBe(
			'Dismiss it with press("Escape") — this session\'s roster holds no window 19083 to acquire.',
		);
		// The same reply about a window the roster does hold keeps the call.
		const held = await refused(obscured, [{ ...f.row, window_id: 19083, title: "Window" }]);
		expect(held.split("\n").at(-1)).toBe(
			'Acquire it with computer.window("19083") and act there, or dismiss it with press("Escape").',
		);
		// The 0.9.0 arm for the state that was really refusing: no panel of the
		// app's own, the window is not key, and the rung is what makes it key.
		const notKey = await refused(
			{ escalation: { target: "foreground", reason: "route_unavailable" } },
			[lease],
			undefined,
			notKeyText,
		);
		expect(notKey.split("\n").at(-1)).toBe(
			'retry with { delivery: "foreground" } — the window is not the app\'s key window and a foreground dispatch makes it key first.',
		);
		// Already on that rung: it is not a route to offer twice.
		const spent = await refused(
			{ escalation: { target: "foreground", reason: "route_unavailable" } },
			[lease],
			{ delivery: "foreground" },
			notKeyText,
		);
		expect(spent).not.toContain('delivery: "foreground" } —');
		expect(spent.split("\n").at(-1)).toBe(
			"Evidence: route=ax requested=foreground effect=not_dispatched escalation=foreground",
		);
	} finally {
		await f.close();
	}
});
it("names the app's own panel that reveal() cannot get past", async () => {
	const f = await fixture();
	// AdviceMatrix, both apps: process activated, target focused, and the
	// app's own panel in front — reported where `#focusHolder` never looked.
	const behind = (extra: Wire, error?: boolean) => ({
		text: "bring_to_front: exact window 1 for pid 101 was not verified as the frontmost process's focused, front window (request_accepted=true, process_activated=true, focused=true, front_in_process=false).",
		structuredJson: JSON.stringify({
			code: error
				? "bring_to_front_exact_window_unverified"
				: "bring_to_front_exact_window_verified_behind_owned_panel",
			activated: true,
			status: "partial",
			observed: { focused_window_id: 1, process_frontmost_ordinary_window_id: 17013, frontmost_pid: 101 },
			...extra,
		}),
		isError: error === true,
		...(error === true ? { errorCode: "bring_to_front_exact_window_unverified" } : {}),
		images: [],
	});
	/** Both owned panels are rows of the app's own listing while they are up. */
	const panels = async (name: string) =>
		name === "list_windows"
			? reply({ windows: [f.row, ...[17013, 17018].map(id => ({ ...f.row, window_id: id, title: "" }))] })
			: undefined;
	try {
		f.state.hook = panels;
		await f.session.windows(f.context);
		// The id alone is enough to name the window and the call for it.
		f.state.hook = async name => (name === "bring_to_front" ? behind({}, true) : panels(name));
		const refused = await f.session.raise(f.context, f.window).catch((error: unknown) => error);
		if (!(refused instanceof ToolError)) throw new Error("Expected the raise refusal");
		expect(refused.message.split("\n").at(-1)).toBe(
			'window 17013 (untitled) is pid 101\'s own window, drawn in front of window 1: acquire it with computer.window("17013") and act there, or dismiss it with press("Escape"). Pixel targets on window 1 stay covered until it goes away.',
		);
		// A panel with no accessibility window of its own can never be focused,
		// so activating anything is not the route.
		f.state.hook = async name =>
			name === "bring_to_front"
				? behind({
						obscured_by: {
							window_id: 17016,
							title: "",
							layer: 0,
							ax_backed: false,
							role: "",
							subrole: "",
						},
					})
				: panels(name);
		const verified = await f.session.raise(f.context, f.window);
		expect(verified.text.split("\n").at(-1)).toBe(
			'window 17016 (untitled) is pid 101\'s own front window and publishes no accessibility window, so it can never become the focused one and reveal() cannot move it: dismiss it with press("Escape") or act on its pixels.',
		);
		// Once the reply's own prose names that window — which the 0.9.0
		// behind-owned-panel result does — only the calls for it are added.
		f.state.hook = async name =>
			name === "bring_to_front"
				? {
						text: "Brought exact window 1 for pid 101 to the foreground; pid 101's own window 17018 (titleless, AXWindow/AXUnknown) is drawn in front of it. Act on window 17018, or dismiss it — pixel targets on window 1 are covered until then.",
						structuredJson: JSON.stringify({
							code: "bring_to_front_exact_window_verified_behind_owned_panel",
							activated: true,
							status: "activated_behind_owned_panel",
							exact_window_effect: { front_in_process: false },
							observed: { focused_window_id: 1, process_frontmost_ordinary_window_id: 17018 },
							obscured_by: {
								window_id: 17018,
								title: "",
								layer: 0,
								ax_backed: true,
								role: "AXWindow",
								subrole: "AXUnknown",
							},
						}),
						isError: false,
						images: [],
					}
				: panels(name);
		const named = await f.session.raise(f.context, f.window);
		expect(named.text.split("\n").at(-1)).toBe(
			'Acquire it with computer.window("17018") and act there, or dismiss it with press("Escape").',
		);
		// Nothing in front: nothing said.
		f.state.hook = async name =>
			name === "bring_to_front"
				? {
						text: "Brought exact window 1 for pid 101 to the foreground.",
						structuredJson: JSON.stringify({
							code: "bring_to_front_exact_window_verified",
							activated: true,
							observed: { focused_window_id: 1, process_frontmost_ordinary_window_id: 1 },
						}),
						isError: false,
						images: [],
					}
				: panels(name);
		expect((await f.session.raise(f.context, f.window)).text).toBe(
			"Brought exact window 1 for pid 101 to the foreground.",
		);
	} finally {
		await f.close();
	}
});

it("keeps an attached sheet's whole subtree when the caller narrows the parent walk", async () => {
	const f = await fixture();
	const sheet = { ...f.row, window_id: 5, title: "Save", bounds: { x: 30, y: 40, width: 120, height: 80 } };
	try {
		f.state.relatedWindows = [{ pid: 101, window_id: 5, title: "Save", relation: "sheet" }];
		f.state.hook = async (name, args) => {
			if (name === "list_windows") return reply({ windows: [f.row, sheet] });
			if (name !== "get_window_state" || args.window_id !== 5) return undefined;
			return reply({
				pid: 101,
				window_id: 5,
				snapshot_id: "sheet-1",
				window_bounds: sheet.bounds,
				elements: [
					{ element_index: 1, element_token: "sheet-1:1", role: "AXSheet", label: "save", depth: 0 },
					{ element_index: 2, element_token: "sheet-1:2", role: "AXButton", label: "Cancel", depth: 1 },
				],
			});
		};
		const observation = await f.session.observe(f.context, f.window, { maxDepth: 1, query: "Editor" });
		expect(observation.tree).toContain('- [n3] AXButton "Cancel"');
		// The parent walk carries the narrowing; the sheet's does not.
		expect(f.calls.filter(call => call.name === "get_window_state").map(call => call.args)).toEqual([
			{
				pid: 101,
				window_id: 1,
				include_accessibility_tree: true,
				include_screenshot: false,
				max_depth: 1,
				query: "Editor",
			},
			{ pid: 101, window_id: 5, include_accessibility_tree: true, include_screenshot: false },
		]);
	} finally {
		await f.close();
	}
});

it("reports an attached sheet it cannot walk instead of dropping it from the tree", async () => {
	const f = await fixture();
	try {
		f.state.relatedWindows = [{ pid: 202, window_id: 42, title: "Import", relation: "sheet" }];
		const observation = await f.session.observe(f.context, f.window);
		expect(observation.relatedWindows).toEqual([{ pid: 202, id: "42", title: "Import", relation: "sheet" }]);
		expect(observation.tree).toContain(
			'sheet "Import" (window 42) — modal over window 1 — its own walk failed: Missing computer window',
		);
		expect(observation.elements).toHaveLength(1);
		expect(observation.elements[0]!.label).toBe("Editor");
	} finally {
		await f.close();
	}
});

it("rejects malformed attached sheet identities instead of suggesting an ambiguous target", async () => {
	const f = await fixture();
	try {
		for (const invalid of [
			{},
			[{ pid: 0, window_id: 42, title: "Import", relation: "sheet" }],
			[{ pid: 202, window_id: 1.5, title: "Import", relation: "sheet" }],
			[{ pid: 202, window_id: 42, title: "Import", relation: "window" }],
		]) {
			f.state.relatedWindows = invalid;
			await expect(f.session.observe(f.context, f.window)).rejects.toThrow("Malformed Cua related window");
		}
	} finally {
		await f.close();
	}
});

it("preserves uncertain action replies and reads the resulting state without repeating the mutation", async () => {
	const f = await fixture();
	const details = {
		error: "ActionOutcomeUnknown",
		effect: "unverifiable",
		dispatch: "attempted",
		action: "AXPress",
		ax_error: -25205,
		retry: "reconcile_first",
	};
	try {
		const before = await f.session.observe(f.context, f.window);
		f.state.hook = async name => {
			if (name !== "click") return undefined;
			f.state.value = "Saved once";
			return {
				text: "Action may have taken effect; inspect the saved result before retrying",
				isError: true,
				images: [],
				structuredJson: JSON.stringify(details),
			};
		};
		const failure = await f.session
			.click(f.context, f.window, before.elements[0].ref)
			.catch((error: unknown) => error);
		if (!(failure instanceof ToolError)) throw new Error("Expected the uncertain SDK reply");
		expect(failure.message).toContain("ActionOutcomeUnknown");
		expect(failure.context).toEqual(details);
		const after = await f.session.observe(f.context, f.window);
		expect(after.elements[0].value).toBe("Saved once");
		expect(f.calls.filter(call => call.name === "click")).toHaveLength(1);
	} finally {
		await f.close();
	}
});

it("keeps deadline-limited observations partial and exposes the reason with known controls", async () => {
	const f = await fixture();
	try {
		f.state.hook = async name =>
			name === "get_window_state"
				? reply({
						pid: 101,
						window_id: 1,
						snapshot_id: "partial",
						elements_complete: true,
						ax_walk_timed_out: true,
						elements: [{ element_token: "partial:0", role: "AXStaticText", label: "Saved" }],
					})
				: undefined;
		const observation = await f.session.observe(f.context, f.window);
		expect(observation.complete).toBe(false);
		expect(observation.elements[0].label).toBe("Saved");
		expect(observation.tree).toContain("time limit");
		expect(f.calls.filter(call => call.name === "get_window_state")).toHaveLength(1);
		f.state.hook = async name =>
			name === "get_window_state"
				? reply({
						pid: 101,
						window_id: 1,
						snapshot_id: "failed-request",
						elements_complete: true,
						ax_walk_timed_out: false,
						ax_walk_stop_reason: { reason: "native_request_failed", code: -25204 },
						elements: [],
					})
				: undefined;
		const interrupted = await f.session.observe(f.context, f.window);
		expect(interrupted.complete).toBe(false);
		expect(interrupted.tree).toContain("native request could not complete");
		expect(interrupted.tree).not.toContain("time limit");
	} finally {
		await f.close();
	}
});

it("uses reported background capabilities instead of advertising a known refused action", async () => {
	const f = await fixture();
	try {
		f.state.actions = ["AXOpen", "AXConfirm"];
		f.state.backgroundActions = ["AXConfirm"];
		let observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.actions).toEqual(["confirm"]);
		f.state.backgroundActions = [];
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.actions).toBeUndefined();
		f.state.backgroundActions = "AXConfirm";
		await expect(f.session.observe(f.context, f.window)).rejects.toThrow("Malformed Cua background actions");
	} finally {
		await f.close();
	}
});

it("maps each backend's own permission report without inventing the other's fields", async () => {
	const linux = await fixture({ platform: "linux" });
	const darwin = await fixture();
	try {
		expect(linux.session.capabilities).toMatchObject({
			displayServer: "x11",
			capture: true,
			input: true,
			ax: true,
			backgroundWindowInput: true,
			capturePermission: "not-applicable",
			axPermission: "not-applicable",
			permissions: LINUX.permissions,
		});
		expect(darwin.session.capabilities).toMatchObject({
			displayServer: "macos",
			capture: true,
			ax: true,
			capturePermission: "granted",
			permissions: { accessibility: true, screen_recording: true },
		});
	} finally {
		await Promise.all([linux.close(), darwin.close()]);
	}
});

it("keeps a Linux roster addressable: no layer claimed, unowned windows dropped", async () => {
	const f = await fixture({ platform: "linux" });
	try {
		const windows = await f.session.windows(f.context, {});
		// The `pid: null` row (8388610) names no process any driver call could address.
		expect(windows.map(window => window.id)).toEqual(["4194316", "6291459"]);
		expect(windows.map(window => window.layer)).toEqual([undefined, undefined]);
		expect(f.window).toMatchObject({ id: "6291459", pid: 1167788, app: "Google-chrome", onScreen: true });
	} finally {
		await f.close();
	}
});

it("refuses a Linux session without X11 using the driver's own report, and only on Linux", async () => {
	const text = "X11 display: ❌ cannot open display :99\nAT-SPI (D-Bus): ✅ org.a11y.Bus reachable";
	const kills: string[] = [];
	const spawn = (label: string) => async (): Promise<CuaDriver> => ({
		version: "0.28.0",
		pid: 901,
		alive: true,
		async callTool() {
			return {
				text,
				isError: false,
				images: [],
				structuredJson: JSON.stringify({ ...LINUX.permissions, x11: false }),
			};
		},
		async kill() {
			kills.push(label);
		},
	});
	await expect(CuaComputerSession.create({ platform: "linux", spawn: spawn("linux") })).rejects.toThrow(
		"cannot open display :99",
	);
	expect(kills).toEqual(["linux"]);
	// macOS keys off its own grants; an unrelated X11 key must not gate it.
	const macos = await CuaComputerSession.create({ platform: "darwin", spawn: spawn("darwin") });
	expect(macos.capabilities.capture).toBe(false);
	await macos.close();
});

it("surfaces both Linux refusals verbatim and restates their route in prelude vocabulary", async () => {
	const f = await fixture({ platform: "linux" });
	try {
		f.state.hook = async name =>
			name === "type_text"
				? {
						text: LINUX.refusal.text,
						isError: true,
						images: [],
						errorCode: LINUX.refusal.code,
						structuredJson: JSON.stringify({
							code: LINUX.refusal.code,
							detail: LINUX.refusal.detail,
							escalation: LINUX.refusal.escalation,
							suggestion: LINUX.refusal.suggestion,
						}),
					}
				: undefined;
		const refused = await f.session.type(f.context, f.window, "echo hi\n").catch((error: unknown) => error);
		if (!(refused instanceof ToolError)) throw new Error("Expected the background refusal");
		expect(refused.message).toStartWith("background_unavailable: Background delivery is not available:");
		expect(refused.message).toContain("no focus-free input backend");
		expect(refused.message).toContain('{ delivery: "foreground" }');
		// The driver's wire vocabulary never reaches the model as advice it cannot type.
		expect(refused.message).not.toContain("delivery_mode");
		// The structured reason stays exactly as the driver reported it.
		expect(refused.context).toMatchObject({ code: "background_unavailable", suggestion: LINUX.refusal.suggestion });
		// A refusal is not a retry: nothing was dispatched and nothing re-sent.
		expect(f.calls.filter(call => call.name === "type_text")).toHaveLength(1);
		f.state.hook = async name =>
			name === "press_key"
				? {
						text: LINUX.foregroundRefusal.text,
						isError: true,
						images: [],
						errorCode: LINUX.foregroundRefusal.code,
						structuredJson: JSON.stringify({
							code: LINUX.foregroundRefusal.code,
							detail: LINUX.foregroundRefusal.detail,
						}),
					}
				: undefined;
		const blocked = await f.session
			.press(f.context, f.window, "Return", undefined, { delivery: "foreground" })
			.catch((error: unknown) => error);
		if (!(blocked instanceof ToolError)) throw new Error("Expected the foreground refusal");
		expect(blocked.message).toStartWith("foreground_unavailable:");
		expect(blocked.message).toContain("no EWMH-compliant window manager");
		expect(f.calls.filter(call => call.name === "press_key")).toHaveLength(1);
	} finally {
		await f.close();
	}
});

it("keeps the driver's own post-action evidence in the error a refused action throws", async () => {
	const f = await fixture();
	try {
		const observation = await f.session.observe(f.context, f.window);
		f.state.hook = async name =>
			name === "click"
				? {
						text: "AX press refused: the element reports no press action.",
						isError: true,
						images: [],
						errorCode: "action_refused",
						structuredJson: JSON.stringify({
							code: "action_refused",
							route: "accessibility",
							effect: "refused",
							escalation: { reason: "delivery_failed", target: "foreground" },
						}),
					}
				: undefined;
		const refused = await f.session
			.click(f.context, f.window, observation.elements[0]!.ref)
			.catch((error: unknown) => error);
		if (!(refused instanceof ToolError)) throw new Error("Expected the refusal");
		expect(refused.message).toStartWith("action_refused: AX press refused:");
		// One line, off the reply that already arrived: no second walk was made.
		// The reply named no rung of its own, so the line reports the one the
		// call asked for as a fact about the call.
		expect(refused.message.split("\n").at(-1)).toBe(
			"Evidence: route=accessibility requested=background effect=refused escalation=foreground",
		);
		expect(f.calls.filter(call => call.name === "click")).toHaveLength(1);
		expect(f.lastDispatch()).toMatchObject({ name: "click" });
	} finally {
		await f.close();
	}
});

it("prints only the evidence fields a refusal carries", async () => {
	const f = await fixture();
	// T5 `native-act-contacts/omp-2` step 7, verbatim: a submenu listing that
	// reached the projection check. No route, no rung — `invoke_menu` has no
	// delivery input at all — and no effect, yet the line claimed all three.
	const mismatch = {
		text: "internal action outcome mismatch for invoke_menu: successful action omitted its internal execution record; the tool may have executed. Verify state before retrying.",
		structuredJson: JSON.stringify({
			code: "action_outcome_mismatch",
			detail: "successful action omitted its internal execution record",
			execution_state: "unknown",
			tool: "invoke_menu",
		}),
		isError: true,
		errorCode: "action_outcome_mismatch",
		images: [],
	};
	// T4 `native-act-reminders/omp-2` step 4, verbatim.
	const dead = {
		text: "Background input refused (element_outside_target_window): the addressed element could not be proven to belong to window 14229; take a fresh get_window_state snapshot and re-address it",
		structuredJson: JSON.stringify({
			code: "element_outside_target_window",
			effect: "refused",
			escalation: {
				reason:
					"the addressed element could not be proven to belong to window 14229; take a fresh get_window_state snapshot and re-address it",
				recommended: "get_window_state",
			},
			pid: 82791,
			reason:
				"the addressed element could not be proven to belong to window 14229; take a fresh get_window_state snapshot and re-address it",
			window_id: 14229,
		}),
		isError: true,
		errorCode: "element_outside_target_window",
		images: [],
	};
	try {
		f.state.hook = async name => (name === "invoke_menu" ? mismatch : undefined);
		const menu = await f.session
			.menu(f.context, f.window, ["Card", "Add Field"], { delivery: "foreground" })
			.catch((error: unknown) => error);
		if (!(menu instanceof ToolError)) throw new Error("Expected the menu refusal");
		expect(menu.message).toStartWith("action_outcome_mismatch: internal action outcome mismatch");
		expect(menu.message).not.toContain("Evidence:");
		expect(menu.message).not.toContain("cua-sdk");
		expect(menu.message).not.toContain("delivery=background");
		expect(menu.message).not.toContain("effect=refused");

		// The payload is what is under test here; a ref-scoped call on this code
		// is answered with the window's own tree instead of a throw, which its
		// own test covers.
		await f.session.observe(f.context, f.window, { screenshot: true, silent: true });
		f.state.hook = async name => (name === "click" ? dead : undefined);
		const click = await f.session.click(f.context, f.window, [1, 0]).catch((error: unknown) => error);
		if (!(click instanceof ToolError)) throw new Error("Expected the click refusal");
		// `effect` is the reply's own; the route is absent, so none is invented.
		// `get_window_state` is a tool this surface does not expose: the line
		// carries the contract target that names a call the caller can type.
		expect(click.message.split("\n").at(-1)).toBe(
			"Evidence: requested=background effect=refused escalation=snapshot",
		);
		expect(click.message).not.toContain("escalation=get_window_state");
		expect(click.message).not.toContain("route=");

		// `px` is the driver's older spelling of the pixel target; the line
		// carries the contract name so the route renderer recognises it.
		const px = {
			...dead,
			structuredJson: JSON.stringify({
				code: "element_outside_target_window",
				effect: "refused",
				escalation: { reason: "no accessibility route", recommended: "px" },
			}),
		};
		f.state.hook = async name => (name === "click" ? px : undefined);
		const pixel = await f.session.click(f.context, f.window, [1, 0]).catch((error: unknown) => error);
		if (!(pixel instanceof ToolError)) throw new Error("Expected the click refusal");
		expect(pixel.message.split("\n").at(-1)).toBe("Evidence: requested=background effect=refused escalation=pixel");
	} finally {
		await f.close();
	}
});

it("reads a Linux capture and tree that report neither a frame flag nor an exhaustive walk", async () => {
	const f = await fixture({ platform: "linux" });
	try {
		const observation = await f.session.observe(f.context, f.window, { screenshot: true });
		// `elements_complete` is hard-coded false on Linux; equal counts carry the answer.
		expect(observation.complete).toBe(true);
		expect(observation.tree).not.toContain("completeness is unknown");
		expect(observation.elements[0]!.actions).toEqual(["press", "showContextMenu"]);
		// No `screenshot_frame_valid` key at all, and the pixels are still usable.
		expect(observation.screenshotError).toBeUndefined();
		expect(observation.screenshot?.target).toBe("6291459");
		f.state.hook = async name =>
			name === "get_window_state"
				? reply({
						pid: 1167788,
						window_id: 6291459,
						snapshot_id: "s00000002",
						elements_complete: false,
						returned_element_count: 1,
						total_element_count: 182,
						elements: [{ element_index: 0, element_token: "s00000002:0", role: "frame", label: "B3", depth: 0 }],
						window_bounds: LINUX.chrome.bounds,
					})
				: undefined;
		const clipped = await f.session.observe(f.context, f.window);
		expect(clipped.complete).toBe(false);
		f.state.hook = undefined;
		f.state.failCapture = true;
		const failed = await f.session.observe(f.context, f.window, { screenshot: true });
		expect(failed.screenshotError).toContain("Screenshot unavailable");
	} finally {
		await f.close();
	}
});

it("answers every contracted tool with a payload upstream's success schema accepts", async () => {
	const schemas = new Map(
		(contract.tools as { name: string; success_output_schema?: unknown }[])
			.filter(tool => tool.success_output_schema !== undefined)
			.map(tool => [tool.name, fromJsonSchema(tool.success_output_schema)] as const),
	);
	for (const platform of ["darwin", "linux"] as const) {
		const f = await fixture({ platform });
		try {
			await f.session.observe(f.context, f.window, { screenshot: true });
			await f.session.click(f.context, f.window, [1, 0]);
			await f.session.type(f.context, f.window, "hi");
			await f.session.press(f.context, f.window, "Return");
			await f.session.scroll(f.context, f.window, "down");
			await f.session.apps(f.context);
			await f.session.screenshot(f.context, { silent: true });
			const contracted = f.replies.filter(({ name }) => schemas.has(name));
			// list_windows, get_window_state, list_apps, get_screen_size,
			// get_desktop_state and the four input tools.
			expect(new Set(contracted.map(({ name }) => name)).size).toBeGreaterThanOrEqual(8);
			for (const { name, data } of contracted) {
				const validated = schemas.get(name)!(data);
				expect(validated instanceof type.errors ? `${name}: ${validated.summary}` : name).toBe(name);
			}
		} finally {
			await f.close();
		}
	}
});

it("leads with the menu command a chord was dispatched as and never names the foreground rung for it", async () => {
	const f = await fixture();
	const pressed = async (data: Wire, text: string) => {
		f.state.hook = async name =>
			name === "hotkey"
				? { text, structuredJson: JSON.stringify(wireResult(data)), isError: false, images: [] }
				: undefined;
		return f.session.press(f.context, f.window, "cmd+option+f");
	};
	// Recorded from the fork build on Notes (2026-09-19): the app was fronted,
	// the search field took focus while the window was key and released it
	// when the prior frontmost came back.
	const fronted =
		"Dispatched cmd+option+f to pid 101 as its menu command Edit > Find > Note List Search…: the application keeps that item disabled until window 1 is key, so the chord itself could not land there. pid 101 was not the frontmost application, so it was fronted and window 1 made key for the dispatch, then the prior frontmost was restored.\n🔎 Delivered: app_focus changed after the dispatch, so the app reacted. That is delivery, not the intended result — check the postcondition you wanted. ⚠️ That change (app_focus) did not survive restoring the prior frontmost: the command's effect holds only while window 1 is key. Re-sending the chord on any delivery mode lands nothing new — address the control the command targets directly, or raise the window first and keep it key.";
	const menu = {
		delivery: { mode: "foreground" },
		effect: "unverifiable",
		evidence: [{ kind: "observed_change", signal: "app_focus" }],
		menu_path: ["Edit", "Find", "Note List Search…"],
		route: "menu_command",
	};
	try {
		f.state.role = "AXTextField";
		f.state.subrole = "AXSearchField";
		f.state.enabled = true;
		const observed = await f.session.observe(f.context, f.window);
		const field = observed.elements[0]!.ref;
		const reverted = await pressed(
			{ ...menu, escalation: { reason: "route_unavailable", target: "element" } },
			fronted,
		);
		expect(reverted.text.split("\n")[0]).toBe(
			"Delivered as menu command Edit > Find > Note List Search… (app fronted: yes)",
		);
		expect(reverted.menuPath).toEqual(["Edit", "Find", "Note List Search…"]);
		expect(reverted.route).toBe("menu_command");
		expect(reverted.escalation).toBe(
			`⚠️ The driver escalates this action (route_unavailable): address the field itself: win.ref(${JSON.stringify(field)}).type("<text>") or win.ref(${JSON.stringify(field)}).setValue("<value>"), or raise the window (win.raise()) and keep it key before re-running.`,
		);
		expect(reverted.text).not.toContain('{ delivery: "foreground" }');
		// The same-app case: only the window was made key, and the change held.
		const held = await pressed(
			menu,
			"Dispatched cmd+option+l to pid 101 as its menu command Window > Arrange > Left: the application keeps that item disabled until window 1 is key, so the chord itself could not land there. window 1 was not pid 101's key window, so it was made key for the dispatch, then the prior frontmost was restored.\n🔎 Delivered: window_tree changed after the dispatch, so the app reacted. That is delivery, not the intended result — check the postcondition you wanted. That change is still in place after the restore.",
		);
		expect(held.text.split("\n")[0]).toBe(
			"Delivered as menu command Edit > Find > Note List Search… (app fronted: no)",
		);
		expect(held.escalation).toBeUndefined();
		// No reaction at all: the rung that would make the window key is the one
		// that just ran, so the advice is the field or a read, never foreground.
		const inert = await pressed(
			{ ...menu, effect: "suspected_noop", evidence: null },
			"Dispatched cmd+option+f to pid 101 as its menu command Edit > Find > Note List Search…: the application keeps that item disabled until window 1 is key, so the chord itself could not land there. window 1 was already key.\n⚠️ Unverified: the target was watched for 500 ms after the dispatch and nothing changed (focused element, app focus, window contents) — re-observe before repeating. The dispatch may still have landed, so a second call could act twice.",
		);
		expect(inert.text.split("\n")[0]).toBe(
			"Dispatched as menu command Edit > Find > Note List Search… (app fronted: no)",
		);
		expect(inert.escalation).toContain("as the menu command Edit > Find > Note List Search… with the window key");
		expect(inert.escalation).not.toContain("foreground");
		// The remembered-rung machinery is untouched: a menu-command reply names
		// no foreground escalation, so the next chord stays background.
		await pressed(
			{ delivery: { mode: "background" }, effect: "unverifiable", route: "synthetic_events" },
			"Pressed cmd+option+f on pid 101.",
		);
		expect(f.calls.at(-1)?.args.delivery_mode).toBeUndefined();
	} finally {
		await f.close();
	}
});
