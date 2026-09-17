import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromJsonSchema, type } from "@oh-my-pi/omptype";
import type { DesktopSystemWindow } from "@oh-my-pi/pi-natives";
import { CuaComputerSession } from "@oh-my-pi/pi-coding-agent/tools/computer/cua-session";
import type { CuaDriver, CuaToolResult } from "@oh-my-pi/pi-coding-agent/tools/computer/driver";
import { ToolAbortError, ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import type {
	ComputerImage,
	ComputerOperationContext,
	ComputerPoint,
} from "@oh-my-pi/pi-coding-agent/tools/computer/types";
import type { WindowRosterSample } from "@oh-my-pi/pi-coding-agent/tools/computer/interruption";
/** Upstream's generated tool contract at `e7e141ae` (`libs/cua-driver/contract/manifest.json`). */
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
							enabled: false,
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
		expect(observation.tree).toContain(
			"69 row(s) are scrolled out of view and were not read. Scroll the list or use the window's search field to reach them.",
		);
		// A skipped row is a clipped walk, whatever the element counts say.
		expect(observation.complete).toBe(false);
		// Nothing was skipped: neither surface says anything about scrolling.
		collapsed = 0;
		const whole = await f.session.observe(f.context, f.window);
		expect(whole.tree).not.toContain("scrolled out of view");
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
						evidence: { kind: "post_action_tree_digest", detail: "the target was watched for 2011 ms" },
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

it("reports whether a written value survived the app's own end-of-edit", async () => {
	const f = await fixture();
	try {
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		const write = async (data: Wire, text: string) => {
			f.state.hook = async name =>
				name === "set_value"
					? { text, structuredJson: JSON.stringify(data), isError: false, images: [] }
					: undefined;
			return f.session.setValue(f.context, f.window, ref, "Project_File_List");
		};
		const lost = await write(
			{ committed: false },
			"📨 Sent (unverified) AXValue on [1] AXTextArea. Not committed: a multi-line AXTextArea has no end-of-edit gesture, so the app may never register the write.",
		);
		expect(lost.committed).toBe(false);
		expect(lost.text).toContain(
			"committed=false — a multi-line AXTextArea has no end-of-edit gesture, so the app may never register the write",
		);
		expect(lost.text).toContain("read it back before relying on it");
		const kept = await write({ committed: true }, "✅ Set AXValue on [1] AXTextField. Committed via tab.");
		expect(kept.committed).toBe(true);
		expect(kept.text).toContain("committed=true");
		// The flag stands on its own when the driver states no reason.
		const bare = await write({ committed: false }, "📨 Sent (unverified) AXValue on [1] AXTextField.");
		expect(bare.text).toContain("committed=false — the driver reported no reason");
		// Contract-optional: a driver that reports no flag renders none.
		const silent = await write({ effect: "unverifiable" }, "✅ Set AXValue on [1] AXSlider.");
		expect(silent.committed).toBeUndefined();
		expect(silent.text).toBe("✅ Set AXValue on [1] AXSlider.");
	} finally {
		await f.close();
	}
});

it("carries a write nothing proved into the next observation of its own window", async () => {
	const f = await fixture();
	const observed = async () => (await f.session.observe(f.context, f.window)).elements[0]!.ref;
	const written = (data: Wire) => {
		f.state.hook = async name => (name === "set_value" ? reply(data) : undefined);
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
			`setValue on ${dropped} "Editor" is not proven committed — re-read the field before building on it`,
		);
		// Spent by that read: it is the re-read the sentence asked for.
		expect((await f.session.observe(f.context, f.window)).tree).not.toContain("not proven committed");
		// Proof is the driver's own verdict on a reply that read the value back
		// and names no better route.
		written({ committed: true, effect: "confirmed", evidence: [{ kind: "value_readback" }] });
		expect((await f.session.setValue(f.context, f.window, await observed(), "Project_File_List.txt")).committed).toBe(
			true,
		);
		expect((await f.session.observe(f.context, f.window)).tree).not.toContain("not proven committed");
		written({
			committed: true,
			effect: "confirmed",
			escalation: { reason: "delivery_failed", target: "foreground" },
		});
		await f.session.setValue(f.context, f.window, await observed(), "Project_File_List.txt");
		expect((await f.session.observe(f.context, f.window)).tree).toContain("setValue on n");
		// `type` reports no commit flag at all, and answered `confirmed` for the
		// one write Automator took and for the three it ignored.
		f.state.hook = undefined;
		const typed = await observed();
		await f.session.type(f.context, f.window, "Project_File_List.txt", typed);
		await f.session.type(f.context, f.window, "Project_File_List.txt", typed);
		const carried = await f.session.observe(f.context, f.window);
		expect(carried.tree.split("\n")[0]).toBe(
			`type on ${typed} "Editor" is not proven committed — re-read the field before building on it`,
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
		expect((await f.session.observe(f.context, f.window)).tree.split("\n")[0]).toBe(
			`type on ${partial} "Editor" is not proven committed — re-read the field before building on it`,
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
		expect((await f.session.observe(f.context, other)).tree).not.toContain("not proven committed");
		f.texts.length = 0;
		await f.session.captureWindow(f.context, other);
		expect(f.texts).toEqual([]);
		// A capture has no text of its own, so the doubt is pushed into the cell.
		await f.session.captureWindow(f.context, f.window);
		expect(f.texts).toEqual([
			`setValue on ${ref} "Save as:" is not proven committed — re-read the field before building on it`,
		]);
		f.texts.length = 0;
		await f.session.captureWindow(f.context, f.window);
		expect(f.texts).toEqual([]);
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
		// remembered route corrects it rather than staying quiet.
		const named = await pressed(
			{ effect: "unverifiable", escalation: { recommended: "foreground" } },
			'⚠️ Unverified. To deliver a real click, click this control\'s pixel center with delivery_mode:"foreground".',
		);
		expect(named.text).toContain('{ delivery: "foreground" }');
		expect(named.text).not.toContain("delivery_mode");
		expect(named.escalation).toContain("now take the foreground route");
		// A rung this surface cannot type is not turned into advice.
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
		expect(typed.text).toContain("re-run it as-is; this window's keystrokes now take the foreground route");
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
		expect(watched.text).toContain("the driver saw no change within 505 ms — observe() once");
		expect(watched.text).toContain("if the tree is unchanged, click the control's own centre off a screenshot");
		expect(watched.text.indexOf("observe() once")).toBeLessThan(watched.text.indexOf("off a screenshot"));
		// A driver that says how long it watched is quoted the same way.
		const settled = await dispatched(
			"⚠️ Unverified: the target was watched for 2000 ms after the dispatch and nothing changed.",
		);
		expect(settled.text).toContain("the driver saw no change within 2000 ms — observe() once");
		// No window in the reply: the doubt is still named, without a number.
		const bare = await dispatched('✅ Performed AXPress on [15] AXMenuButton "".');
		expect(bare.text).toContain("the driver could not confirm this landed — observe() once");
		expect(bare.text).not.toContain(" ms");
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
		await expect(f.session.click(f.context, f.window, first.elements[0]!.ref)).rejects.toThrow("StaleRef");
		f.row.pid = 102;
		await expect(f.session.type(f.context, f.window, "no")).rejects.toThrow("Missing");
		expect(f.calls.some(call => call.name === "click" || call.name === "type_text")).toBe(false);
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
		expect(refused.message.split("\n").at(-1)).toBe(
			"Evidence: route=accessibility delivery=background effect=refused escalation=foreground",
		);
		expect(f.calls.filter(call => call.name === "click")).toHaveLength(1);
		expect(f.lastDispatch()).toMatchObject({ name: "click" });
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
