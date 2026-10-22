/**
 * launchd agents in `~/Library/LaunchAgents`.
 *
 * Calls (all read-only):
 * 1. `plutil -convert json` for every plist (one shell loop)
 * 2. `launchctl print-disabled gui/<uid>` plus `launchctl print gui/<uid>/<label>` per label,
 *    filtered remotely to top-level scalar lines so inherited environments (tokens) never leave launchctl
 * 3. `readlink -f` on the plists and `stat` on their log files (log mtime approximates the last run)
 */
import { flagsFrom, formatSeconds, inScratch, isOmpTicker, isoFromMs, nextCron, programPaths } from "./common";
import type { CommandRunner, ExternalJob, ExternalKind } from "./types";

const DUMP_SCRIPT = `for f in "$HOME"/Library/LaunchAgents/*.plist; do
[ -e "$f" ] || continue
printf '==> %s\\n' "$f"
plutil -convert json -o - "$f" 2>&1
printf '\\n'
done`;

const STATE_SCRIPT = `uid=$(id -u)
printf '==> disabled\\n'
launchctl print-disabled "gui/$uid" 2>/dev/null
for l in "$@"; do
printf '==> print %s\\n' "$l"
launchctl print "gui/$uid/$l" 2>/dev/null | grep -E '^\t[a-z][a-z ]* = [^{]*$' || printf '!not-loaded\\n'
done
exit 0`;

type CalendarEntry = Partial<Record<"Minute" | "Hour" | "Day" | "Weekday" | "Month", number>>;

interface Plist {
	Label?: string;
	Program?: string;
	ProgramArguments?: string[];
	StartCalendarInterval?: CalendarEntry | CalendarEntry[];
	StartInterval?: number;
	RunAtLoad?: boolean;
	KeepAlive?: unknown;
	WatchPaths?: string[];
	QueueDirectories?: string[];
	StandardOutPath?: string;
	StandardErrorPath?: string;
	WorkingDirectory?: string;
	Disabled?: boolean;
}

/** Splits `==> <header>` sections; returns `[header, body]` pairs in order. */
function sections(stdout: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const part of stdout.split(/^==> /m).slice(1)) {
		const newline = part.indexOf("\n");
		out.push(newline < 0 ? [part, ""] : [part.slice(0, newline), part.slice(newline + 1)]);
	}
	return out;
}

function calendarToCron(entry: CalendarEntry): string {
	const field = (value: number | undefined) => (value === undefined ? "*" : String(value));
	const weekday = entry.Weekday === 7 ? 0 : entry.Weekday;
	return [field(entry.Minute), field(entry.Hour), field(entry.Day), field(entry.Month), field(weekday)].join(" ");
}

function describeCalendar(entry: CalendarEntry): string {
	const keys = Object.keys(entry);
	const pad = (value: number) => String(value).padStart(2, "0");
	if (keys.length === 2 && entry.Hour !== undefined && entry.Minute !== undefined) {
		return `daily ${pad(entry.Hour)}:${pad(entry.Minute)}`;
	}
	if (keys.length === 1 && entry.Minute !== undefined) return `hourly :${pad(entry.Minute)}`;
	return `cron ${calendarToCron(entry)}`;
}

/** Top-level `key = value` lines of `launchctl print`. */
function parsePrint(body: string): Map<string, string> | null {
	if (body.trim() === "!not-loaded") return null;
	const fields = new Map<string, string>();
	for (const line of body.split("\n")) {
		const match = /^\t([a-z][a-z ]*?) = (.*)$/.exec(line);
		if (match && !fields.has(match[1])) fields.set(match[1], match[2].trim());
	}
	return fields;
}

