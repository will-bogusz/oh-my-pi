/**
 * Unattended agent runs: a prompt timer whose session is `fresh` (a new
 * session per run) or `own` (one session the timer keeps and resumes). The
 * runner starts the session as its own `omp --mode rpc --no-ui` host, sends
 * the fire envelope, and watches the run over RPC:
 *
 * - `maxCost`: model-call cost is summed from `message_end` usage; once it
 *   exceeds the limit the run is aborted and fails with `budget` (it can
 *   overshoot by the call that crossed the limit).
 * - `maxTime` (default 30m): past the deadline the run is aborted and fails
 *   with `timeout`.
 * - Approvals: the host has no UI, so a tool call that needs an approval
 *   fails at once instead of waiting for an answer nobody can give; the run
 *   continues (the model sees the denial) and fails with `approval`.
 * - `expect`: paths that must exist in the run's cwd afterwards.
 * - `before`/`after` hooks: shell in the run's cwd with `OMP_TIMER_RUN_DIR`
 *   (and `OMP_TIMER_RESULT` for `after`).
 *
 * Every run leaves `result.json` in its run dir, then reports per `report`:
 * mail to the session that set the timer (through the mailbox ladder: a live
 * session gets it now, a closed one when it next opens) and, when no live
 * session hears it, the notify sinks. The failure policy applies on top, as
 * for any timer: repeated failures alert and pause the timer.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { isEnoent, logger, ptree } from "@oh-my-pi/pi-utils";
import { RpcClient } from "../modes/rpc/rpc-client";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { NO_UI_APPROVAL_DENIAL } from "../tools/approval";
import { HEADLESS_SESSION_TAKEN_EXIT } from "../mailbox/headless";
import { type DeliveryTarget, deliveryTarget, describeDeliveryTarget, postMail } from "../mailbox/mailbox";
import { QUIET_MARKER, renderMail } from "../mailbox/message";
import { MAILBOX_HEADLESS_ENV } from "../mailbox/paths";
import { readSessionInfo } from "../session/session-listing";
import { type RunProfile, resolveRunProfile } from "./agent-profile";
import { loadTimerNotifyConfig, sendTimerAlerts } from "./notify";
import { ownSessionDir, runDirPath, timerStateDir } from "./paths";
import { firstErrorLine } from "./policy";
import { runCommand } from "./run-command";
import { formatCost, writeRunResult } from "./run-result";
import { formatDuration, HOUR, MINUTE } from "./schedule";
import { openTimerDb } from "./store";
import type {
	AgentRunFailure,
	AgentRunResult,
	TimerAlert,
	TimerFirePayload,
	TimerReport,
	TimerReportPayload,
	TimerSpec,
} from "./types";

/** `maxTime` when the spec sets none. */
const DEFAULT_AGENT_RUN_MAX_TIME_MS = HOUR / 2;
/** After an abort, how long the turn gets to wind down before the host is stopped. */
const ABORT_GRACE_MS = 15_000;
/** Cap on one `before`/`after` hook. */
const HOOK_TIMEOUT_MS = 10 * MINUTE;
/** `after` runs even when the agent used up maxTime: it gets at least this long to clean up and record. */
const AFTER_HOOK_FLOOR_MS = MINUTE;
/** Final text kept in `result.json` and in the report mail. */
const FINAL_TEXT_MAX = 8000;

/** The slice of {@link RpcClient} a run drives; tests pass a fake. */
export interface AgentRunHost {
	start(): Promise<void>;
	onEvent(listener: (event: AgentEvent) => void): () => void;
	promptAndWait(message: string, images: undefined, timeout: number): Promise<unknown>;
	waitForSettled(timeout: number): Promise<void>;
	abort(): Promise<void>;
	getLastAssistantText(): Promise<string | null>;
	getSessionStats(): Promise<{ sessionFile?: string }>;
	stop(): Promise<void>;
	/** The host process's exit code once it has exited (`undefined` if it never started). */
	exitCode(): Promise<number | undefined>;
}

export interface AgentRunDeps {
	createHost(args: string[], cwd: string, env: Record<string, string>): AgentRunHost;
	deliveryTarget(sessionId: string): DeliveryTarget;
	notify(alerts: TimerAlert[]): Promise<void>;
}

