import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
	registerComputerController,
	releaseComputerResourcesForOwner,
} from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { cfgComputerEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

function acpRuntime(
	options: { enabled?: boolean; available?: boolean; display?: string; maxWidth?: number; maxHeight?: number } = {},
) {
	const ownerId = crypto.randomUUID();
	const settings = Settings.isolated({
		"computer.enabled": options.enabled ?? false,
		"computer.display": options.display ?? "all",
		"computer.maxWidth": options.maxWidth ?? 1920,
		"computer.maxHeight": options.maxHeight ?? 1200,
	});
	const getEvalPreludes = vi.fn(() =>
		cfgComputerEnabled.get(settings) && options.available !== false ? [{ name: "computer" }] : [],
	);
	const refreshBaseSystemPrompt = vi.fn(async () => {});
	const abort = vi.fn(async () => releaseComputerResourcesForOwner(ownerId));
	const output = vi.fn();
	const runtime = {
		session: {
			abort,
			getEvalKernelOwnerId: () => ownerId,
			settings,
			getEvalPreludes,
			getEvalToolSession: () => undefined,
			refreshBaseSystemPrompt,
		},
		output,
	};
	return { ownerId, output, refreshBaseSystemPrompt, runtime, settings, abort };
}

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
			expect(cfgComputerEnabled.get(h.settings)).toBe(false);
			expect(active).toBe(true);
			expect(h.output).not.toHaveBeenCalled();
			drained.resolve();
			await off;
			expect(active).toBe(false);
			expect(h.output).toHaveBeenCalledWith("Computer use disabled for this session.");
			await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer on", h.runtime]);
			expect(cfgComputerEnabled.get(h.settings)).toBe(true);
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
			expect(cfgComputerEnabled.get(h.settings)).toBe(false);
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
		expect(cfgComputerEnabled.get(h.settings)).toBe(true);
		expect(h.settings.getGlobalSettings()).toEqual({});
		expect(h.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(h.abort).not.toHaveBeenCalled();
		const [reported] = h.output.mock.calls[0] as [string];
		expect(reported.startsWith("Computer use enabled for this session.")).toBe(true);
		expect(reported).toContain("Computer use: enabled");
		expect(reported).toContain("Permissions:");
	});

	it("toggles an enabled session off", async () => {
		const h = acpRuntime({ enabled: true });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer", h.runtime]);
		expect(cfgComputerEnabled.get(h.settings)).toBe(false);
		expect(h.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(h.output).toHaveBeenCalledWith("Computer use disabled for this session.");
	});

	it("honors explicit on and off regardless of current state", async () => {
		const on = acpRuntime({ enabled: true });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer on", on.runtime]);
		expect(cfgComputerEnabled.get(on.settings)).toBe(true);

		const off = acpRuntime({ enabled: false });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer off", off.runtime]);
		expect(cfgComputerEnabled.get(off.settings)).toBe(false);
	});

	it("reports status without changing settings or refreshing the prompt", async () => {
		const h = acpRuntime({ enabled: true });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer status", h.runtime]);
		expect(cfgComputerEnabled.get(h.settings)).toBe(true);
		expect(h.refreshBaseSystemPrompt).not.toHaveBeenCalled();
		const [reported] = h.output.mock.calls[0] as [string];
		expect(reported).toContain("Computer use: enabled");
		expect(reported).toContain("prelude: active");
	});

	it("reports configured values", async () => {
		const h = acpRuntime({ enabled: true, display: "display-2", maxWidth: 1600, maxHeight: 900 });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer status", h.runtime]);
		const [reported] = h.output.mock.calls[0] as [string];
		expect(reported).toContain("display=display-2");
		expect(reported).toContain("maxWidth=1600");
		expect(reported).toContain("maxHeight=900");
	});

	it("rolls back when the session has no computer prelude", async () => {
		const h = acpRuntime({ enabled: false, available: false });
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer on", h.runtime]);
		expect(cfgComputerEnabled.get(h.settings)).toBe(false);
		expect(h.settings.getGlobalSettings()).toEqual({});
		expect(h.refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("Computer use is unavailable in this session.");
	});

	it("rejects unknown arguments with usage", async () => {
		const h = acpRuntime();
		await Reflect.apply(executeAcpBuiltinSlashCommand, undefined, ["/computer bogus", h.runtime]);
		expect(cfgComputerEnabled.get(h.settings)).toBe(false);
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
		expect(cfgComputerEnabled.get(h.settings)).toBe(false);
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
		expect(cfgComputerEnabled.get(h.settings)).toBe(false);
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
	expect(cfgComputerEnabled.get(h.settings)).toBe(false);
	expect(h.output).not.toHaveBeenCalled();
});
