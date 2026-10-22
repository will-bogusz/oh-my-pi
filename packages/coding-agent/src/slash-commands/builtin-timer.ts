/**
 * `/timer` and `/timers`: the CLI's timer verbs from inside a session, plus
 * sugar that wakes the current session (`/timer in 2h <prompt>`,
 * `/timer at 8:00 <prompt>`, `/timer every 30m <prompt>`). `/timers` opens
 * the timers sheet in the TUI and lists them elsewhere.
 */
import { replaceTabs, shortenEmbeddedPaths, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import {
	renderTimerListLines,
	type TimerCardView,
	type TimerListRowView,
	timerCardComponent,
} from "@oh-my-pi/pi-tui/tools/timer";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	editTimer,
	fireTimerNow,
	hostTimeZone,
	listTimers,
	loadTimerRow,
	normalizeEvery,
	readTickerStatus,
	removeTimer,
	renderRuns,
	renderTimerCard,
	renderTimerTable,
	requireTimer,
	resolveAt,
	setPaused,
	setTimer,
	type TimerEditInput,
	type TimerSetInput,
	timerRuns,
} from "../timers";
import { readShellWord } from "../tools/shell-tokenize";
import { readTimerRunLog, timerCardView, timerListRowView } from "../tools/timer-view";
import type { AgentSession } from "../session/agent-session";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandRuntime, SlashCommandSpec } from "./types";

const TIMER_USAGE =
	"Usage: /timer [in <dur>|at <time>|every <cadence>] <prompt> · /timer ls|show|runs|logs|fire|pause|resume|rm <id> · /timer set [<id>] --reason … --at|--every|--until|--ci|--pid … --prompt|--shell … · /timer edit <id> --<field> <value|none> …";

/** What a `/timer` invocation produced: model-free text, plus the structured view the TUI draws. */
export interface TimerSlashResult {
	text: string;
	card?: TimerCardView;
	rows?: TimerListRowView[];
	failed?: boolean;
}

/** Flags `/timer set` accepts, mapped onto {@link TimerSetInput}; same spelling as `omp timer set`. */
const SET_FLAGS: Record<string, (input: TimerSetInput, value: string) => void> = {
	reason: (input, value) => {
		input.reason = value;
	},
	title: (input, value) => {
		input.title = value;
	},
	at: (input, value) => {
		input.at = value;
	},
	every: (input, value) => {
		input.every = value;
	},
	until: (input, value) => {
		input.when = { ...input.when, cmd: value };
	},
	ci: (input, value) => {
		input.when = { ...input.when, ci: value };
	},
	pid: (input, value) => {
		input.when = { ...input.when, pid: Number(value) };
	},
	prompt: (input, value) => {
		input.prompt = value;
	},
	shell: (input, value) => {
		input.shell = value;
	},
	session: (input, value) => {
		input.session = value;
	},
	"when-closed": (input, value) => {
		if (value !== "resume" && value !== "hold") throw new Error("--when-closed takes resume or hold");
		input.whenClosed = value;
	},
	tz: (input, value) => {
		input.tz = value;
	},
	cwd: (input, value) => {
		input.cwd = value;
	},
	expires: (input, value) => {
		input.expires = value;
	},
	"max-runs": (input, value) => {
		input.maxRuns = Number(value);
	},
	model: (input, value) => {
		input.model = value;
	},
};

/** Parse `[<id>] --flag value …` (shell quoting) into a set request. */
export function parseTimerSetArgs(text: string): TimerSetInput {
	const words: string[] = [];
	let rest = text;
	for (let word = readShellWord(rest); word !== undefined; word = readShellWord(rest)) {
		if (word === "unterminated") throw new Error("Unterminated quote in /timer set");
		words.push(word.value);
		rest = word.rest;
	}
	const input: TimerSetInput = { reason: "" };
	for (let i = 0; i < words.length; i++) {
		const word = words[i]!;
		if (!word.startsWith("--")) {
			if (input.id !== undefined) throw new Error(`Unexpected argument "${word}"; flags take one value each`);
			input.id = word;
			continue;
		}
		const eq = word.indexOf("=");
		const name = eq === -1 ? word.slice(2) : word.slice(2, eq);
		const apply = SET_FLAGS[name];
		if (!apply) throw new Error(`Unknown flag --${name}`);
		const value = eq === -1 ? words[++i] : word.slice(eq + 1);
		if (value === undefined) throw new Error(`--${name} needs a value`);
		apply(input, value);
	}
	return input;
}

const clearable = (value: string | undefined): string | null | undefined =>
	value === "none" || value === "never" ? null : value;