export function defaultAgentRunDeps(): AgentRunDeps {
	return {
		createHost: (args, cwd, env) => {
			let child: ptree.ChildProcess<"pipe"> | undefined;
			const client = new RpcClient({
				args,
				spawn: hostArgs => {
					child = ptree.spawn([...resolveCliEntryCmd(), ...hostArgs], {
						cwd,
						env: { ...Bun.env, ...env },
						stdin: "pipe",
					});
					return child;
				},
			});
			return Object.assign(client, { exitCode: async () => child?.exited.catch(() => undefined) });
		},
		deliveryTarget,
		notify: async alerts => sendTimerAlerts(alerts, await loadTimerNotifyConfig()),
	};
}

/**
 * Flags of the run's RPC host. A profile is applied through the flags a
 * profile maps onto (model, thinking, appended system prompt, tools); the
 * spec's own `model`/`thinking` win over the profile's. `hermetic` turns off
 * rules, skills, extensions and title generation; context files (AGENTS.md
 * and the like) still load from the cwd's ancestors, which `cwd: run` avoids.
 */
function agentRunArgs(
	spec: TimerSpec,
	profile: RunProfile | undefined,
	session: { sessionDir: string; resume?: string },
): string[] {
	const args = ["--no-ui", "--session-dir", session.sessionDir];
	if (session.resume) args.push("--resume", session.resume);
	const model = spec.model ?? profile?.model;
	if (model) args.push("--model", model);
	const thinking = spec.run.thinking ?? profile?.thinking;
	if (thinking) args.push("--thinking", thinking);
	if (profile?.systemPrompt.trim()) args.push("--append-system-prompt", profile.systemPrompt);
	if (profile?.tools) {
		if (profile.tools.length) args.push("--tools", profile.tools.join(","));
		else args.push("--no-tools");
	}
	if (spec.run.hermetic) args.push("--no-rules", "--no-skills", "--no-extensions", "--no-title");
	return args;
}

/** Whether a run's result goes to the origin session and sinks under `mode`. A failure always says something. */
function shouldReport(mode: TimerReport, result: Pick<AgentRunResult, "ok" | "quiet">): boolean {
	switch (mode) {
		case "always":
			return true;
		case "said":
			return !result.ok || !result.quiet;
		case "failure":
			return !result.ok;
		case "never":
			return false;
	}
}

/** The session an `own` timer resumes: the newest transcript in its session dir. */
async function ownSessionFile(dir: string): Promise<string | undefined> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	let newest: { file: string; mtime: number } | undefined;
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const file = path.join(dir, name);
		const { mtimeMs } = await fs.stat(file);
		if (!newest || mtimeMs > newest.mtime) newest = { file, mtime: mtimeMs };
	}
	return newest?.file;
}

function toolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
	return result.content
		.map((block: unknown) =>
			block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "",
		)
		.join("\n");
}

