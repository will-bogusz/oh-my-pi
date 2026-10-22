import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { TimerToolDetails } from "@oh-my-pi/pi-tui/tools/timer";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import timerDescription from "../prompts/tools/timer.md" with { type: "text" };
import {
	editTimer,
	fireTimerNow,
	listTimers,
	loadTimerRow,
	readTickerStatus,
	removeTimer,
	renderRuns,
	renderTimerCard,
	renderTimerTable,
	requireTimer,
	setPaused,
	setTimer,
	timerRuns,
} from "../timers";
import type { ToolSession } from ".";
import {
	lastRunResult,
	runResults,
	timerArgsTier,
	timerCardView,
	timerEditPatch,
	timerListRowView,
} from "./timer-view";
import { toolResult } from "./tool-result";

const TimerOp = type('"set" | "edit" | "list" | "show" | "runs" | "remove" | "fire" | "pause" | "resume"');

const timerSchema = type({
	op: TimerOp.describe(
		"set: create, or replace an existing id (needs reason, one of at/every/when, one of prompt/shell). edit: change only the given fields of an existing id; a new at/every/when replaces its schedule. list/show/runs: inspect. fire: run now. pause/resume/remove: control (need id).",
	),
	"id?": type("string").describe("timer id ([a-z0-9][a-z0-9._-]*); optional for set (derived from reason)"),
	"reason?": type("string").describe("REQUIRED for set: why this timer exists, in the user's terms"),
	"at?": type("string").describe("one-shot: 'now', 'in 2h', '08:00' (next occurrence), '2026-10-22 08:00', or ISO"),
	"every?": type("string").describe("recurring: '15m', '2h', 'daily 09:00', or a 5-field cron"),
	"when?": type({
		"cmd?": type("string").describe("shell check: exit 0 = fire, 1 = not yet, anything else = failure"),
		"ci?": type("string").describe(
			"PR ('owner/repo#123' or URL) or commit ('owner/repo@sha'): fires once every check finished, pass or fail",
		),
		"pid?": type("number").describe("fires once this process exits"),
	}).describe("condition checked each minute without model tokens; fires once when it holds. Exactly one key"),
	"prompt?": type("string").describe(
		"set needs exactly one of prompt or shell: self-contained instruction delivered when it fires",
	),
	"shell?": type("string").describe("command to run instead of a prompt"),
	"session?": type("string").describe(
		"where a prompt runs: 'origin' (default, this conversation), 'fresh' (new session per run), 'own' (one session the timer keeps), or a session id",
	),
	"whenClosed?": type('"resume" | "hold"').describe(
		"target session not open when it fires: resume it headless (default) or hold the message until it opens",
	),
	"tz?": type("string").describe("IANA zone for clock times; default this machine's"),
	"cwd?": type("string").describe("working directory, or 'run' for a fresh dir per run; default this session's"),
	"expires?": type("string").describe("'7d', a date, or 'never'"),
	"maxRuns?": type("number").describe("retire after this many runs"),
	"model?": type("string").describe("model for fresh/own runs"),
	"agent?": type("string").describe("fresh/own: agent profile to run as"),
	"thinking?": type("string").describe("fresh/own: thinking level"),
	"hermetic?": type("boolean").describe("fresh/own: no rules, skills or extensions"),
	"maxTime?": type("string").describe("fresh/own: abort past this duration, e.g. '20m'"),
	"maxCost?": type("number").describe("fresh/own: abort past this many USD"),
	"expect?": type("string[]").describe("fresh/own: paths that must exist after the run"),
	"before?": type("string").describe("fresh/own: shell run first; non-zero exit fails the run"),
	"after?": type("string").describe("fresh/own: shell run after, with OMP_TIMER_RESULT"),
	"report?": type('"always" | "said" | "failure" | "never"').describe(
		"fresh/own: which runs report back (default said: not [quiet])",
	),
});

type TimerParams = typeof timerSchema.infer;

export class TimerTool implements AgentTool<typeof timerSchema, TimerToolDetails> {
	readonly name = "timer";
	readonly label = "Timer";
	readonly summary =
		"Set, list and control timers that wake this session later, on a schedule, or when a condition holds";
	readonly description = prompt.render(timerDescription);
	readonly parameters = timerSchema;
	readonly strict = true;
	/**
	 * list/show/runs are read. set/edit/fire/pause/resume/remove are write while
	 * they wake this conversation, exec for a shell command, a fresh agent,
	 * another session's timer or target (see {@link timerArgsTier}).
	 */
	readonly approval = (args: unknown): ToolApprovalDecision =>
		timerArgsTier((args ?? {}) as Partial<TimerParams>, this.session.getSessionId?.() ?? undefined);
	readonly loadMode = "essential";
	readonly intent = (args: Partial<TimerParams>) =>
		args.op ? `timer ${args.op}${args.id ? ` ${args.id}` : ""}` : "timer";

