import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { CuaDriverChild, CuaDriverExitedError } from "@oh-my-pi/pi-coding-agent/tools/computer/driver";
import { CuaComputerSession } from "@oh-my-pi/pi-coding-agent/tools/computer/cua-session";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

const fixture = path.resolve(import.meta.dir, "../fixtures/fake-cua-driver.ts");

function spawnFake(options: { cancel?: boolean; cancelGraceMs?: number } = {}) {
	return CuaDriverChild.spawn([process.execPath, fixture], {
		env: { FAKE_CUA_CANCEL: options.cancel ? "1" : "0" },
		cancelGraceMs: options.cancelGraceMs,
	});
}

function structured(result: { structuredJson?: string }): Record<string, unknown> {
	return JSON.parse(result.structuredJson ?? "{}") as Record<string, unknown>;
}

describe("cua driver child", () => {
	it("answers concurrent requests by id and reports the driver version from the handshake", async () => {
		const child = await spawnFake();
		try {
			expect(child.version).toBe("fake-1.0");
			const [slow, fast] = await Promise.all([
				child.callTool("sleep", { ms: 150 }),
				child.callTool("echo", { value: 7 }),
			]);
			expect(structured(slow)).toEqual({ slept_ms: 150 });
			expect(structured(fast)).toEqual({ echoed: { value: 7 } });
		} finally {
			await child.kill();
		}
	});

	it("cancels an in-flight call cooperatively and keeps the child for the next call", async () => {
		const child = await spawnFake({ cancel: true });
		try {
			const abort = new AbortController();
			const pending = child.callTool("sleep", { ms: 10_000 }, abort.signal);
			abort.abort(new ToolAbortError("user pressed escape"));
			const started = performance.now();
			const error = await pending.catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(ToolAbortError);
			expect((error as Error).message).toContain("partial");
			expect(performance.now() - started).toBeLessThan(2_000);
			expect(child.alive).toBe(true);
			const pid = structured(await child.callTool("pid", {})).pid;
			expect(pid).toBe(child.pid);
		} finally {
			await child.kill();
		}
	});

	it("drops a cancelled call the driver ignores and kills the child only after the grace period", async () => {
		const child = await spawnFake({ cancel: false, cancelGraceMs: 200 });
		try {
			const abort = new AbortController();
			const pending = child.callTool("sleep", { ms: 60_000 }, abort.signal);
			abort.abort();
			const started = performance.now();
			const error = await pending.catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(CuaDriverExitedError);
			expect(performance.now() - started).toBeGreaterThanOrEqual(150);
			expect(child.alive).toBe(false);
		} finally {
			await child.kill();
		}
	});

	it("does not kill the child when an ignored cancel is answered within the grace period", async () => {
		const child = await spawnFake({ cancel: false, cancelGraceMs: 2_000 });
		try {
			const abort = new AbortController();
			const pending = child.callTool("sleep", { ms: 100 }, abort.signal);
			abort.abort();
			expect(structured(await pending)).toEqual({ slept_ms: 100 });
			expect(child.alive).toBe(true);
		} finally {
			await child.kill();
		}
	});

	it("rejects pending calls when the child dies", async () => {
		const child = await spawnFake();
		const pending = child.callTool("sleep", { ms: 10_000 });
		await child.callTool("crash", {}).catch(() => undefined);
		await expect(pending).rejects.toBeInstanceOf(CuaDriverExitedError);
		expect(child.alive).toBe(false);
		await expect(child.callTool("echo", {})).rejects.toBeInstanceOf(CuaDriverExitedError);
	});
});

describe("cua session over a driver child", () => {
	it("respawns a dead child on the next operation instead of staying closed", async () => {
		const spawned: CuaDriverChild[] = [];
		const session = await CuaComputerSession.create({
			spawn: async () => {
				const child = await spawnFake();
				spawned.push(child);
				return child;
			},
		});
		const context = {
			signal: new AbortController().signal,
			readOnly: false,
			maxWidth: 1,
			maxHeight: 1,
			emitImage() {},
		};
		try {
			expect(spawned).toHaveLength(1);
			await spawned[0].callTool("crash", {}).catch(() => undefined);
			expect(spawned[0].alive).toBe(false);
			const apps = (await session.apps(context)) as { pid: number };
			expect(spawned).toHaveLength(2);
			expect(spawned[1].alive).toBe(true);
			expect(apps.pid).toBe(spawned[1].pid);
		} finally {
			await session.close();
			expect(spawned.every(child => !child.alive)).toBe(true);
		}
	});
});
