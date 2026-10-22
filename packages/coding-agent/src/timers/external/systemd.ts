/**
 * systemd timers and long-running services, user or system scope.
 *
 * Calls (all read-only):
 * 1. `systemctl list-timers --all -o json`, `list-units --type=service --all -o json`,
 *    `list-unit-files --type=timer -o json` (timers that exist but are not loaded)
 * 2. `systemctl show -p Id,FragmentPath,Unit <candidates…>` to drop vendor units
 * 3. one batched `systemctl show -p <PROPS> --timestamp=unix <custom units…>`
 * 4. `readlink -f <fragment paths…>` so linked units show their repo
 * 5. `kill -l <n>` on the host for units killed by a signal (signal numbers differ between architectures)
 */
import { flagsFrom, isOmpTicker, isoFromMs, stdoutOf } from "./common";
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
	"OnFailure",
	"ExecStart",
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

interface Outcome {
	/** `success`, `running`, `exit 1`, `timeout (signal 9)`, `success (exit 42)`, … ; null when it never ran. */
	text: string | null;
	failed: boolean;
}

function serviceOutcome(service: ShowBlock | undefined, signals: Map<number, string>): Outcome {
	if (!service) return { text: null, failed: false };
	if (isRunning(service)) return { text: "running", failed: false };
	const failedUnit = one(service, "ActiveState") === "failed";
	if (!one(service, "ExecMainStartTimestamp")) return { text: failedUnit ? "failed" : null, failed: failedUnit };
	const result = one(service, "Result");
	const status = Number(one(service, "ExecMainStatus") || "0");
	const code = Number(one(service, "ExecMainCode") || "0");
	// ExecMainCode: 1 = exited, 2 = killed, 3 = dumped (status then holds the signal).
	const raw =
		code === 2 || code === 3 ? `signal ${signals.get(status) ?? status}` : status !== 0 ? `exit ${status}` : null;
	// `Result=` is systemd's verdict: `SuccessExitStatus=` turns listed exit codes and signals into success.
	const failed = failedUnit || (result !== "" && result !== "success");
	if (!failed) return { text: raw ? `success (${raw})` : "success", failed };
	const verdict = result && result !== "success" ? result : "failed";
	if (raw && (verdict === "exit-code" || verdict === "signal" || verdict === "core-dump"))
		return { text: raw, failed };
	return { text: raw ? `${verdict} (${raw})` : verdict, failed };
}

/** Names for the signal numbers units died of, from the host's own `kill -l`; numbers stay bare if it fails. */
async function signalNames(run: CommandRunner, shown: Map<string, ShowBlock>): Promise<Map<number, string>> {
	const numbers = [
		...new Set(
			[...shown.values()]
				.filter(block => one(block, "ExecMainCode") === "2" || one(block, "ExecMainCode") === "3")
				.map(block => Number(one(block, "ExecMainStatus"))),
		),
	];
	const names = new Map<number, string>();
	if (numbers.length === 0) return names;
	const out = await run(["sh", "-c", 'for n do kill -l "$n"; done', "sh", ...numbers.map(String)]);
	const lines = out.stdout.trim().split("\n");
	if (out.code !== 0 || lines.length !== numbers.length) return names;
	numbers.forEach((number, index) => {
		const name = lines[index].trim().replace(/^SIG/, "");
		if (/^[A-Z0-9+-]+$/.test(name)) names.set(number, name);
	});
	return names;
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
	const systemctl = async (...args: string[]) =>
		stdoutOf(await run(["systemctl", ...scopeArgs, ...args]), ["systemctl", ...scopeArgs, args[0]].join(" "));
	const [timersOut, servicesOut, filesOut] = await Promise.all([
		systemctl("list-timers", "--all", "--no-pager", "-o", "json"),
		systemctl("list-units", "--type=service", "--all", "--no-pager", "-o", "json"),
		systemctl("list-unit-files", "--type=timer", "--no-pager", "-o", "json"),
	]);
	const listed = parseJsonArray<ListedTimer>(timersOut, "list-timers");
	const services = parseJsonArray<{ unit: string }>(servicesOut, "list-units");
	const timerFiles = parseJsonArray<{ unit_file: string; state: string }>(filesOut, "list-unit-files");

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

	const paths = parseShow(await systemctl("show", "-p", "Id,FragmentPath,Unit", "--", ...names));
	const custom = new Set<string>();
	for (const [id, block] of paths) {
		if (isVendor(one(block, "FragmentPath"))) continue;
		custom.add(id);
		const activates = one(block, "Unit");
		if (activates) custom.add(activates);
	}
	if (custom.size === 0) return [];

	const shown = parseShow(await systemctl("show", "-p", PROPS.join(","), "--timestamp=unix", "--", ...custom));
	const signals = await signalNames(run, shown);
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
		const outcome = serviceOutcome(service, signals);
		const command = execCommand(service?.get("ExecStart"));
		const log = service ? logLocation(service, serviceName, scope) : null;
		const flags: HealthFlag[] = flagsFrom([
			["failed", outcome.failed],
			["never-ran", !last && !serviceRunning],
			["unarmed", subState !== "elapsed" && (!fromList || timerActive !== "active" || (!next && !serviceRunning))],
			["no-failure-alert", !one(service, "OnFailure") && !one(timer, "OnFailure")],
			["interval-only", calendar.length === 0 && monotonic.length > 0],
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
			lastResult: outcome.text,
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
		const outcome = serviceOutcome(service, signals);
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
			lastResult: outcome.text,
			state: `${active}/${one(service, "SubState")}`,
			command,
			sourcePath: sourceOf(service),
			log: logLocation(service, id, scope),
			flags: flagsFrom([
				["failed", outcome.failed],
				["no-failure-alert", !one(service, "OnFailure")],
			]),
		});
	}
	return jobs;
}
