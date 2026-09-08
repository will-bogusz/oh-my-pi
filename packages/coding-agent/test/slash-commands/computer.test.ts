import { describe, expect, it, vi } from "bun:test";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
	registerComputerController,
	releaseComputerResourcesForOwner,
} from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";

function acpRuntime(options?: { enabled?: boolean; available?: boolean }) {
	const ownerId = crypto.randomUUID();
	const store = {
		"computer.enabled": options?.enabled ?? false,
		"computer.display": "all",
		"computer.maxWidth": 1920,
		"computer.maxHeight": 1200,
	};
	const get = vi.fn((path: string) => {
		switch (path) {
			case "computer.enabled":
				return store["computer.enabled"];
			case "computer.display":
				return store["computer.display"];
			case "computer.maxWidth":
				return store["computer.maxWidth"];
			case "computer.maxHeight":
				return store["computer.maxHeight"];
		}
	});
	const override = vi.fn((path: string, value: boolean) => {
		if (path === "computer.enabled") store[path] = value;
	});
	const set = vi.fn();
	const getEvalPreludes = vi.fn(() =>
		store["computer.enabled"] && options?.available !== false ? [{ name: "computer" }] : [],
	);
	const refreshBaseSystemPrompt = vi.fn(async () => {});
	const abort = vi.fn(async () => releaseComputerResourcesForOwner(ownerId));
	const output = vi.fn();
	const runtime = {
		session: {
			abort,
			getEvalKernelOwnerId: () => ownerId,
			settings: { get, override, set },
			getEvalPreludes,
			refreshBaseSystemPrompt,
		},
		output,
	};
	return { ownerId, getEvalPreludes, override, output, refreshBaseSystemPrompt, runtime, set, store, abort };
}

const enabledStatus =
	"Computer use: enabled · prelude: active · configured: display=all, maxWidth=1920, maxHeight=1200";

