/**
 * `result.json` of an agent run (fresh/own session): written once by the
 * runner when the run ends (and rewritten after the `after` hook and the
 * report), read by `omp timer runs/logs`, `timer://<id>/runs/<seq>` and the
 * `/timers` sheet.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { runResultPath, timersRoot } from "./paths";
import { formatDuration } from "./schedule";
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
