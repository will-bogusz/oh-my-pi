/** The invoking user's crontab (`crontab -l`), one row per schedule line. */
import { flagsFrom, inScratch, isoFromMs, nextCron, programPaths } from "./common";
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

/** Parses crontab text into rows; `MAILTO=` (non-empty) counts as a failure alert for the lines after it. */
export function parseCrontab(text: string, host: string, now: number): ExternalJob[] {
	const jobs: ExternalJob[] = [];
	let mailto = true; // cron mails output to the owner by default
	text.split("\n").forEach((raw, index) => {
		const line = raw.trim();
		if (!line || line.startsWith("#")) return;
		const env = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (env) {
			if (env[1] === "MAILTO") mailto = env[2].replace(/^["']|["']$/g, "") !== "";
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
		// Output redirected to a file is the only log cron keeps; `>/dev/null 2>&1` also discards the mail.
		const redirect = /(?:^|\s)\d?>>?\s*(\S+)/.exec(command)?.[1] ?? null;
		const discarded = redirect === "/dev/null" && /2>&1|2>\s*\/dev\/null/.test(command);
		const next = expression ? nextCron(expression, now) : null;
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
			log: redirect && redirect !== "/dev/null" ? redirect : null,
			flags: flagsFrom([
				["unarmed", expression !== null && next === null],
				["no-failure-alert", !mailto || discarded],
				["source-in-scratch", inScratch(...programPaths(command.split(/\s+/)))],
			]),
		});
	});
	return jobs;
}

export async function scanCrontab(run: CommandRunner, host: string, now: number): Promise<ExternalJob[]> {
	const result = await run(["crontab", "-l"]);
	// `crontab -l` exits 1 with "no crontab for <user>" when there is none.
	if (result.code !== 0) {
		if (/no crontab/i.test(result.stderr)) return [];
		throw new Error(`crontab -l failed: ${result.stderr.trim() || result.code}`);
	}
	return parseCrontab(result.stdout, host, now);
}