describe("/computer slash command", () => {
	it("off disables admission immediately but reports success only after resource release", async () => {
		const h = acpRuntime({ enabled: true });
		const started = Promise.withResolvers<void>();
		const drained = Promise.withResolvers<void>();
		let active = true;
		const unregister = registerComputerController(h.ownerId, {
			async release() {
				started.resolve();
				await drained.promise;
				active = false;
			},
			async close() {},
		});
		try {
			const off = Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer off", h.runtime]);
			await started.promise;
			expect(h.store["computer.enabled"]).toBe(false);
			expect(active).toBe(true);
			expect(h.output).not.toHaveBeenCalled();
			drained.resolve();
			await off;
			expect(active).toBe(false);
			expect(h.output).toHaveBeenCalledWith("Computer use disabled for this session.");
			await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer on", h.runtime]);
			expect(h.store["computer.enabled"]).toBe(true);
		} finally {
			drained.resolve();
			unregister();
		}
	});

	it("off stays disabled and surfaces failed cleanup without claiming success", async () => {
		const h = acpRuntime({ enabled: true });
		const unregister = registerComputerController(h.ownerId, {
			async release() {
				throw new Error("exit was not confirmed");
			},
			async close() {},
		});
		try {
			await expect(
				Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer off", h.runtime]),
			).rejects.toThrow("could not be released");
			expect(h.store["computer.enabled"]).toBe(false);
			expect(h.output).not.toHaveBeenCalled();
		} finally {
			unregister();
		}
	});
	it("toggles a disabled session on and refreshes prelude guidance", async () => {
		const h = acpRuntime({ enabled: false });
		expect(await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer", h.runtime])).toEqual({
			consumed: true,
		});
		expect(h.override).toHaveBeenCalledWith("computer.enabled", true);
		expect(h.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(h.set).not.toHaveBeenCalled();
		expect(h.abort).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(`Computer use enabled for this session. ${enabledStatus}`);
	});

	it("toggles an enabled session off", async () => {
		const h = acpRuntime({ enabled: true });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer", h.runtime]);
		expect(h.override).toHaveBeenCalledWith("computer.enabled", false);
		expect(h.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(h.output).toHaveBeenCalledWith("Computer use disabled for this session.");
	});

	it("honors explicit on and off regardless of current state", async () => {
		const on = acpRuntime({ enabled: true });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer on", on.runtime]);
		expect(on.override).toHaveBeenCalledWith("computer.enabled", true);

		const off = acpRuntime({ enabled: false });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer off", off.runtime]);
		expect(off.override).toHaveBeenCalledWith("computer.enabled", false);
	});

	it("reports status without changing settings or refreshing the prompt", async () => {
		const h = acpRuntime({ enabled: true });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer status", h.runtime]);
		expect(h.override).not.toHaveBeenCalled();
		expect(h.refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(enabledStatus);
	});

	it("reports configured values", async () => {
		const h = acpRuntime({ enabled: true });
		h.store["computer.display"] = "display-2";
		h.store["computer.maxWidth"] = 1600;
		h.store["computer.maxHeight"] = 900;
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer status", h.runtime]);
		expect(h.output).toHaveBeenCalledWith(
			"Computer use: enabled · prelude: active · configured: display=display-2, maxWidth=1600, maxHeight=900",
		);
	});

	it("rolls back when the session has no computer prelude", async () => {
		const h = acpRuntime({ enabled: false, available: false });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer on", h.runtime]);
		expect(h.override).toHaveBeenNthCalledWith(1, "computer.enabled", true);
		expect(h.override).toHaveBeenNthCalledWith(2, "computer.enabled", false);
		expect(h.refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("Computer use is unavailable in this session.");
	});

	it("rejects unknown arguments with usage", async () => {
		const h = acpRuntime();
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer bogus", h.runtime]);
		expect(h.override).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("Usage: /computer [on|off|status]");
	});
});

it("TUI off shows stopping while resources drain and disabled only after completion", async () => {
	const h = acpRuntime({ enabled: true });
	const started = Promise.withResolvers<void>();
	const drained = Promise.withResolvers<void>();
	const showStatus = vi.fn();
	const setText = vi.fn();
	const unregister = registerComputerController(h.ownerId, {
		async release() {
			started.resolve();
			await drained.promise;
		},
		async close() {},
	});
	try {
		const handler = lookupBuiltinSlashCommand("computer")?.handleTui;
		if (!handler) throw new Error("Missing computer TUI handler");
		const pending = Reflect.apply(handler, undefined, [
			{ args: "off" },
			{ ctx: { session: h.runtime.session, showStatus, editor: { setText } } },
		]);
		await started.promise;
		expect(h.store["computer.enabled"]).toBe(false);
		expect(showStatus.mock.calls).toEqual([["Stopping computer use…"]]);
		drained.resolve();
		await pending;
		expect(showStatus.mock.calls).toEqual([["Stopping computer use…"], ["Computer use disabled for this session."]]);
	} finally {
		drained.resolve();
		unregister();
	}
});

it("off stays disabled after successful drain even if prompt refresh fails", async () => {
	const h = acpRuntime({ enabled: true });
	const released = vi.fn(async () => {});
	const unregister = registerComputerController(h.ownerId, { release: released, async close() {} });
	h.refreshBaseSystemPrompt.mockImplementation(async () => {
		throw new Error("prompt refresh failed");
	});
	try {
		await expect(
			Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer off", h.runtime]),
		).rejects.toThrow("prompt refresh failed");
		expect(released).toHaveBeenCalledTimes(1);
		expect(h.store["computer.enabled"]).toBe(false);
		expect(h.output).not.toHaveBeenCalled();
	} finally {
		unregister();
	}
});

it("on restores its prior disabled setting when prompt refresh fails", async () => {
	const h = acpRuntime({ enabled: false });
	h.refreshBaseSystemPrompt.mockImplementation(async () => {
		throw new Error("prompt refresh failed");
	});
	await expect(Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer on", h.runtime])).rejects.toThrow(
		"prompt refresh failed",
	);
	expect(h.store["computer.enabled"]).toBe(false);
	expect(h.output).not.toHaveBeenCalled();
});
