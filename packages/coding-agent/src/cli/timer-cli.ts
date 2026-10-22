/**
 * `omp timer …`: out-of-session surface over the timer store.
 * Standalone commands (no TUI), so they write to stdout/stderr directly.
 * Every verb takes `--json` for a machine-readable result on stdout.
 */
import { getProjectDir, VERSION } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import {
	createTimerHost,
	type DoctorReport,
	doctorTicker,
	editTimer,
	execTimerRun,
	fireTimerNow,
	type GateTest,
	installTicker,
	listTimers,
	loadTimerRow,
	parseWhen,
	planTickerInstall,
	readTickerStatus,
	removeTimer,
	renderRuns,
	renderTimerCard,
	renderTimerTable,
	requireTimer,
	runTick,
	setPaused,
	setTimer,
	storeHealth,
	type TimerEditInput,
	type TimerReport,
	type TimerRow,
	type TimerSetInput,
	tickerUnitEnv,
	tickLogPath,
	timerLog,
	timerRuns,
	timersRoot,
	uninstallTicker,
} from "../timers";
import { lastRunResult, readRunResult, renderRunResultBlock, runResults } from "../timers/run-result";

export const TIMER_ACTIONS = [
	"set",
	"edit",
	"ls",
	"list",
	"show",
	"runs",
	"logs",
	"fire",
	"pause",
	"resume",
	"rm",
	"remove",
	"tick",
	"exec",
	"install",
	"uninstall",
	"doctor",
] as const;
export type TimerAction = (typeof TIMER_ACTIONS)[number];

/**
 * Flags that set or edit a timer. `none` clears `at`/`every`/`until`/`expires`/`grace`
 * and the agent-run keys (model, agent, thinking, maxTime, maxCost, expect, before, after) on edit.
 */
export interface TimerFieldArgs {
	reason?: string;
	title?: string;
	when?: string;
	at?: string;
	every?: string;
	until?: string;
	ci?: string;
	pid?: number;
	prompt?: string;
	shell?: string;
	session?: string;
	whenClosed?: "resume" | "hold";
	tz?: string;
	cwd?: string;
	expires?: string;
	maxRuns?: number;
	model?: string;
	agent?: string;
	thinking?: string;
	/** `--hermetic` true, `--no-hermetic` false. */
	hermetic?: boolean;
	maxTime?: string;
	/** USD as typed (`0.5`), or `none` on edit. */
	maxCost?: string;
	/** Repeatable `--expect`; `none` clears on edit. */
	expect?: string[];
	before?: string;
	after?: string;
	report?: TimerReport;
	overlap?: "skip" | "queue";
	grace?: string;
	catchup?: "run" | "skip";
	pauseAfter?: number;
	allowTimers?: boolean;
	rev?: number;
}

export interface TimerCommandArgs {
	action: TimerAction;
	id?: string;
	extra: string[];
	json: boolean;
	fields: TimerFieldArgs;
	/** `fire --data`: untrusted text handed to the run. */
	data?: string;
	/** `runs --limit`. */
	limit?: number;
	/** install/uninstall/doctor: write files but run no launchctl/systemctl. */
	dryRun: boolean;
}

class UsageError extends Error {}

function out(text: string): void {
	process.stdout.write(`${text}\n`);
}

function json(value: unknown): void {
	out(JSON.stringify(value, null, 2));
}

function requireId(cmd: TimerCommandArgs): string {
	if (!cmd.id) throw new UsageError(`omp timer ${cmd.action} needs a timer id`);
	return cmd.id;
}

/** `--when` (Tern/Carly grammar) fills `at` or `every`; it cannot be combined with them. */
function scheduleFields(fields: TimerFieldArgs): { at?: string; every?: string } {
	if (!fields.when) return { at: fields.at, every: fields.every };
	if (fields.at || fields.every) throw new UsageError("--when replaces --at/--every; pass one of them");
	return parseWhen(fields.when);
}

/** `--max-cost` as USD; `none` is handled by the edit caller. */
function usd(value: string): number {
	const amount = Number(value);
	if (!value.trim() || !Number.isFinite(amount)) throw new UsageError(`--max-cost takes a USD amount, got "${value}"`);
	return amount;
}