/** Split a trailing `[quiet]` line off the final message. */
function splitQuiet(text: string): { quiet: boolean; text?: string } {
	const lines = text.trimEnd().split("\n");
	if (lines.at(-1)?.trim() !== QUIET_MARKER) return { quiet: false, text: text.trim() || undefined };
	return { quiet: true, text: lines.slice(0, -1).join("\n").trim() || undefined };
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface AgentRunContext {
	root: string;
	/** Environment of everything the run starts (`OMP_TIMER_RUN`, `OMP_TIMERS_DIR`, …). */
	env: Record<string, string>;
	now?: () => number;
}

/** Execute one agent run end to end; never throws for a run that failed, only records it. */
export async function runAgent(
	spec: TimerSpec,
	payload: TimerFirePayload,
	ctx: AgentRunContext,
	deps: AgentRunDeps = defaultAgentRunDeps(),
): Promise<AgentRunResult> {
	if (spec.target.kind === "session") throw new Error(`timer ${spec.id} wakes a session; it has no agent run`);
	const now = ctx.now ?? Date.now;
	const session = spec.target.kind;
	const started = now();
	// Absolute: hooks and the host run in another cwd, and the paths go into the result and env.
	const dir = path.resolve(runDirPath(spec.id, payload.seq, ctx.root));
	const cwd = spec.run.runCwd
		? session === "own"
			? path.resolve(timerStateDir(spec.id, ctx.root), "work")
			: path.join(dir, "work")
		: spec.cwd;
	const env = { ...ctx.env, OMP_TIMER_RUN_DIR: dir };
	const maxTime = spec.run.maxTimeMs ?? DEFAULT_AGENT_RUN_MAX_TIME_MS;
	const deadline = started + maxTime;
	const result: AgentRunResult = {
		v: 1,
		runId: payload.runId,
		timerId: spec.id,
		seq: payload.seq,
		session,
		ok: true,
		quiet: false,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
		startedAt: new Date(started).toISOString(),
		endedAt: new Date(started).toISOString(),
		durationMs: 0,
		cwd,
	};
	// The first failure names the run's outcome; later ones only add detail.
	const fail = (failure: AgentRunFailure, detail: string): void => {
		if (!result.ok) return;
		result.ok = false;
		result.failure = failure;
		result.detail = detail;
	};
	const stamp = (): void => {
		const ended = now();
		result.endedAt = new Date(ended).toISOString();
		result.durationMs = ended - started;
	};
	/** A hook gets the time left before the deadline (at most the hook cap); `floor` keeps `after` able to clean up. */
	const hook = async (name: "before" | "after", command: string, extraEnv: Record<string, string>, floor = 0) => {
		const budget = Math.max(floor, deadline - now());
		const limit = Math.min(HOOK_TIMEOUT_MS, budget);
		const done = await runCommand(["/bin/sh", "-c", command], cwd, { ...env, ...extraEnv }, limit);
		if (done.ok) return;
		if (done.timedOut && limit === budget)
			fail("timeout", `${name} hook still running at maxTime ${formatDuration(maxTime)}`);
		else fail(name, `${name} hook ${done.detail ?? "failed"}`);
	};

	let cwdReady = false;
	try {
		await fs.mkdir(dir, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		cwdReady = true;
		if (spec.run.before) await hook("before", spec.run.before, {});
		if (result.ok && now() >= deadline)
			fail("timeout", `no time left for the agent within maxTime ${formatDuration(maxTime)}`);
		if (result.ok)
			await runSession(spec, payload, { ...ctx, now }, deps, { cwd, dir, env, deadline, maxTime }, result, fail);
		if (result.ok && spec.run.expect?.length) {
			const missing: string[] = [];
			for (const entry of spec.run.expect) {
				if (!(await fs.exists(path.resolve(cwd, entry)))) missing.push(entry);
			}
			if (missing.length) {
				result.expectMissing = missing;
				fail("expect", `missing after the run: ${missing.join(", ")}`);
			}
		}
	} catch (err) {
		fail("error", firstErrorLine(err instanceof Error ? err.message : String(err)));
	}
	stamp();
	const resultPath = await writeRunResult(result, ctx.root);
	if (spec.run.after && cwdReady) {
		const outcome = result.ok ? "ok" : `failed: ${result.failure}`;
		try {
			await hook(
				"after",
				spec.run.after,
				{ OMP_TIMER_RESULT: resultPath, OMP_TIMER_OUTCOME: outcome },
				AFTER_HOOK_FLOOR_MS,
			);
		} catch (err) {
			// It could not even start (its cwd is gone, say): a failed `after`, still stamped, reported and recorded.
			fail("after", `after hook ${firstErrorLine(err instanceof Error ? err.message : String(err))}`);
		}
		stamp();
	}
	try {
		result.report = await reportRun(spec, result, resultPath, ctx.root, deps, now);
	} catch (err) {
		logger.warn("timer run report failed", { runId: result.runId, error: String(err) });
		result.report = { mode: spec.report, state: "skipped", detail: firstErrorLine(String(err)) };
	}
	await writeRunResult(result, ctx.root);
	return result;
}

interface RunPlace {
	cwd: string;
	dir: string;
	env: Record<string, string>;
	deadline: number;
	maxTime: number;
}

async function runSession(
	spec: TimerSpec,
	payload: TimerFirePayload,
	ctx: AgentRunContext & { now: () => number },
	deps: AgentRunDeps,
	place: RunPlace,
	result: AgentRunResult,
	fail: (failure: AgentRunFailure, detail: string) => void,
): Promise<void> {
	const session = result.session;
	let profile: RunProfile | undefined;
	if (spec.run.agent) {
		try {
			// Profiles resolve from the timer's cwd (its project), not the per-run directory.
			profile = await resolveRunProfile(spec.run.agent, spec.cwd);
		} catch (err) {
			fail("error", firstErrorLine(err instanceof Error ? err.message : String(err)));
			return;
		}
	}
	const sessionDir =
		session === "own" ? path.resolve(ownSessionDir(spec.id, ctx.root)) : path.join(place.dir, "session");
	await fs.mkdir(sessionDir, { recursive: true });
	const resume = session === "own" ? await ownSessionFile(sessionDir) : undefined;
	// An own session someone has open is theirs: running in it would fork the run onto a hidden sibling file.
	// The host re-checks before it writes anything (`exitUnlessHeadlessRunMayWrite`), closing the startup race.
	const ownId = resume ? (await readSessionInfo(resume))?.id : undefined;
	const busy = (where: string): void => fail("busy", `its own session is open ${where}; this run did not start`);
	if (ownId) {
		const target = deps.deliveryTarget(ownId);
		const holder = "pid" in target ? ` (${target.host}, pid ${target.pid})` : "";
		if (target.kind !== "free") return busy(`in another omp process${holder}`);
	}
	result.model = spec.model ?? profile?.model;
	const env = ownId ? { ...place.env, [MAILBOX_HEADLESS_ENV]: payload.runId } : place.env;
	const host = deps.createHost(agentRunArgs(spec, profile, { sessionDir, resume }), place.cwd, env);
	const envelope = renderMail(
		{ v: 1, id: payload.runId, kind: "timer-fire", sessionId: "", createdAt: payload.firedAt, fire: payload },
		"run",
		ctx.now(),
		{ session, cwd: place.cwd, expect: spec.run.expect },
	);
	const { promise: limitHit, resolve: hitLimit } = Promise.withResolvers<"budget" | "timeout">();
	const denied = new Set<string>();
	let lastError: string | undefined;
	const unsubscribe = host.onEvent(event => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const { usage } = event.message;
			result.tokens.input += usage.input;
			result.tokens.output += usage.output;
			result.tokens.cacheRead += usage.cacheRead;
			result.tokens.cacheWrite += usage.cacheWrite;
			result.tokens.total += usage.totalTokens;
			result.cost += usage.cost.total;
			result.stopReason = event.message.stopReason;
			lastError = event.message.stopReason === "error" ? event.message.errorMessage : undefined;
			if (spec.run.maxCost !== undefined && result.cost > spec.run.maxCost) hitLimit("budget");
		} else if (event.type === "tool_execution_end" && event.isError) {
			if (toolResultText(event.result).includes(NO_UI_APPROVAL_DENIAL)) denied.add(event.toolName);
		}
	});
	const timeout = setTimeout(() => hitLimit("timeout"), Math.max(0, place.deadline - ctx.now()));
	let abortReason: "budget" | "timeout" | undefined;
	let turnError: unknown;
	let taken = false;
	let prompted = false;
	try {
		// Startup counts against maxTime too, and nothing is sent once the deadline has passed.
		const startup = host.start();
		startup.catch(() => undefined);
		try {
			abortReason = await Promise.race([startup.then(() => undefined), limitHit]);
		} catch (err) {
			taken = ownId !== undefined && (await host.exitCode()) === HEADLESS_SESSION_TAKEN_EXIT;
			if (!taken) throw err;
		}
		if (!abortReason && !taken && ctx.now() >= place.deadline) abortReason = "timeout";
		if (!abortReason && !taken) {
			prompted = true;
			const remaining = (): number => Math.max(1, place.deadline - ctx.now()) + ABORT_GRACE_MS;
			const turn = (async () => {
				await host.promptAndWait(envelope, undefined, remaining());
				await host.waitForSettled(remaining());
			})();
			abortReason = await Promise.race([
				turn.then(
					() => undefined,
					err => {
						turnError = err;
						return undefined;
					},
				),
				limitHit,
			]);
			if (abortReason) {
				await host.abort().catch(err => logger.debug("timer run abort failed", { error: String(err) }));
				await Promise.race([turn.catch(() => undefined), Bun.sleep(ABORT_GRACE_MS)]);
			}
		}
		if (prompted) {
			const finalText = await host.getLastAssistantText().catch(() => null);
			const split = splitQuiet(finalText ?? "");
			result.quiet = split.quiet;
			result.finalText = split.text?.slice(0, FINAL_TEXT_MAX);
			result.transcript = (await host.getSessionStats().catch(() => undefined))?.sessionFile;
		}
	} catch (err) {
		turnError = err;
	} finally {
		clearTimeout(timeout);
		unsubscribe();
		await host.stop().catch(err => logger.debug("timer run host stop failed", { error: String(err) }));
	}

	if (taken) {
		busy("in another omp process");
	} else if (abortReason === "timeout" && !prompted) {
		fail("timeout", `the host was not ready within maxTime ${formatDuration(place.maxTime)}; nothing was sent`);
	} else if (abortReason === "budget") {
		fail("budget", `spent ${formatCost(result.cost)}, over maxCost ${formatCost(spec.run.maxCost ?? 0)}`);
	} else if (abortReason === "timeout") {
		fail("timeout", `still running after maxTime ${formatDuration(place.maxTime)}`);
	} else if (turnError !== undefined) {
		fail("error", firstErrorLine(turnError instanceof Error ? turnError.message : String(turnError)));
	} else if (result.stopReason === "error") {
		fail("model", firstErrorLine(lastError ?? "model error"));
	} else if (result.stopReason === "aborted") {
		fail("error", "the turn was aborted");
	}
	if (denied.size) {
		result.approvalsDenied = [...denied];
		fail("approval", `needed an approval nobody can give an unattended run: ${result.approvalsDenied.join(", ")}`);
	}
}

