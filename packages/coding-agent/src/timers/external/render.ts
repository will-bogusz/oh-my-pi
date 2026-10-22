import chalk from "@oh-my-pi/pi-utils/chalk";
import { formatDuration } from "../schedule";
import type { Estate } from "./estate";
import type { ExternalJob, ExternalSource, HealthFlag } from "./types";

const SOURCE_LABEL: Record<ExternalSource, string> = {
	"systemd-user": "systemd",
	"systemd-system": "systemd(sys)",
	launchd: "launchd",
	cron: "cron",
};

/** Flags that mean the job is not doing its work, as opposed to risk factors (`never-ran` may just be new). */
const ALARM: Partial<Record<HealthFlag, true>> = { failed: true, unarmed: true };

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function relative(iso: string | null, now: number, approx?: boolean): string {
	if (!iso) return "—";
	const delta = Date.parse(iso) - now;
	const text = delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
	return approx ? `~${text}` : text;
}

/** The `--all` section of `omp timer ls`: one row per external job, then where to look for the broken ones. */
export function renderEstate(estate: Estate, now: number): string {
	const lines: string[] = [];
	const header = ["HOST", "SOURCE", "ID", "SCHEDULE", "NEXT", "LAST", "RESULT", "FLAGS"];
	const body = estate.jobs.map(job => [
		job.host,
		SOURCE_LABEL[job.source],
		clip(job.id, 44),
		clip(job.schedule, 36),
		relative(job.next, now),
		relative(job.last, now, job.lastApprox),
		job.lastResult ?? "—",
		job.flags.join(",") || "ok",
	]);
	if (body.length) {
		const widths = header.map((h, i) => Math.max(h.length, ...body.map(cells => Bun.stringWidth(cells[i]))));
		const fmt = (cells: string[]): string =>
			cells
				.map((cell, i) => (i === cells.length - 1 ? cell : cell + " ".repeat(widths[i] - Bun.stringWidth(cell))))
				.join("  ");
		lines.push(chalk.bold(`external (${estate.jobs.length})`), fmt(header));
		estate.jobs.forEach((job, index) => {
			const row = fmt(body[index]);
			lines.push(job.flags.some(flag => ALARM[flag]) ? chalk.red(row) : row);
		});
	} else {
		lines.push("external: none found");
	}

	const broken = estate.jobs.filter(job => job.flags.some(flag => ALARM[flag] || flag === "source-in-scratch"));
	if (broken.length) lines.push("", chalk.bold("needs attention"));
	for (const job of broken) lines.push(describeBroken(job));

	for (const report of estate.hosts) {
		if (report.via === "ssh")
			lines.push(chalk.dim(`${report.host}: scanned over ssh (its omp has no \`timer ls --all\`)`));
		if (report.via === "omp" && report.timers?.length) {
			lines.push("", chalk.bold(`${report.host}: ${report.timers.length} omp timer(s)`));
			for (const timer of report.timers as Array<{ id?: string; status?: string; next?: string | null }>) {
				lines.push(`  ${timer.id ?? "?"}  ${timer.status ?? "?"}  next ${timer.next ?? "—"}`);
			}
		}
		for (const error of report.errors) lines.push(chalk.yellow(`${report.host}: ${error}`));
	}
	return lines.join("\n");
}

function describeBroken(job: ExternalJob): string {
	const what = job.flags.filter(flag => ALARM[flag] || flag === "source-in-scratch").join(", ");
	const detail = [
		job.lastResult && job.lastResult !== "success" ? `last ${job.lastResult}` : null,
		`state ${job.state}`,
		job.log ? `log ${job.log}` : null,
		job.sourcePath ? `source ${job.sourcePath}` : null,
	].filter(Boolean);
	return `  ${job.host} ${job.id}: ${what} · ${detail.join(" · ")}`;
}
