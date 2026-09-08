import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NativeComputerSession } from "@oh-my-pi/pi-coding-agent/tools/computer/native-session";
import type { ComputerOperationContext } from "@oh-my-pi/pi-coding-agent/tools/computer/types";

it("does not type when canceled during native window validation", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-session-"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const abort = new AbortController();
	let blocked = false;
	let value = "";
	const native = {
		capabilities: {},
		async pinWindow() {},
		async listWindows() {
			if (blocked) {
				entered.resolve();
				await release.promise;
			}
			return [{ id: "1", pid: 101, app: "Fixture", title: "Editor", x: 0, y: 0, width: 100, height: 100 }];
		},
		async typeText(_id: string, text: string) {
			value += text;
		},
		async close() {},
	};
	const session = Reflect.construct(NativeComputerSession, [
		native,
		path.join(directory, "input"),
	]) as NativeComputerSession;
	const context: ComputerOperationContext = {
		signal: abort.signal,
		readOnly: false,
		maxWidth: 100,
		maxHeight: 100,
		emitImage() {},
	};
	try {
		const window = await session.window(context, { id: "1", pid: 101 });
		blocked = true;
		const action = session.type(context, window, "must not appear");
		const rejected = action.then(
			() => undefined,
			error => error,
		);
		await entered.promise;
		abort.abort();
		release.resolve();
		expect(await rejected).toBeInstanceOf(Error);
		expect(value).toBe("");
		blocked = false;
		await session.type({ ...context, signal: new AbortController().signal }, window, "next action");
		expect(value).toBe("next action");
	} finally {
		release.resolve();
		await session.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-contract-"));
	const row = { id: "1", pid: 101, app: "Fixture", title: "Editor", x: 0, y: 0, width: 100, height: 100 };
	const node = {
		ref: "native-1",
		role: "textbox",
		nativeRole: "AXTextField",
		title: "",
		description: "Editor",
		value: "",
		enabled: true as boolean | undefined,
		focused: false,
		actions: ["AXScrollDownByLine", "AXScrollDownByPage"],
	};
	const state = {
		rows: [row],
		nodes: [node],
		truncated: false,
		skipped: 0,
		value: "",
		scrollPosition: 0,
		closed: false,
		snapshots: 0,
	};
	const pins = new Map<string, number>();
	const native = {
		capabilities: { capturePermission: "denied", inputPermission: "denied", axPermission: "denied" },
		async listWindows() {
			return state.rows;
		},
		async pinWindow(id: string, pid: number) {
			if (pins.has(id) && pins.get(id) !== pid) throw new Error("InvalidTarget: owner changed");
			pins.set(id, pid);
		},
		async axSnapshot() {
			state.snapshots++;
			return {
				nodes: state.nodes,
				text: state.nodes.map(item => `- ${item.nativeRole} [ref=${item.ref}]`).join("\n"),
				truncated: state.truncated,
				skipped: state.skipped,
			};
		},
		async axNode(ref: string) {
			const found = state.nodes.find(item => item.ref === ref);
			if (!found) throw new Error("StaleRef");
			return { ...found, value: state.value };
		},
		async axSetValue(_ref: string, value: string) {
			state.value = value;
		},
		async axInsertText(_ref: string, text: string) {
			state.value += text;
		},
		async axFocus() {
			node.focused = true;
		},
		async keyChord(_id: string, chord: string[]) {
			if (node.focused && chord[0] === "Backspace") state.value = state.value.slice(0, -1);
		},
		async axPerform(_ref: string, action: string) {
			state.scrollPosition += action.endsWith("ByPage") ? 10 : 1;
		},
		async close() {
			state.closed = true;
		},
	};
	const session = Reflect.construct(NativeComputerSession, [
		native,
		path.join(directory, "input"),
	]) as NativeComputerSession;
	const context: ComputerOperationContext = {
		signal: new AbortController().signal,
		readOnly: false,
		maxWidth: 100,
		maxHeight: 100,
		emitImage() {},
	};
	const window = await session.window(context, { id: "1", pid: 101 });
	return {
		session,
		context,
		window,
		native,
		state,
		node,
		async close() {
			await session.close();
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

it("pins an owner for the native session lifetime and rejects replacement owners", async () => {
	const f = await fixture();
	try {
		f.state.rows = [{ ...f.state.rows[0]!, pid: 202 }];
		await expect(f.session.window(f.context, { id: "1", pid: 202 })).rejects.toThrow("owner changed");
		await expect(f.session.type(f.context, f.window, "wrong owner")).rejects.toThrow("Missing");
		expect(f.state.value).toBe("");
	} finally {
		await f.close();
	}
});

it("retains exact public refs across actions but rejects wrong-window and re-observed refs", async () => {
	const f = await fixture();
	try {
		const observation = await f.session.observe(f.context, f.window, { screenshot: false });
		const ref = observation.elements[0]!.ref;
		expect(observation.elements[0]!.label).toBe("Editor");
		expect(observation.tree).toContain('"Editor"');
		await f.session.setValue(f.context, f.window, ref, "first");
		await f.session.type(f.context, f.window, " second", ref);
		expect(f.state.value).toBe("first second");
		expect(() => f.session.element(ref, { ...f.window, pid: 202 })).toThrow("different window");
		await f.session.observe(f.context, f.window, { screenshot: false });
		await expect(f.session.setValue(f.context, f.window, ref, "stale")).rejects.toThrow("StaleRef");
		expect(f.state.value).toBe("first second");
	} finally {
		await f.close();
	}
});

it("does not report incomplete AX absence as a verified postcondition", async () => {
	const f = await fixture();
	try {
		f.state.nodes = [];
		f.state.skipped = 1;
		const observation = await f.session.observe(f.context, f.window, { screenshot: false });
		expect(observation.complete).toBe(false);
		const predicate = [{ element: { selector: { label_contains: "Missing" }, exists: true } }];
		expect(await f.session.verify(f.context, f.window, predicate, { timeoutMs: 0 })).toMatchObject({
			status: "unknown",
			stable: false,
			predicates: [{ unknown_reason: "observation_unavailable" }],
		});
		f.state.skipped = 0;
		expect(await f.session.verify(f.context, f.window, predicate, { timeoutMs: 0 })).toMatchObject({
			status: "unsatisfied",
			stable: false,
		});
	} finally {
		await f.close();
	}
});

it("requires a complete walk for property uniqueness but accepts observed positive existence", async () => {
	const f = await fixture();
	try {
		const selector = { label_contains: "Editor" };
		for (const partial of [
			{ truncated: true, skipped: 0 },
			{ truncated: false, skipped: 1 },
		]) {
			Object.assign(f.state, partial);
			for (const property of [{ value_equals: "" }, { enabled: true }, { selected: true }]) {
				expect(
					await f.session.verify(f.context, f.window, [{ element: { selector, ...property } }], { timeoutMs: 0 }),
				).toMatchObject({ status: "unknown", predicates: [{ unknown_reason: "observation_unavailable" }] });
			}
			expect(
				await f.session.verify(f.context, f.window, [{ element: { selector, exists: true } }], { timeoutMs: 0 }),
			).toMatchObject({ status: "satisfied" });
		}
		Object.assign(f.state, { truncated: false, skipped: 0 });
		expect(
			await f.session.verify(f.context, f.window, [{ element: { selector, value_equals: "" } }], { timeoutMs: 0 }),
		).toMatchObject({ status: "satisfied" });
	} finally {
		await f.close();
	}
});

it("preserves unavailable enabled state instead of asserting enabled or disabled", async () => {
	const f = await fixture();
	try {
		f.node.enabled = undefined;
		const observation = await f.session.observe(f.context, f.window, { screenshot: false });
		expect(observation.elements[0]!.enabled).toBeUndefined();
		expect(observation.tree).not.toContain("(disabled)");
		for (const enabled of [true, false]) {
			expect(
				await f.session.verify(
					f.context,
					f.window,
					[{ element: { selector: { label_contains: "Editor" }, enabled } }],
					{ timeoutMs: 0 },
				),
			).toMatchObject({ status: "unknown", predicates: [{ unknown_reason: "unsupported_predicate" }] });
		}
	} finally {
		await f.close();
	}
});

it("refreshes nested and top-level permissions from one live capability snapshot", async () => {
	const f = await fixture();
	try {
		expect(f.session.capabilities.permissions.capture).toBe("denied");
		f.native.capabilities = { capturePermission: "granted", inputPermission: "granted", axPermission: "granted" };
		const caps = f.session.capabilities;
		expect(caps).toMatchObject({
			capturePermission: "granted",
			inputPermission: "granted",
			axPermission: "granted",
			permissions: { capture: "granted", input: "granted", accessibility: "granted" },
		});
	} finally {
		await f.close();
	}
});

it("verifies exact window absence and bounded geometry without requiring a live handle", async () => {
	const f = await fixture();
	try {
		expect(
			await f.session.verify(
				f.context,
				f.window,
				[{ window: { bounds: { x: 1, y: 0, width: 100, height: 100, tolerance_px: 1 } } }],
				{ timeoutMs: 0 },
			),
		).toMatchObject({ status: "satisfied", stable: true });
		expect(
			await f.session.verify(
				f.context,
				f.window,
				[{ window: { bounds: { x: 2, y: 0, width: 100, height: 100, tolerance_px: 1 } } }],
				{ timeoutMs: 0 },
			),
		).toMatchObject({ status: "unsatisfied" });
		f.state.rows = [{ ...f.state.rows[0]!, pid: 202 }];
		expect(
			await f.session.verify(f.context, f.window, [{ window: { exists: false } }], { timeoutMs: 0 }),
		).toMatchObject({ status: "satisfied" });
	} finally {
		await f.close();
	}
});

it("keeps ambiguous, unavailable selected, and web semantic evidence unknown", async () => {
	const f = await fixture();
	try {
		const predicate = { element: { selector: { label_contains: "Editor" }, value_equals: "" } };
		f.state.nodes.push({ ...f.node, ref: "native-2" });
		expect(await f.session.verify(f.context, f.window, [predicate], { timeoutMs: 0 })).toMatchObject({
			status: "unknown",
			predicates: [{ unknown_reason: "multi_match" }],
		});
		f.state.nodes = [f.node];
		expect(
			await f.session.verify(
				f.context,
				f.window,
				[{ element: { selector: { role: "AXTextField" }, selected: true } }],
				{ timeoutMs: 0 },
			),
		).toMatchObject({ status: "unknown", predicates: [{ unknown_reason: "unsupported_predicate" }] });
		f.node.nativeRole = "AXWebArea";
		expect(await f.session.verify(f.context, f.window, [predicate], { timeoutMs: 0 })).toMatchObject({
			status: "unknown",
			predicates: [{ unknown_reason: "untrusted_source" }],
		});
		await expect(
			f.session.verify(f.context, f.window, [{ element: { selector: { role: "button" }, exists: false } }], {
				timeoutMs: 0,
			}),
		).rejects.toThrow("only supports true");
	} finally {
		await f.close();
	}
});

it("requires consecutive satisfied samples and returns bounded raw evidence", async () => {
	const f = await fixture();
	try {
		const snapshot = f.native.axSnapshot.bind(f.native);
		f.native.axSnapshot = async () => {
			f.node.value = f.state.snapshots === 1 ? "not ready" : "ready";
			return snapshot();
		};
		const verification = await f.session.verify(
			f.context,
			f.window,
			[
				{
					element: {
						selector: { role: "TextField", label_contains: "editor" },
						value_equals: "ready",
						enabled: true,
					},
				},
			],
			{ timeoutMs: 1000, stableSamples: 2 },
		);
		expect(verification).toMatchObject({
			status: "satisfied",
			stable: true,
			samples: 4,
			predicates: [{ status: "satisfied", unknown_reason: null }],
		});
		const evidence = verification.predicates[0]!.observed_json;
		if (evidence === null) throw new Error("Missing verification evidence");
		expect(JSON.parse(evidence)).toMatchObject({ value: "ready", label: "Editor", enabled: true });
	} finally {
		await f.close();
	}
});

it("supports default semantic scrolling, repeated page actions and unique untargeted inference", async () => {
	const f = await fixture();
	try {
		const { elements } = await f.session.observe(f.context, f.window, { screenshot: false });
		await f.session.scroll(f.context, f.window, "down", elements[0]!.ref);
		expect(f.state.scrollPosition).toBe(1);
		await f.session.scroll(f.context, f.window, "down", elements[0]!.ref, { amount: 2, by: "page" });
		expect(f.state.scrollPosition).toBe(21);
		await f.session.scroll(f.context, f.window, "down");
		expect(f.state.scrollPosition).toBe(22);
		f.state.nodes.push({ ...f.node, ref: "native-2" });
		await expect(f.session.scroll(f.context, f.window, "down")).rejects.toThrow("unique");
		expect(f.state.scrollPosition).toBe(22);
	} finally {
		await f.close();
	}
});

it("requires explicit foreground admission for menus and element keyboard focus", async () => {
	const f = await fixture();
	try {
		const { elements } = await f.session.observe(f.context, f.window, { screenshot: false });
		f.state.value = "value";
		await expect(f.session.press(f.context, f.window, "Backspace", elements[0]!.ref)).rejects.toThrow(
			"BackgroundUnavailable",
		);
		expect(f.state.value).toBe("value");
		await f.session.press(f.context, f.window, "Backspace", elements[0]!.ref, { delivery: "foreground" });
		expect(f.state.value).toBe("valu");
		await expect(f.session.menu(f.context, f.window, ["File"])).rejects.toThrow("foreground");
		await expect(f.session.menu(f.context, f.window, ["File"], { delivery: "background" })).rejects.toThrow(
			"foreground",
		);
	} finally {
		await f.close();
	}
});

it("drains an admitted AX mutation after cancellation and stops repeated actions", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const abort = new AbortController();
	try {
		const { elements } = await f.session.observe(f.context, f.window, { screenshot: false });
		f.native.axPerform = async () => {
			entered.resolve();
			await release.promise;
			f.state.scrollPosition++;
		};
		const operation = f.session.scroll({ ...f.context, signal: abort.signal }, f.window, "down", elements[0]!.ref, {
			amount: 3,
		});
		const rejected = operation.then(
			() => undefined,
			error => error,
		);
		await entered.promise;
		abort.abort();
		const closing = f.session.close();
		expect(f.state.closed).toBe(false);
		release.resolve();
		expect(await rejected).toBeInstanceOf(Error);
		await closing;
		expect(f.state.scrollPosition).toBe(1);
		expect(f.state.closed).toBe(true);
	} finally {
		release.resolve();
		await f.close();
	}
});

it("cancels verification polling without another observation", async () => {
	const f = await fixture();
	const abort = new AbortController();
	try {
		const snapshot = f.native.axSnapshot.bind(f.native);
		f.native.axSnapshot = async () => {
			const result = await snapshot();
			abort.abort();
			return result;
		};
		await expect(
			f.session.verify({ ...f.context, signal: abort.signal }, f.window, [
				{ element: { selector: { role: "TextField" }, exists: true } },
			]),
		).rejects.toThrow();
		expect(f.state.snapshots).toBe(1);
	} finally {
		await f.close();
	}
});

it("does not dispatch a canceled action that was queued behind an admitted mutation", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const abort = new AbortController();
	try {
		const { elements } = await f.session.observe(f.context, f.window, { screenshot: false });
		f.native.axInsertText = async (_ref, text) => {
			entered.resolve();
			await release.promise;
			f.state.value += text;
		};
		const first = f.session.type(f.context, f.window, "first", elements[0]!.ref);
		await entered.promise;
		const queued = f.session.type({ ...f.context, signal: abort.signal }, f.window, "canceled", elements[0]!.ref);
		const rejected = queued.then(
			() => undefined,
			error => error,
		);
		abort.abort();
		release.resolve();
		await first;
		expect(await rejected).toBeInstanceOf(Error);
		expect(f.state.value).toBe("first");
	} finally {
		release.resolve();
		await f.close();
	}
});
