/** The invoking user's crontab (`crontab -l`), one row per schedule line. */
import { flagsFrom, isoFromMs, isTimeZone, nextCron, stdoutOf } from "./common";
import type { CommandRunner, ExternalJob } from "./types";

const NICKNAMES: Record<string, string | null> = {
	"@yearly": "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
	"@monthly": "0 0 1 * *",
	"@weekly": "0 0 * * 0",
	"@daily": "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@hourly": "0 * * * *",
	"@reboot": null,
};

/** How the host's cron reads schedule times. */
export interface CronClock {
	/** The host's zone; null when it could not be read, so no next run is computed. */
	timeZone: string | null;
	/** The daemon honours `CRON_TZ=` lines (cronie); elsewhere next runs after one are unknown. */
	cronTz: boolean;
}

type Stream = "cron" | "file" | "null";

type Token = { word: string } | { fd: number | null; op: string };

/**
 * Words and redirections of a command line; `compound` is set by pipes, lists and background jobs, whose
 * streams this reading does not follow. Null for substitutions and unbalanced quotes.
 */
function shellTokens(command: string): { tokens: Token[]; compound: boolean } | null {
	const tokens: Token[] = [];
	let compound = false;
	let word = "";
	let inWord = false;
	let quoted = false;
	const flush = () => {
		if (inWord) tokens.push({ word });
		word = "";
		inWord = false;
		quoted = false;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (c === "`" || (c === "$" && command[i + 1] === "(")) return null;
		if (c === "\\") {
			word += command[i + 1] ?? "";
			i++;
			inWord = true;
			quoted = true;
		} else if (c === "'" || c === '"') {
			const end = command.indexOf(c, i + 1);
			if (end < 0) return null;
			word += command.slice(i + 1, end);
			i = end;
			inWord = true;
			quoted = true;
		} else if (/\s/.test(c)) {
			flush();
		} else if (c === "#" && !inWord) {
			break;
		} else if (c === ">" || c === "<") {
			const fd = inWord && !quoted && /^\d+$/.test(word) ? Number(word) : null;
			if (fd === null) flush();
			else {
				word = "";
				inWord = false;
			}
			const next = command[i + 1];
			const op = next === ">" || next === "&" || next === "|" || (c === "<" && next === "<") ? c + next : c;
			if (op === "<<") return null;
			i += op.length - 1;
			tokens.push({ fd, op });
		} else if (c === "|" || c === ";" || c === "&" || c === "(" || c === ")") {
			flush();
			compound = true;
		} else {
			word += c;
			inWord = true;
		}
	}
	flush();
	return { tokens, compound };
}

/**
 * Whether a crontab command's stdout or stderr still reaches cron (which mails it), from its redirections in
 * order (`2>&1 >/dev/null` keeps stderr), and the first file it writes to. `reachesCron` is null when the line is
 * a pipeline, list or substitution whose streams this reading cannot follow.
 */
export function cronOutput(command: string): { reachesCron: boolean | null; log: string | null } {
	const parsed = shellTokens(command);
	if (!parsed) return { reachesCron: null, log: null };
	const streams: Record<1 | 2, Stream> = { 1: "cron", 2: "cron" };
	let log: string | null = null;
	let followed = !parsed.compound;
	for (let i = 0; i < parsed.tokens.length; i++) {
		const token = parsed.tokens[i];
		if ("word" in token) continue;
		const target = parsed.tokens[i + 1];
		if (!target || !("word" in target)) return { reachesCron: null, log };
		i++;
		const fd = token.fd ?? (token.op.startsWith("<") ? 0 : 1);
		if (fd !== 1 && fd !== 2) continue;
		if (token.op === ">&" || token.op === "<&") {
			if (target.word === "1" || target.word === "2") streams[fd] = streams[target.word === "1" ? 1 : 2];
			else if (target.word === "-") streams[fd] = "null";
			else followed = false;
		} else if (token.op.startsWith("<")) {
			followed = false;
		} else if (/^\/dev\/(?:stdout|fd\/1)$/.test(target.word)) {
			streams[fd] = streams[1];
		} else if (/^\/dev\/(?:stderr|fd\/2)$/.test(target.word)) {
			streams[fd] = streams[2];
		} else if (target.word === "/dev/null") {
			streams[fd] = "null";
		} else {
			streams[fd] = "file";
			log ??= target.word;
		}
	}
	return { reachesCron: followed ? streams[1] === "cron" || streams[2] === "cron" : null, log };
}

