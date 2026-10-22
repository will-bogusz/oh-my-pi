/**
 * `omp timer …` and `omp poke …`: out-of-session surfaces over the timer store.
 * Standalone commands (no TUI), so they write to stdout/stderr directly.
 * Every verb takes `--json` for a machine-readable result on stdout.
 */
import * as os from "node:os";
import * as path from "node:path";
import { $env, getProjectDir, VERSION } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { resolveResumableSession } from "../session/session-listing";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import {
	createTimerHost,
	type DoctorReport,
	doctorTicker,
	editTimer,
	execTimerRun,
	fireTimerNow,
	hasLiveMailboxConsumer,
	installTicker,
	listTimers,
	loadTimerRow,
	newMailId,
	parseWhen,
	postMail,
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
	type TimerRow,
	type TimerSetInput,
	tickLogPath,
	timerLog,
	timerRuns,
	timersRoot,
	uninstallTicker,
} from "../timers";

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

/** Flags that set or edit a timer. `none` clears `at`/`every`/`until`/`expires` on edit. */
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
	overlap?: "skip" | "queue";
	grace?: string;
	pauseAfter?: number;
	allowTimers?: boolean;
	wakeMachine?: boolean;
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

function conditionOf(fields: TimerFieldArgs): TimerSetInput["when"] {
	return fields.until || fields.ci || fields.pid !== undefined
		? { cmd: fields.until, ci: fields.ci, pid: fields.pid }
		: undefined;
}

function setInput(cmd: TimerCommandArgs): TimerSetInput {
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
		overlap: fields.overlap,
		grace: fields.grace,
		pauseAfter: fields.pauseAfter,
		allowTimers: fields.allowTimers,
		wakeMachine: fields.wakeMachine,
		expectedRev: fields.rev,
	};
}

const clearable = (value: string | undefined): string | null | undefined =>
	value === "none" || value === "never" ? null : value;

function editInput(fields: TimerFieldArgs): TimerEditInput {
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
		model: fields.model,
		overlap: fields.overlap,
		grace: clearable(fields.grace),
		pauseAfter: fields.pauseAfter,
		allowTimers: fields.allowTimers,
		wakeMachine: fields.wakeMachine,
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
		origin: row.spec.created.session ?? null,
		target: row.spec.target,
		reason: row.spec.reason,
		spec: row.spec,
		state: row.state,
	};
}

async function card(
	id: string,
	now: number,
	verb: string,
	extra: Parameters<typeof renderTimerCard>[2] | object = {},
): Promise<string> {
	const row = await loadTimerRow(await requireTimer(id), now);
	return renderTimerCard(row, now, { verb, ticker: readTickerStatus(), ...extra });
}

function renderDoctor(report: DoctorReport): string {
	const mark = { ok: chalk.green("✓"), warn: chalk.yellow("⚠"), fail: chalk.red("✗") };
	return [
		`ticker unit: ${report.kind}`,
		...report.checks.map(check => `${mark[check.status]} ${check.name}: ${check.detail}`),
		report.ok ? "doctor: ok" : "doctor: problems found",
	].join("\n");
}

async function runAction(cmd: TimerCommandArgs, now: number): Promise<number> {
	switch (cmd.action) {
		case "set": {
			const result = await setTimer(setInput(cmd), { by: "cli", cwd: getProjectDir(), now });
			if (cmd.json) return (json(result), 0);
			out(await card(result.spec.id, now, result.replaced ? "re-armed" : "armed", result));
			return 0;
		}
		case "edit": {
			const id = requireId(cmd);
			const result = await editTimer(id, editInput(cmd.fields), { by: "cli", cwd: getProjectDir(), now });
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
			const runs = await timerRuns(requireId(cmd), { limit: cmd.limit });
			if (cmd.json) return (json(runs), 0);
			out(renderRuns(runs));
			return 0;
		}
		case "logs": {
			const id = requireId(cmd);
			const seq = cmd.extra[0] !== undefined ? Number(cmd.extra[0]) : undefined;
			if (seq !== undefined && !Number.isInteger(seq)) throw new UsageError("omp timer logs <id> [seq]");
			const log = await timerLog(id, seq);
			if (cmd.json) return (json(log ?? null), 0);
			if (!log) {
				out(
					`no run log for ${id}${seq !== undefined ? `#${seq}` : ""} (only shell, fresh and headless runs keep one)`,
				);
				return 0;
			}
			out(`${chalk.dim(`${log.runId} ${log.path}`)}\n${log.text.trimEnd()}`);
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
			const result = await installTicker(host, {
				ompCommand: resolveCliEntryCmd(),
				// The unit runs outside any login shell: bake in this shell's PATH (deduped) and the store it ticks.
				env: {
					PATH: [...new Set(($env.PATH ?? "/usr/bin:/bin").split(path.delimiter).filter(Boolean))].join(
						path.delimiter,
					),
					OMP_TIMERS_DIR: path.resolve(timersRoot()),
				},
				logPath: tickLogPath(),
			});
			if (cmd.json) return (json({ ...result, dryRun: cmd.dryRun, commands: host.commands }), result.ok ? 0 : 1);
			out(
				`${result.ok ? "installed" : "install failed:"} ${result.plan.kind} ticker${cmd.dryRun ? " (dry run: no launchctl/systemctl ran)" : ""}`,
			);
			for (const file of result.plan.files) out(`  wrote ${file.path}`);
			for (const run of result.results) {
				out(
					`  ${cmd.dryRun ? "would run" : "ran"} ${run.argv.join(" ")}${cmd.dryRun ? "" : ` → exit ${run.exitCode}`}${run.exitCode && run.stderr ? ` (${run.stderr.trim()})` : ""}`,
				);
			}
			return result.ok ? 0 : 1;
		}
		case "uninstall": {
			const host = createTimerHost({ dryRun: cmd.dryRun });
			const result = await uninstallTicker(host);
			if (cmd.json) return (json({ ...result, dryRun: cmd.dryRun }), 0);
			out(`uninstalled ${result.kind} ticker${cmd.dryRun ? " (dry run: no launchctl/systemctl ran)" : ""}`);
			for (const file of result.removed) out(`  removed ${file}`);
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

function fail(message: string): never {
	process.stderr.write(`${chalk.red(`error: ${message}`)}\n`);
	process.exit(1);
}

/** `omp poke <session> <message…>`: post a message into a session's mailbox. */
export async function runPokeCommand(sessionArg: string, text: string, from: string | undefined): Promise<void> {
	if (!sessionArg || !text.trim()) fail("usage: omp poke <session> <message>");
	const match = await resolveResumableSession(sessionArg, getProjectDir(), undefined, { allowGlobalFallback: true });
	if (!match) fail(`no session matches "${sessionArg}"`);
	const sessionId = match.session.id;
	await postMail({
		v: 1,
		id: newMailId("poke"),
		kind: "poke",
		sessionId,
		createdAt: new Date().toISOString(),
		poke: { text, from: from ?? `${os.userInfo().username}@${os.hostname()} (pid ${process.pid})` },
	});
	if (hasLiveMailboxConsumer(sessionId)) {
		out(`poked session ${sessionId}: a live omp holds it and will deliver now`);
	} else {
		out(`queued for session ${sessionId}: no live omp has it open; it is delivered when the session is next opened`);
	}
}
