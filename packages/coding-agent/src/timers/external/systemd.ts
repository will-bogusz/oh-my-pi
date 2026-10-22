/**
 * systemd timers and long-running services, user or system scope.
 *
 * Calls (all read-only):
 * 1. `systemctl list-timers --all -o json`, `list-units --type=service --all -o json`,
 *    `list-unit-files --type=timer -o json` (timers that exist but are not loaded)
 * 2. `systemctl show -p Id,FragmentPath,Unit <candidates…>` to drop vendor units
 * 3. one batched `systemctl show -p <PROPS> --timestamp=unix <custom units…>`
 * 4. `readlink -f <fragment paths…>` so linked units show their repo
 */
import { flagsFrom, inScratch, isOmpTicker, isoFromMs, programPaths, signalName } from "./common";
import type { CommandRunner, ExternalJob, HealthFlag } from "./types";

export type SystemdScope = "user" | "system";

const PROPS = [
	"Id",
	"Description",
	"Type",
	"Restart",
	"Result",
	"ExecMainStatus",
	"ExecMainCode",
	"ExecMainStartTimestamp",
	"ActiveState",
	"SubState",
	"LoadState",
	"UnitFileState",
	"FragmentPath",
	"DropInPaths",
	"OnFailure",
	"ExecStart",
	"WorkingDirectory",
	"StandardOutput",
	"StandardOutputFileDescriptorName",
	"TimersCalendar",
	"TimersMonotonic",
	"Unit",
	"TriggeredBy",
];

/** Unit files the distribution or a generator ships; everything else was installed by someone on purpose. */
const VENDOR_PREFIXES = ["/usr/lib/", "/lib/", "/usr/share/", "/run/systemd/generator", "/run/systemd/system/"];

interface ListedTimer {
	unit: string;
	activates?: string;
	next?: number | null;
	last?: number | null;
}

type ShowBlock = Map<string, string[]>;

/** Parses `systemctl show` output: blank-line separated blocks of `Key=value`; repeated keys accumulate. */
export function parseShow(stdout: string): Map<string, ShowBlock> {
	const units = new Map<string, ShowBlock>();
	for (const chunk of stdout.split(/\n\s*\n/)) {
		const block: ShowBlock = new Map();
		for (const line of chunk.split("\n")) {
			const eq = line.indexOf("=");
			if (eq <= 0) continue;
			const key = line.slice(0, eq);
			const values = block.get(key);
			if (values) values.push(line.slice(eq + 1));
			else block.set(key, [line.slice(eq + 1)]);
		}
		const id = block.get("Id")?.[0];
		if (id) units.set(id, block);
	}
	return units;
}

function one(block: ShowBlock | undefined, key: string): string {
	return block?.get(key)?.[0] ?? "";
}

function parseJsonArray<T>(stdout: string, what: string): T[] {
	const parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed)) throw new Error(`${what}: expected a JSON array`);
	return parsed as T[];
}

function microsToIso(value: number | null | undefined): string | null {
	return typeof value === "number" && value > 0 ? isoFromMs(Math.floor(value / 1000)) : null;
}

/** `@1792650610` (from `--timestamp=unix`) → ISO. */
function unixStampToIso(value: string): string | null {
	const match = /^@(\d+)/.exec(value);
	return match ? isoFromMs(Number(match[1]) * 1000) : null;
}