/** Parse `<id> --flag value …` into an edit: only the given fields change; `none` clears at/every/until/expires. */
export function parseTimerEditArgs(text: string): { id: string; patch: TimerEditInput } {
	const input = parseTimerSetArgs(text);
	if (!input.id) throw new Error("/timer edit needs a timer id");
	if (input.session !== undefined) throw new Error("/timer edit cannot change --session; set the timer again");
	const patch: TimerEditInput = {
		title: input.title,
		reason: input.reason || undefined,
		at: clearable(input.at),
		every: clearable(input.every),
		when: input.when?.cmd === "none" ? null : input.when,
		tz: input.tz,
		prompt: input.prompt,
		shell: input.shell,
		whenClosed: input.whenClosed,
		cwd: input.cwd,
		expires: clearable(input.expires),
		maxRuns: input.maxRuns,
		model: input.model,
	};
	if (Object.values(patch).every(value => value === undefined)) throw new Error("/timer edit: nothing to change");
	return { id: input.id, patch };
}

/** Longest schedule prefix `parse` accepts, out of the first `widths` word counts. */
function takeSchedule(
	words: readonly string[],
	widths: readonly number[],
	parse: (text: string) => void,
): { schedule: string; rest: string } | undefined {
	for (const width of widths) {
		if (words.length <= width) continue;
		const schedule = words.slice(0, width).join(" ");
		try {
			parse(schedule);
		} catch {
			continue;
		}
		return { schedule, rest: words.slice(width).join(" ") };
	}
	return undefined;
}

/**
 * `in 2h <prompt>`, `at 8:00 <prompt>`, `every 30m <prompt>` as a wake of
 * the current session; undefined when `args` is not sugar. The prompt, as
 * typed, is also the reason, so the derived id reads as the work, not the schedule.
 */
export function parseTimerSugar(args: string, now = Date.now()): TimerSetInput | undefined {
	const [head, ...words] = args.trim().split(/\s+/);
	const keyword = head?.toLowerCase();
	const tz = hostTimeZone();
	let taken: { schedule: string; rest: string } | undefined;
	let input: Pick<TimerSetInput, "at" | "every"> = {};
	if (keyword === "in") {
		taken = takeSchedule(words, [1], text => resolveAt(`in ${text}`, now, tz));
		if (taken) input = { at: `in ${taken.schedule}` };
	} else if (keyword === "at") {
		taken = takeSchedule(words, [2, 1], text => resolveAt(text, now, tz));
		if (taken) input = { at: taken.schedule };
	} else if (keyword === "every") {
		taken = takeSchedule(words, [5, 2, 1], text => normalizeEvery(text));
		if (taken) input = { every: taken.schedule };
	}
	if (!taken?.rest.trim()) return undefined;
	return { ...input, prompt: taken.rest, reason: taken.rest };
}

async function cardResult(
	id: string,
	verb: string,
	sessionId: string | undefined,
	gate?: { gateNow?: "met" | "not-yet" | "broken"; gateDetail?: string },
): Promise<TimerSlashResult> {
	const now = Date.now();
	const row = await loadTimerRow(await requireTimer(id), now);
	const ticker = await readTickerStatus();
	return {
		text: renderTimerCard(row, now, { verb, selfSessionId: sessionId, ticker, ...gate }),
		card: timerCardView(row, { verb, selfSessionId: sessionId, ticker, now, ...gate }),
	};
}

/** Run one `/timer` invocation against the timer store. Throws on invalid input. */
export async function runTimerSlash(args: string, session: AgentSession, cwd: string): Promise<TimerSlashResult> {
	const sessionId = session.sessionManager.getSessionId() ?? undefined;
	const sessionFile = session.sessionManager.getSessionFile();
	const setContext = { by: "cli" as const, cwd, sessionId, sessionFile };
	const set = async (input: TimerSetInput): Promise<TimerSlashResult> => {
		const result = await setTimer({ ...input, session: input.session ?? "origin" }, setContext);
		return cardResult(result.spec.id, result.replaced ? "re-armed" : "armed", sessionId, result);
	};
	const sugar = parseTimerSugar(args);
	if (sugar) return set(sugar);
	const { verb, rest } = parseSubcommand(args);
	const [id = "", ...extra] = rest.split(/\s+/).filter(Boolean);
	const needId = (): string => {
		if (!id) throw new Error(`/timer ${verb} needs a timer id`);
		return id;
	};
	switch (verb) {
		case "":
		case "ls":
		case "list": {
			const now = Date.now();
			const { rows, errors } = await listTimers(now);
			const ticker = await readTickerStatus();
			const lines = [rows.length > 0 ? renderTimerTable(rows, now, ticker) : "no timers"];
			for (const error of errors) lines.push(`invalid spec ${error.id}: ${error.error}`);
			return { text: lines.join("\n"), rows: rows.map(row => timerListRowView(row, now)) };
		}
		case "set":
			return set(parseTimerSetArgs(rest));
		case "edit": {
			const { id: target, patch } = parseTimerEditArgs(rest);
			const result = await editTimer(target, patch, setContext);
			return cardResult(target, result.rearmed ? "re-armed" : "edited", sessionId, result);
		}
		case "show":
			return cardResult(needId(), "", sessionId);
		case "runs":
			return { text: renderRuns(await timerRuns(needId())) };
		case "logs": {
			const seq = extra[0] === undefined ? undefined : Number(extra[0]);
			if (seq !== undefined && !Number.isInteger(seq)) throw new Error(`Invalid run number "${extra[0]}"`);
			return { text: await readTimerRunLog(needId(), seq) };
		}
		case "fire": {
			const data = rest.trim().slice(id.length).trim();
			const line = await fireTimerNow(needId(), Date.now(), { data: data || undefined });
			return {
				text: `timer ${line.id} ${line.action}${line.runId ? ` (${line.runId})` : ""}${line.detail ? `: ${line.detail}` : ""}`,
			};
		}
		case "pause":
		case "resume":
			await setPaused(needId(), verb === "pause");
			return cardResult(id, verb === "pause" ? "paused" : "resumed", sessionId);
		case "rm":
		case "remove":
			if (!(await removeTimer(needId()))) throw new Error(`No timer "${id}"`);
			return { text: `timer ${id} removed (run history kept)` };
		default:
			return { text: TIMER_USAGE, failed: true };
	}
}

