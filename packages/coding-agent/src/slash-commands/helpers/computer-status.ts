import * as os from "node:os";
import type { AgentSession } from "../../session/agent-session";
import { DRIVER_PLATFORM, type InstalledCuaDriver, installedCuaDriver } from "../../tools/computer/driver";
import { releaseComputerResourcesForOwner } from "../../tools/computer/supervisor";
import { type VendoredDriver, vendoredDriver } from "../../tools/computer/vendored";

/** One row of the host process table: enough to walk a process's ancestry. */
export interface ProcessRow {
	pid: number;
	ppid: number;
	/** Executable path as `ps -o comm=` prints it. */
	command: string;
}

export interface ComputerStatusDeps {
	installed: () => Promise<InstalledCuaDriver | undefined>;
	pinned: () => Promise<VendoredDriver | undefined>;
	processes: () => ProcessRow[];
	platform: NodeJS.Platform;
}

const defaultDeps: ComputerStatusDeps = {
	installed: installedCuaDriver,
	pinned: () => vendoredDriver(DRIVER_PLATFORM),
	processes: listProcesses,
	platform: process.platform,
};

function listProcesses(): ProcessRow[] {
	const listed = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,comm="], { stdout: "pipe", stderr: "ignore" });
	if (listed.exitCode !== 0) return [];
	return listed.stdout
		.toString()
		.split("\n")
		.flatMap(line => {
			const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
			return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
		});
}

/**
 * The app macOS attributes a process's TCC grants to: the outermost
 * application bundle among its ancestors (`/Applications/iTerm.app/…` →
 * `iTerm`). `undefined` when no ancestor runs from a bundle, e.g. a chain
 * re-parented to launchd under a daemonized multiplexer.
 */
export function responsibleApp(pid: number, rows: readonly ProcessRow[]): string | undefined {
	const byPid = new Map(rows.map(row => [row.pid, row]));
	let app: string | undefined;
	const seen = new Set<number>();
	for (let row = byPid.get(pid); row && !seen.has(row.pid); row = byPid.get(row.ppid)) {
		seen.add(row.pid);
		app = /([^/]+)\.app\//.exec(row.command)?.[1] ?? app;
	}
	return app;
}

const PERMISSIONS = [
	["accessibility", "Accessibility"],
	["screen_recording", "Screen Recording"],
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function driverLine(
	installed: InstalledCuaDriver | undefined,
	running: string | undefined,
	pinned: VendoredDriver | undefined,
): string {
	if (!installed)
		return pinned
			? `Driver: not installed yet; the first computer call installs cua-driver ${pinned.version} (${pinned.commit.slice(0, 9)})`
			: `Driver: none is vendored for ${DRIVER_PLATFORM}`;
	const version = running ?? installed.version ?? "unknown version";
	const home = os.homedir();
	const where = installed.path.startsWith(`${home}/`) ? `~${installed.path.slice(home.length)}` : installed.path;
	return [
		`Driver: cua-driver ${version}${installed.commit ? ` (${installed.commit.slice(0, 9)})` : ""}`,
		installed.sha256 ? `sha256 ${installed.sha256.slice(0, 12)}` : undefined,
		where,
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * Permission lines from the driver's own `check_permissions` report (carried
 * on its capabilities): each grant, the process macOS attributes them to, and
 * the one thing to do when one is missing.
 */
function permissionLines(permissions: Record<string, unknown>, deps: ComputerStatusDeps): string[] {
	if (deps.platform !== "darwin") {
		const reported = Object.entries(permissions)
			.filter(([, value]) => typeof value === "boolean")
			.map(([key, value]) => `${key} ${value ? "yes" : "no"}`);
		return [`Display access: ${reported.join(" · ") || "not reported"}`];
	}
	const source = record(permissions.source) ?? {};
	const responsiblePid = typeof source.responsible_ppid === "number" ? source.responsible_ppid : process.pid;
	const grantee =
		source.attribution === "driver-daemon"
			? "CuaDriver"
			: source.attribution === "host" && typeof source.host_bundle_id === "string" && source.host_bundle_id
				? source.host_bundle_id
				: responsibleApp(responsiblePid, deps.processes());
	const states = PERMISSIONS.map(([key, label]) => ({
		label,
		granted: permissions[key] === true,
	}));
	const lines = [
		`Permissions (${grantee ? `held by ${grantee}` : "held by the app omp runs in"}, pid ${responsiblePid} launched the driver): ${states
			.map(state => `${state.label} ${state.granted ? "granted" : "not granted"}`)
			.join(" · ")}`,
	];
	const missing = states.filter(state => !state.granted).map(state => state.label);
	if (missing.length > 0) {
		const app = grantee ?? "the terminal app omp runs in";
		lines.push(
			`Grant ${missing.join(" and ")} to ${app} in System Settings › Privacy & Security, then quit and reopen ${grantee ?? "it"}: macOS gives the driver the access of the app that launched omp, not of cua-driver itself.`,
		);
	}
	return lines;
}

/**
 * Detailed, session-effective `/computer status`: settings, the installed
 * driver, and — when computer use is on — the driver's permission report.
 * Checking permissions starts the driver if it is not running; an idle
 * session hands it back afterwards, as turn settle would.
 */
export async function computerUseStatus(
	session: Pick<AgentSession, "settings" | "getEvalPreludes" | "getEvalToolSession" | "getEvalKernelOwnerId"> & {
		readonly isStreaming?: boolean;
	},
	deps: ComputerStatusDeps = defaultDeps,
): Promise<string> {
	const enabled = session.settings.get("computer.enabled");
	const definition = session.getEvalPreludes().find(candidate => candidate.name === "computer");
	const lines = [
		[
			`Computer use: ${enabled ? "enabled" : "disabled"}`,
			`prelude: ${definition ? "active" : "inactive"}`,
			`configured: display=${session.settings.get("computer.display")}, maxWidth=${session.settings.get("computer.maxWidth")}, maxHeight=${session.settings.get("computer.maxHeight")}`,
		].join(" · "),
	];
	const toolSession = session.getEvalToolSession();
	let capabilities: Record<string, unknown> | undefined;
	let unavailable: string | undefined;
	if (!enabled || !definition) unavailable = "not checked; computer use is off (/computer on, then /computer status)";
	else if (!toolSession) unavailable = "not checked; this session runs no eval tools";
	else {
		try {
			const result = await definition.invoke(
				{ action: "capabilities" },
				{ session: toolSession, toolCallId: "computer-status" },
			);
			capabilities = record(result.details);
		} catch (error) {
			unavailable = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			if (!session.isStreaming) await releaseComputerResourcesForOwner(session.getEvalKernelOwnerId());
		}
	}
	const running = record(capabilities?.driver)?.version;
	lines.push(driverLine(await deps.installed(), typeof running === "string" ? running : undefined, await deps.pinned()));
	const permissions = record(capabilities?.permissions);
	if (permissions) lines.push(...permissionLines(permissions, deps));
	else lines.push(`Permissions: ${unavailable ?? "not reported by the driver"}`);
	return lines.join("\n");
}
