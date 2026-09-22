import { describe, expect, it, vi } from "bun:test";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import {
	type ComputerStatusDeps,
	computerUseStatus,
	type ProcessRow,
	responsibleApp,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/computer-status";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { registerComputerController } from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";

const ITERM: ProcessRow[] = [
	{ pid: 300, ppid: 200, command: "/Users/me/.bun/bin/omp" },
	{ pid: 200, ppid: 100, command: "-zsh" },
	{ pid: 100, ppid: 1, command: "/Applications/iTerm.app/Contents/MacOS/iTerm2" },
	{ pid: 1, ppid: 0, command: "/sbin/launchd" },
];

const deps = (overrides: Partial<ComputerStatusDeps> = {}): ComputerStatusDeps => ({
	installed: async () => ({
		path: "/opt/natives/cua-driver/cua-driver",
		version: "0.28.2",
		commit: "1c1c7f0c2abcdef",
		sha256: "ab".repeat(32),
	}),
	pinned: async () => undefined,
	processes: () => ITERM,
	platform: "darwin",
	...overrides,
});

function session(options: { enabled?: boolean; permissions?: Record<string, unknown>; streaming?: boolean } = {}) {
	const ownerId = crypto.randomUUID();
	const invoke = vi.fn(async () => ({
		content: [],
		details: { driver: { version: "0.28.2" }, permissions: options.permissions ?? {} },
	}));
	const definition = { name: "computer", invoke } as unknown as EvalPreludeDefinition;
	const store: Record<string, unknown> = {
		"computer.enabled": options.enabled ?? true,
		"computer.display": "all",
		"computer.maxWidth": 1920,
		"computer.maxHeight": 1200,
	};
	return {
		invoke,
		ownerId,
		value: {
			settings: { get: (key: string) => store[key] },
			getEvalPreludes: () => (store["computer.enabled"] ? [definition] : []),
			getEvalToolSession: () => ({}) as ToolSession,
			getEvalKernelOwnerId: () => ownerId,
			isStreaming: options.streaming ?? false,
		} as unknown as Parameters<typeof computerUseStatus>[0],
	};
}

describe("/computer status permission report", () => {
	it("names each missing grant and the terminal app that must hold it", async () => {
		const s = session({
			permissions: {
				accessibility: true,
				screen_recording: false,
				source: { attribution: "caller", responsible_ppid: 300 },
			},
		});
		const lines = (await computerUseStatus(s.value, deps())).split("\n");
		const permissions = lines.find(line => line.startsWith("Permissions"))!;
		expect(permissions).toMatch(/Accessibility granted/);
		expect(permissions).toMatch(/Screen Recording not granted/);
		expect(permissions).toContain("iTerm");
		expect(permissions).toContain("300");
		const remedy = lines.find(line => line.startsWith("Grant"))!;
		expect(remedy).toContain("Screen Recording");
		expect(remedy).not.toContain("Accessibility");
		expect(remedy).toContain("iTerm");
		const driver = lines.find(line => line.startsWith("Driver"))!;
		expect(driver).toContain("0.28.2");
		expect(driver).toContain("1c1c7f0c2");
		expect(driver).toContain("abababab");
		expect(driver).toContain("/opt/natives/cua-driver/cua-driver");
	});

	it("gives no remediation when both grants are held, and names the driver bundle when it holds them", async () => {
		const s = session({
			permissions: { accessibility: true, screen_recording: true, source: { attribution: "driver-daemon" } },
		});
		const report = await computerUseStatus(s.value, deps());
		expect(report).not.toMatch(/^Grant/m);
		expect(report).toContain("CuaDriver");
		expect(report).not.toContain("iTerm");
	});

	it("does not start the driver while computer use is off, and says what installs on first use", async () => {
		const s = session({ enabled: false });
		const report = await computerUseStatus(
			s.value,
			deps({
				installed: async () => undefined,
				pinned: async () => ({
					platform: "darwin-arm64",
					version: "0.28.2",
					commit: "1c1c7f0c2",
					sha256: "0".repeat(64),
					size: 1,
					url: "https://example.invalid/cua-driver",
				}),
			}),
		);
		expect(s.invoke).not.toHaveBeenCalled();
		expect(report).toMatch(/^Permissions: not checked/m);
		expect(report).toMatch(/^Driver: not installed.*0\.28\.2/m);
	});

	it("hands back a driver it started only when no turn is running", async () => {
		for (const streaming of [false, true]) {
			const s = session({ permissions: { accessibility: true, screen_recording: true }, streaming });
			const release = vi.fn(async () => {});
			const unregister = registerComputerController(s.ownerId, { release, async close() {} });
			try {
				await computerUseStatus(s.value, deps());
				expect(s.invoke).toHaveBeenCalledTimes(1);
				expect(release).toHaveBeenCalledTimes(streaming ? 0 : 1);
			} finally {
				unregister();
			}
		}
	});

	it("reports a driver that fails to start instead of claiming permissions", async () => {
		const s = session();
		s.invoke.mockImplementation(async () => {
			throw new Error("no cua-driver is vendored for this platform");
		});
		const report = await computerUseStatus(s.value, deps());
		expect(report).toMatch(/^Permissions: unavailable: no cua-driver is vendored/m);
	});
});

describe("responsibleApp", () => {
	it("takes the outermost app bundle among the ancestors", () => {
		const rows: ProcessRow[] = [
			{ pid: 40, ppid: 30, command: "/usr/local/bin/omp" },
			{ pid: 30, ppid: 20, command: "/bin/zsh" },
			{
				pid: 20,
				ppid: 10,
				command:
					"/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
			},
			{ pid: 10, ppid: 1, command: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" },
		];
		expect(responsibleApp(40, rows)).toBe("Visual Studio Code");
	});

	it("names nothing when the chain runs outside any bundle", () => {
		const rows: ProcessRow[] = [
			{ pid: 40, ppid: 30, command: "/usr/local/bin/omp" },
			{ pid: 30, ppid: 1, command: "tmux" },
		];
		expect(responsibleApp(40, rows)).toBeUndefined();
	});
});