export async function scanLaunchd(run: CommandRunner, host: string, now: number): Promise<ExternalJob[]> {
	const dump = await run(["sh", "-c", DUMP_SCRIPT]);
	const plists: Array<{ path: string; plist: Plist | null; error?: string }> = [];
	for (const [path, body] of sections(dump.stdout)) {
		try {
			plists.push({ path, plist: JSON.parse(body) as Plist });
		} catch {
			plists.push({ path, plist: null, error: body.trim().split("\n")[0] });
		}
	}
	const labelled = plists.filter(
		entry => !isOmpTicker(entry.plist?.Label ?? entry.path) && (entry.plist?.Label || entry.error),
	);
	if (labelled.length === 0) return [];

	const labels = labelled.flatMap(entry => (entry.plist?.Label ? [entry.plist.Label] : []));
	const logs = [
		...new Set(
			labelled.flatMap(entry => [entry.plist?.StandardOutPath, entry.plist?.StandardErrorPath]).filter(Boolean),
		),
	] as string[];
	const [state, links, stats] = await Promise.all([
		run(["sh", "-c", STATE_SCRIPT, "sh", ...labels]),
		run(["readlink", "-f", ...labelled.map(entry => entry.path)]),
		logs.length ? run(["stat", "-f", "%m %N", ...logs]) : Promise.resolve({ code: 0, stdout: "", stderr: "" }),
	]);

	const disabled = new Set<string>();
	const prints = new Map<string, Map<string, string> | null>();
	for (const [header, body] of sections(state.stdout)) {
		if (header === "disabled") {
			for (const match of body.matchAll(/"([^"]+)" => (disabled|true)\b/g)) disabled.add(match[1]);
		} else if (header.startsWith("print ")) {
			prints.set(header.slice("print ".length), parsePrint(body));
		}
	}
	const realPaths = links.stdout.split("\n");
	const resolvedPath = new Map(labelled.map((entry, index) => [entry.path, realPaths[index] || entry.path]));
	const mtimes = new Map<string, number>();
	for (const line of stats.stdout.split("\n")) {
		const match = /^(\d+) (.+)$/.exec(line);
		if (match) mtimes.set(match[2], Number(match[1]) * 1000);
	}

	const jobs: ExternalJob[] = [];
	for (const entry of labelled) {
		const sourcePath = resolvedPath.get(entry.path) ?? entry.path;
		const plist = entry.plist;
		if (!plist?.Label) {
			jobs.push({
				host,
				source: "launchd",
				kind: "agent",
				id: entry.path.split("/").pop() ?? entry.path,
				description: `unreadable plist: ${entry.error ?? "no Label"}`,
				schedule: "—",
				next: null,
				last: null,
				lastResult: null,
				state: "invalid",
				command: null,
				sourcePath,
				log: null,
				flags: ["unarmed", "no-failure-alert"],
			});
			continue;
		}
		const calendars = plist.StartCalendarInterval
			? Array.isArray(plist.StartCalendarInterval)
				? plist.StartCalendarInterval
				: [plist.StartCalendarInterval]
			: [];
		const triggers = [
			...calendars.map(describeCalendar),
			...(plist.StartInterval ? [`every ${formatSeconds(plist.StartInterval)}`] : []),
			...(plist.KeepAlive ? ["keepalive"] : []),
			...(plist.RunAtLoad ? ["at load"] : []),
			...(plist.WatchPaths?.length ? [`watch ${plist.WatchPaths.join(", ")}`] : []),
			...(plist.QueueDirectories?.length ? [`queue ${plist.QueueDirectories.join(", ")}`] : []),
		];
		const kind: ExternalKind =
			calendars.length || plist.StartInterval ? "timer" : plist.KeepAlive ? "service" : "agent";
		const nexts = calendars.map(entry => nextCron(calendarToCron(entry), now)).filter(n => n !== null) as number[];
		const fields = prints.get(plist.Label);
		const loaded = fields !== null && fields !== undefined;
		const isDisabled = disabled.has(plist.Label) || plist.Disabled === true;
		const runs = loaded ? Number(fields.get("runs") ?? "0") : null;
		const running = fields?.get("state") === "running";
		const exitText = fields?.get("last exit code");
		const signal = fields?.get("last terminating signal");
		const exitCode = exitText && /^-?\d+$/.test(exitText) ? Number(exitText) : null;
		const lastResult = signal
			? `signal ${signal}`
			: exitCode === null
				? null
				: exitCode === 0
					? "success"
					: `exit ${exitCode}`;
		const logPaths = [...new Set([plist.StandardOutPath, plist.StandardErrorPath].filter(Boolean))] as string[];
		const logMtime = Math.max(0, ...logPaths.map(path => mtimes.get(path) ?? 0));
		const program = plist.ProgramArguments?.join(" ") ?? plist.Program ?? null;
		jobs.push({
			host,
			source: "launchd",
			kind,
			id: plist.Label,
			description: null,
			schedule: triggers.join(" + ") || "on demand",
			next: loaded && !isDisabled && nexts.length ? isoFromMs(Math.min(...nexts)) : null,
			last: runs ? isoFromMs(logMtime) : null,
			...(runs && logMtime ? { lastApprox: true } : {}),
			lastResult,
			state: !loaded
				? isDisabled
					? "disabled"
					: "not loaded"
				: running
					? `running pid ${fields.get("pid") ?? "?"}`
					: isDisabled
						? "disabled"
						: (fields.get("state") ?? "loaded"),
			command: program,
			sourcePath,
			log: logPaths.join(", ") || null,
			flags: flagsFrom([
				["failed", !!signal || (exitCode !== null && exitCode !== 0)],
				["never-ran", kind === "timer" && runs === 0 && !running],
				["unarmed", !loaded || isDisabled],
				// launchd has no OnFailure equivalent: a failing job only writes its log.
				["no-failure-alert", true],
				// Logs count too: a scratch sweep deletes the only record of a failure.
				[
					"source-in-scratch",
					inScratch(
						sourcePath,
						entry.path,
						...programPaths(plist.ProgramArguments ?? (plist.Program ? [plist.Program] : [])),
						plist.WorkingDirectory,
						...logPaths,
					),
				],
				["sleep-lossy", !!plist.StartInterval],
			]),
		});
	}
	return jobs;
}