/** A report body fitted to the report's width: the listing, or plain text (runs, logs) sanitized line by line. */
function reportBody(result: TimerSlashResult): Component {
	const lines = result.rows ? undefined : shortenEmbeddedPaths(replaceTabs(sanitizeText(result.text))).split("\n");
	return {
		render: width =>
			result.rows
				? renderTimerListLines(result.rows, theme, width, result.rows.length)
				: (lines ?? []).map(line => truncateToWidth(line, width)),
		invalidate: () => {},
	};
}

async function handleText(args: string, runtime: SlashCommandRuntime) {
	try {
		const result = await runTimerSlash(args, runtime.session, runtime.cwd);
		if (result.failed) return usage(result.text, runtime);
		await runtime.output(result.text);
		return commandConsumed();
	} catch (error) {
		return usage(error instanceof Error ? error.message : String(error), runtime);
	}
}

const TIMER_SUBCOMMANDS = [
	{ name: "in", description: "Wake this session after a delay", usage: "<dur> <prompt>" },
	{ name: "at", description: "Wake this session at a clock time", usage: "<time> <prompt>" },
	{ name: "every", description: "Wake this session on a schedule", usage: "<cadence> <prompt>" },
	{ name: "ls", description: "List timers" },
	{ name: "show", description: "Show a timer's card", usage: "<id>" },
	{ name: "runs", description: "Show a timer's run history", usage: "<id>" },
	{ name: "logs", description: "Show a run's log (newest by default)", usage: "<id> [seq]" },
	{ name: "fire", description: "Run a timer now", usage: "<id> [data]" },
	{ name: "pause", description: "Pause a timer", usage: "<id>" },
	{ name: "resume", description: "Resume a paused timer", usage: "<id>" },
	{ name: "rm", description: "Remove a timer (run history kept)", usage: "<id>" },
	{
		name: "set",
		description: "Set a timer with omp timer set flags",
		usage: "[<id>] --reason … --every|--at … --prompt …",
	},
	{
		name: "edit",
		description: "Change some fields of a timer (none clears at/every/until/expires)",
		usage: "<id> --<field> <value> …",
	},
];

export const BUILTIN_TIMER_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "timer",
		icon: "timer",
		description: "Set and control timers (/timer in 2h <prompt> wakes this session)",
		acpDescription: "Set and control timers",
		acpInputHint:
			"[in <dur>|at <time>|every <cadence>] <prompt> | ls|show|runs|logs|fire|pause|resume|rm <id> | edit <id> --<field> …",
		subcommands: TIMER_SUBCOMMANDS,
		subcommandOptional: true,
		allowArgs: true,
		handle: (command, runtime) => handleText(command.args, runtime),
		handleTui: async (command, runtime) => {
			const { ctx } = runtime;
			clearSubmittedText(runtime);
			try {
				const result = await runTimerSlash(command.args, ctx.session, ctx.sessionManager.getCwd());
				ctx.refreshTimerPill();
				if (result.failed) {
					ctx.showStatus(result.text);
				} else {
					const body = result.card ? timerCardComponent(result.card, theme, true) : reportBody(result);
					ctx.showCommandReport({ title: result.rows ? "Timers" : "Timer", body });
				}
			} catch (error) {
				ctx.showError(error instanceof Error ? error.message : String(error));
			}
		},
	},
	{
		name: "timers",
		icon: "timer",
		description: "Open the timers sheet: show, fire, pause, resume, remove, logs",
		acpDescription: "List timers",
		allowArgs: false,
		handle: (_command, runtime) => handleText("ls", runtime),
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			runtime.ctx.showTimersSheet();
		},
	},
];
