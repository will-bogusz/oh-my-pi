import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import {
	releaseComputerResourcesForOwner,
	releaseComputerSessionsForOwner,
} from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import type { ComputerScreenshot } from "@oh-my-pi/pi-coding-agent/tools/computer/types";

const created: string[] = [];
afterEach(async () => {
	await Promise.allSettled(created.splice(0).map(file => fs.rm(file, { recursive: true, force: true })));
});

async function file(target: string): Promise<string> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	await Bun.write(target, "png");
	created.push(target);
	return target;
}

const exists = (target: string) =>
	fs.access(target).then(
		() => true,
		() => false,
	);

it("session close removes the captures its runs wrote, turn settle keeps them, and nothing else is touched", async () => {
	const owner = `capture-retention-${crypto.randomUUID()}`;
	const ours = await file(path.join(os.tmpdir(), `omp-computer-${crypto.randomUUID()}.png`));
	const elsewhereDir = path.join(os.tmpdir(), `capture-retention-${crypto.randomUUID()}`);
	created.push(elsewhereDir);
	const lookalike = await file(path.join(elsewhereDir, `omp-computer-${crypto.randomUUID()}.png`));
	const unrelated = await file(path.join(os.tmpdir(), `screenshot-${crypto.randomUUID()}.png`));
	const neverReported = await file(path.join(os.tmpdir(), `omp-computer-${crypto.randomUUID()}.png`));
	const session: ToolSession = {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalKernelOwnerId: () => owner,
		settings: Settings.isolated({ "computer.enabled": true }),
	};
	const prelude = createComputerPrelude(session, () => ({
		async run() {
			return {
				displays: [],
				returnValue: undefined,
				screenshots: [ours, lookalike, unrelated].map(shot => ({ path: shot }) as ComputerScreenshot),
			};
		},
		async capabilities() {
			throw new Error("not used");
		},
		async close() {},
	}));
	await prelude.invoke({ action: "run", code: "1" }, { session, toolCallId: "capture" });

	await releaseComputerResourcesForOwner(owner);
	expect(await exists(ours)).toBe(true);

	await releaseComputerSessionsForOwner(owner);
	expect(await exists(ours)).toBe(false);
	expect(await exists(lookalike)).toBe(true);
	expect(await exists(unrelated)).toBe(true);
	expect(await exists(neverReported)).toBe(true);
});

it("computer.close() removes the session's captures, a later call starts a fresh session, and teardown still removes its captures", async () => {
	const owner = `capture-close-${crypto.randomUUID()}`;
	const capture = () => file(path.join(os.tmpdir(), `omp-computer-${crypto.randomUUID()}.png`));
	let shot = await capture();
	const session: ToolSession = {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalKernelOwnerId: () => owner,
		settings: Settings.isolated({ "computer.enabled": true }),
	};
	let controllers = 0;
	const prelude = createComputerPrelude(session, () => {
		controllers++;
		return {
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [{ path: shot } as ComputerScreenshot] };
			},
			async capabilities() {
				throw new Error("not used");
			},
			async close() {},
		};
	});
	const context = { session, toolCallId: "capture" };
	try {
		await prelude.invoke({ action: "run", code: "1" }, context);
		const closed = shot;
		await prelude.invoke({ action: "close" }, context);
		expect(await exists(closed)).toBe(false);
		shot = await capture();
		await prelude.invoke({ action: "run", code: "1" }, context);
		expect(controllers).toBe(2);
		await releaseComputerSessionsForOwner(owner);
		expect(await exists(shot)).toBe(false);
	} finally {
		await releaseComputerSessionsForOwner(owner);
	}
});
