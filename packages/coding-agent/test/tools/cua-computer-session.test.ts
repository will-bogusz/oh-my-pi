import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CuaComputerSession } from "@oh-my-pi/pi-coding-agent/tools/computer/cua-session";
import type { CuaDriver, CuaToolResult } from "@oh-my-pi/pi-coding-agent/tools/computer/driver";
import { ToolAbortError, ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import type { ComputerImage, ComputerOperationContext } from "@oh-my-pi/pi-coding-agent/tools/computer/types";

type Wire = Record<string, unknown>;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEklEQVR4nGP4z8DwHxkzoAsAAA8hD/EEN8afAAAAAElFTkSuQmCC";
function reply(data: Wire, images: CuaToolResult["images"] = []): CuaToolResult {
	return { text: "SDK response", structuredJson: JSON.stringify(data), isError: false, images };
}

async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cua-session-"));
	const calls: { name: string; args: Wire }[] = [];
	const images: ComputerImage[] = [];
	const row = {
		window_id: 1,
		pid: 101,
		app_name: "Fixture",
		title: "Editor",
		bounds: { x: 10, y: 20, width: 200, height: 100 },
		is_on_screen: true,
		layer: 0,
	};
	const state = {
		sequence: 0,
		value: "" as string | undefined,
		placeholder: "Hint, not value" as string | undefined,
		actions: undefined as unknown,
		backgroundActions: undefined as unknown,
		elementDoubleClick: undefined as unknown,
		relatedWindows: undefined as unknown,
		failCapture: false,
		wrongIdentity: false,
		kills: 0,
		cancelled: [] as string[],
		displayIdentity: true,
		display: { uuid: "display-uuid", nativeId: 7, x: 0, y: 0, width: 2, height: 1, scale: 2 },
		hook: undefined as ((name: string, args: Wire) => Promise<CuaToolResult | undefined>) | undefined,
	};
	const driver: CuaDriver = {
		version: "0.24.0",
		pid: 900,
		get alive() {
			return state.kills === 0;
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
			if (override) return override;
			if (name === "check_permissions") return reply({ accessibility: true, screen_recording: true });
			if (name === "list_windows") return reply({ windows: [row] });
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
						screen_width: display.width,
						screen_height: display.height,
						scale_factor: display.scale,
						screenshot_width: 4,
						screenshot_height: 2,
						...identity,
					},
					[{ dataBase64: PNG, mimeType: "image/png" }],
				);
			}
			if (name === "get_window_state") {
				state.sequence++;
				return reply(
					{
						pid: state.wrongIdentity ? 999 : row.pid,
						window_id: row.window_id,
						snapshot_id: `s${state.sequence}`,
						elements_complete: false,
						related_windows: state.relatedWindows,
						element_double_click: state.elementDoubleClick,
						elements: [
							{
								element_token: `s${state.sequence}:1`,
								role: "AXTextField",
								label: "Editor",
								value: state.value,
								placeholder: state.placeholder,
								actions: state.actions,
								background_actions: state.backgroundActions,
								enabled: false,
								selected: false,
								depth: 0,
								frame: { x: 10, y: 20, w: 200, h: 100 },
							},
						],
						window_bounds: row.bounds,
						screenshot_frame_valid: !state.failCapture,
						screenshot_width: 4,
						screenshot_height: 2,
					},
					args.include_screenshot && !state.failCapture ? [{ dataBase64: PNG, mimeType: "image/png" }] : [],
				);
			}
			if (name === "set_value") state.value = String(args.value);
			if (name === "type_text") state.value += String(args.text);
			return reply({ effect: "unverifiable", evidence: { posted: true } });
		},
		async kill() {
			state.kills++;
		},
	};
	const session = await CuaComputerSession.create({
		spawn: async () => driver,
		sampleRoster: () => ({ windows: [], elapsedMs: 0 }),
	});
	const context: ComputerOperationContext = {
		signal: new AbortController().signal,
		readOnly: false,
		maxWidth: 2,
		maxHeight: 1,
		emitImage(image) {
			images.push(image);
		},
	};
	const window = await session.window(context, { id: "1", pid: 101 });
	return {
		session,
		context,
		window,
		state,
		row,
		calls,
		images,
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
		expect(f.calls).toEqual([{ name: "list_windows", args: {} }]);
	} finally {
		await f.close();
	}
});

