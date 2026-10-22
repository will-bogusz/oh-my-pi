/**
 * `result.json` of an agent run (fresh/own session): written once by the
 * runner when the run ends (and rewritten after the `after` hook and the
 * report), read by `omp timer runs/logs`, `timer://<id>/runs/<seq>`, the
 * `/timers` sheet and the `timer` tool.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { runResultPath, timersRoot } from "./paths";
import { formatDuration } from "./schedule";
import type { TimerRow } from "./service";
import type { RunView } from "./store";
import type { AgentRunResult } from "./types";

export async function writeRunResult(result: AgentRunResult, root = timersRoot()): Promise<string> {
	const file = path.resolve(runResultPath(result.timerId, result.seq, root));
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await Bun.write(tmp, `${JSON.stringify(result, null, 2)}\n`);
	await fs.rename(tmp, file);
	return file;
}

/** The run's result, or undefined for a run that is not an agent run or has not ended. */
export async function readRunResult(id: string, seq: number, root = timersRoot()): Promise<AgentRunResult | undefined> {
	try {
		return (await Bun.file(runResultPath(id, seq, root)).json()) as AgentRunResult;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

/** `$0.0123` with enough digits to show sub-cent runs. */
export function formatCost(usd: number): string {
	return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** Compact token count: `950`, `12.3k`, `1.2M`. */
function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

/** One line: `ok · quiet · $0.0021 · 3.1k tok · 12s` or `failed: budget · …`. */
export function describeRunResult(result: AgentRunResult): string {
	const parts = [result.ok ? "ok" : `failed: ${result.failure ?? "error"}`];
	if (result.quiet) parts.push("quiet");
	parts.push(formatCost(result.cost), `${formatTokens(result.tokens.total)} tok`, formatDuration(result.durationMs));
	if (result.report && result.report.state !== "skipped") parts.push(`reported (${result.report.state})`);
	return parts.join(" · ");
}

/** `result.json` of each given run that has one (ended agent runs), by seq. */
export async function runResults(
	id: string,
	runs: readonly RunView[],
	root = timersRoot(),
): Promise<Map<number, AgentRunResult>> {
	const results = new Map<number, AgentRunResult>();
	const loaded = await Promise.all(runs.map(run => readRunResult(id, run.seq, root)));
	runs.forEach((run, index) => {
		const result = loaded[index];
		if (result) results.set(run.seq, result);
	});
	return results;
}

/** `result.json` of the row's last run, when it was an agent run that ended. */
export function lastRunResult(row: TimerRow, root = timersRoot()): Promise<AgentRunResult | undefined> {
	return row.lastRun ? readRunResult(row.spec.id, row.lastRun.seq, root) : Promise.resolve(undefined);
}

/** Longest final text a run-result block shows. */
const FINAL_TEXT_MAX = 2000;

/** What an agent run's `result.json` says, under its run log: paths, outcome, final text. */
export function renderRunResultBlock(id: string, seq: number, result: AgentRunResult, root = timersRoot()): string {
	const lines = [`result: ${runResultPath(id, seq, root)}`];
	if (result.transcript) lines.push(`transcript: ${result.transcript}`);
	lines.push(`outcome: ${describeRunResult(result)}${result.detail ? ` (${result.detail})` : ""}`);
	if (result.expectMissing?.length) lines.push(`missing: ${result.expectMissing.join(", ")}`);
	if (result.approvalsDenied?.length) lines.push(`approvals denied: ${result.approvalsDenied.join(", ")}`);
	const text = result.finalText?.trim();
	if (text) {
		const shown = text.length > FINAL_TEXT_MAX ? `${text.slice(0, FINAL_TEXT_MAX)}…` : text;
		lines.push("final text:", shown);
	}
	return lines.join("\n");
}
