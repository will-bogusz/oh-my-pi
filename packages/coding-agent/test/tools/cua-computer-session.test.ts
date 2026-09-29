import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromJsonSchema, type } from "@oh-my-pi/omptype";
import type { DesktopSystemWindow } from "@oh-my-pi/pi-natives";
import { appNote } from "@oh-my-pi/pi-coding-agent/tools/computer/app-notes";
import { actionMark } from "@oh-my-pi/pi-coding-agent/tools/computer/cell-reply";
import { CuaComputerSession } from "@oh-my-pi/pi-coding-agent/tools/computer/cua-session";
import type { CuaDriver, CuaToolResult } from "@oh-my-pi/pi-coding-agent/tools/computer/driver";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type {
	ComputerImage,
	ComputerOperationContext,
	ComputerPoint,
	ObserveOptions,
} from "@oh-my-pi/pi-coding-agent/tools/computer/types";
import type { WindowRosterSample } from "@oh-my-pi/pi-coding-agent/tools/computer/interruption";
/**
 * The fork's generated tool contract (`libs/cua-driver/contract/manifest.json`,
 * 0.11.0), copied verbatim from `cargo run -p cua-driver-contract --bin
 * cua-contract-gen -- manifest`.
 */
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
function systemWindow(row: { id: string; title: string; zIndex?: number; app?: string; pid?: number }): DesktopSystemWindow {
	return {
		id: row.id,
		pid: row.pid ?? 101,
		app: row.app ?? "Fixture",
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

async function fixture(options: { platform?: NodeJS.Platform; bundles?: Record<number, string | undefined> } = {}) {
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
		/** WindowServer sample, or the sample each read answers with; absent means macOS reported no roster at all. */
		roster: undefined as WindowRosterSample | (() => WindowRosterSample | undefined) | undefined,
		/** How often the session asked the platform for that sample. */
		rosterReads: 0,
		failCapture: false,
		/**
		 * The rect a capture's pixels cover. Absent is the ordinary case —
		 * the window's own frame — and present is the fork's report that the
		 * window server drew a popover or menu into the same capture.
		 */
		captureContent: undefined as { x: number; y: number; width: number; height: number } | undefined,
		/** Pixels the driver delivered for that rect. */
		captureSize: { width: 4, height: 2 },
		wrongIdentity: false,
		kills: 0,
		cancelled: [] as string[],
		displayIdentity: true,
		display: { uuid: "display-uuid", nativeId: 7, x: 0, y: 0, width: 2, height: 1, scale: 2 },
		hook: undefined as ((name: string, args: Wire) => Promise<CuaToolResult | undefined>) | undefined,
		/** Pids whose bundle id the session asked for. */
		bundleReads: [] as number[],
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
					...(state.captureContent === undefined
						? {}
						: { screenshot_content_bounds: state.captureContent }),
					screenshot_width: state.captureSize.width,
					screenshot_height: state.captureSize.height,
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
	/** A backend over the same fake driver, as each turn's supervisor builds one. */
	const create = () =>
		CuaComputerSession.create({
			platform,
			spawn: async () => {
				live = true;
				return driver;
			},
			sampleRoster: () => {
				state.rosterReads++;
				const sample = typeof state.roster === "function" ? state.roster() : state.roster;
				return sample ?? { windows: [], elapsedMs: 0 };
			},
			// A pid listed with undefined is a failed lookup; an unlisted one is no app.
			bundleId: async pid => {
				state.bundleReads.push(pid);
				return options.bundles !== undefined && pid in options.bundles ? options.bundles[pid] : null;
			},
		});
	const session = await create();
	/** What this conversation was told, as the computer tool's lifetime keeps it. */
	const taught = new Set<string>();
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
		teach(topic) {
			if (taught.has(topic)) return false;
			taught.add(topic);
			return true;
		},
	};
	const window = await session.window(context, { id: String(row.window_id), pid: row.pid as number });
	return {
		session,
		create,
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
	const lease = { ...f.row, window_id: 9, title: "Window", kind: "system_overlay", z_index: 12 };
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

it("offers an app window the driver classified as nobody's only when it says so", async () => {
	const f = await fixture();
	// The pattern this replaced was the indicator's own title and geometry, so
	// an app window that happened to be a 66×20 "Window" was hidden from every
	// roster and could not be acquired at all. Which window a capture lease
	// caused is the driver's to know, and an unclassified row is the app's.
	const lookalike = { ...f.row, window_id: 9, title: "Window", bounds: { x: 0, y: 0, width: 66, height: 20 } };
	try {
		f.state.hook = async name => (name === "list_windows" ? reply({ windows: [f.row, lookalike] }) : undefined);
		expect((await f.session.windows(f.context)).map(window => window.id)).toEqual(["1", "9"]);
		expect(await f.session.window(f.context, { id: "9", pid: 101 })).toMatchObject({ id: "9", title: "Window" });
	} finally {
		await f.close();
	}
});

it("resolves an { app } that is a bundle id through the apps roster the window list has no room for", async () => {
	const f = await fixture();
	try {
		f.state.hook = async name =>
			name === "list_apps"
				? reply({ apps: [{ pid: 101, name: "Fixture", bundle_id: "dev.omp.fixture", running: true, active: true }] })
				: undefined;
		// A window roster publishes the display name alone, so the identifier
		// `launch_app` accepts matched nothing and read as "not running".
		expect(await f.session.window(f.context, { app: "dev.omp.fixture" })).toMatchObject({ id: "1" });
		expect((await f.session.windows(f.context, { app: "DEV.OMP.FIXTURE" })).map(window => window.id)).toEqual(["1"]);
		// A display name that matches costs no apps read at all.
		f.calls.length = 0;
		expect(await f.session.window(f.context, { app: "Fixture" })).toMatchObject({ id: "1" });
		expect(f.calls.some(call => call.name === "list_apps")).toBe(false);
		// A bundle id no running app carries still misses, and says so.
		await expect(f.session.window(f.context, { app: "dev.omp.absent" })).rejects.toThrow("Missing computer window");
	} finally {
		await f.close();
	}
});

it("reads only the acted pid's windows once a handle names one", async () => {
	const f = await fixture();
	const print = { ...f.row, window_id: 7, title: "Print", z_index: 9 };
	const lease = { ...f.row, window_id: 9, title: "Window", kind: "system_overlay" };
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
		// The roster, and nothing else: the announcement is a fact about the
		// app, so no accessibility mapping is read to dress it up.
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
	const lease = { ...f.row, window_id: 9, title: "Window", kind: "system_overlay" };
	try {
		await f.session.observe(f.context, f.window);
		const quiet = await f.session.press(f.context, f.window, "cmd+p", undefined, { delivery: "foreground" });
		expect(quiet.text).not.toContain("gained window");
		f.state.hook = async name => (name === "list_windows" ? reply({ windows: [f.row, print, lease] }) : undefined);
		const opened = await f.session.press(f.context, f.window, "cmd+p", undefined, { delivery: "foreground" });
		expect(opened.text).toContain('pid 101 gained window 7 ("Print") since your last observation.');
		// The line names the window and stops: no route, no acquisition.
		expect(opened.text).not.toContain("computer.window(");
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

it("renders a window the app opened under the handle that opened it, for as long as it is up", async () => {
	const f = await fixture();
	// Chrome's print dialog renders seconds after the invoke that asked for
	// it: another window of the same pid, which the caller drives through the
	// handle it already holds instead of spending a call to acquire it.
	const print = { ...f.row, window_id: 7, title: "Print", z_index: 9 };
	const lease = { ...f.row, window_id: 9, title: "Window", kind: "system_overlay" };
	let windows: WindowRow[] = [f.row];
	try {
		f.state.hook = async (name, args) => {
			if (name === "list_windows")
				return reply({
					windows,
					...(args.include_accessibility_metadata
						? {
								accessibility_windows: {
									pid: 101,
									complete: true,
									windows: [
										{ window_id: 1, role: "AXWindow" },
										{ window_id: 7, role: "AXWindow" },
									],
								},
							}
						: {}),
				});
			if (name !== "get_window_state" || args.window_id !== 7) return undefined;
			return reply({
				pid: 101,
				window_id: 7,
				snapshot_id: "p1",
				truncated: false,
				window_bounds: print.bounds,
				elements: [{ element_index: 1, element_token: "p1:1", role: "AXButton", label: "Print", depth: 0 }],
			});
		};
		await f.session.observe(f.context, f.window);
		windows = [f.row, print, lease];
		// The action that put it on screen names it, and rebinds nothing.
		const opened = await f.session.press(f.context, f.window, "cmd+p", undefined, { delivery: "foreground" });
		expect(opened.text).toContain('pid 101 gained window 7 ("Print") since your last observation.');
		expect(f.window.id).toBe("1");
		// The next read of the opener carries it: its own rows, under a line
		// that says which handle drives them.
		const observed = await f.session.observe(f.context, f.window);
		const button = observed.elements.find(element => element.label === "Print")!;
		expect(observed.tree.split("\n").slice(-2)).toEqual([
			'window 7 "Print" — opened by this app, driven through this window\'s refs',
			`  ${button.ref} button "Print"`,
		]);
		expect(button.windowId).toBe("7");
		// The driver's own capture-lease window is nobody's.
		expect(observed.tree).not.toContain("window 9");
		// A ref printed there acts on the window it was minted in, dispatched
		// through the handle the caller holds.
		await f.session.click(f.context, f.window, button.ref);
		expect(f.lastDispatch()).toMatchObject({
			name: "click",
			args: { window_id: 7, pid: 101, element_token: "p1:1", snapshot_id: "p1" },
		});
		// Still up on the next read, so it is still printed: what keeps it
		// there is the window being on screen, not the diff that found it.
		expect((await f.session.observe(f.context, f.window)).tree).toContain('window 7 "Print"');
		// Gone: the opener's tree is its own again.
		windows = [f.row];
		const alone = await f.session.observe(f.context, f.window);
		expect(alone.tree).not.toContain("window 7");
		expect(alone.elements.map(element => element.windowId)).toEqual(["1"]);
	} finally {
		await f.close();
	}
});

it("sends the caller to a modal dialog's own rows instead of to an acquisition it does not need", async () => {
	const f = await fixture();
	// An application-modal alert is a real top-level window with an AXWindow
	// of its own, and the walk already drew its buttons into the blocked
	// window's tree: announcing it again would send the caller away from the
	// refs it is already holding. Modality is an accessibility fact, so the
	// driver labels the row only on a roster read that asked for the
	// mapping; `modal_windows` on the observation is the always-present half.
	const alert = { ...f.row, window_id: 40, title: "alert" };
	let windows: WindowRow[] = [f.row];
	let modal = false;
	try {
		f.state.hook = async (name, args) => {
			if (name === "list_windows")
				return reply({
					windows: windows.map(row =>
						args.include_accessibility_metadata && row.window_id === 40 ? { ...row, kind: "app-modal" } : row,
					),
					...(args.include_accessibility_metadata
						? {
								accessibility_windows: {
									pid: 101,
									complete: true,
									windows: [
										{ window_id: 1, role: "AXWindow" },
										...(modal ? [{ window_id: 40, role: "AXWindow" }] : []),
									],
								},
							}
						: {}),
				});
			if (name !== "get_window_state" || !modal) return undefined;
			return reply({
				pid: 101,
				window_id: 1,
				snapshot_id: "s1",
				truncated: false,
				window_bounds: f.row.bounds,
				modal_windows: [{ pid: 101, window_id: 40, title: "alert", relation: "app-modal" }],
				elements: [
					{ element_index: 1, element_token: "s1:1", role: "AXWindow", label: "Editor", depth: 0 },
					{ element_index: 2, element_token: "s1:2", role: "AXWindow", subrole: "AXDialog", label: "alert", depth: 1 },
					{ element_index: 3, element_token: "s1:3", role: "AXButton", label: "Only This Event", depth: 2 },
				],
			});
		};
		await f.session.observe(f.context, f.window);
		windows = [f.row, alert];
		modal = true;
		const blocked = await f.session.observe(f.context, f.window);
		const only = blocked.elements.find(element => element.label === "Only This Event")!;
		expect(blocked.tree).toContain(`${only.ref} button "Only This Event"`);
		// The walk rendered it, so nothing sends the caller off to acquire it.
		expect(blocked.tree.split("\n").filter(line => line.includes("window 40"))).toEqual([]);
		// The driver's own label for that window survives the roster.
		expect((await f.session.windows(f.context, { pid: 101 })).find(row => row.id === "40")?.kind).toBe("app-modal");
	} finally {
		await f.close();
	}
});

it("resolves by exact id an app-modal window only the accessibility roster lists", async () => {
	const f = await fixture();
	// Recorded shape (driver 5b3a6cf96): while an application-modal prompt
	// is up, the app's window sits on CGWindow layer 8, and only the
	// `include_accessibility_metadata` view of `list_windows` carries it; the
	// plain views (with or without `pid`) are layer 0 and omit it.
	const modal = {
		...f.row,
		window_id: 58,
		title: "prompt",
		bounds: { height: 598, width: 935, x: 200, y: 386 },
		layer: 8,
		kind: "app-modal",
		ax_backed: true,
		z_index: 43,
	};
	const helper = { ...f.row, window_id: 56, title: "", is_on_screen: false, ax_backed: false };
	try {
		f.state.hook = async (name, args) => {
			if (name === "get_window_state" && args.window_id === 58)
				return reply({
					pid: 101,
					window_id: 58,
					snapshot_id: "s58",
					truncated: false,
					window_bounds: modal.bounds,
					elements: [
						{ element_index: 1, element_token: "s58:1", role: "AXWindow", subrole: "AXDialog", depth: 0 },
						{ element_index: 2, element_token: "s58:2", role: "AXButton", label: "Delete", depth: 1 },
					],
				});
			if (name !== "list_windows") return undefined;
			if (!args.include_accessibility_metadata)
				return reply({ windows: [f.row, { ...helper, ax_backed: undefined }] });
			return reply({
				windows: [modal, f.row, helper],
				accessibility_windows: {
					pid: 101,
					complete: true,
					windows: [
						{ window_id: 58, role: "AXWindow", subrole: "AXDialog", main: true, minimized: false, modal: true },
					],
				},
			});
		};
		f.state.roster = {
			windows: [
				{ ...systemWindow({ id: "58", title: "prompt" }), layer: 8 },
				{ ...systemWindow({ id: "77", title: "" }), layer: 3 },
			],
			elapsedMs: 0,
		};
		const listed = (await f.session.windows(f.context, { pid: 101 })).find(window => window.id === "58");
		expect(listed).toMatchObject({ kind: "app-modal", axBacked: true, main: true });
		// The id the roster printed resolves, with or without its pid, to the same row.
		const reads = () => f.calls.filter(call => call.name === "list_windows").length;
		for (const selector of [{ id: "58", pid: 101 }, { id: "58" }, "58"]) {
			const resolved = await f.session.window(f.context, selector);
			expect(resolved).toMatchObject({ id: "58", pid: 101, kind: "app-modal", layer: 8, main: true });
		}
		// A held handle's re-resolution (`#current`) reaches it too.
		const handle = await f.session.window(f.context, { id: "58", pid: 101 });
		const observed = await f.session.observe(f.context, handle);
		expect(observed.window.id).toBe("58");
		// A layer-0 id is answered by the plain view alone.
		const before = reads();
		await f.session.window(f.context, { id: "1", pid: 101 });
		expect(reads() - before).toBe(1);
		// The WindowServer only names the pid to ask: an id the driver lists
		// in neither view is still missing.
		for (const selector of [{ id: "77", pid: 101 }, { id: "77" }])
			await expect(f.session.window(f.context, selector)).rejects.toThrow(/Missing computer window/);
	} finally {
		await f.close();
	}
});

it("prints the provider's verdict that a control would accept a written value", async () => {
	const f = await fixture();
	// A date area reads like a text field and refuses typing; the row that
	// admits a write is the one to write to, and only the provider knows.
	try {
		f.state.hook = async name =>
			name === "get_window_state"
				? reply({
						pid: 101,
						window_id: 1,
						snapshot_id: "s1",
						truncated: false,
						window_bounds: f.row.bounds,
						elements: [
							{
								element_index: 1,
								element_token: "s1:1",
								role: "AXDateTimeArea",
								label: "start-datepicker",
								depth: 0,
								value: "2026-09-25T17:00:00-07:00",
								value_settable: true,
							},
							{ element_index: 2, element_token: "s1:2", role: "AXStepper", label: "Repeat", depth: 0 },
						],
					})
				: undefined;
		const observation = await f.session.observe(f.context, f.window);
		expect(observation.tree.split("\n")).toEqual([
			'n1 datetimearea "start-datepicker" = "2026-09-25T17:00:00-07:00" [settable]',
			'n2 stepper "Repeat"',
		]);
		expect(observation.elements.map(element => element.settable)).toEqual([true, undefined]);
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

it("keeps the desktop surface out of an app's front-window choice and reaches it by kind", async () => {
	const f = await fixture();
	try {
		// Finder: one document window and the display's desktop icon window,
		// which the driver files as kind "desktop" - untitled, behind everything,
		// stacked above the document in z_index because WindowServer orders it so.
		const desktop = { ...f.row, window_id: 9814, title: "", z_index: 114, kind: "desktop" };
		const document = { ...f.row, window_id: 2, title: "Documents", z_index: 3 };
		f.state.hook = async name => (name === "list_windows" ? reply({ windows: [desktop, document] }) : undefined);
		// The desktop is no app's front window, and a plain {app} selector does
		// not even name it as an alternative.
		expect(await f.session.window(f.context, { app: "Fixture" })).toMatchObject({ id: "2", title: "Documents" });
		expect(f.texts).toEqual([]);
		expect(await f.session.window(f.context, { app: "Fixture", kind: "desktop" })).toMatchObject({
			id: "9814",
			kind: "desktop",
		});
		expect(f.texts).toEqual([]);
		// Alone, it is still reachable only by kind.
		f.state.hook = async name => (name === "list_windows" ? reply({ windows: [desktop] }) : undefined);
		await expect(f.session.window(f.context, { app: "Fixture" })).rejects.toThrow("Missing computer window");
		expect(await f.session.window(f.context, { app: "Fixture", kind: "desktop" })).toMatchObject({ id: "9814" });
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
			"Fixture: pid 101 has 3 WindowServer rows and no accessibility window; every input route to them is refused.",
		);
		// What makes a running app open a window is named with the call that does it.
		expect(failure.message).toContain('computer.launch({ name: "Fixture", urls: [');
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

it("never hands an app selector the desktop surface when the app has no window of its own", async () => {
	const f = await fixture();
	// A running app with no window open: WindowServer rows no AXWindow claims,
	// and the display's desktop surface, which the driver files under the same
	// pid and reads through AX without it being an AXWindow.
	const ghost = (id: number) => ({
		...f.row,
		window_id: id,
		title: "",
		is_on_screen: false,
		bounds: { x: 0, y: 0, width: 1920, height: 30 },
	});
	const desktop = { ...f.row, window_id: 9814, title: "", z_index: 114, kind: "desktop", ax_backed: true };
	try {
		f.state.hook = async name =>
			name === "list_windows"
				? reply({
						windows: [ghost(52), desktop, ghost(51)],
						accessibility_windows: { pid: 101, complete: true, windows: [] },
					})
				: undefined;
		// Named by app or by pid — the pid is how a launch that reused the
		// running process addresses it — the app has no window that takes input,
		// and the refusal neither acquires the desktop nor offers it as one.
		for (const selector of [{ app: "Fixture" }, { pid: 101 }]) {
			const failure = await f.session.window(f.context, selector).catch((error: unknown) => error);
			if (!(failure instanceof Error)) throw new Error(`Expected ${JSON.stringify(selector)} to be refused`);
			expect(failure.message).toContain(
				"2 WindowServer rows besides the display's desktop surface and no accessibility window",
			);
			expect(failure.message).toContain('computer.launch({ name: "Fixture", urls: [');
			expect(failure.message).not.toContain("9814");
		}
		// The desktop itself stays reachable by kind and by its exact id.
		expect(await f.session.window(f.context, { kind: "desktop" })).toMatchObject({ id: "9814", kind: "desktop" });
		expect(await f.session.window(f.context, { id: "9814", pid: 101 })).toMatchObject({ id: "9814" });
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

it("names the launch option only for a selector that can be launched", async () => {
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
		// The row says only what carries news: an empty value, an unselected
		// row and an enabled one are what every row is until it says otherwise.
		expect(observation.tree).toBe('n1 textfield "Editor" [disabled] placeholder="Hint, not value"');
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

it("takes completeness only from the walker's own verdict, never from a count", async () => {
	const f = await fixture({ platform: "linux" });
	try {
		// A capped walk reports returned === total, because both count the nodes
		// it reached, so no count can stand in for the verdict. Neither can its
		// absence: a walker that says nothing has proved nothing.
		expect((await f.session.observe(f.context, f.window, { maxElements: 1 })).complete).toBe(false);
		expect((await f.session.observe(f.context, f.window)).complete).toBe(false);
		// A walker that states its verdict is believed either way, cap or none.
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
		const cell = lines.findIndex(line => line.includes('"ICMNoteListCell"'));
		// A note this session wrote about the tree is parenthesised and a row
		// the window rendered is not, so the two never read alike.
		expect(lines[cell + 1]).toBe("      (69 of 81 rows are scrolled out of view and were not read)");
		expect(lines[cell + 2]).toBe('            text "Meeting 070"');
		expect(lines[cell + 3]).toBe(`      ${observation.elements[1]!.ref} button`);
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
		expect(observation.tree).toBe('n1 textfield "Editor" [disabled] placeholder="Hint, not value"');
		f.state.value = " \tΩ café\n";
		f.state.placeholder = 'Hint "quoted" Ω';
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.value).toBe(f.state.value);
		expect(observation.elements[0]!.placeholder).toBe(f.state.placeholder);
		expect(observation.tree).toBe(
			`n2 textfield "Editor" = ${JSON.stringify(f.state.value)} [disabled] placeholder=${JSON.stringify(
				f.state.placeholder,
			)}`,
		);
		f.state.placeholder = undefined;
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.placeholder).toBeUndefined();
		expect(observation.tree).toBe(`n3 textfield "Editor" = ${JSON.stringify(f.state.value)} [disabled]`);
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
		expect(observation.tree).toBe('n1 textfield "Editor" [disabled] placeholder="Hint, not value"');
		// A tooltip is what this row is described as when it has none of its own.
		f.state.help = 'Send the "draft" Ω';
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.help).toBe(f.state.help);
		expect(observation.tree).toContain(`(${f.state.help})`);
		// Its own description is the one it prints, and the tooltip behind it
		// is not printed a second time.
		f.state.description = "Compose button";
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]).toMatchObject({ help: f.state.help, description: f.state.description });
		expect(observation.tree).toContain("(Compose button)");
		expect(observation.tree).not.toContain("draft");
		// A description that only repeats the label is the label twice: the
		// snapshot keeps the provider's word, the row drops it.
		f.state.help = undefined;
		f.state.description = "Editor";
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.description).toBe("Editor");
		expect(observation.elements[0]!.help).toBeUndefined();
		expect(observation.tree).not.toContain("(Editor)");
		// A provider that says "none" with an empty string, and a description
		// that only restates the row's own value, add nothing to the line.
		f.state.help = "";
		f.state.value = "Draft";
		f.state.description = "Draft";
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.help).toBeUndefined();
		expect(observation.elements[0]!.description).toBeUndefined();
		expect(observation.tree).not.toContain("(Draft)");
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
		// The desktop surface: the menu bar at depth 0 and the icons deeper than
		// it under a non-indexed scroll area. Ancestry, not depth, says what is
		// under the menu bar when the driver reports `parent_index`.
		const desktop = [
			{ element_index: 0, element_token: "s:0", role: "AXMenuBar", label: "", depth: 0 },
			{ element_index: 1, element_token: "s:1", role: "AXMenuBarItem", label: "File", depth: 1, parent_index: 0 },
			{ element_index: 334, element_token: "s:334", role: "AXGroup", label: "desktop", depth: 1 },
			{
				element_index: 335,
				element_token: "s:335",
				role: "AXImage",
				label: "Report.pdf",
				depth: 2,
				parent_index: 334,
			},
		];
		f.state.hook = async name =>
			name === "get_window_state"
				? reply({ pid: 101, window_id: 1, snapshot_id: "s", truncated: false, elements: desktop })
				: undefined;
		const icons = await f.session.observe(f.context, f.window);
		expect(icons.elements.map(element => `${element.role} ${element.label}`)).toEqual([
			"AXGroup desktop",
			"AXImage Report.pdf",
		]);
		// The hint was already spent on this window's first observation.
		expect(icons.tree).not.toContain("Menu bar hidden");
	} finally {
		await f.close();
	}
});

it("says the menu bar is hidden once per window, and once for every window", async () => {
	const f = await fixture();
	// The hint is a fact about the surface, not about the observation: a model
	// that has read it once does not need it on every walk of the same window,
	// and a window it has never been told about is a window it has to be told
	// about. Repeating it cost a line of every observation on the bench.
	const rows = [
		{ element_index: 1, element_token: "s:1", role: "AXWindow", label: "Editor", depth: 0 },
		{ element_index: 2, element_token: "s:2", role: "AXMenuBar", label: "", depth: 1 },
		{ element_index: 3, element_token: "s:3", role: "AXMenuBarItem", label: "File", depth: 2 },
	];
	try {
		const second = { ...f.row, window_id: 2, title: "Second" };
		f.state.hook = async (name, args) =>
			name === "list_windows"
				? reply({ windows: [f.row, second] })
				: name === "get_window_state"
					? reply({
							pid: 101,
							window_id: args.window_id,
							snapshot_id: `s${String(args.window_id)}`,
							truncated: false,
							elements: rows,
						})
					: undefined;
		expect((await f.session.observe(f.context, f.window)).tree).toContain("Menu bar hidden (2 rows)");
		expect((await f.session.observe(f.context, f.window)).tree).not.toContain("Menu bar hidden");
		const other = await f.session.window(f.context, { id: "2", pid: 101 });
		expect((await f.session.observe(f.context, other)).tree).toContain("Menu bar hidden (2 rows)");
		expect((await f.session.observe(f.context, other)).tree).not.toContain("Menu bar hidden");
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

it("says a drag was delivered without evidence and pushes that into the cell", async () => {
	const f = await fixture();
	try {
		await f.session.captureWindow(f.context, f.window);
		// The vendored driver's drag reply: no evidence block, no effect verdict.
		const unprobed = await f.session.drag(f.context, f.window, [0, 0], [100, 0], { delivery: "foreground" });
		expect(unprobed.text).toContain(
			"Delivered; the driver reported no effect evidence for this drag — observe the window to confirm it moved anything.",
		);
		expect(unprobed.mustShow).toBe(true);
		// Once the driver's probe covers drag, its own verdict is the whole answer.
		f.state.hook = async name =>
			name === "drag"
				? reply({
						effect: "no_observed_change",
						evidence: [{ kind: "window_change", signal: "window_tree" }],
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

it("says what a write turned out to be, keyed on the driver's verdict and effect", async () => {
	const f = await fixture();
	try {
		let ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		const said = "✅ Set AXValue on [1] AXTextField.";
		/**
		 * One write, answered with a payload the shipping driver can publish,
		 * then a fresh observation: every write is judged on its own reply and
		 * nothing it left unproven reaches the next one.
		 */
		const write = async (data: Wire, operation: "setValue" | "type" = "setValue") => {
			const structuredJson = JSON.stringify(wireResult(data));
			const tool = operation === "type" ? "type_text" : "set_value";
			f.state.hook = async name =>
				name === tool ? { text: said, structuredJson, isError: false, images: [] } : undefined;
			const used = ref;
			const result =
				operation === "type"
					? await f.session.type(f.context, f.window, "Project_File_List", used)
					: await f.session.setValue(f.context, f.window, used, "Project_File_List");
			ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
			return { result, lines: result.text.split("\n"), note: result.text.split("\n").at(-1)!, used };
		};
		const readBack = [{ kind: "value_readback" }];
		// Proven: the verdict, a confirmed effect and the driver's own read-back.
		// Nothing is left to say, so no line is added and the cell is not made
		// to print anything.
		const proven = await write({ committed: "committed", effect: "confirmed", evidence: readBack });
		expect(proven.result.text).toBe(said);
		expect(proven.result.committed).toBe("committed");
		expect(proven.result.mustShow).toBeUndefined();
		// Every other outcome adds exactly one line, which names the row the
		// observation printed — its role and label, never the value it holds —
		// and rides the must-show flag.
		const odd = await write({ committed: "committed", effect: "unverifiable", evidence: readBack });
		expect(odd.note.startsWith(`setValue on ${odd.used} AXTextField "Editor": `)).toBe(true);
		expect(odd.note).toContain("judged the value committed but reported the effect as unverifiable");
		expect(odd.lines).toHaveLength(2);
		expect(odd.result.mustShow).toBe(true);
		const unread = await write({ committed: "committed", effect: "confirmed" });
		expect(unread.note).toContain("judged the value committed but nothing in the reply read it back");
		const lost = await write({ committed: "not_committed", effect: "confirmed" });
		expect(lost.result.committed).toBe("not_committed");
		expect(lost.note).toContain("not committed");
		const echoed = await write({ committed: "unproven", effect: "confirmed", evidence: readBack });
		expect(echoed.result.committed).toBe("unproven");
		expect(echoed.note).toContain("the value reads back as written");
		const blind = await write({ committed: "unproven", effect: "confirmed" });
		expect(blind.note).toContain("could not prove the app kept this value");
		// No verdict at all: what the effect says, and nothing where the driver
		// reports it never went out.
		const unreadable = await write({ effect: "unverifiable", evidence: null });
		expect(unreadable.result.committed).toBeUndefined();
		expect(unreadable.note).toContain("publishes no readable value");
		const unjudged = await write({ effect: "confirmed", evidence: readBack }, "type");
		expect(unjudged.note.startsWith(`type on ${unjudged.used} AXTextField "Editor": `)).toBe(true);
		expect(unjudged.note).toContain("nothing in the reply says whether the app kept this value");
		// A write's `element` escalation is answered by its own verdict: the
		// rung would only say "address the field" to a call that just did.
		const addressed = await write({
			committed: "unproven",
			effect: "confirmed",
			evidence: readBack,
			escalation: { reason: "effect_unconfirmed", target: "element" },
		});
		expect(addressed.lines).toHaveLength(2);
		expect(addressed.result.text).not.toContain("address the field");
		// A field with no title of its own is labelled by its own value, so the
		// line names what it was written with instead of which row it is; the
		// placeholder is the name that survives the write.
		f.state.label = "Apple Park";
		f.state.value = "Apple Park";
		ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		const churned = await write({ committed: "unproven", effect: "confirmed" });
		expect(churned.note.startsWith(`setValue on ${churned.used} AXTextField "Hint, not value": `)).toBe(true);
	} finally {
		await f.close();
	}
});

it("spells out what a partial type left in the field and how to finish it", async () => {
	const f = await fixture();
	// A partial delivery is the one refusal that still wrote: the remainder is
	// what the caller has to send, and only this side can slice it by codepoint.
	const incomplete = (text: string, details?: Wire): void => {
		f.state.hook = async name =>
			name === "type_text"
				? {
						text,
						errorCode: "type_text_incomplete",
						...(details === undefined ? {} : { structuredJson: JSON.stringify(details) }),
						isError: true,
						images: [],
					}
				: undefined;
	};
	const refused = async (ref: string): Promise<string> => {
		const failure = await f.session
			.type(f.context, f.window, "Project_File_List.txt", ref)
			.catch((error: unknown) => error);
		f.state.hook = undefined;
		if (!(failure instanceof Error)) throw new Error("Expected the incomplete type to refuse");
		return failure.message.split("\n").at(-1)!;
	};
	try {
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		incomplete(
			'type_text incomplete: delivered 6 of 21 character(s) via CGEvent (30ms delay); retry with text: "t_File_List.txt"',
			{ code: "type_text_incomplete", effect: "partial", delivered_chars: 6, retryable: true },
		);
		// The remainder spelled out: the reply's own "retry with text" left the
		// caller to slice by codepoint, and the model retyped the whole string.
		expect(await refused(ref)).toBe(
			`type on ${ref} AXTextField "Editor": 6 of 21 characters landed, so the field holds neither its old value nor the one asked for — type only the remainder: "t_File_List.txt".`,
		);
		// Nothing delivered and the driver could not probe focus: the rung may
		// still land, so the remainder is still the route — but the field holds
		// what it held, which the old sentence denied.
		incomplete("type_text incomplete: delivered 0 of 21 character(s) via CGEvent (30ms delay); retry with text: …");
		expect(await refused(ref)).toBe(
			`type on ${ref} AXTextField "Editor": 0 of 21 characters landed, so the field still holds its old value — type only the remainder: "Project_File_List.txt".`,
		);
		// Nothing delivered at a target the driver probed and found unfocused:
		// the same keystrokes land nothing again however they are sliced, so
		// the remainder is the one instruction that must not be printed.
		incomplete(
			'type_text incomplete: delivered 0 of 21 character(s) via CGEvent (0ms delay); the addressed element did not take keyboard focus, so typed keystrokes cannot be proven to reach it: click the control first, write it with set_value, or retry with delivery_mode "foreground". A row that only displays text is not an editor',
			{
				code: "type_text_incomplete",
				effect: "suspected_noop",
				requested_chars: 21,
				delivered_chars: 0,
				retryable: false,
				target_focused: false,
			},
		);
		expect(await refused(ref)).toBe(
			`type on ${ref} AXTextField "Editor": nothing landed, so the field still holds its old value and re-sending these keystrokes lands nothing again — write it without keystrokes: win.ref(${JSON.stringify(
				ref,
			)}).setValue("Project_File_List.txt"), or re-run this call with { delivery: "foreground" }.`,
		);
	} finally {
		await f.close();
	}
});

it("re-samples a window once when its header and its own tree disagree after a mutation", async () => {
	const f = await fixture();
	// The roster names the window the app is becoming and the AX tree still
	// carries the one it was: the read was chained onto a write the app is
	// still applying. The bench spent its next cell on exactly this re-read.
	f.state.role = "AXWindow";
	f.state.label = "Bench - 80 notes";
	const walks = (): number => f.calls.filter(call => call.name === "get_window_state").length;
	try {
		// Nothing this session did touched the window, so the two titles are
		// the app's business and not a transition to wait out.
		const first = await f.session.observe(f.context, f.window);
		expect(walks()).toBe(1);
		expect(first.tree).toContain('window "Bench - 80 notes"');
		let walked = 0;
		f.state.hook = async name => {
			if (name === "get_window_state") f.state.label = ++walked >= 2 ? "Editor" : "Bench - 80 notes";
			return undefined;
		};
		await f.session.click(f.context, f.window, first.elements[0]!.ref);
		f.calls.length = 0;
		const settled = await f.session.observe(f.context, f.window);
		expect(walks()).toBe(2);
		expect(settled.tree).toContain('window "Editor"');
		// Spent by that read: the next one walks once whatever the titles say.
		f.state.hook = undefined;
		f.state.label = "Bench - 80 notes";
		f.calls.length = 0;
		await f.session.observe(f.context, f.window);
		expect(walks()).toBe(1);
		// One retry, not a poll: a window whose two titles simply differ costs
		// one extra walk and then renders what it has.
		const stale = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		await f.session.click(f.context, f.window, stale);
		f.calls.length = 0;
		expect((await f.session.observe(f.context, f.window)).tree).toContain('window "Bench - 80 notes"');
		expect(walks()).toBe(2);
	} finally {
		await f.close();
	}
});

it("answers a write at a control that is gone without asking for a read-back", async () => {
	const f = await fixture();
	const dead = {
		text: "Background input refused (element_no_longer_exists): the addressed element is no longer in the accessibility tree; take a fresh get_window_state snapshot and re-address it",
		structuredJson: JSON.stringify({
			code: "element_no_longer_exists",
			effect: "refused",
			escalation: {
				reason: "the addressed element is no longer in the accessibility tree",
				recommended: "snapshot",
			},
			pid: 101,
			window_id: 1,
		}),
		isError: true,
		errorCode: "element_no_longer_exists",
		images: [],
	};
	try {
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		f.state.hook = async name => (name === "set_value" ? dead : undefined);
		// The row is not in the fresh tree under any reference.
		f.state.label = "Editor (renamed)";
		const answered = await f.session.setValue(f.context, f.window, ref, "Project_File_List");
		expect(answered.effect).toBe("not_dispatched");
		expect(answered.mustShow).toBe(true);
		// The dead-ref recovery is the whole answer: a write that never went out
		// has no value to read back.
		expect(answered.text).toContain(`${ref} (AXTextField "Editor") no longer exists in window 1`);
		expect(answered.text).not.toContain("setValue on");
		expect(answered.text).not.toContain("read the field back");
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
		expect(dropped.text.split("\n")[0]).toBe("Pressed cmd+n on pid 101.");
		// The post never went out, so the named rung is the whole advice.
		expect(dropped.escalation).toBe('Not delivered: re-run it with { delivery: "foreground" }.');
		expect(dropped.escalation).toBe(dropped.text.split("\n")[1]);
		expect(dropped.mustShow).toBe(true);
		// Any other doubt is about a dispatch that may have landed: the read
		// comes first, because re-sending an action that landed does it twice.
		// The refusal payloads of both pinned builds still spell the rung
		// `recommended`, and the driver's own wire vocabulary never survives.
		const unproven = await pressed(
			{ effect: "unverifiable", escalation: { recommended: "foreground" } },
			'⚠️ Unverified. To deliver a real click, click this control\'s pixel center with delivery_mode:"foreground".',
		);
		expect(unproven.escalation).toBe(
			'Delivery unproven: observe first — it may have landed; only if the window shows no change, re-run it with { delivery: "foreground" }.',
		);
		expect(unproven.text).toContain('{ delivery: "foreground" }');
		expect(unproven.text).not.toContain("delivery_mode");
		// A rung this surface cannot type is not turned into advice.
		const elsewhere = await pressed(
			{ effect: "unverifiable", escalation: { target: "session", reason: "permission_required" } },
			"Pressed cmd+n on pid 101.",
		);
		expect(elsewhere.text).toBe("Pressed cmd+n on pid 101.");
		expect(elsewhere.escalation).toBeUndefined();
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
		// coordinate rung the escalation named is the one Contacts swallows —
		// so the read comes first, and the rung only if nothing moved.
		const watched = await dispatched(
			'✅ Performed AXPress on [15] AXMenuButton "".\n⚠️ Unverified: no change observed within 505 ms (element state, app focus, window contents, new windows).',
		);
		// No capture of this window is live, and a pixel action refuses before
		// dispatch without one, so the capture is part of the route.
		expect(watched.escalation).toBe(
			"Delivery unproven: observe first — it may have landed; only if the window shows no change, click the control's own centre in a fresh capture (observe({ screenshot: true })).",
		);
		expect(watched.text.indexOf("observe first")).toBeLessThan(
			watched.text.indexOf("click the control's own centre"),
		);
		expect(watched.mustShow).toBe(true);
		// Once the window has a frame, the coordinate it names is already in hand.
		await f.session.observe(f.context, f.window, { screenshot: true, silent: true });
		const captured = await dispatched('✅ Performed AXPress on [15] AXMenuButton "".');
		expect(captured.escalation).toContain("click the control's own centre in the capture this window already has");
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
			"Delivery unproven: observe first — it may have landed; only if the window shows no change, address the field itself — observe window 1 and write the row it mints.",
		);
		// A row the app publishes disabled refuses the write, so it is no
		// candidate however text-shaped its role is.
		await f.session.observe(f.context, f.window);
		expect((await f.session.type(f.context, f.window, "hi")).escalation).toContain(
			"observe window 1 and write the row it mints",
		);
		// One enabled text row in hand: the route is a call the caller can type.
		f.state.enabled = true;
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		expect((await f.session.type(f.context, f.window, "hi")).escalation).toContain(
			`address the field itself: win.ref("${ref}").type("<text>") or win.ref("${ref}").setValue("<value>")`,
		);
		// The call already addressed a row, so the route is to write it, not to
		// hunt for it again.
		expect((await f.session.type(f.context, f.window, "hi", ref)).escalation).toContain(
			`write the field instead of posting keystrokes at it: win.ref("${ref}").setValue("<value>")`,
		);
	} finally {
		await f.close();
	}
});

it("names the foreground rung to a background keystroke the driver saw move nothing", async () => {
	const f = await fixture();
	// T11 `native-act-notes/omp-2`: a background cmd+f moved nothing, and the
	// reply names no rung of its own — background keystrokes reach only the
	// app's key window, which is what the foreground rung makes this one.
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
		f.state.hook = async name => (name === "hotkey" ? inert("background") : undefined);
		const background = await f.session.press(f.context, f.window, "cmd+f");
		expect(background.escalation).toBe(
			'Delivery unproven: observe first — it may have landed; only if the window shows no change, re-run them with { delivery: "foreground" }, which makes this window key first — background keystrokes reach only the app\'s key window.',
		);
		// On the rung it named there is nothing left to offer, and the reply is
		// still unproven, so the cell still prints it.
		f.state.hook = async name => (name === "hotkey" ? inert("foreground") : undefined);
		const spent = await f.session.press(f.context, f.window, "cmd+f", undefined, { delivery: "foreground" });
		expect(spent.escalation).toBeUndefined();
		expect(spent.mustShow).toBe(true);
	} finally {
		await f.close();
	}
});

it("stops naming the foreground rung to an action that already ran on it", async () => {
	const f = await fixture();
	// AdviceMatrix: the AXEnabled refusal and its escalation are byte-identical
	// on both rungs, so the rung it names is the one that just answered.
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
			'Delivery unproven: observe first — it may have landed; only if the window shows no change, re-run it with { delivery: "foreground" }.',
		);
		const foreground = await f.session.click(f.context, f.window, ref, { delivery: "foreground" });
		expect(foreground.escalation).toBeUndefined();
		expect(foreground.text).toBe("✅ Performed AXPress on [1] AXButton.");
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
				recommended: "snapshot",
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
		// The reply names the code, the retired ref with the row it stood for,
		// the window it was addressed in, and a census of the fresh tree. The
		// code is an ancestry refusal, so it never claims the element died.
		const header = answered.text.split("\n")[0]!;
		expect(header).toStartWith("element_outside_target_window:");
		expect(header).toContain(`${ref} (AXTextField "Editor")`);
		expect(header).toContain("window 1");
		expect(header).not.toContain("no longer exists");
		expect(answered.text).toContain("no row of the fresh tree carries its role and label");
		expect(answered.text).toContain(`${ref} is retired`);
		// The route past the check does not depend on the row staying in place.
		expect(answered.text).toContain('the same click with { delivery: "foreground" } is not held to this check');
		// The tree is in the reply, and the reply is marked for the cell — not
		// left in a return value the cell is free to drop.
		expect(answered.text).toContain('n2 textfield "Editor (renamed)"');
		expect(answered.mustShow).toBe(true);
		// One read, and the refusal's own payload survives on the result.
		expect(f.calls.filter(call => call.name === "get_window_state")).toHaveLength(2);
		expect(answered.data).toMatchObject({ code: "element_outside_target_window", window_id: 14229 });
		// The row the walk just minted is addressable without another observe.
		f.state.hook = undefined;
		expect((await f.session.click(f.context, f.window, "n2")).effect).toBe("unverifiable");
		// A recovery walk that returns no rows has no new ref to hand back, and
		// says so rather than pointing at a tree that is not there.
		const empty = await f.session.window(f.context, { id: "1", pid: 101 });
		const gone = (await f.session.observe(f.context, empty)).elements[0]!.ref;
		f.state.hook = async name =>
			name === "click"
				? dead
				: name === "get_window_state"
					? reply({ pid: 101, window_id: 1, snapshot_id: "s9", truncated: false, elements: [] })
					: undefined;
		const nothing = await f.session.click(f.context, empty, gone);
		expect(nothing.text).toContain(`${gone} is retired and this walk minted no refs to address`);
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

it("renders an unproven-ancestry refusal as that, and names what the check does not gate", async () => {
	const f = await fixture();
	// Driver 5b3a6cf96, verbatim but for the window id and pid (VM probe q7): a
	// desktop icon refused this way on every background re-address, at 0, 1
	// and 3 s, while the same action with delivery_mode "foreground"
	// dispatched. The row is alive and in place; only its ancestry is unproven.
	const reason =
		"the addressed element could not be proven to belong to window 1; re-observe the window and re-address the element from that observation";
	const unproven = {
		text: `Background input refused (element_outside_target_window): ${reason}`,
		structuredJson: JSON.stringify({
			advice: "snapshot",
			code: "element_outside_target_window",
			effect: "refused",
			escalation: { reason: "route_unavailable", target: "snapshot" },
			pid: 101,
			reason,
			window_id: 1,
		}),
		isError: true,
		errorCode: "element_outside_target_window",
		images: [],
	};
	f.state.role = "AXImage";
	f.state.label = "Icon";
	f.state.actions = ["AXOpen", "AXShowMenu"];
	const dispatches = () =>
		f.calls.filter(call => call.name === "click" || call.name === "type_text").map(call => call.args.delivery_mode);
	try {
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		f.state.hook = async (name, args) =>
			(name === "click" || name === "type_text") && args.delivery_mode !== "foreground" ? unproven : undefined;
		const refused = await f.session.click(f.context, f.window, ref);
		expect(refused.effect).toBe("not_dispatched");
		expect(refused.mustShow).toBe(true);
		expect(refused.text).not.toContain("no longer exists");
		const fresh = refused.text.match(/on (n\d+), the row in that position now/)?.[1];
		expect(fresh).toBeDefined();
		// What the check does not gate, should the same refusal come back.
		expect(refused.text).toContain('the same click with { delivery: "foreground" } is not held to this check');
		expect(refused.text).toContain('computer.launch({ name: "Fixture", urls: ["<document or folder path>"] })');
		// A refusal, not a retry: one background dispatch, nothing in the foreground.
		expect(dispatches()).toEqual(["background"]);
		// Both re-addresses stay callable as written: the background one re-checks, the foreground one is not held.
		expect((await f.session.click(f.context, f.window, fresh!)).effect).toBe("not_dispatched");
		const row = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		expect((await f.session.click(f.context, f.window, row, { delivery: "foreground" })).effect).toBe("unverifiable");
		// A keystroke call has its own foreground form and no document hand-off.
		const field = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		const typed = await f.session.type(f.context, f.window, "x", field);
		expect(typed.text).toContain('the same type with { delivery: "foreground" } is not held to this check');
		expect(typed.text).not.toContain("computer.launch");
		// `perform` takes no delivery option here, so only the hand-off is named.
		const icon = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		const performed = await f.session.perform(f.context, f.window, icon, "AXOpen");
		expect(performed.effect).toBe("not_dispatched");
		expect(performed.text).not.toContain('delivery: "foreground"');
		expect(performed.text).toContain("if opening a document or folder that row stands for is the aim");
	} finally {
		await f.close();
	}
});

/**
 * `mixed-web-contact/omp-1` cell 5, in shape: one observation, five writes
 * batched behind it, the second dispatch landing on a control the app had
 * just re-created. The recovery walk re-minted the window's refs and the
 * three unspent writes died on `StaleRef` with the cell, losing a
 * half-written contact card the run then spent 15 cells rebuilding.
 */
const DEAD_ROW = {
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
/**
 * A card of fields under one group, as an app re-lays it out: every
 * generation mints new element tokens, and the toggle disappears from the
 * generation that answers the refusal.
 */
function card(generation: number, company: string, toggle: boolean, street = ""): Wire[] {
	const token = (index: number) => `g${generation}:${index}`;
	return [
		{ element_index: 1, element_token: token(1), role: "AXGroup", label: "Contact", depth: 0 },
		{ element_index: 2, element_token: token(2), role: "AXTextField", label: "Company", value: company, depth: 1 },
		...(toggle
			? [{ element_index: 3, element_token: token(3), role: "AXCheckBox", label: "Company", value: "0", depth: 1 }]
			: []),
		{ element_index: 4, element_token: token(4), role: "AXTextField", label: "Phone", value: "", depth: 1 },
		{ element_index: 5, element_token: token(5), role: "AXTextField", label: "Street", value: street, depth: 1 },
	];
}

it("leaves the rest of a batch's refs bound to their own elements across a dead ref's walk", async () => {
	const f = await fixture();
	try {
		let generation = 0;
		let company = "";
		let toggle = true;
		f.state.hook = async (name, args) => {
			if (name === "get_window_state")
				return reply({
					pid: 101,
					window_id: 1,
					snapshot_id: `w${++generation}`,
					truncated: false,
					// The card comes back holding another record's street: same
					// field, same place, contents this session did not write.
					elements: card(generation, company, toggle, toggle ? "" : "1 Infinite Loop"),
				});
			// The app re-creates the card on the first write's end-of-edit, so
			// the toggle the next dispatch addresses is gone by then.
			if (name === "set_value" && args.element_token === "g1:2") {
				company = String(args.value);
				toggle = false;
			}
			return name === "click" && args.element_token === "g1:3" ? DEAD_ROW : undefined;
		};
		const observed = await f.session.observe(f.context, f.window);
		const [group, companyField, checkbox, phone, street] = observed.elements.map(element => element.ref);
		// One cell: write a field, toggle a control that dies under it, write
		// two more fields. Every dispatch answers with its own verdict.
		const first = await f.session.setValue(f.context, f.window, companyField!, "Apple Park Visitor Center");
		const dead = await f.session.click(f.context, f.window, checkbox!);
		const third = await f.session.setValue(f.context, f.window, phone!, "408 961-1560");
		expect([first.effect, dead.effect, third.effect]).toEqual(["unverifiable", "not_dispatched", "unverifiable"]);
		// Nothing was dispatched at the dead row, and nothing was dispatched at
		// another row in its place: one click went out, and it was refused.
		expect(f.calls.filter(call => call.name === "click")).toHaveLength(1);
		// The third write reached the exact element its own observation minted
		// it for: this session's recovery walk is not the caller's observe, so
		// it re-binds nothing.
		expect(f.lastDispatch()?.args).toMatchObject({ element_token: "g1:4", snapshot_id: "w1" });
		// The dead ref is the only one retired, and that reply is the one place
		// the fresh tree is printed.
		expect(dead.text).toContain(`${checkbox} is retired`);
		expect(dead.text).toContain("Your other refs keep the exact elements they were minted for");
		expect(dead.text).toContain(`n${observed.elements.length + 2} textfield "Company"`);
		await expect(f.session.click(f.context, f.window, checkbox!)).rejects.toThrow(`StaleRef: ${checkbox} —`);
		// Every other ref still reaches its own element, whatever the fresh
		// tree did with that row's place or value.
		await f.session.setValue(f.context, f.window, companyField!, "Apple Park");
		expect(f.lastDispatch()?.args).toMatchObject({ element_token: "g1:2", snapshot_id: "w1" });
		await f.session.setValue(f.context, f.window, street!, "no");
		expect(f.lastDispatch()?.args).toMatchObject({ element_token: "g1:5", snapshot_id: "w1" });
		expect(f.session.element(group!).role).toBe("AXGroup");
		// The caller's own observation is what retires refs, and still does.
		await f.session.observe(f.context, f.window);
		await expect(f.session.setValue(f.context, f.window, phone!, "no")).rejects.toThrow(`StaleRef: ${phone} —`);
	} finally {
		await f.close();
	}
});

it("numbers element refs compactly and never reissues one a later observation invalidated", async () => {
	const f = await fixture();
	try {
		const first = await f.session.observe(f.context, f.window);
		expect(first.elements.map(element => element.ref)).toEqual(["n1"]);
		expect(first.tree).toStartWith('n1 textfield "Editor"');
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

/**
 * The driver's refusal once its idle sweep (or its owner) ended the implicit
 * session, as cua-driver 0.28.2 answered it live: every call is refused
 * before dispatch until `start_session` revives the session.
 */
const SESSION_ENDED: CuaToolResult = {
	text: "this session has ended; call start_session explicitly to reuse its label",
	structuredJson: JSON.stringify({
		refusal: {
			code: "session_ended",
			message: "this session has ended; call start_session explicitly to reuse its label",
		},
		status: "refused",
	}),
	isError: true,
	images: [],
};

it("revives a driver session that ended, re-sends the refused call once, and keeps refs", async () => {
	const f = await fixture();
	try {
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		let ended = true;
		f.state.hook = async name => {
			if (name === "start_session") {
				ended = false;
				return reply({ active: true, revived: true, session: "implicit" });
			}
			return ended ? SESSION_ENDED : undefined;
		};
		const before = f.calls.length;
		await f.session.setValue(f.context, f.window, ref, "after idle");
		const calls = f.calls.slice(before);
		expect(calls.filter(call => call.name === "start_session")).toEqual([{ name: "start_session", args: {} }]);
		// The refused call goes out again, unchanged, right after the revival.
		const revival = calls.findIndex(call => call.name === "start_session");
		expect(calls[revival + 1]).toEqual(calls[revival - 1]!);
		expect(f.state.value).toBe("after idle");
		expect(f.session.element(ref).role).toBe("AXTextField");
	} finally {
		await f.close();
	}
});

it("re-sends an ended session's call only once, and never when the revival is refused", async () => {
	const f = await fixture();
	try {
		f.state.hook = async name => (name === "start_session" ? reply({ active: true, revived: true }) : SESSION_ENDED);
		let before = f.calls.length;
		await expect(f.session.observe(f.context, f.window)).rejects.toThrow(
			"session_ended: the driver refused 'list_windows' again right after reviving its session",
		);
		expect(f.calls.slice(before).map(call => call.name)).toEqual(["list_windows", "start_session", "list_windows"]);

		// A transport that does not own the ended session cannot revive it.
		const unavailable = { code: "session_unavailable", message: "session is not available to this transport" };
		f.state.hook = async name =>
			name === "start_session"
				? { text: unavailable.message, structuredJson: JSON.stringify(unavailable), isError: true, images: [] }
				: SESSION_ENDED;
		before = f.calls.length;
		const refused = await f.session.observe(f.context, f.window).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(ToolError);
		expect((refused as ToolError).message).toStartWith(
			"session_ended: the driver ended this computer session and refused to start a new one",
		);
		expect((refused as ToolError).context).toMatchObject({ code: "session_unavailable" });
		expect(f.calls.slice(before).map(call => call.name)).toEqual(["list_windows", "start_session"]);
	} finally {
		await f.close();
	}
});

it("sends any other driver refusal once, without reviving the session", async () => {
	const f = await fixture();
	try {
		const refusal = {
			status: "refused",
			refusal: { code: "background_unavailable", message: "no focus-free route" },
		};
		f.state.hook = async name =>
			name === "list_windows"
				? { text: "no focus-free route", structuredJson: JSON.stringify(refusal), isError: true, images: [] }
				: undefined;
		const before = f.calls.length;
		await expect(f.session.observe(f.context, f.window)).rejects.toThrow("no focus-free route");
		expect(f.calls.slice(before).map(call => call.name)).toEqual(["list_windows"]);
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

/// The window server draws the popovers and menus an application hangs over a
/// window into that window's capture, so the pixels cover more than the
/// window. Read against the window's own bounds, a 0.77x picture was labelled
/// "1 px = 1 window point" and every coordinate taken off it landed somewhere
/// else (calendar-recur omp-1 L69/L78 vs the window list at L81).
it("takes a capture that covers more than the window on the rect it covers", async () => {
	const f = await fixture();
	try {
		f.row.bounds.x = 0;
		f.row.bounds.y = 0;
		f.row.bounds.width = 2;
		f.row.bounds.height = 1;
		// A popover hanging above and to the left: 4x2 pt of content, still
		// 4x2 px delivered, so the picture is point-for-point on its own rect
		// and two points left of the window's origin.
		f.state.captureContent = { x: -2, y: -1, width: 4, height: 2 };
		const window = await f.session.window(f.context, { id: "1", pid: 101 });
		const image = await f.session.captureWindow(f.context, window);
		expect(image).toMatchObject({
			width: 4,
			height: 2,
			pointWidth: 4,
			pointHeight: 2,
			originX: -2,
			originY: -1,
			scale: 1,
		});
		// A window point is still a window point to the caller; it reaches the
		// driver in the frame the driver delivered.
		await f.session.click(f.context, window, [1, 0]);
		expect(f.lastDispatch()?.args).toMatchObject({ x: 3, y: 1 });
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

it("reads a window once more when its frame moved during the read, and refuses a second move", async () => {
	const f = await fixture();
	let moves = 1;
	try {
		// The frame moves while the driver walks the window.
		f.state.hook = async name => {
			if (name === "get_window_state" && moves > 0) {
				moves--;
				f.row.bounds.width++;
			}
			return undefined;
		};
		const observation = await f.session.observe(f.context, f.window, { screenshot: true });
		expect(observation.window.bounds).toEqual(f.row.bounds);
		expect(f.calls.filter(call => call.name === "get_window_state")).toHaveLength(2);
		// A frame that moves again under the second read is still refused.
		moves = 2;
		await expect(f.session.observe(f.context, f.window)).rejects.toThrow(
			"StaleFrame: window geometry changed during observation",
		);
		expect(f.calls.filter(call => call.name === "get_window_state")).toHaveLength(4);
		// Any other refusal of the read is not retried.
		f.state.wrongIdentity = true;
		await expect(f.session.observe(f.context, f.window)).rejects.toThrow("WrongWindow");
		expect(f.calls.filter(call => call.name === "get_window_state")).toHaveLength(5);
		// After a mutation the geometry re-read is the observation's one
		// re-sample: titles that still disagree do not buy a third read.
		f.state.wrongIdentity = false;
		f.state.role = "AXWindow";
		f.state.label = "Previous document";
		const target = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		await f.session.click(f.context, f.window, target);
		f.calls.length = 0;
		moves = 1;
		await f.session.observe(f.context, f.window);
		expect(f.calls.filter(call => call.name === "get_window_state")).toHaveLength(2);
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

it("projects a query over the walked tree: a string is literal, an array is any-of", async () => {
	const f = await fixture();
	const row = (index: number, role: string, label: string, depth: number, extra: Wire = {}): Wire => ({
		element_index: index,
		element_token: `s1:${index}`,
		role,
		label,
		depth,
		enabled: true,
		...extra,
	});
	try {
		f.state.hook = async name =>
			name === "get_window_state"
				? reply({
						pid: 101,
						window_id: 1,
						snapshot_id: "s1",
						truncated: false,
						window_bounds: f.row.bounds,
						elements: [
							row(1, "AXWindow", "Card", 0),
							row(2, "AXGroup", "Phones", 1),
							row(3, "AXTextField", "home", 2, { value: "(555) 123-4567" }),
							row(4, "AXButton", "Remove Phone", 2),
							row(5, "AXGroup", "Actions", 1),
							row(6, "AXButton", "Done", 2),
							row(7, "AXButton", "Cancel", 2),
							row(8, "AXButton", "Export | CSV", 2),
						],
					})
				: undefined;
		// Two literals, neither in the row's own case, keep their rows and the
		// groups that place them; the rest is hidden and counted.
		const observation = await f.session.observe(f.context, f.window, { query: ["remove phone", "DONE"] });
		expect(observation.tree.split("\n")).toEqual([
			'n1 window "Card"',
			'  n2 group "Phones"',
			'    n4 button "Remove Phone"',
			'  n5 group "Actions"',
			'    n6 button "Done"',
			'Query ["remove phone","DONE"] matched 2 of 8 rows (ancestors kept); 3 hidden — drop the query to read them.',
		]);
		expect(observation.elements.map(element => element.label)).toEqual([
			"Card",
			"Phones",
			"Remove Phone",
			"Actions",
			"Done",
		]);
		// One string is one substring: the pipe is a character the row would
		// have to print, not a separator, so this asks for a row none of them is.
		const literal = await f.session.observe(f.context, f.window, { query: "remove phone|DONE" });
		expect(literal.tree.split("\n")[0]).toBe(
			'No row matched query "remove phone|DONE" under window 1 "Editor" (Fixture): the walk read 8 actionable rows and reported the tree complete. Next: drop the query to read the whole tree, or widen it — a query is a case-insensitive substring; pass an array to search for any of several; observe({ menubar: true }) adds the menu bar.',
		);
		// And a row whose own label carries a pipe is reachable, which the
		// split made impossible: every such query asked for nothing.
		expect((await f.session.observe(f.context, f.window, { query: "Export | CSV" })).tree).toContain(
			'button "Export | CSV"',
		);
		// A value is searchable too, and a query that keeps everything says nothing.
		expect((await f.session.observe(f.context, f.window, { query: "123-4567" })).tree).toContain(
			'textfield "home"',
		);
		expect((await f.session.observe(f.context, f.window, { query: "ax" })).tree).not.toContain("hidden");
		// A matched container answers with what it holds. The bench asked an
		// open popover for its contents, was told `AXPopover ""` and 121 rows
		// hidden, and spent two cells recovering from the non-answer.
		const container = await f.session.observe(f.context, f.window, { query: "Phones" });
		expect(container.tree.split("\n").map(line => line.replace(/^(\s*)n\d+/, "$1[ref]"))).toEqual([
			'[ref] window "Card"',
			'  [ref] group "Phones"',
			'    [ref] textfield "home" = "(555) 123-4567"',
			'    [ref] button "Remove Phone"',
			'Query "Phones" matched 1 of 8 rows (ancestors kept, 2 rows shown under them); 4 hidden — drop the query to read them.',
		]);
		// The driver never sees the query.
		expect(
			f.calls.filter(call => call.name === "get_window_state").every(call => call.args.query === undefined),
		).toBe(true);
	} finally {
		await f.close();
	}
});

it("refuses an empty, blank or non-string query", async () => {
	const f = await fixture();
	// `[]` used to mean "no projection" and a number threw a raw TypeError out
	// of `String.prototype.split`; both are a caller saying something it did
	// not mean. `""` is a string, so the reply for it names it and the way to
	// read the whole window.
	try {
		for (const query of [[], ["ok", 3], 7, ["Save", "  "]])
			await expect(
				f.session.observe(f.context, f.window, { query } as unknown as ObserveOptions),
			).rejects.toThrow("Invalid observe query");
		const empty = f.session.observe(f.context, f.window, { query: "" });
		await expect(empty).rejects.toThrow('omit query (not "")');
	} finally {
		await f.close();
	}
});

it("caps how much of a matched container it prints and says what it left out", async () => {
	const f = await fixture();
	// The root window row is a container whose subtree is the whole tree in
	// 119 of 129 walked trees, and any query that matches a window title or a
	// role lands on it, so an expansion has to be bounded to be a projection.
	const row = (index: number, role: string, label: string, depth: number): Wire => ({
		element_index: index,
		element_token: `s1:${index}`,
		role,
		label,
		depth,
	});
	try {
		f.state.hook = async name =>
			name === "get_window_state"
				? reply({
						pid: 101,
						window_id: 1,
						snapshot_id: "s1",
						truncated: false,
						window_bounds: f.row.bounds,
						elements: [
							row(1, "AXWindow", "Card", 0),
							row(2, "AXGroup", "Phones", 1),
							...Array.from({ length: 20 }, (_, index) => row(index + 3, "AXTextField", `field ${index + 1}`, 2)),
						],
					})
				: undefined;
		const observation = await f.session.observe(f.context, f.window, { query: "Phones" });
		const lines = observation.tree.split("\n");
		expect(lines.filter(line => line.includes("textfield"))).toHaveLength(12);
		expect(observation.tree).toContain('textfield "field 12"');
		expect(observation.tree).not.toContain('textfield "field 13"');
		expect(lines[2]).toBe("    (8 more rows under this one were not shown — drop the query to read them.)");
		expect(lines.at(-1)).toBe(
			'Query "Phones" matched 1 of 22 rows (ancestors kept, 12 rows shown under them); 8 hidden — drop the query to read them.',
		);
		// The cap prints rows, so they are handles too — the same 14 the tree
		// shows, and not the 8 it says it left out.
		expect(observation.elements).toHaveLength(14);
	} finally {
		await f.close();
	}
});

it("does not expand a match that contains another match", async () => {
	const f = await fixture();
	const row = (index: number, role: string, label: string, depth: number): Wire => ({
		element_index: index,
		element_token: `s1:${index}`,
		role,
		label,
		depth,
	});
	try {
		f.state.hook = async name =>
			name === "get_window_state"
				? reply({
						pid: 101,
						window_id: 1,
						snapshot_id: "s1",
						truncated: false,
						window_bounds: f.row.bounds,
						elements: [
							row(1, "AXWindow", "Card", 0),
							row(2, "AXGroup", "Phones", 1),
							row(3, "AXTextField", "home", 2),
							row(4, "AXTextField", "mobile", 2),
						],
					})
				: undefined;
		// The deeper match is the specific answer: expanding its ancestor as
		// well would re-print the tree around what was asked for.
		const observation = await f.session.observe(f.context, f.window, { query: ["phones", "mobile"] });
		expect(observation.tree.split("\n")).toEqual([
			'n1 window "Card"',
			'  n2 group "Phones"',
			'    n4 textfield "mobile"',
			'Query ["phones","mobile"] matched 2 of 4 rows (ancestors kept); 1 hidden — drop the query to read them.',
		]);
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
			'No row matched query "Repeat" under window 1 "Editor" (Fixture): the walk read 148 actionable rows and reported the tree complete. Next: drop the query to read the whole tree, or widen it — a query is a case-insensitive substring; pass an array to search for any of several; observe({ menubar: true }) adds the menu bar.',
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

it("answers a query from the text the window displays, not from its controls alone", async () => {
	const f = await fixture();
	// The driver's structured `elements` carry actionable nodes only; a node it
	// gave no action — a version string, a heading, a status line — exists in
	// the markdown and nowhere else, so a query over `elements` reported the
	// window does not say what it is plainly showing.
	const markdown = [
		'- [1] AXWindow "About" [actions=[press]]',
		'  - [2] AXGroup "Overview" [actions=[press]]',
		'    - AXStaticText "Version" = "macOS Tahoe Version 26.1"',
		'    - [3] AXButton "More Info…" [actions=[press]]',
	].join("\n");
	const row = (index: number, role: string, label: string, depth: number): Wire => ({
		element_index: index,
		element_token: `s1:${index}`,
		role,
		label,
		depth,
	});
	try {
		f.state.hook = async name =>
			name === "get_window_state"
				? reply({
						pid: 101,
						window_id: 1,
						snapshot_id: "s1",
						truncated: false,
						window_bounds: f.row.bounds,
						tree_markdown: markdown,
						elements: [row(1, "AXWindow", "About", 0), row(2, "AXGroup", "Overview", 1), row(3, "AXButton", "More Info…", 2)],
					})
				: undefined;
		const found = await f.session.observe(f.context, f.window, { query: "Tahoe" });
		expect(found.tree.split("\n")).toEqual([
			'n1 window "About"',
			'  n2 group "Overview"',
			'    text "Version" = "macOS Tahoe Version 26.1"',
			// The row the text hangs off is the match, so what it holds comes
			// with it: the button beside the version string is part of the
			// answer, and nothing is left hidden to announce.
			'    n3 button "More Info…"',
		]);
		// Display-only text is text, never a target: no ref is minted for it and
		// the observation's element list is still the controls.
		expect(found.elements.map(element => element.label)).toEqual(["About", "Overview", "More Info…"]);
		// Every read says what the window shows, not only the one that asked
		// for it: the version string is in no walk's `elements` at all.
		expect((await f.session.observe(f.context, f.window)).tree.split("\n")).toEqual([
			'n4 window "About"',
			'  n5 group "Overview"',
			'    text "Version" = "macOS Tahoe Version 26.1"',
			'    n6 button "More Info…"',
		]);
		// A miss now says the text was searched too, so widening the query is
		// the next move rather than reaching for a screenshot.
		expect((await f.session.observe(f.context, f.window, { query: "Sequoia" })).tree).toContain(
			"the walk read 3 actionable rows and every line of text it renders",
		);
	} finally {
		await f.close();
	}
});

it("answers a query about a window under a sheet from the sheet, which is what the window is showing", async () => {
	const f = await fixture();
	const sheet = { ...f.row, window_id: 5, title: "open-panel", bounds: { x: 30, y: 40, width: 120, height: 80 } };
	const parent = (data: Wire): CuaToolResult =>
		reply({
			pid: 101,
			window_id: 1,
			snapshot_id: "s1",
			elements: [],
			truncated: false,
			element_count: 119,
			total_element_count: 119,
			collapsed_rows: 22,
			window_bounds: f.row.bounds,
			related_windows: [{ pid: 101, window_id: 5, title: "open-panel", relation: "sheet" }],
			...data,
		});
	const sheetRows = (label: string): CuaToolResult =>
		reply({
			pid: 101,
			window_id: 5,
			snapshot_id: "sheet-1",
			window_bounds: sheet.bounds,
			elements: [
				{ element_index: 1, element_token: "sheet-1:1", role: "AXSheet", label: "open-panel", depth: 0 },
				{ element_index: 2, element_token: "sheet-1:2", role: "AXRow", label, depth: 1 },
			],
		});
	try {
		f.state.relatedWindows = [{ pid: 101, window_id: 5, title: "open-panel", relation: "sheet" }];
		f.state.hook = async (name, args) => {
			if (name === "list_windows") return reply({ windows: [f.row, sheet] });
			if (name !== "get_window_state") return undefined;
			return args.window_id === 5 ? sheetRows("Calculator") : parent({});
		};
		// The match is in the sheet, printed above; the window behind it is not
		// where to look and its 22 out-of-view rows are not what to scroll.
		const hit = await f.session.observe(f.context, f.window, { query: "Calculator" });
		const matched = hit.elements.find(element => element.label === "Calculator")!;
		expect(hit.tree).toContain(`  ${matched.ref} row "Calculator"`);
		expect(matched.windowId).toBe("5");
		expect(hit.tree.split("\n").filter(line => line.startsWith("No row"))).toEqual([
			'No row of window 1 itself matched query "Calculator"; 1 row(s) of the sheet "open-panel" (window 5) modal over it match and are printed above — work in the sheet while it is up.',
		]);
		expect(hit.tree).not.toContain("scroll the list first");
		// Nothing anywhere: the census is still the sheet's, with its own row
		// count, and the advice is about the sheet.
		f.state.hook = async (name, args) => {
			if (name === "list_windows") return reply({ windows: [f.row, sheet] });
			if (name !== "get_window_state") return undefined;
			return args.window_id === 5 ? sheetRows("Documents") : parent({});
		};
		const missed = await f.session.observe(f.context, f.window, { query: "Calculator" });
		expect(missed.tree.split("\n").filter(line => line.startsWith("No row"))).toEqual([
			'No row matched query "Calculator" in the sheet "open-panel" (window 5) modal over window 1 "Editor" (Fixture): its walk read 2 rows. Next: drop the query to read the sheet whole, or widen it — a query is a case-insensitive substring; pass an array to search for any of several. The window behind it takes no input until the sheet is answered, so its own rows are not the place to look.',
		]);
		expect(missed.tree).not.toContain("22 row(s) are out of view");
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
		// Without the subrole the row reads `textfield` and names nothing.
		expect(observation.tree.split("\n")[0]).toBe(`${observation.elements[0]!.ref} searchfield [disabled]`);
		// A subrole that only restates its role is 164 of the 173 a Notes window
		// carries, so the row does not print it twice — but the snapshot keeps
		// it, which is what `find` reads.
		f.state.role = "AXRow";
		f.state.subrole = "AXTableRow";
		const listed = await f.session.observe(f.context, f.window);
		expect(listed.elements[0]!.subrole).toBe("AXTableRow");
		expect(listed.tree.split("\n")[0]).toBe(`${listed.elements[0]!.ref} row [disabled]`);
		// A provider that reports no subrole says nothing about one.
		f.state.subrole = undefined;
		const plain = await f.session.observe(f.context, f.window);
		expect(plain.elements[0]!.subrole).toBeUndefined();
		expect(plain.tree.split("\n")[0]).toBe(`${plain.elements[0]!.ref} row [disabled]`);
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

it("waits for a launched app's crash alert only when that process is already gone", async () => {
	const f = await fixture();
	const alert = {
		windows: [
			systemWindow({
				id: "777",
				title: "Fixture quit unexpectedly.",
				app: "UserNotificationCenter",
				pid: 55,
			}),
		],
		elapsedMs: 0,
	};
	const launched = async (pid: number) => {
		f.state.hook = async name => (name === "launch_app" ? reply({ pid }) : undefined);
		const before = f.state.rosterReads;
		const result = await f.session.launch(f.context, { name: "Fixture" });
		return { result, samples: f.state.rosterReads - before };
	};
	try {
		// Every launch reads the roster twice on its own — the pre-dispatch gate
		// and the reply's own interruption check — and the crash report lands
		// after both, so only a watch that polls for it can ever see it.
		let armed = 0;
		f.state.roster = () => (f.state.rosterReads > armed + 2 ? alert : undefined);
		// A live launch pays nothing: only a process that is already gone can
		// have raised the alert this would be waiting for.
		armed = f.state.rosterReads;
		const alive = await launched(process.pid);
		expect(alive.samples).toBe(2);
		expect(alive.result.interruptedBy).toBeUndefined();
		expect(alive.result.text).not.toContain("Do not relaunch");
		// One that died during the launch is polled for it, and what it raised
		// is named as a crash report rather than as a launch to retry.
		armed = f.state.rosterReads;
		const dead = await launched(2 ** 22);
		expect(dead.samples).toBe(3);
		expect(dead.result.interruptedBy?.windowId).toBe("777");
		expect(dead.result.text).toContain("Do not relaunch");
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
		expect(observation.tree).toContain('textfield "Buy milk"');
		// The value repeats the label; the row does not print it twice.
		expect(observation.tree).not.toContain('= "Buy milk"');
		// Both of these are advertised by every row of some family: printing
		// them names nothing a reader could not have assumed.
		expect(observation.tree).not.toContain("actions=");
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
		// What is left is what this app authored, beside the two AX verbs no
		// family publishes for free.
		expect(observation.tree).toContain("actions=open,toString,Add Reminder,Snooze");
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

it("lists a row's own press alongside every other action the row advertises", async () => {
	const f = await fixture();
	try {
		// Withholding `press` from list roles left the model told twice over:
		// 147 cells in one leg printed `help="Perform press or select Return to
		// open note."` beside an `actions=` list the press was cut from. Which
		// gesture selects is the driver's per-dispatch call, not a row
		// attribute, so every role's list is what that row offers.
		f.state.label = "Incomplete, Buy milk";
		f.state.value = undefined;
		f.state.actions = ["AXPress", "AXShowMenu", "Move Down"];
		for (const role of ["AXRow", "AXCell", "AXListItem", "AXButton"]) {
			f.state.role = role;
			const observation = await f.session.observe(f.context, f.window);
			expect(observation.elements[0]!.actions).toEqual(["press", "show_menu", "Move Down"]);
			// `press` is assumed of every row that has one; the app's own verb is not.
			expect(observation.tree).toContain("actions=Move Down");
		}
		const observation = await f.session.observe(f.context, f.window);
		await f.session.perform(f.context, f.window, observation.elements[0]!.ref, "press");
		expect(f.lastDispatch()).toMatchObject({ name: "click", args: { action: "press" } });
	} finally {
		await f.close();
	}
});

it("prints a sheet once when the roster listed it before it reported attaching", async () => {
	const f = await fixture();
	// Right after the command that opens it, a sheet is already a window of
	// the pid while its parent does not yet report it attached, so that read
	// prints it as a window the app opened. Once it is attached it is the
	// sheet: printed once, and its refs the ones that act.
	const sheet = { ...f.row, window_id: 5, title: "Export", bounds: { x: 30, y: 40, width: 120, height: 80 } };
	let windows: WindowRow[] = [f.row];
	try {
		f.state.hook = async (name, args) => {
			if (name === "list_windows") return reply({ windows });
			if (name !== "get_window_state" || args.window_id !== 5) return undefined;
			return reply({
				pid: 101,
				window_id: 5,
				snapshot_id: "sheet-1",
				related_windows: [],
				window_bounds: sheet.bounds,
				elements: [
					{ element_index: 1, element_token: "sheet-1:1", role: "AXSheet", label: "export", depth: 0 },
					{ element_index: 2, element_token: "sheet-1:2", role: "AXButton", label: "Save", depth: 1 },
				],
			});
		};
		await f.session.observe(f.context, f.window);
		windows = [f.row, sheet];
		await f.session.press(f.context, f.window, "cmd+e", undefined, { delivery: "foreground" });
		expect((await f.session.observe(f.context, f.window)).tree).toContain(
			'window 5 "Export" — opened by this app, driven through this window\'s refs',
		);
		f.state.relatedWindows = [{ pid: 101, window_id: 5, title: "Export", relation: "sheet" }];
		const observation = await f.session.observe(f.context, f.window);
		expect(observation.tree).toContain('sheet "Export" (window 5) — modal over window 1');
		expect(observation.tree.match(/window 5/g)).toHaveLength(1);
		expect(observation.tree.match(/button "Save"/g)).toHaveLength(1);
		const save = observation.elements.find(element => element.label === "Save")!;
		await f.session.click(f.context, observation.window, save.ref);
		expect(f.lastDispatch()).toMatchObject({
			name: "click",
			args: { window_id: 5, pid: 101, element_token: "sheet-1:2", snapshot_id: "sheet-1" },
		});
		// Its parent stops reporting it while it is still on screen: it is the
		// window this app opened again, not gone from the opener's reads.
		f.state.relatedWindows = [];
		expect((await f.session.observe(f.context, f.window)).tree.match(/button "Save"/g)).toHaveLength(1);
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
				`  ${observation.elements[1]!.ref} sheet "save"`,
				`    ${cancel.ref} button "Cancel"`,
				`${parentRef} textfield "Editor" [disabled] placeholder="Hint, not value"`,
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
		expect(() => f.session.element(cancel.ref)).toThrow(
			`StaleRef: ${cancel.ref} — sheet "Save" (window 5) is gone`,
		);
	} finally {
		await f.close();
	}
});

it("prints a sheet attached to a sheet under its opener, bounded and without looping", async () => {
	const f = await fixture();
	// Recorded shape (driver 5b3a6cf96, VM probe hc4): the document's walk
	// names only its own sheet (an export panel); the panel's walk names the
	// sheet attached to it (its go-to-folder sheet), which the document's
	// walk never reports.
	const bounds = { x: 30, y: 40, width: 120, height: 80 };
	let related: Record<number, { window_id: number; title: string }[]> = {
		83: [{ window_id: 89, title: "" }],
		89: [],
	};
	const label: Record<number, string> = { 83: "export", 89: "GoToWindow", 90: "third", 91: "fourth" };
	const partial = new Set<number>();
	try {
		f.state.relatedWindows = [{ pid: 101, window_id: 83, title: "export", relation: "sheet" }];
		f.state.hook = async (name, args) => {
			if (name === "list_windows")
				return reply({
					windows: [
						f.row,
						...[83, 89, 90, 91, 92, 93, 94, 95, 96].map(id => ({ ...f.row, window_id: id, title: "", bounds })),
					],
				});
			if (name !== "get_window_state" || args.window_id === 1) return undefined;
			const id = args.window_id as number;
			return reply({
				pid: 101,
				window_id: id,
				snapshot_id: `sheet-${id}`,
				related_windows: (related[id] ?? []).map(row => ({ pid: 101, relation: "sheet", ...row })),
				...(partial.has(id) ? { truncated: true } : {}),
				window_bounds: bounds,
				elements: [
					{ element_index: 0, element_token: `sheet-${id}:0`, role: "AXSheet", label: label[id], depth: 0 },
					{ element_index: 1, element_token: `sheet-${id}:1`, role: "AXButton", label: "Cancel", depth: 1 },
				],
			});
		};
		// A query is answered from the sheet taking input: the panel's match
		// sits under the inner sheet, so it is not offered as the place to work.
		const queried = await f.session.observe(f.context, f.window, { query: "export" });
		expect(queried.tree).toContain('No row matched query "export" in the sheet "" (window 89) modal over window 1');
		const observation = await f.session.observe(f.context, f.window);
		const ref = (id: string, role: string) =>
			observation.elements.find(element => element.windowId === id && element.role === role)!.ref;
		expect(observation.tree).toBe(
			[
				'sheet "export" (window 83) — modal over window 1',
				`  ${ref("83", "AXSheet")} sheet "export"`,
				`    ${ref("83", "AXButton")} button "Cancel"`,
				'  sheet "" (window 89) — modal over sheet 83',
				`    ${ref("89", "AXSheet")} sheet "GoToWindow"`,
				`      ${ref("89", "AXButton")} button "Cancel"`,
				`${observation.elements[0]!.ref} textfield "Editor" [disabled] placeholder="Hint, not value"`,
			].join("\n"),
		);
		// The inner sheet's ref, reached through the document's handle, acts on the inner sheet.
		const inner = ref("89", "AXButton");
		await f.session.click(f.context, observation.window, inner);
		expect(f.lastDispatch()).toMatchObject({ name: "click", args: { window_id: 89, element_token: "sheet-89:1" } });
		// A keyboard refusal on the document names the innermost sheet, the one
		// that holds the keyboard over the panel it opened from.
		const hook = f.state.hook;
		f.state.hook = async (name, args) =>
			name === "press_key"
				? {
						text: "press_key delivery failed: exact target window did not become focused for foreground HID delivery",
						structuredJson: JSON.stringify({ code: "delivery_failed" }),
						isError: true,
						errorCode: "delivery_failed",
						images: [],
					}
				: hook!(name, args);
		await expect(
			f.session.press(f.context, observation.window, "right", undefined, { delivery: "foreground" }),
		).rejects.toThrow("window 89 — a sheet attached to 83 — holds keyboard focus, not window 1");
		f.state.hook = hook;

		// The inner sheet was answered: its refs say so; the panel's stay.
		related = { 83: [] };
		const answered = await f.session.observe(f.context, f.window);
		expect(answered.tree).not.toContain("window 89");
		expect(() => f.session.element(inner)).toThrow(`StaleRef: ${inner} — sheet "" (window 89) is gone`);

		// A relation that loops back ends at the window already printed, and a
		// chain past the depth bound is named with the call that reads it.
		related = {
			83: [{ window_id: 89, title: "" }],
			89: [
				{ window_id: 83, title: "export" },
				{ window_id: 90, title: "third" },
			],
			90: [{ window_id: 91, title: "fourth" }],
			91: [{ window_id: 83, title: "export" }],
		};
		const reads = f.calls.filter(call => call.name === "get_window_state").length;
		const deep = await f.session.observe(f.context, f.window);
		expect(deep.tree.match(/\(window 83\)/g)).toHaveLength(1);
		expect(deep.tree).toContain('    sheet "third" (window 90) — modal over sheet 89');
		expect(deep.tree).toContain(
			'      sheet "fourth" (window 91) — modal over sheet 90; not read here — computer.window({"id":"91","pid":101}) reads it',
		);
		// The document, then 83, 89 and 90: the fourth level is not walked.
		expect(f.calls.filter(call => call.name === "get_window_state").length - reads).toBe(4);

		// A panel whose own read failed says nothing about what is attached to
		// it: its inner sheets' refs stop being admitted, as unread, not gone.
		const third = deep.elements.find(element => element.windowId === "90")!.ref;
		f.state.hook = async (name, args) =>
			name === "get_window_state" && args.window_id === 83
				? { text: "walk failed", isError: true, errorCode: "CuaError", images: [] }
				: hook!(name, args);
		const failed = await f.session.observe(f.context, f.window);
		expect(failed.tree).toContain('sheet "export" (window 83) — modal over window 1 — its own walk failed');
		expect(() => f.session.element(third)).toThrow(
			`StaleRef: ${third} — sheet "third" (window 90) was not read in the last observation`,
		);

		// A walk the driver cut short proves nothing about a sheet it did not
		// report: the inner sheet's refs stop being admitted, as unread.
		f.state.hook = hook;
		related = { 83: [{ window_id: 89, title: "" }], 89: [] };
		const before = (await f.session.observe(f.context, f.window)).elements.find(element => element.windowId === "89")!.ref;
		related = { 83: [] };
		partial.add(83);
		await f.session.observe(f.context, f.window);
		expect(() => f.session.element(before)).toThrow(`StaleRef: ${before} — sheet "" (window 89) was not read in the last observation`);
		partial.clear();

		// Past six walked sheets in one read, the rest are named, not read.
		f.state.hook = hook;
		related = {};
		f.state.relatedWindows = [83, 91, 92, 93, 94, 95, 96].map(id => ({ pid: 101, window_id: id, title: "", relation: "sheet" }));
		const wide = await f.session.observe(f.context, f.window);
		expect(wide.tree.match(/; not read here/g)).toHaveLength(1);
		expect(wide.tree).toContain('sheet "" (window 96) — modal over window 1; not read here — computer.window({"id":"96","pid":101}) reads it');
	} finally {
		await f.close();
	}
});

it("keeps a read's own sheets when remembered relations reverse, and names a sheet it could not read", async () => {
	const f = await fixture();
	const bounds = { x: 30, y: 40, width: 120, height: 80 };
	let related: Record<number, number[]> = {};
	const failed = new Set<number>();
	const labels: Record<number, string> = {};
	f.state.hook = async (name, args) => {
		if (name === "list_windows")
			return reply({ windows: [f.row, ...[2, 3, 4].map(id => ({ ...f.row, window_id: id, title: `W${id}`, bounds }))] });
		if (name !== "get_window_state") return undefined;
		const id = args.window_id as number;
		if (failed.has(id)) return { text: "walk failed", isError: true, errorCode: "CuaError", images: [] };
		return reply({
			pid: 101,
			window_id: id,
			snapshot_id: `w${id}-${f.calls.length}`,
			related_windows: (related[id] ?? []).map(sheet => ({ pid: 101, window_id: sheet, title: `W${sheet}`, relation: "sheet" })),
			window_bounds: id === 1 ? f.row.bounds : bounds,
			elements: [
				{ element_index: 0, element_token: `w${id}:0:${f.calls.length}`, role: "AXSheet", label: `S${id}`, depth: 0 },
				{ element_index: 1, element_token: `w${id}:1:${f.calls.length}`, role: "AXButton", label: labels[id] ?? "Cancel", depth: 1 },
			],
		});
	};
	const live = (observation: { elements: readonly { ref: string }[] }) =>
		observation.elements.filter(element => {
			try {
				f.session.element(element.ref);
				return false;
			} catch {
				return true;
			}
		});
	try {
		// Remembered 1 → 2 → 3 → 4; then the app reports 4 → 2 and nothing else.
		related = { 1: [2], 2: [3], 3: [4] };
		const remembered = await f.session.observe(f.context, f.window);
		const three = remembered.elements.find(element => element.windowId === "3")!.ref;
		related = { 4: [2] };
		const four = await f.session.observe(f.context, await f.session.window(f.context, { id: "4", pid: 101 }));
		expect(four.tree).toContain('sheet "W2" (window 2) — modal over window 4');
		// Every ref this reply printed is live.
		expect(live(four).map(element => element.ref)).toEqual([]);
		// The window whose remembered edge closed the cycle was not read here:
		// its refs stop being admitted instead of lingering unreachable.
		expect(() => f.session.element(three)).toThrow(`StaleRef: ${three} — sheet "W3" (window 3) was not read in the last observation`);

		// A sheet taking input that could not be read is named as unread, with
		// the call that reads it — not as a sheet read with no rows, and not by
		// sending the caller to the sheet it covers.
		related = { 1: [2], 2: [3] };
		labels[2] = "Match here";
		failed.add(3);
		const queried = await f.session.observe(f.context, f.window, { query: "Match" });
		expect(queried.tree).toContain(
			'the query did not search the sheet "W3" (window 3) modal over it: that sheet was not read here, so neither its rows nor what is attached to it are known. Read it with computer.window({"id":"3","pid":101}) and observe that handle.',
		);
		expect(queried.tree).not.toContain("work in the sheet while it is up");
		expect(queried.tree).not.toContain("drop the query");
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
		// The driver's own advice is its own; what this side owes the caller is
		// the rung spelled the way they type it.
		f.state.hook = async name => (name === "click" ? untyped : undefined);
		const legacy = await f.session
			.click(f.context, f.window, ref, { delivery: "foreground" })
			.catch((error: unknown) => error);
		if (!(legacy instanceof ToolError)) throw new Error("Expected the legacy refusal");
		expect(legacy.message).toContain('Retry this action with { delivery: "foreground" }');
		expect(legacy.message).not.toContain("delivery_mode");
		// An untyped code is no `element_disabled`, so nothing is added to it.
		expect(legacy.message.split("\n").at(-1)).toBe("Evidence: requested=foreground");

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
		// A menu row: the row's own role is the whole decision, and no rung and
		// no window is the answer at all.
		f.state.role = "AXMenuItem";
		f.state.label = "_popUpItemAction:";
		const menuRef = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		f.state.hook = async name =>
			name === "click"
				? disabled(
						'AXPress was not dispatched: AXMenuItem "_popUpItemAction:" of window 1 reports AXEnabled=false.',
						{ front_in_process: true, role: "AXMenuItem" },
					)
				: undefined;
		const menu = await f.session.click(f.context, f.window, menuRef).catch((error: unknown) => error);
		if (!(menu instanceof ToolError)) throw new Error("Expected the disabled refusal");
		expect(menu.message.split("\n").at(-1)).toBe(
			"That AXMenuItem is disabled by the app's own current state: a menu row's AXEnabled tracks the command's applicability, not focus or delivery. Satisfy the command's precondition (a selection, a document, a mode) or pick another item.",
		);
	} finally {
		await f.close();
	}
});

it("spells the press a value_not_settable refusal names as a click", async () => {
	const f = await fixture();
	/** The driver's refusal for a control with no value to write (fork 77b8264f0). */
	const unsettable = (subrole: string | undefined, actions: string[]) => ({
		text: `set_value was not dispatched: AXButton${subrole ? `/${subrole}` : ""} "Search" of window 1 publishes no AXValue, so it has no value to write.`,
		structuredJson: JSON.stringify({
			code: "value_not_settable",
			effect: "not_dispatched",
			route: "ax",
			action: "set_value",
			role: "AXButton",
			...(subrole ? { subrole } : {}),
			label: "Search",
			window_id: 1,
			pid: 101,
			value_attribute: "absent",
			advertised_actions: actions,
		}),
		isError: true,
		errorCode: "value_not_settable",
		images: [],
	});
	try {
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		const refused = async (subrole: string | undefined, actions: string[]) => {
			f.state.hook = async name => (name === "set_value" ? unsettable(subrole, actions) : undefined);
			const error = await f.session.setValue(f.context, f.window, ref, "Dock").catch((caught: unknown) => caught);
			if (!(error instanceof ToolError)) throw new Error("Expected the value_not_settable refusal");
			return error.message;
		};
		// Activity Monitor's collapsed toolbar search: `press()` would send keys.
		expect((await refused("AXSearchField", ["AXPress"])).split("\n").at(-1)).toBe(
			`Press it with win.ref(${JSON.stringify(ref)}).click() (press() sends keys), then win.observe() and setValue on the search field it reveals.`,
		);
		expect((await refused(undefined, ["AXPress"])).split("\n").at(-1)).toBe(
			`Its press is win.ref(${JSON.stringify(ref)}).click(); press() sends keys.`,
		);
		// No press to spell: the driver's sentence is the whole answer.
		const inert = await refused(undefined, []);
		expect(inert).not.toContain(".click()");
		expect(inert).toContain("set_value was not dispatched");
	} finally {
		await f.close();
	}
});

it("offers a disabled control the window it can acquire, and the rung a not-key window needs", async () => {
	const f = await fixture();
	// T11 `native-act-notes/omp-2`: the panel named in front of the search
	// field was the capture lease's own indicator, which the driver classifies
	// and this roster hides — `computer.window("19083")` answered `Missing
	// computer window {"id":"19083"}`.
	const lease = { ...f.row, window_id: 19083, title: "Window", kind: "system_overlay" };
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
		expect(observation.tree).toContain(
			`${observation.elements.find(element => element.label === "Cancel")!.ref} button "Cancel"`,
		);
		// The parent walk carries the depth budget; the query is projected here,
		// never sent, and the sheet's walk carries neither.
		expect(f.calls.filter(call => call.name === "get_window_state").map(call => call.args)).toEqual([
			{
				pid: 101,
				window_id: 1,
				include_accessibility_tree: true,
				include_screenshot: false,
				max_depth: 1,
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
				recommended: "snapshot",
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
		expect(click.message.split("\n").at(-1)).toBe(
			"Evidence: requested=background effect=refused escalation=snapshot",
		);
		expect(click.message).not.toContain("route=");

		// A rung this surface renders no call for stays out of the line as
		// well: advice the caller cannot follow is worse than none.
		const elsewhere = {
			...dead,
			structuredJson: JSON.stringify({
				code: "element_outside_target_window",
				effect: "refused",
				escalation: { reason: "permission_required", target: "session" },
			}),
		};
		f.state.hook = async name => (name === "click" ? elsewhere : undefined);
		const unrendered = await f.session.click(f.context, f.window, [1, 0]).catch((error: unknown) => error);
		if (!(unrendered instanceof ToolError)) throw new Error("Expected the click refusal");
		expect(unrendered.message.split("\n").at(-1)).toBe("Evidence: requested=background effect=refused");
	} finally {
		await f.close();
	}
});

it("reads a Linux capture that reports no frame flag and a walk that states its verdict", async () => {
	const f = await fixture({ platform: "linux" });
	try {
		// `elements_complete` is hard-coded false on Linux, so the fork's own
		// `truncated` verdict is the whole of the answer.
		f.state.truncated = false;
		const observation = await f.session.observe(f.context, f.window, { screenshot: true });
		expect(observation.complete).toBe(true);
		expect(observation.tree).not.toContain("completeness is unknown");
		expect(observation.elements[0]!.actions).toEqual(["press", "showContextMenu"]);
		// No `screenshot_frame_valid` key at all, and the pixels are still usable.
		expect(observation.screenshotError).toBeUndefined();
		expect(observation.screenshot?.target).toBe("6291459");
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

/**
 * A scroll reply in the fork driver's closed `ActionResult` shape: the
 * measured `scroll` object (its `point` in window-local screenshot pixels),
 * the coarse route, and the effect and evidence each outcome publishes —
 * `confirmed` only on the driver's postcondition: travel the way asked, or
 * an end reached without travelling back.
 */
function scrollReply(scroll: Wire, text = "driver verdict in screenshot pixels", extra: Wire = {}): CuaToolResult {
	const along = typeof scroll.moved_pt === "number" ? scroll.moved_pt : 0;
	const confirmed = (scroll.outcome === "moved" && along > 0) || (scroll.outcome === "at_end" && along >= 0);
	return {
		text,
		structuredJson: JSON.stringify({
			route: scroll.delivery === "foreground" ? "global_input" : "synthetic_events",
			delivery: { mode: scroll.delivery },
			effect: confirmed ? "confirmed" : scroll.outcome === "no_motion" ? "suspected_noop" : "unverifiable",
			evidence: confirmed ? [{ kind: "frame_motion" }] : null,
			scroll: { direction: "down", across_pt: 0, chunks: 1, ...scroll },
			...extra,
		}),
		isError: false,
		images: [],
	};
}

it("leads a measured scroll with its verdict at the caller's own point and sends points on the wire", async () => {
	const f = await fixture();
	try {
		// Window 200×100 pt captured as 4×2 px: the wire point is in pixels.
		await f.session.captureWindow(f.context, f.window, { silent: true });
		f.state.hook = async name =>
			name === "scroll"
				? scrollReply(
						{
							delivery: "foreground",
							point: { x: 3, y: 1 },
							requested_pt: 231,
							wheel: { unit: "pixel", events: 10, total: 300 },
							chunks: 2,
							outcome: "moved",
							moved_pt: 231,
							confidence: 0.93,
						},
						"✓ Scrolled down 231 pt at (3, 1) (requested 231; foreground pointer wheel, 2 chunks, 300 px)\nnot driver-verified — confirm via screenshot",
					)
				: undefined;
		const result = await f.session.scroll(f.context, f.window, "down", [150, 60], {
			amount: 231,
			by: "points",
			delivery: "foreground",
		});
		expect(result.text).toBe(
			"✓ Scrolled down 231 pt at (150, 60) (requested 231 pt; foreground pointer wheel, 2 chunks, 300 px)",
		);
		expect(result.mustShow).toBe(true);
		expect(result.effect).toBe("confirmed");
		expect(result.evidence).toEqual([{ kind: "frame_motion" }]);
		expect(result.scroll?.point).toEqual({ x: 150, y: 60 });
		expect(actionMark(result)).toBe("✓");
		expect(f.lastDispatch()).toEqual({
			name: "scroll",
			args: {
				pid: 101,
				window_id: 1,
				x: 3,
				y: 1.2,
				direction: "down",
				amount: 231,
				by: "points",
				delivery_mode: "foreground",
				detect_window_change: false,
			},
		});
	} finally {
		await f.close();
	}
});

it("maps an untargeted scroll's driver point back into window points for its verdict", async () => {
	const f = await fixture();
	try {
		await f.session.captureWindow(f.context, f.window, { silent: true });
		f.state.hook = async name =>
			name === "scroll"
				? scrollReply({
						delivery: "foreground",
						point: { x: 2, y: 1 },
						requested_pt: 231,
						wheel: { unit: "pixel", events: 10, total: 300 },
						outcome: "at_end",
						moved_pt: 58,
						confidence: 0.8,
					})
				: undefined;
		const end = await f.session.scroll(f.context, f.window, "down", undefined, {
			by: "page",
			delivery: "foreground",
		});
		expect(end.text).toBe(
			"✓ At end: moved 58 of 231 pt at (100, 50), then the view stopped at its end — scrolling further down there moves nothing (requested 231 pt; foreground pointer wheel, 300 px)",
		);
		expect(end.scroll?.point).toEqual({ x: 100, y: 50 });
		expect(f.lastDispatch()?.args).not.toHaveProperty("x");
		expect(actionMark(end)).toBe("✓");

		// Background: measured stillness names the foreground retry in the
		// caller's vocabulary, and the driver's escalation is not restated as a doubt.
		f.state.hook = async name =>
			name === "scroll"
				? scrollReply(
						{
							delivery: "background",
							point: { x: 2, y: 1 },
							requested_pt: null,
							wheel: { unit: "line", events: 3, total: 3 },
							outcome: "no_motion",
							moved_pt: 0,
							confidence: null,
						},
						'✗ No motion at (2, 1): the view under the pointer did not scroll; retry with delivery_mode:"foreground"',
						{ escalation: { target: "foreground", reason: "suspected_noop" } },
					)
				: undefined;
		const still = await f.session.scroll(f.context, f.window, "down", undefined, { amount: 3 });
		expect(still.text).toBe(
			'✗ No motion at (100, 50) — no displacement observed (background line wheel, 3 lines); the view may be at its end — unless it is, retry with { delivery: "foreground" }: background wheels do not reach views that scroll only under the real pointer',
		);
		// The route stays on the result for code that branches on it; the
		// text does not restate it as "delivery unproven".
		expect(still.escalation).toContain('{ delivery: "foreground" }');
		expect(still.effect).toBe("suspected_noop");
		expect(still.mustShow).toBe(true);
		expect(actionMark(still)).toBe("✗");
	} finally {
		await f.close();
	}
});

it("names a ref target when no frame maps the driver's point, and keeps unproven outcomes at ?", async () => {
	const f = await fixture();
	try {
		const ref = (await f.session.observe(f.context, f.window)).elements[0]!.ref;
		const sent = {
			delivery: "foreground",
			point: { x: 2, y: 1 },
			requested_pt: 40,
			wheel: { unit: "pixel", events: 2, total: 40 },
		};
		f.state.hook = async name =>
			name === "scroll"
				? scrollReply({ ...sent, outcome: "changed_in_place", moved_pt: 0, confidence: null })
				: undefined;
		const changed = await f.session.scroll(f.context, f.window, "down", ref, { delivery: "foreground" });
		expect(changed.text).toBe(
			`? Changed in place at ${ref}: pixels changed but nothing shifted (a pager, sheet or navigation) (requested 40 pt; foreground pointer wheel, 40 px) — observe before the next coordinate action`,
		);
		expect(changed.scroll?.point).toBeUndefined();
		expect(actionMark(changed)).toBe("?");
		f.state.hook = async name =>
			name === "scroll"
				? scrollReply({
						...sent,
						outcome: "unmeasured",
						moved_pt: null,
						across_pt: null,
						confidence: null,
						reason: "capture unavailable: window capture returned no image",
					})
				: undefined;
		const blind = await f.session.scroll(f.context, f.window, "down", undefined, { delivery: "foreground" });
		expect(blind.text).toBe(
			"? Unmeasured: scrolled down at the window centre (requested 40 pt; foreground pointer wheel, 40 px), but the capture was unavailable: window capture returned no image — observe({ screenshot: true }) to see where it landed",
		);
		expect(blind.evidence).toBeNull();
		expect(actionMark(blind)).toBe("?");
		// With a frame the ref's wheel point maps back onto the result, and
		// the verdict still names the target the way the caller gave it.
		await f.session.captureWindow(f.context, f.window, { silent: true });
		f.state.hook = async name =>
			name === "scroll" ? scrollReply({ ...sent, outcome: "moved", moved_pt: 40, confidence: 0.9 }) : undefined;
		const moved = await f.session.scroll(f.context, f.window, "down", ref, { delivery: "foreground" });
		expect(moved.text).toBe(`✓ Scrolled down 40 pt at ${ref} (requested 40 pt; foreground pointer wheel, 40 px)`);
		expect(moved.scroll?.point).toEqual({ x: 100, y: 50 });
	} finally {
		await f.close();
	}
});

it("never marks a scroll that travelled against the request, or not at all, as done", async () => {
	const f = await fixture();
	try {
		await f.session.captureWindow(f.context, f.window, { silent: true });
		const sent = {
			delivery: "foreground",
			point: { x: 3, y: 1.2 },
			requested_pt: 231,
			wheel: { unit: "pixel", events: 10, total: 231 },
		};
		const scroll = async (reported: Wire) => {
			f.state.hook = async name => (name === "scroll" ? scrollReply({ ...sent, ...reported }) : undefined);
			return f.session.scroll(f.context, f.window, "down", [150, 60], {
				amount: 231,
				by: "points",
				delivery: "foreground",
			});
		};
		const back = await scroll({ outcome: "moved", moved_pt: -80, confidence: 0.9 });
		expect(back.text).toBe(
			"? Moved the other way: the view scrolled up 80 pt at (150, 60) (requested 231 pt; foreground pointer wheel, 231 px) — observe before the next coordinate action",
		);
		expect(actionMark(back)).toBe("?");
		const bouncedBack = await scroll({ outcome: "at_end", moved_pt: -12, confidence: 0.8 });
		expect(bouncedBack.text).toStartWith("? Moved the other way: the view scrolled up 12 pt at (150, 60)");
		expect(actionMark(bouncedBack)).toBe("?");
		const still = await scroll({ outcome: "moved", moved_pt: 0, confidence: 0.5 });
		expect(still.text).toStartWith("? At end: moved 0 of 231 pt at (150, 60)");
		expect(actionMark(still)).toBe("?");
		// An end reached with no travel is the driver's confirmed postcondition.
		const end = await scroll({ outcome: "at_end", moved_pt: 0, confidence: 0.9 });
		expect(end.text).toStartWith("✓ At end: moved 0 of 231 pt at (150, 60)");
		expect(actionMark(end)).toBe("✓");
	} finally {
		await f.close();
	}
});

it("says on the verdict line that a scroll stopped early, and that the user has the pointer when they took it", async () => {
	const f = await fixture();
	try {
		await f.session.captureWindow(f.context, f.window, { silent: true });
		const sent = {
			delivery: "foreground",
			point: { x: 3, y: 1.2 },
			requested_pt: 400,
			wheel: { unit: "pixel", events: 5, total: 150 },
		};
		const scroll = async (reported: Wire, text: string) => {
			f.state.hook = async name => (name === "scroll" ? scrollReply({ ...sent, ...reported }, text) : undefined);
			return f.session.scroll(f.context, f.window, "down", [150, 60], {
				amount: 400,
				by: "points",
				delivery: "foreground",
			});
		};
		// The driver's shape: `stopped early: <why>` alone in the reason for a
		// move, and " Stopped early: <why>." at the end of its own first line.
		const taken = await scroll(
			{
				outcome: "moved",
				moved_pt: 120,
				confidence: 0.9,
				reason: "stopped early: the pointer moved to (10, 10) during the scroll; the user has it",
			},
			"✓ Scrolled down 120 pt at (3, 1) (requested 400; foreground pointer wheel, 1 chunk, 150 px) Stopped early: the pointer moved to (10, 10) during the scroll; the user has it.",
		);
		expect(taken.text).toBe(
			"✓ Scrolled down 120 pt at (150, 60) (requested 400 pt; foreground pointer wheel, 150 px). Stopped early: the pointer moved to (10, 10) during the scroll; the user has it. The user has the pointer or the front app now: do not retry this scroll; wait until they are done, or ask.",
		);
		// A no-motion reason carries its own clause first; the list advice
		// does not apply to a gesture that was cut off.
		const cut = await scroll(
			{
				outcome: "no_motion",
				moved_pt: 0,
				confidence: null,
				reason:
					"no displacement observed — the view may be at its end, or nothing under this point scrolls with the wheel; stopped early: another application came to the front during the scroll",
			},
			"✗ No motion …",
		);
		expect(cut.text).toBe(
			"✗ No motion at (150, 60) — no displacement observed (requested 400 pt; foreground pointer wheel, 150 px). Stopped early: another application came to the front during the scroll. The user has the pointer or the front app now: do not retry this scroll; wait until they are done, or ask.",
		);
		// A stop the user did not cause names itself and asks for a read first.
		const failed = await scroll(
			{
				outcome: "unmeasured",
				moved_pt: null,
				across_pt: null,
				confidence: null,
				reason: "capture unavailable: window 1 returned no image; stopped early: input stopped: event tap refused",
			},
			"? Unmeasured …",
		);
		expect(failed.text).toBe(
			"? Unmeasured: scrolled down at (150, 60) (requested 400 pt; foreground pointer wheel, 150 px), but the capture was unavailable: window 1 returned no image. Stopped early: input stopped: event tap refused. Observe before scrolling again.",
		);
	} finally {
		await f.close();
	}
});

it("refuses a scroll amount or unit the driver cannot honour before sending anything", async () => {
	const f = await fixture();
	const refusal = (options: Wire) =>
		f.session.scroll(f.context, f.window, "down", undefined, options).then(
			() => "sent",
			(error: Error) => error.message,
		);
	try {
		expect(await refusal({ amount: 51 })).toBe('Scroll amount must be an integer from 1 to 50 for by: "line"');
		expect(await refusal({ amount: 0, by: "page" })).toBe(
			'Scroll amount must be an integer from 1 to 50 for by: "page"',
		);
		expect(await refusal({ amount: 5001, by: "points" })).toBe(
			'Scroll amount must be an integer from 1 to 5000 for by: "points"',
		);
		expect(await refusal({ amount: 2.5, by: "points" })).toBe(
			'Scroll amount must be an integer from 1 to 5000 for by: "points"',
		);
		expect(await refusal({ by: "pixels" })).toBe('Scroll by must be "line", "page" or "points", not "pixels"');
		expect(await refusal({ by: "points" })).toBe(
			'Scroll by: "points" needs an amount: the distance in window points, 1 to 5000',
		);
		expect(f.calls.some(call => call.name === "scroll")).toBe(false);
		expect(await refusal({ amount: 5000, by: "points" })).toBe("sent");
		expect(f.lastDispatch()?.args).toMatchObject({ amount: 5000, by: "points" });
	} finally {
		await f.close();
	}
});

it("says a covered scroll target in the caller's point and sends nothing", async () => {
	const f = await fixture();
	/** The driver's refusal: its point in screenshot pixels, the covering owner or null. */
	const refusal = (covered_by: Wire | null, text: string): CuaToolResult => ({
		text,
		structuredJson: JSON.stringify({ code: "target_covered", window_id: 1, point: { x: 3, y: 1.2 }, covered_by }),
		isError: true,
		errorCode: "target_covered",
		images: [],
	});
	const scroll = () =>
		f.session.scroll(f.context, f.window, "down", [150, 60], { delivery: "foreground" }).then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
	try {
		await f.session.captureWindow(f.context, f.window, { silent: true });
		f.state.hook = async name =>
			name === "scroll"
				? refusal(
						{ app_name: "Terminal", pid: 42 },
						"scroll refused: window 1 stays covered by Terminal (pid 42) at (3, 1); no input was sent",
					)
				: undefined;
		const covered = await scroll();
		expect(covered).toBeInstanceOf(ToolError);
		expect((covered as ToolError).message).toBe(
			"target_covered: nothing was sent — at (150, 60), window 1 stays covered by Terminal (pid 42) even after its app was raised. Scroll at a point where window 1 is on top, or ask the user to move the covering window.",
		);
		f.state.hook = async name =>
			name === "scroll"
				? refusal(null, "scroll refused: window 1 is not on screen under (3, 1); no input was sent")
				: undefined;
		const offscreen = await scroll();
		expect((offscreen as ToolError).message).toBe(
			"target_covered: nothing was sent — at (150, 60), window 1 is not on screen under that point even after its app was raised. Scroll at a point inside the part of window 1 that is visible.",
		);
	} finally {
		await f.close();
	}
});

it("says a scroll the driver could not send, at the caller's point, and who has the pointer", async () => {
	const f = await fixture();
	/** The driver's `not_sent_refusal`: its point in screenshot pixels and its reason. */
	const notSent = (reason: string): CuaToolResult => ({
		text: `scroll not sent at (2, 1): ${reason}; no wheel event was posted`,
		structuredJson: JSON.stringify({ code: "scroll_not_sent", window_id: 1, point: { x: 2, y: 1 }, reason }),
		isError: true,
		errorCode: "scroll_not_sent",
		images: [],
	});
	const scroll = (target?: [number, number]) =>
		f.session.scroll(f.context, f.window, "down", target, { delivery: "foreground" }).then(
			() => undefined,
			(thrown: unknown) => (thrown instanceof ToolError ? thrown.message : thrown),
		);
	try {
		await f.session.captureWindow(f.context, f.window, { silent: true });
		f.state.hook = async name =>
			name === "scroll" ? notSent("the pointer moved to (10, 10) during the scroll; the user has it") : undefined;
		expect(await scroll([150, 60])).toBe(
			"scroll_not_sent: nothing was sent — at (150, 60), the pointer moved to (10, 10) during the scroll; the user has it. The user has the pointer or the front app now: do not retry this scroll; wait until they are done, or ask.",
		);
		// Untargeted: the driver's pixel point, mapped back into window points.
		f.state.hook = async name =>
			name === "scroll" ? notSent("another application came to the front during the scroll") : undefined;
		expect(await scroll()).toBe(
			"scroll_not_sent: nothing was sent — at (100, 50), another application came to the front during the scroll. The user has the pointer or the front app now: do not retry this scroll; wait until they are done, or ask.",
		);
		f.state.hook = async name => (name === "scroll" ? notSent("input stopped: event tap refused") : undefined);
		expect(await scroll([150, 60])).toBe(
			"scroll_not_sent: nothing was sent — at (150, 60), input stopped: event tap refused. Observe before scrolling again.",
		);
	} finally {
		await f.close();
	}
});

it("prints an app's note once per conversation, with the first window of the bundle it is keyed on", async () => {
	const mirror = await fixture({ bundles: { 101: "com.apple.ScreenContinuity" } });
	const notes = () => mirror.texts.filter(text => text === appNote("com.apple.ScreenContinuity"));
	try {
		expect(notes()).toHaveLength(1);
		await mirror.session.window(mirror.context, { id: "1", pid: 101 });
		await mirror.session.window(mirror.context, { app: "Fixture" });
		expect(notes()).toHaveLength(1);
		// Asked once per pid, and never through the driver's slow app scan.
		expect(mirror.state.bundleReads).toEqual([101]);
		expect(mirror.calls.some(call => call.name === "list_apps")).toBe(false);
		// The next turn's backend asks again, and the conversation already has it.
		const nextTurn = await mirror.create();
		try {
			await nextTurn.window(mirror.context, { id: "1", pid: 101 });
		} finally {
			await nextTurn.close();
		}
		expect(mirror.state.bundleReads).toEqual([101, 101]);
		expect(notes()).toHaveLength(1);
	} finally {
		await mirror.close();
	}
	const other = await fixture({ bundles: { 101: "com.example.Fixture", 202: "com.apple.ScreenContinuity" } });
	try {
		expect(other.texts.some(text => text.startsWith("App note"))).toBe(false);
	} finally {
		await other.close();
	}
	// A failed lookup is asked again, and the note still comes once it answers.
	const bundles: Record<number, string | undefined> = { 101: undefined };
	const flaky = await fixture({ bundles });
	try {
		expect(flaky.texts.some(text => text.startsWith("App note"))).toBe(false);
		bundles[101] = "com.apple.ScreenContinuity";
		await flaky.session.window(flaky.context, { id: "1", pid: 101 });
		expect(flaky.state.bundleReads).toEqual([101, 101]);
		expect(flaky.texts.filter(text => text === appNote("com.apple.ScreenContinuity"))).toHaveLength(1);
	} finally {
		await flaky.close();
	}
});