it("returns exact candidates without inspecting one when broad acquisition remains ambiguous", async () => {
	const f = await fixture();
	const second = { ...f.row, window_id: 2, title: "Second", is_on_screen: false };
	const axWindow = { window_id: 1, role: "AXWindow" };
	try {
		for (const metadata of [
			undefined,
			{ pid: 101, complete: false, windows: [axWindow] },
			{ pid: 101, complete: true, windows: [] },
			{ pid: 101, complete: true, windows: [axWindow, { window_id: 2, role: "AXWindow", minimized: true }] },
			{ pid: 101, complete: true, windows: [axWindow, { window_id: 3, role: "AXWindow" }] },
		]) {
			f.state.hook = async name =>
				name === "list_windows" ? reply({ windows: [f.row, second], accessibility_windows: metadata }) : undefined;
			f.calls.length = 0;
			const failure = await f.session.window(f.context, { app: "Fixture" }).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			if (!(failure instanceof Error)) throw new Error("Expected ambiguous acquisition to fail");
			expect(failure.message).toContain("Ambiguous");
			expect(failure.message).toContain('"id":"1","pid":101');
			expect(failure.message).toContain('"id":"2","pid":101');
			expect(failure.message).toContain('"title":"Second"');
			expect(f.calls.every(call => call.name === "list_windows")).toBe(true);
		}
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
		await expect(f.session.window(f.context, { app: "Fixture" })).rejects.toThrow("Ambiguous");
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
		expect(f.calls.at(-1)).toEqual({
			name: "set_value",
			args: { pid: 101, window_id: 1, element_token: "s1:1", snapshot_id: "s1", value: "" },
		});
	} finally {
		await f.close();
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
			await f.session.click(f.context, f.window, [1, 0]);
			expect(f.calls.at(-1)?.args).toMatchObject({ pid: 101, window_id: 1, x: 2, y: 0 });
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

it("maps resized image coordinates to the exact SDK image and invalidates failed captures", async () => {
	const f = await fixture();
	try {
		const image = await f.session.captureWindow(f.context, f.window);
		expect(image).toMatchObject({
			width: 2,
			height: 1,
			sourceWidth: 4,
			sourceHeight: 2,
			target: "1",
			label: "Fixture: Editor",
		});
		await f.session.click(f.context, f.window, [1, 0]);
		expect(f.calls.at(-1)).toEqual({
			name: "click",
			args: { pid: 101, window_id: 1, x: 2, y: 0, delivery_mode: "background" },
		});
		await expect(f.session.click(f.context, f.window, [2, 0])).rejects.toThrow("InvalidCoordinates");
		f.state.failCapture = true;
		await expect(f.session.captureWindow(f.context, f.window)).rejects.toThrow("Screenshot unavailable");
		await expect(f.session.click(f.context, f.window, [1, 0])).rejects.toThrow("StaleFrame");
		expect(f.calls.filter(call => call.name === "click")).toHaveLength(1);
	} finally {
		await f.close();
	}
});

it("invalidates pixel frames on geometry changes and AX-only re-observation", async () => {
	const f = await fixture();
	try {
		await f.session.captureWindow(f.context, f.window);
		f.row.bounds.x++;
		await expect(f.session.click(f.context, f.window, [1, 0])).rejects.toThrow("StaleFrame");
		await f.session.captureWindow(f.context, f.window);
		await f.session.observe(f.context, f.window);
		await expect(f.session.click(f.context, f.window, [1, 0])).rejects.toThrow("StaleFrame");
		expect(f.calls.some(call => call.name === "click")).toBe(false);
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
		await f.session.click(f.context, f.window, [1, 0]);
		expect(f.calls.at(-1)?.args).toMatchObject({ x: 2, y: 0, pid: 101, window_id: 1 });
	} finally {
		await f.close();
	}
});

it("refuses semantic modifiers and click counts the SDK would silently ignore", async () => {
	const f = await fixture();
	try {
		const observation = await f.session.observe(f.context, f.window);
		const ref = observation.elements[0]!.ref;
		await expect(f.session.click(f.context, f.window, ref, { count: 2 })).rejects.toThrow("pixel target");
		await expect(
			f.session.click(f.context, f.window, ref, { modifiers: ["shift"], delivery: "foreground" }),
		).rejects.toThrow("pixel target");
		expect(f.calls.some(call => call.name === "click")).toBe(false);
	} finally {
		await f.close();
	}
});

it("uses advertised native element double-click without converting cached bounds into pixels", async () => {
	const f = await fixture();
	try {
		f.state.elementDoubleClick = "left_center_v1";
		const observation = await f.session.observe(f.context, f.window);
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
		await expect(f.session.click(f.context, f.window, ref, { count: 2, button: "right" })).rejects.toThrow(
			"pixel target",
		);
		await expect(f.session.click(f.context, f.window, ref, { count: 2, modifiers: ["shift"] })).rejects.toThrow(
			"pixel target",
		);
		f.state.elementDoubleClick = undefined;
		const legacy = await f.session.observe(f.context, f.window);
		await expect(f.session.click(f.context, f.window, ref, { count: 2 })).rejects.toThrow("StaleRef");
		await expect(f.session.click(f.context, f.window, legacy.elements[0]!.ref, { count: 2 })).rejects.toThrow(
			"pixel target",
		);
		expect(f.calls.filter(call => call.name === "click")).toHaveLength(1);
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
		expect(f.calls.at(-1)?.args).toEqual({
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
		expect(f.calls.at(-1)).toEqual({
			name: "click",
			args: { scope: "desktop", x: 2, y: 0, count: 2, modifier: ["shift"], delivery_mode: "foreground" },
		});
		const moved = await f.session.desktopMove(f.context, 1, 0, { delivery: "foreground" });
		expect(f.calls.at(-1)).toEqual({ name: "move_cursor", args: { scope: "desktop", x: 2, y: 0 } });
		expect(moved.delivery).toBe("foreground");
		await f.session.desktopDrag(
			f.context,
			[
				[0, 0],
				[1, 0],
			],
			{ delivery: "foreground", button: "right" },
		);
		expect(f.calls.at(-1)?.args).toEqual({
			scope: "desktop",
			from_x: 0,
			from_y: 0,
			to_x: 2,
			to_y: 0,
			button: "right",
			delivery_mode: "foreground",
		});
		await f.session.desktopScroll(f.context, 1, 0, { delivery: "foreground", dy: 240 });
		expect(f.calls.at(-1)?.args).toEqual({
			scope: "desktop",
			x: 2,
			y: 0,
			direction: "down",
			amount: 2,
			by: "line",
			delivery_mode: "foreground",
		});
		await f.session.desktopScroll(f.context, 1, 0, { delivery: "foreground", dx: -120 });
		expect(f.calls.at(-1)?.args.direction).toBe("left");
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
		await f.session.drag(f.context, f.window, [0, 0], [1, 0], {
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
				},
			},
		]);
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

it("maps observed semantic actions to usable perform names without inventing capabilities", async () => {
	const f = await fixture();
	try {
		let observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.actions).toBeUndefined();
		f.state.actions = ["AXConfirm", "AXRaise", "AXOpen", "AXConfirm", null, "toString"];
		observation = await f.session.observe(f.context, f.window);
		const element = observation.elements[0]!;
		expect(element.actions).toEqual(["confirm", "open"]);
		expect(observation.tree).toContain('actions=["confirm","open"]');
		await f.session.perform(f.context, f.window, element.ref, element.actions![0]!);
		expect(f.calls.at(-1)).toMatchObject({
			name: "click",
			args: { action: "confirm", element_token: "s2:1", window_id: 1, pid: 101 },
		});
		f.state.actions = [];
		observation = await f.session.observe(f.context, f.window);
		expect(observation.elements[0]!.actions).toEqual([]);
		expect(observation.tree).not.toContain(" actions=");
	} finally {
		await f.close();
	}
});

it("preserves attached sheet identities without converting them into parent element references", async () => {
	const f = await fixture();
	try {
		expect((await f.session.observe(f.context, f.window)).relatedWindows).toBeUndefined();
		f.state.relatedWindows = [{ pid: 202, window_id: 42, title: "Import", relation: "sheet" }];
		const observation = await f.session.observe(f.context, f.window);
		expect(observation.relatedWindows).toEqual([{ pid: 202, id: "42", title: "Import", relation: "sheet" }]);
		expect(observation.tree).toContain(
			'Attached sheets: [{"id":"42","pid":202,"title":"Import","relation":"sheet"}]',
		);
		expect(observation.elements).toHaveLength(1);
		expect(observation.elements[0]!.label).toBe("Editor");
		expect(Object.isFrozen(observation.relatedWindows)).toBe(true);
		expect(Object.isFrozen(observation.relatedWindows![0])).toBe(true);
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
		expect(observation.elements[0]!.actions).toEqual([]);
		f.state.backgroundActions = "AXConfirm";
		await expect(f.session.observe(f.context, f.window)).rejects.toThrow("Malformed Cua background actions");
	} finally {
		await f.close();
	}
});
