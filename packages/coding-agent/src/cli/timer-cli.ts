/**
 * `omp timer …` and `omp poke …`: out-of-session surfaces over the timer store.
 * Standalone commands (no TUI), so they write to stdout/stderr directly.
 */
import * as os from "node:os";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { resolveResumableSession } from "../session/session-listing";
import {
	execTimerRun,
	fireTimerNow,
	hasLiveMailboxConsumer,
	listTimers,
	loadTimerRow,
	newMailId,
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
	type TimerSetInput,
	timerRuns,
} from "../timers";
import { renderEstate, scanEstate } from "../timers/external";

export const TIMER_ACTIONS = ["set", "ls", "show", "runs", "rm", "pause", "resume", "fire", "tick", "exec"] as const;
export type TimerAction = (typeof TIMER_ACTIONS)[number];

export interface TimerCommandArgs {
	action: TimerAction;
	id?: string;
	extra: string[];
	json: boolean;
	/** ls: also list external systemd/launchd/cron jobs (`--all`) on this host and `--host` hosts. */
	all?: boolean;
	hosts?: string[];
	set: Omit<TimerSetInput, "id" | "reason"> & { reason?: string };
}

function fail(message: string): never {
	process.stderr.write(`${chalk.red(`error: ${message}`)}\n`);
	process.exit(1);
}

function out(text: string): void {
	process.stdout.write(`${text}\n`);
}

function requireId(cmd: TimerCommandArgs): string {
	if (!cmd.id) fail(`omp timer ${cmd.action} needs a timer id`);
	return cmd.id;
}

export async function runTimerCommand(cmd: TimerCommandArgs): Promise<void> {
	const now = Date.now();
	try {
		switch (cmd.action) {
			case "set": {
				const result = await setTimer(
					{ ...cmd.set, id: cmd.id, reason: cmd.set.reason ?? "" },
					{ by: "cli", cwd: getProjectDir(), now },
				);
				if (cmd.json) return out(JSON.stringify(result.spec, null, 2));
				const row = await loadTimerRow(result.spec, now);
				return out(
					renderTimerCard(row, now, {
						verb: result.replaced ? "re-armed" : "armed",
						ticker: await readTickerStatus(),
						gateNow: result.gateNow,
						gateDetail: result.gateDetail,
					}),
				);
			}
			case "ls": {
				const { rows, errors } = await listTimers(now);
				const ticker = await readTickerStatus();
				const estate = cmd.all || cmd.hosts?.length ? await scanEstate({ hosts: cmd.hosts ?? [], now }) : undefined;
				if (cmd.json) {
					return out(
						JSON.stringify(
							{
								ticker,
								timers: rows.map(row => ({
									id: row.spec.id,
									status: row.status,
									next: typeof row.next === "number" ? new Date(row.next).toISOString() : (row.next ?? null),
									last: row.lastRun ?? null,
									origin: row.spec.created.session ?? null,
									target: row.spec.target,
									reason: row.spec.reason,
									spec: row.spec,
									state: row.state,
								})),
								errors,
								...(estate ? { external: estate.jobs, hosts: estate.hosts } : {}),
							},
							null,
							2,
						),
					);
				}
				out(rows.length ? renderTimerTable(rows, now, ticker) : "no timers");
				for (const { id, error } of errors) out(chalk.yellow(`invalid spec ${id}: ${error}`));
				if (estate) out(`\n${renderEstate(estate, now)}`);
				return;
			}
			case "show": {
				const row = await loadTimerRow(await requireTimer(requireId(cmd)), now);
				if (cmd.json) return out(JSON.stringify(row, null, 2));
				return out(renderTimerCard(row, now, { verb: "", ticker: await readTickerStatus() }));
			}
			case "runs": {
				const runs = await timerRuns(requireId(cmd));
				return out(cmd.json ? JSON.stringify(runs, null, 2) : renderRuns(runs));
			}
			case "rm": {
				const id = requireId(cmd);
				if (!(await removeTimer(id))) fail(`no timer "${id}"`);
				return out(`timer ${id} removed (run history kept)`);
			}
			case "pause":
			case "resume": {
				const id = requireId(cmd);
				await setPaused(id, cmd.action === "pause");
				return out(`timer ${id} ${cmd.action === "pause" ? "paused" : "resumed"}`);
			}
			case "fire": {
				const line = await fireTimerNow(requireId(cmd), now);
				return out(
					cmd.json
						? JSON.stringify(line)
						: `${line.id} ${line.action} ${line.runId ?? ""} ${line.detail ?? ""}`.trim(),
				);
			}
			case "tick": {
				const report = await runTick(now);
				if (cmd.json) return out(JSON.stringify(report));
				if (report.locked) return out(`${report.at} another tick holds the lock; skipped`);
				out(`${report.at} tick: ${report.lines.length} action(s)`);
				for (const line of report.lines) {
					out(
						`  ${line.id} ${line.action}${line.runId ? ` ${line.runId}` : ""}${line.detail ? ` — ${line.detail}` : ""}`,
					);
				}
				return;
			}
			case "exec": {
				const seq = Number(cmd.extra[0]);
				if (!Number.isInteger(seq)) fail("omp timer exec <id> <seq>");
				const result = await execTimerRun(requireId(cmd), seq);
				process.exit(result.ok ? 0 : 1);
			}
		}
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
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