/** The command part of a crontab line: cron turns the first unescaped `%` into a newline and feeds the rest to stdin. */
function cronCommand(text: string): string {
	const percent = /(?<!\\)%/.exec(text);
	return (percent ? text.slice(0, percent.index) : text).replaceAll("\\%", "%");
}

/**
 * Parses crontab text into rows. cron mails a job's output (to the owner, or `MAILTO=`), so a line has a
 * failure alert only while `MAILTO` is not empty and some of its output provably still reaches cron.
 */
export function parseCrontab(text: string, host: string, now: number, clock: CronClock): ExternalJob[] {
	const jobs: ExternalJob[] = [];
	let mailto = true; // cron mails output to the owner by default
	let timeZone = clock.timeZone;
	text.split("\n").forEach((raw, index) => {
		const line = raw.trim();
		if (!line || line.startsWith("#")) return;
		const env = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (env) {
			const value = env[2].replace(/^["']|["']$/g, "");
			if (env[1] === "MAILTO") mailto = value !== "";
			if (env[1] === "CRON_TZ") {
				timeZone = !clock.cronTz ? null : value === "" ? clock.timeZone : isTimeZone(value) ? value : null;
			}
			return;
		}
		let schedule: string;
		let expression: string | null;
		let command: string;
		if (line.startsWith("@")) {
			const [nickname, ...rest] = line.split(/\s+/);
			if (!(nickname in NICKNAMES)) return;
			schedule = nickname;
			expression = NICKNAMES[nickname];
			command = rest.join(" ");
		} else {
			const fields = line.split(/\s+/);
			if (fields.length < 6) return;
			expression = fields.slice(0, 5).join(" ");
			schedule = expression;
			command = fields.slice(5).join(" ");
		}
		const output = cronOutput(cronCommand(command));
		const next = expression && timeZone ? nextCron(expression, now, timeZone) : null;
		jobs.push({
			host,
			source: "cron",
			kind: "cron",
			id: `crontab:${index + 1}`,
			description: /\s#\s*(.+)$/.exec(command)?.[1] ?? null,
			schedule,
			next: isoFromMs(next),
			last: null,
			lastResult: null,
			state: "installed",
			command,
			sourcePath: "crontab -l",
			log: output.log,
			flags: flagsFrom([
				// Without a known zone the next run is unknown, not absent.
				["unarmed", expression !== null && timeZone !== null && next === null],
				["no-failure-alert", !mailto || output.reachesCron !== true],
			]),
		});
	});
	return jobs;
}

export async function scanCrontab(
	run: CommandRunner,
	host: string,
	now: number,
	timeZone: string | null,
): Promise<ExternalJob[]> {
	const result = await run(["crontab", "-l"]);
	// `crontab -l` exits 1 with "no crontab for <user>" when there is none.
	if (result.code !== 0 && /no crontab/i.test(result.stderr)) return [];
	const text = stdoutOf(result, "crontab -l");
	// Only cronie schedules by `CRON_TZ=`; `crontab -V` names it there and is an unknown option elsewhere.
	let cronTz = false;
	if (/^\s*CRON_TZ\s*=/m.test(text)) {
		const version = await run(["crontab", "-V"]);
		cronTz = version.code === 0 && /cronie/i.test(version.stdout + version.stderr);
	}
	return parseCrontab(text, host, now, { timeZone, cronTz });
}