function conditionOf(fields: TimerFieldArgs): TimerSetInput["when"] {
	return fields.until || fields.ci || fields.pid !== undefined
		? { cmd: fields.until, ci: fields.ci, pid: fields.pid }
		: undefined;
}

export function setInput(cmd: TimerCommandArgs): TimerSetInput {
	const { fields } = cmd;
	return {
		id: cmd.id,
		reason: fields.reason ?? "",
		title: fields.title,
		...scheduleFields(fields),
		when: conditionOf(fields),
		tz: fields.tz,
		prompt: fields.prompt,
		shell: fields.shell,
		session: fields.session,
		whenClosed: fields.whenClosed,
		cwd: fields.cwd,
		expires: fields.expires,
		maxRuns: fields.maxRuns,
		model: fields.model,
		agent: fields.agent,
		thinking: fields.thinking,
		hermetic: fields.hermetic,
		maxTime: fields.maxTime,
		maxCost: fields.maxCost === undefined ? undefined : usd(fields.maxCost),
		expect: fields.expect,
		before: fields.before,
		after: fields.after,
		report: fields.report,
		overlap: fields.overlap,
		grace: fields.grace,
		catchup: fields.catchup,
		pauseAfter: fields.pauseAfter,
		allowTimers: fields.allowTimers,
		expectedRev: fields.rev,
	};
}

const clearable = (value: string | undefined): string | null | undefined =>
	value === "none" || value === "never" ? null : value;

export function editInput(fields: TimerFieldArgs): TimerEditInput {
	const schedule = scheduleFields(fields);
	const patch: TimerEditInput = {
		title: fields.title,
		reason: fields.reason,
		at: clearable(schedule.at),
		every: clearable(schedule.every),
		tz: fields.tz,
		prompt: fields.prompt,
		shell: fields.shell,
		whenClosed: fields.whenClosed,
		cwd: fields.cwd,
		expires: clearable(fields.expires),
		maxRuns: fields.maxRuns,
		model: clearable(fields.model),
		agent: clearable(fields.agent),
		thinking: clearable(fields.thinking),
		hermetic: fields.hermetic,
		maxTime: clearable(fields.maxTime),
		maxCost: fields.maxCost === "none" ? null : fields.maxCost === undefined ? undefined : usd(fields.maxCost),
		expect: fields.expect?.includes("none") ? null : fields.expect,
		before: clearable(fields.before),
		after: clearable(fields.after),
		report: fields.report,
		overlap: fields.overlap,
		grace: clearable(fields.grace),
		catchup: fields.catchup,
		pauseAfter: fields.pauseAfter,
		allowTimers: fields.allowTimers,
		expectedRev: fields.rev,
	};
	if (fields.until === "none") patch.when = null;
	else if (conditionOf(fields)) patch.when = conditionOf(fields);
	if (Object.values(patch).every(value => value === undefined))
		throw new UsageError("omp timer edit: nothing to change");
	return patch;
}

function rowJson(row: TimerRow): Record<string, unknown> {
	return {
		id: row.spec.id,
		rev: row.spec.rev,
		status: row.status,
		pausedReason: row.spec.pausedReason ?? null,
		next: typeof row.next === "number" ? new Date(row.next).toISOString() : (row.next ?? null),
		last: row.lastRun ?? null,
		incidents: row.incidents,
		target: row.spec.target,
		run: row.spec.run,
		report: row.spec.report,
		reason: row.spec.reason,
		spec: row.spec,
		state: row.state,
	};
}

async function card(
	id: string,
	now: number,
	verb: string,
	result: GateTest & { warnings?: string[] } = {},
): Promise<string> {
	const row = await loadTimerRow(await requireTimer(id), now);
	const { warnings, gateNow, gateDetail } = result;
	return renderTimerCard(row, now, {
		verb,
		ticker: readTickerStatus(),
		warnings,
		gateNow,
		gateDetail,
		lastResult: await lastRunResult(row),
	});
}

function renderDoctor(report: DoctorReport): string {
	const mark = { ok: chalk.green("✓"), warn: chalk.yellow("⚠"), fail: chalk.red("✗") };
	return [
		`ticker unit: ${report.kind}`,
		...report.checks.flatMap(check => [
			`${mark[check.status]} ${check.name}: ${check.detail}`,
			...(check.log ?? []).map(line => `    ${chalk.dim(line)}`),
		]),
		report.ok ? "doctor: ok" : "doctor: problems found",
	].join("\n");
}