	constructor(private readonly session: ToolSession) {}

	/** Timers target resumable sessions; subagents cannot be resumed headless. */
	static createIf(session: ToolSession): TimerTool | null {
		return (session.taskDepth ?? 0) === 0 ? new TimerTool(session) : null;
	}

	async execute(_toolCallId: string, params: TimerParams): Promise<AgentToolResult<TimerToolDetails>> {
		const now = Date.now();
		const sessionId = this.session.getSessionId?.() ?? undefined;
		const details: TimerToolDetails = { op: params.op, id: params.id };
		const requireId = (): string => {
			if (!params.id) throw new ToolError(`op "${params.op}" needs id`);
			return params.id;
		};
		/** The stored record as the model's text card and the transcript's card. */
		const card = async (
			id: string,
			verb: string,
			gate?: { gateNow?: "met" | "not-yet" | "broken"; gateDetail?: string },
		): Promise<AgentToolResult<TimerToolDetails>> => {
			const row = await loadTimerRow(await requireTimer(id), now);
			const [ticker, lastResult] = await Promise.all([readTickerStatus(), lastRunResult(row)]);
			details.id = id;
			details.card = timerCardView(row, { verb, selfSessionId: sessionId, ticker, now, lastResult, ...gate });
			const text = renderTimerCard(row, now, { verb, selfSessionId: sessionId, ticker, lastResult, ...gate });
			return toolResult<TimerToolDetails>(details).text(text).done();
		};
		try {
			switch (params.op) {
				case "set": {
					const result = await setTimer(
						{
							id: params.id,
							reason: params.reason ?? "",
							at: params.at,
							every: params.every,
							when: params.when,
							tz: params.tz,
							prompt: params.prompt,
							shell: params.shell,
							session: params.session,
							whenClosed: params.whenClosed,
							cwd: params.cwd,
							expires: params.expires,
							maxRuns: params.maxRuns,
							model: params.model,
							agent: params.agent,
							thinking: params.thinking,
							hermetic: params.hermetic,
							maxTime: params.maxTime,
							maxCost: params.maxCost,
							expect: params.expect,
							before: params.before,
							after: params.after,
							report: params.report,
						},
						{
							by: "tool",
							cwd: this.session.cwd,
							sessionId,
							sessionFile: this.session.getSessionFile() ?? undefined,
							now,
						},
					);
					return await card(result.spec.id, result.replaced ? "re-armed" : "armed", result);
				}
				case "edit": {
					const { op: _op, id: _id, ...fields } = params;
					const id = requireId();
					const result = await editTimer(id, timerEditPatch(fields), {
						by: "tool",
						cwd: this.session.cwd,
						sessionId,
						sessionFile: this.session.getSessionFile() ?? undefined,
						now,
					});
					return await card(id, result.rearmed ? "re-armed" : "edited", result);
				}
				case "list": {
					const { rows, errors } = await listTimers(now);
					const ticker = await readTickerStatus();
					details.rows = rows.map(row => timerListRowView(row, now));
					const lines = [rows.length ? renderTimerTable(rows, now, ticker) : "no timers"];
					for (const { id, error } of errors) lines.push(`invalid spec ${id}: ${error}`);
					return toolResult<TimerToolDetails>(details).text(lines.join("\n")).done();
				}
				case "show":
					return await card(requireId(), "");
				case "runs": {
					const id = requireId();
					const runs = await timerRuns(id);
					return toolResult<TimerToolDetails>(details)
						.text(renderRuns(runs, await runResults(id, runs)))
						.done();
				}
				case "pause":
				case "resume": {
					const id = requireId();
					await setPaused(id, params.op === "pause");
					return await card(id, params.op === "pause" ? "paused" : "resumed");
				}
				case "remove": {
					const id = requireId();
					if (!(await removeTimer(id))) throw new ToolError(`No timer "${id}"`);
					return toolResult<TimerToolDetails>(details).text(`timer ${id} removed (run history kept)`).done();
				}
				case "fire": {
					const line = await fireTimerNow(requireId(), now);
					return toolResult<TimerToolDetails>(details)
						.text(
							`timer ${line.id} ${line.action}${line.runId ? ` (${line.runId})` : ""}${line.detail ? `: ${line.detail}` : ""}`,
						)
						.done();
				}
			}
		} catch (error) {
			if (error instanceof ToolError) throw error;
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
	}
}