/** `{ OnCalendar=*-*-* 02:30:00 ; next_elapse=… }` → `OnCalendar=*-*-* 02:30:00`; `OnUnitActiveUSec=10min` → `OnUnitActiveSec=10min`. */
function triggerSpec(value: string): string | null {
	const match = /^\{\s*([A-Za-z]+)=(.*?)\s*;/.exec(value);
	if (!match) return null;
	return `${match[1].replace(/USec$/, "Sec")}=${match[2]}`;
}

/** `{ path=… ; argv[]=/usr/bin/python3 x poll ; ignore_errors=… }` → `/usr/bin/python3 x poll`. */
function execCommand(values: string[] | undefined): string | null {
	const commands = (values ?? []).map(value => /argv\[\]=(.*?) ;/.exec(value)?.[1]).filter(Boolean) as string[];
	return commands.length ? commands.join(" && ") : null;
}

function isVendor(fragment: string): boolean {
	return !fragment || VENDOR_PREFIXES.some(prefix => fragment.startsWith(prefix));
}

/** A run is in progress: mid-transition, or an active non-oneshot (a oneshot that stays `active` has finished). */
function isRunning(service: ShowBlock | undefined): boolean {
	const active = one(service, "ActiveState");
	if (active === "activating" || active === "deactivating" || active === "reloading") return true;
	return active === "active" && one(service, "Type") !== "oneshot";
}

function lastResult(service: ShowBlock | undefined): string | null {
	if (!service) return null;
	if (isRunning(service)) return "running";
	const active = one(service, "ActiveState");
	if (!one(service, "ExecMainStartTimestamp")) return active === "failed" ? "failed" : null;
	const result = one(service, "Result");
	const status = Number(one(service, "ExecMainStatus") || "0");
	const code = Number(one(service, "ExecMainCode") || "0");
	// ExecMainCode: 1 = exited, 2 = killed, 3 = dumped (status then holds the signal).
	if (code === 2 || code === 3) return `signal ${signalName(status)}`;
	if (status !== 0) return `exit ${status}`;
	if (result && result !== "success") return result;
	return active === "failed" ? "failed" : "success";
}

function logLocation(service: ShowBlock | undefined, unit: string, scope: SystemdScope): string | null {
	const output = one(service, "StandardOutput");
	if (output === "null") return null;
	const fileMatch = /^(?:append|file|truncate):(.+)$/.exec(output);
	if (fileMatch) return fileMatch[1];
	if (output === "append" || output === "file" || output === "truncate") {
		return one(service, "StandardOutputFileDescriptorName") || null;
	}
	return `journalctl ${scope === "user" ? "--user " : ""}-u ${unit}`;
}

export async function scanSystemd(run: CommandRunner, scope: SystemdScope, host: string): Promise<ExternalJob[]> {
	const scopeArgs = scope === "user" ? ["--user"] : [];
	const systemctl = (...args: string[]) => run(["systemctl", ...scopeArgs, ...args]);
	const [timersOut, servicesOut, filesOut] = await Promise.all([
		systemctl("list-timers", "--all", "--no-pager", "-o", "json"),
		systemctl("list-units", "--type=service", "--all", "--no-pager", "-o", "json"),
		systemctl("list-unit-files", "--type=timer", "--no-pager", "-o", "json"),
	]);
	if (timersOut.code !== 0) {
		const failed = ["systemctl", ...scopeArgs, "list-timers"].join(" ");
		throw new Error(`${failed} failed: ${timersOut.stderr.trim() || timersOut.code}`);
	}
	const listed = parseJsonArray<ListedTimer>(timersOut.stdout, "list-timers");
	const services = servicesOut.code === 0 ? parseJsonArray<{ unit: string }>(servicesOut.stdout, "list-units") : [];
	const timerFiles =
		filesOut.code === 0
			? parseJsonArray<{ unit_file: string; state: string }>(filesOut.stdout, "list-unit-files")
			: [];

	const listedByUnit = new Map(listed.map(timer => [timer.unit, timer]));
	const candidates = new Set<string>();
	for (const timer of listed) {
		candidates.add(timer.unit);
		if (timer.activates) candidates.add(timer.activates);
	}
	for (const file of timerFiles) {
		// Template timers (`x@.timer`) are not units by themselves.
		if (!file.unit_file.includes("@.")) candidates.add(file.unit_file);
	}
	for (const service of services) candidates.add(service.unit);
	const names = [...candidates].filter(name => !isOmpTicker(name));
	if (names.length === 0) return [];

	const paths = parseShow((await systemctl("show", "-p", "Id,FragmentPath,Unit", "--", ...names)).stdout);
	const custom = new Set<string>();
	for (const [id, block] of paths) {
		if (isVendor(one(block, "FragmentPath"))) continue;
		custom.add(id);
		const activates = one(block, "Unit");
		if (activates) custom.add(activates);
	}
	if (custom.size === 0) return [];

	const shown = parseShow(
		(await systemctl("show", "-p", PROPS.join(","), "--timestamp=unix", "--", ...custom)).stdout,
	);
	const fragments = [...new Set([...shown.values()].map(block => one(block, "FragmentPath")).filter(Boolean))];
	const resolved = new Map<string, string>();
	if (fragments.length) {
		const out = await run(["readlink", "-f", "--", ...fragments]);
		const lines = out.stdout.split("\n");
		if (out.code === 0 && lines.length >= fragments.length) {
			fragments.forEach((fragment, index) => resolved.set(fragment, lines[index] || fragment));
		}
	}
	const sourceOf = (block: ShowBlock | undefined): string | null => {
		const fragment = one(block, "FragmentPath");
		return fragment ? (resolved.get(fragment) ?? fragment) : null;
	};
	const source = scope === "user" ? "systemd-user" : "systemd-system";

	const jobs: ExternalJob[] = [];
	const timerActivated = new Set<string>();
	for (const [id, timer] of shown) {
		if (!id.endsWith(".timer") || isVendor(one(timer, "FragmentPath"))) continue;
		const serviceName = one(timer, "Unit");
		timerActivated.add(serviceName);
		const service = shown.get(serviceName);
		const fromList = listedByUnit.get(id);
		const calendar = (timer.get("TimersCalendar") ?? []).map(triggerSpec).filter(Boolean) as string[];
		const monotonic = (timer.get("TimersMonotonic") ?? []).map(triggerSpec).filter(Boolean) as string[];
		const next = microsToIso(fromList?.next);
		const last = microsToIso(fromList?.last) ?? unixStampToIso(one(service, "ExecMainStartTimestamp"));
		const timerActive = one(timer, "ActiveState");
		const subState = one(timer, "SubState");
		const serviceRunning = isRunning(service);
		const result = lastResult(service);
		const command = execCommand(service?.get("ExecStart"));
		const workdir = one(service, "WorkingDirectory");
		const log = service ? logLocation(service, serviceName, scope) : null;
		const flags: HealthFlag[] = flagsFrom([
			[
				"failed",
				one(service, "ActiveState") === "failed" || (!!result && result !== "success" && result !== "running"),
			],
			["never-ran", !last && !serviceRunning],
			["unarmed", subState !== "elapsed" && (!fromList || timerActive !== "active" || (!next && !serviceRunning))],
			["no-failure-alert", !one(service, "OnFailure") && !one(timer, "OnFailure")],
			["interval-only", calendar.length === 0 && monotonic.length > 0],
			[
				"source-in-scratch",
				inScratch(
					sourceOf(timer),
					log,
					sourceOf(service),
					...programPaths(command?.split(" ") ?? []),
					workdir,
					...(timer.get("DropInPaths") ?? []),
					...(service?.get("DropInPaths") ?? []),
				),
			],
		]);
		jobs.push({
			host,
			source,
			kind: "timer",
			id,
			description: one(timer, "Description") || one(service, "Description") || null,
			schedule: [...calendar, ...monotonic].join("; ") || "—",
			next,
			last,
			lastResult: result,
			state: fromList ? `${timerActive}/${subState}` : `not loaded (${one(timer, "UnitFileState") || "unknown"})`,
			command,
			sourcePath: sourceOf(timer),
			log,
			flags,
		});
	}

	for (const [id, service] of shown) {
		if (!id.endsWith(".service") || timerActivated.has(id) || isVendor(one(service, "FragmentPath"))) continue;
		if (one(service, "TriggeredBy")) continue;
		const active = one(service, "ActiveState");
		const restart = one(service, "Restart");
		const longRunning = restart !== "" && restart !== "no";
		const daemon = isRunning(service);
		// Template instances (OnFailure alert handlers) and finished one-shots are not standing work.
		if (!(longRunning || daemon || active === "failed")) continue;
		const command = execCommand(service.get("ExecStart"));
		jobs.push({
			host,
			source,
			kind: "service",
			id,
			description: one(service, "Description") || null,
			schedule: longRunning ? `always (Restart=${restart})` : "started once",
			next: null,
			last: unixStampToIso(one(service, "ExecMainStartTimestamp")),
			lastResult: lastResult(service),
			state: `${active}/${one(service, "SubState")}`,
			command,
			sourcePath: sourceOf(service),
			log: logLocation(service, id, scope),
			flags: flagsFrom([
				["failed", active === "failed"],
				["no-failure-alert", !one(service, "OnFailure")],
				[
					"source-in-scratch",
					inScratch(
						sourceOf(service),
						...programPaths(command?.split(" ") ?? []),
						one(service, "WorkingDirectory"),
						...(service.get("DropInPaths") ?? []),
					),
				],
			]),
		});
	}
	return jobs;
}
