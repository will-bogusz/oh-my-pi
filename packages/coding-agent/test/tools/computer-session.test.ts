import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NativeComputerSession } from "@oh-my-pi/pi-coding-agent/tools/computer/native-session";
import type { ComputerOperationContext } from "@oh-my-pi/pi-coding-agent/tools/computer/types";

async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-computer-session-"));
	const images: string[] = [];
	const app = { counter: 0, bounds: { x: 0, y: 0, width: 100, height: 100 } };
	const sibling = { bounds: { x: 200, y: 0, width: 100, height: 100 } };
	let nextListGate: { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
	const rows = () =>
		[app, sibling].map((state, index) => ({
			id: String(index + 1),
			pid: 101 + index,
			app: "Fixture",
			title: `Fixture ${index}`,
			...state.bounds,
		}));
	const pins = new Map<string, number>();
	const pinnedState = (id: string) => {
		const row = rows().find(row => row.id === id);
		if (!row || pins.get(id) !== row.pid) throw new Error("Wrong window owner");
		return id === "1" ? app : sibling;
	};
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
		"base64",
	);
	const captures = new Map<string, typeof app.bounds>();
	const native = {
		capabilities: {
			capturePermission: "granted",
			inputPermission: "granted",
			axPermission: "granted",
			backgroundWindowInput: true,
		},
		async listWindows() {
			const gate = nextListGate;
			nextListGate = undefined;
			if (gate) {
				gate.entered.resolve();
				await gate.release.promise;
			}
			return rows();
		},
		async pinWindow(id: string, pid: number) {
			if (!rows().some(row => row.id === id && row.pid === pid) || (pins.has(id) && pins.get(id) !== pid))
				throw new Error("Wrong window owner");
			pins.set(id, pid);
		},
		async axSnapshot(id: string) {
			pinnedState(id);
			return { nodes: [], text: "", truncated: false, skipped: 0 };
		},
		async capture(id: string) {
			const state = pinnedState(id);
			captures.set(id, { ...state.bounds });
			return {
				data: png,
				format: "png",
				width: 1,
				height: 1,
				sourceWidth: state.bounds.width,
				sourceHeight: state.bounds.height,
				target: id,
			};
		},
		async click(id: string, x: number, y: number) {
			const state = pinnedState(id);
			const capturedBounds = captures.get(id);
			if (!capturedBounds) throw new Error("Missing capture");
			// Native coordinates refer to the captured image. Resizing between
			// coordinate proof and dispatch makes them miss the centered control.
			if (
				state === app &&
				x * capturedBounds.width === state.bounds.width / 2 &&
				y * capturedBounds.height === state.bounds.height / 2
			)
				app.counter++;
		},
		async setWindowFrame(id: string, x: number, y: number, width: number, height: number) {
			pinnedState(id).bounds = { x, y, width, height };
		},
		async close() {},
	};
	// Instantiate the actual session against a deterministic window provider;
	// no native desktop or production module mocking is involved.
	const session = Reflect.construct(NativeComputerSession, [
		native,
		path.join(directory, "input"),
	]) as NativeComputerSession;
	const context: ComputerOperationContext = {
		signal: new AbortController().signal,
		readOnly: false,
		maxWidth: 1,
		maxHeight: 1,
		emitImage(image) {
			images.push(image.path);
		},
	};
	return {
		session,
		context,
		app,
		sibling,
		blockNextList() {
			const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
			nextListGate = gate;
			return gate;
		},
		async close() {
			await session.close();
			await Promise.all(images.map(image => fs.rm(image, { force: true })));
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

it("keeps screenshot-coordinate proof and click atomic against a queued resize", async () => {
	const f = await fixture();
	let release: (() => void) | undefined;
	try {
		const window = await f.session.window(f.context, { id: "1", pid: 101 });
		const observation = await f.session.observe(f.context, window);
		expect(observation.screenshot).toBeDefined();
		const gate = f.blockNextList();
		release = gate.release.resolve;
		const click = f.session.click(f.context, window, [0.5, 0.5]);
		await gate.entered.promise;
		const resize = f.session.setFrame(f.context, window, { ...window.bounds, width: 200 });
		gate.release.resolve();
		await Promise.all([click, resize]);
		expect(f.app.counter).toBe(1);
		expect(f.app.bounds.width).toBe(200);
		await expect(f.session.click(f.context, window, [0.5, 0.5])).rejects.toThrow();
		expect(f.app.counter).toBe(1);
	} finally {
		release?.();
		await f.close();
	}
});

it("cannot redirect a pinned window resize through extra frame identity keys", async () => {
	const f = await fixture();
	try {
		const window = await f.session.window(f.context, { id: "1", pid: 101 });
		const frame = { x: 10, y: 20, width: 300, height: 400, pid: 102, window_id: 2 };
		await f.session.setFrame(f.context, window, frame);
		expect(f.app.bounds).toEqual({ x: 10, y: 20, width: 300, height: 400 });
		expect(f.sibling.bounds).toEqual({ x: 200, y: 0, width: 100, height: 100 });
	} finally {
		await f.close();
	}
});