/** Send the run's result where `report` says: mail to the origin session, else (or when it is closed) the sinks. */
async function reportRun(
	spec: TimerSpec,
	result: AgentRunResult,
	resultPath: string,
	root: string,
	deps: AgentRunDeps,
	now: () => number,
): Promise<NonNullable<AgentRunResult["report"]>> {
	const mode = spec.report;
	if (!shouldReport(mode, result)) return { mode, state: "skipped" };
	const outcome = result.ok ? (result.quiet ? "ok (quiet)" : "ok") : `failed: ${result.failure}`;
	const detail = result.ok ? result.finalText : result.detail;
	const summary = `run #${result.seq} ${outcome}${detail ? `: ${oneLine(detail, 160)}` : ""}`;
	// The failure policy alerts the last run of a one-shot itself (tick: `final`); every other result is announced here.
	const policyAlerts = !result.ok && !spec.every;
	const notify = async (): Promise<void> => {
		if (policyAlerts) return;
		await deps.notify([
			{ timerId: spec.id, runId: result.runId, event: "report", summary, count: 1, logPath: resultPath },
		]);
	};
	const origin = spec.created.session;
	if (!origin) {
		await notify();
		return { mode, state: "notified" };
	}
	const at = new Date(now()).toISOString();
	const report: TimerReportPayload = {
		timerId: spec.id,
		runId: result.runId,
		seq: result.seq,
		title: spec.title,
		reason: spec.reason,
		session: result.session,
		ok: result.ok,
		failure: result.failure,
		detail: result.detail,
		quiet: result.quiet,
		finalText: result.finalText,
		cost: result.cost,
		durationMs: result.durationMs,
		endedAt: result.endedAt,
		resultPath,
		transcript: result.transcript,
		tz: spec.tz,
	};
	await postMail({
		v: 1,
		id: `${result.runId}.report`,
		kind: "timer-report",
		sessionId: origin,
		createdAt: at,
		report,
	});
	const target = deps.deliveryTarget(origin);
	const db = openTimerDb(root);
	if (target.kind === "live") {
		db.recordDelivery(spec.id, { runId: result.runId, at, state: "queued", session: origin, detail: "report" });
		return { mode, state: "mailed-live", session: origin };
	}
	const why =
		target.kind === "held" ? describeDeliveryTarget(target) : "the session is not open; delivered when it opens";
	db.recordDelivery(spec.id, { runId: result.runId, at, state: "held", session: origin, detail: `report: ${why}` });
	await notify();
	return { mode, state: "mailed-held", session: origin, detail: why };
}

/** `failed: budget: spent …` in run listings; the runner's end detail. */
export function agentRunEndDetail(result: AgentRunResult): string | undefined {
	if (!result.ok) return `${result.failure}: ${result.detail ?? ""}`.trim();
	return result.quiet ? "quiet" : undefined;
}