async function runAction(cmd: TimerCommandArgs, now: number): Promise<number> {
	switch (cmd.action) {
		case "set": {
			const result = await setTimer(setInput(cmd), { cwd: getProjectDir(), now });
			if (cmd.json) return (json(result), 0);
			out(await card(result.spec.id, now, result.replaced ? "re-armed" : "armed", result));
			return 0;
		}
		case "edit": {
			const id = requireId(cmd);
			const result = await editTimer(id, editInput(cmd.fields), { cwd: getProjectDir(), now });
			if (cmd.json) return (json(result), 0);
			out(await card(id, now, result.rearmed ? "edited, re-armed" : "edited", result));
			return 0;
		}
		case "ls":
		case "list": {
			const { rows, errors } = await listTimers(now);
			const ticker = readTickerStatus();
			if (cmd.json) return (json({ ticker, timers: rows.map(rowJson), errors }), 0);
			out(rows.length ? renderTimerTable(rows, now, ticker) : "no timers");
			for (const { id, error } of errors) out(chalk.yellow(`invalid spec ${id}: ${error}`));
			return 0;
		}
		case "show": {
			const id = requireId(cmd);
			if (cmd.json) return (json(rowJson(await loadTimerRow(await requireTimer(id), now))), 0);
			out(await card(id, now, ""));
			return 0;
		}
		case "runs": {
			const id = requireId(cmd);
			const runs = await timerRuns(id, { limit: cmd.limit });
			const results = await runResults(id, runs);
			if (cmd.json) return (json(runs.map(run => ({ ...run, result: results.get(run.seq) ?? null }))), 0);
			out(renderRuns(runs, results));
			return 0;
		}
		case "logs": {
			const id = requireId(cmd);
			const seq = cmd.extra[0] !== undefined ? Number(cmd.extra[0]) : undefined;
			if (seq !== undefined && !Number.isInteger(seq)) throw new UsageError("omp timer logs <id> [seq]");
			const log = await timerLog(id, seq);
			// The run whose result.json goes with the log: the asked-for one, the logged one, else the newest.
			let resultSeq = seq;
			if (resultSeq === undefined) {
				const runs = await timerRuns(id);
				resultSeq = log ? runs.find(run => run.runId === log.runId)?.seq : runs.at(-1)?.seq;
			}
			const result = resultSeq === undefined ? undefined : await readRunResult(id, resultSeq);
			if (cmd.json) return (json(log || result ? { ...log, seq: resultSeq, result: result ?? null } : null), 0);
			if (!log && !result) {
				out(
					`no run log for ${id}${seq !== undefined ? `#${seq}` : ""} (only shell runs, agent runs and headless resumes keep one)`,
				);
				return 0;
			}
			if (log) out(`${chalk.dim(`${log.runId} ${log.path}`)}\n${log.text.trimEnd()}`);
			if (result && resultSeq !== undefined) out(`${log ? "\n" : ""}${renderRunResultBlock(id, resultSeq, result)}`);
			return 0;
		}
		case "fire": {
			const line = await fireTimerNow(requireId(cmd), now, { data: cmd.data });
			if (cmd.json) return (json(line), 0);
			out(`${line.id} ${line.action} ${line.runId ?? ""} ${line.detail ?? ""}`.trim());
			return 0;
		}
		case "pause":
		case "resume": {
			const id = requireId(cmd);
			const spec = await setPaused(id, cmd.action === "pause", { now, expectedRev: cmd.fields.rev });
			if (cmd.json) return (json(spec), 0);
			out(`timer ${id} ${cmd.action === "pause" ? "paused" : "resumed"} (rev ${spec.rev})`);
			return 0;
		}
		case "rm":
		case "remove": {
			const id = requireId(cmd);
			const removed = await removeTimer(id);
			if (cmd.json) return (json({ id, removed }), removed ? 0 : 1);
			if (!removed) throw new Error(`no timer "${id}"`);
			out(`timer ${id} removed (spec kept under history/, run history kept)`);
			return 0;
		}
		case "tick": {
			const report = await runTick(now);
			if (cmd.json) return (out(JSON.stringify(report)), 0);
			if (report.locked) return (out(`${report.at} another tick holds the lock; skipped`), 0);
			out(
				`${report.at} tick: ${report.lines.length} action(s)${report.alerts.length ? `, ${report.alerts.length} alert(s)` : ""}`,
			);
			for (const line of report.lines) {
				out(
					`  ${line.id} ${line.action}${line.runId ? ` ${line.runId}` : ""}${line.detail ? ` — ${line.detail}` : ""}`,
				);
			}
			for (const alert of report.alerts) out(`  alert ${alert.timerId} ${alert.event}: ${alert.summary}`);
			return 0;
		}
		case "exec": {
			const seq = Number(cmd.extra[0]);
			if (!Number.isInteger(seq)) throw new UsageError("omp timer exec <id> <seq>");
			const result = await execTimerRun(requireId(cmd), seq);
			return result.ok ? 0 : 1;
		}
		case "install": {
			const host = createTimerHost({ dryRun: cmd.dryRun });
			const input = {
				ompCommand: resolveCliEntryCmd(),
				env: tickerUnitEnv(),
				logPath: tickLogPath(),
				lastTickAt: () => readTickerStatus().lastTickAt,
			};
			if (cmd.dryRun) {
				// Nothing is written: launchd loads any plist in ~/Library/LaunchAgents at the next login.
				const plan = planTickerInstall(host, input);
				if (cmd.json) return (json({ dryRun: true, plan }), 0);
				out(
					`dry run: omp timer install would write ${plan.files.length} file(s) and run ${plan.commands.length} command(s); nothing was changed`,
				);
				for (const file of plan.files) {
					out(`\n--- ${file.path}`);
					out(file.content.trimEnd());
				}
				out("");
				for (const argv of plan.commands) out(`would run ${argv.join(" ")}`);
				return 0;
			}
			const result = await installTicker(host, input);
			if (cmd.json) return (json({ ...result, dryRun: false, commands: host.commands }), result.ok ? 0 : 1);
			out(`${result.ok ? "installed" : "install failed:"} ${result.plan.kind} ticker`);
			for (const file of result.plan.files) out(`  wrote ${file.path}`);
			for (const run of result.results) {
				out(
					`  ran ${run.argv.join(" ")} → exit ${run.exitCode}${run.exitCode && run.stderr ? ` (${run.stderr.trim()})` : ""}`,
				);
			}
			if (result.detail) out(`  ${result.detail}`);
			return result.ok ? 0 : 1;
		}
		case "uninstall": {
			const host = createTimerHost({ dryRun: cmd.dryRun });
			const result = await uninstallTicker(host);
			if (cmd.json) return (json({ ...result, dryRun: cmd.dryRun }), 0);
			out(`uninstalled ${result.kind} ticker${cmd.dryRun ? " (dry run: nothing was removed or unloaded)" : ""}`);
			for (const file of result.removed) out(`  ${cmd.dryRun ? "would remove" : "removed"} ${file}`);
			for (const run of result.results) out(`  ${cmd.dryRun ? "would run" : "ran"} ${run.argv.join(" ")}`);
			return 0;
		}
		case "doctor": {
			const host = createTimerHost({ dryRun: cmd.dryRun });
			const report = await doctorTicker(host, {
				now,
				timersRoot: timersRoot(),
				currentVersion: VERSION,
				ompCommand: resolveCliEntryCmd(),
				unitEnv: tickerUnitEnv(),
				ticker: readTickerStatus(),
				store: storeHealth(),
			});
			if (cmd.json) return (json(report), report.ok ? 0 : 1);
			out(renderDoctor(report));
			return report.ok ? 0 : 1;
		}
	}
}

export async function runTimerCommand(cmd: TimerCommandArgs): Promise<void> {
	try {
		process.exitCode = await runAction(cmd, Date.now());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (cmd.json)
			process.stdout.write(
				`${JSON.stringify({ error: message, kind: error instanceof Error ? error.name : "Error" })}\n`,
			);
		else process.stderr.write(`${chalk.red(`error: ${message}`)}\n`);
		process.exitCode = error instanceof UsageError ? 2 : 1;
	}
}
