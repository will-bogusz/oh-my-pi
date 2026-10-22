/**
 * Shared verbs behind the `timer` tool and `omp timer`: set, list, show,
 * pause/resume, remove. Mutations edit spec files only; `state.json` stays
 * single-writer (the tick).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { readSessionInfo, resolveResumableSession } from "../session/session-listing";
import { compileCondition, type TimerCondition } from "./conditions";
import { runGate } from "./gate";
import { TIMER_ID_PATTERN, timersRoot, timerStateDir } from "./paths";
import { hostTimeZone, nextFireAt, normalizeEvery, parseDuration, resolveAt } from "./schedule";
import {
	joinRuns,
	listTimerSpecs,
	readLedger,
	readTimerSpec,
	readTimerState,
	removeTimerSpec,
	type RunView,
	writeTimerSpec,
} from "./store";
import type { TimerSpec, TimerState, TimerTarget } from "./types";

const DAY = 86_400_000;
/** Agent-set recurring timers retire after this unless `expires` says otherwise. */
const TOOL_RECURRING_EXPIRY_MS = 7 * DAY;
/** Agent-set condition timers retire after this unless `expires` says otherwise. */
const TOOL_GATE_EXPIRY_MS = DAY;
/** Bound on the dry-run of a gate at set time. */
const GATE_DRY_RUN_TIMEOUT_MS = 10_000;

export interface TimerSetInput {
	id?: string;
	reason: string;
	title?: string;
	at?: string;
	every?: string;
	/** Condition checked each minute without model tokens; fires once when it holds. */
	when?: TimerCondition;
	tz?: string;
	prompt?: string;
	shell?: string;
	/** `origin` (the calling session), `fresh`, or a session id/prefix/path. */
	session?: string;
	whenClosed?: "resume" | "hold";
	cwd?: string;
	/** Duration (`7d`), date/time, or `never`. */
	expires?: string;
	maxRuns?: number;
	model?: string;
}

export interface TimerSetContext {
	by: "tool" | "cli";
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	now?: number;
}

export interface TimerSetResult {
	spec: TimerSpec;
	replaced: boolean;
	/** Result of running the gate once at set time. */
	gateNow?: "met" | "not-yet" | "broken";
	gateDetail?: string;
}

function deriveId(reason: string): string {
	const slug = reason
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return slug || "timer";
}

async function freeDerivedId(base: string): Promise<string> {
	for (let n = 1; n < 100; n++) {
		const id = n === 1 ? base : `${base}-${n}`;
		if (!(await readTimerSpec(id))) return id;
	}
	throw new Error(`Cannot derive a free timer id from "${base}"; pass id`);
}

async function resolveTarget(input: TimerSetInput, ctx: TimerSetContext): Promise<TimerTarget> {
	const requested = input.session?.trim() || (ctx.sessionId ? "origin" : "fresh");
	if (requested === "fresh") return { kind: "fresh" };
	if (requested === "origin") {
		if (!ctx.sessionId) throw new Error('session "origin" needs a calling session; pass a session id or "fresh"');
		return { kind: "session", sessionId: ctx.sessionId, sessionFile: ctx.sessionFile };
	}
	if (requested === ctx.sessionId) return { kind: "session", sessionId: requested, sessionFile: ctx.sessionFile };
	const match =
		requested.endsWith(".jsonl") || requested.includes(path.sep)
			? await readSessionInfo(path.resolve(ctx.cwd, requested))
			: (await resolveResumableSession(requested, ctx.cwd, undefined, { allowGlobalFallback: true }))?.session;
	if (!match) throw new Error(`No session matches "${requested}"`);
	return { kind: "session", sessionId: match.id, sessionFile: match.path };
}

function resolveExpiry(input: TimerSetInput, ctx: TimerSetContext, now: number, tz: string): string | undefined {
	const text = input.expires?.trim();
	if (text === "never") return undefined;
	if (text) {
		try {
			return new Date(now + parseDuration(text)).toISOString();
		} catch {
			return new Date(resolveAt(text, now, tz)).toISOString();
		}
	}
	if (ctx.by !== "tool") return undefined;
	if (input.every) return new Date(now + TOOL_RECURRING_EXPIRY_MS).toISOString();
	if (input.when) return new Date(now + TOOL_GATE_EXPIRY_MS).toISOString();
	return undefined;
}

/** Validate everything up front: a timer that would fail at its first fire is rejected here. */
export async function setTimer(input: TimerSetInput, ctx: TimerSetContext): Promise<TimerSetResult> {
	const now = ctx.now ?? Date.now();
	const reason = input.reason?.trim();
	if (!reason) throw new Error("reason is required: why this timer exists, in the user's terms");
	const prompt = input.prompt?.trim();
	const shell = input.shell?.trim();
	if (!prompt === !shell) throw new Error("set exactly one of prompt or shell");
	const condition = input.when ? compileCondition(input.when) : undefined;
	if (!input.at && !input.every && !condition) throw new Error("set at, every, or when");
	const tz = input.tz?.trim() || hostTimeZone();
	const cwd = path.resolve(ctx.cwd, input.cwd ?? ".");
	try {
		if (!(await fs.stat(cwd)).isDirectory()) throw new Error(`cwd ${cwd} is not a directory`);
	} catch (err) {
		if (isEnoent(err)) throw new Error(`cwd ${cwd} does not exist`);
		throw err;
	}
	if (input.maxRuns !== undefined && (!Number.isInteger(input.maxRuns) || input.maxRuns < 1)) {
		throw new Error("maxRuns must be a positive integer");
	}

	let id = input.id?.trim();
	if (id && !TIMER_ID_PATTERN.test(id)) throw new Error(`Invalid id "${id}": use [a-z0-9][a-z0-9._-]{0,47}`);
	const existing = id ? await readTimerSpec(id) : undefined;
	id ??= await freeDerivedId(deriveId(reason));

	const at = input.at ? new Date(resolveAt(input.at, now, tz)).toISOString() : undefined;
	const every = input.every ? normalizeEvery(input.every) : undefined;
	const target: TimerTarget = shell ? { kind: "fresh" } : await resolveTarget(input, ctx);
	const spec: TimerSpec = {
		id,
		title: input.title?.trim() || undefined,
		reason,
		at,
		every,
		until: condition?.until,
		condition: condition?.text,
		tz,
		target,
		whenClosed: input.whenClosed ?? "resume",
		action: shell ? { kind: "shell", command: shell } : { kind: "prompt", prompt: prompt ?? "" },
		cwd,
		expiresAt: resolveExpiry(input, ctx, now, tz),
		maxRuns: input.maxRuns,
		overlap: "skip",
		model: input.model?.trim() || undefined,
		paused: false,
		created: {
			at: new Date(now).toISOString(),
			by: ctx.by,
			host: os.hostname(),
			cwd: ctx.cwd,
			session: ctx.sessionId,
			sessionFile: ctx.sessionFile,
			whenText: [
				input.at && `at ${input.at}`,
				input.every && `every ${input.every}`,
				condition && `when ${condition.text}`,
			]
				.filter(Boolean)
				.join(", "),
		},
	};

	let gateNow: TimerSetResult["gateNow"];
	let gateDetail: string | undefined;
	if (spec.until) {
		const verdict = await runGate(spec.until, cwd, GATE_DRY_RUN_TIMEOUT_MS);
		gateNow = verdict.kind;
		if (verdict.kind === "broken") {
			gateDetail = verdict.timedOut
				? "timed out"
				: `exit ${verdict.exitCode ?? "?"}: ${verdict.output.split("\n")[0] ?? ""}`;
		}
	}
	await writeTimerSpec(spec);
	return { spec, replaced: existing !== undefined, gateNow, gateDetail };
}

export interface TimerRow {
	spec: TimerSpec;
	state: TimerState;
	next: number | "gate" | undefined;
	status: "armed" | "paused" | "done";
	lastRun?: RunView;
}

/** `armedAt` differs from the spec's set time when the timer was re-set: earlier state no longer applies. */
export function currentState(spec: TimerSpec, state: TimerState): TimerState {
	if (state.armedAt === spec.created.at) return state;
	return { seq: state.seq, runCount: 0, failStreak: 0, armedAt: spec.created.at, last: state.last };
}

export async function loadTimerRow(spec: TimerSpec, now: number): Promise<TimerRow> {
	const state = currentState(spec, await readTimerState(spec.id));
	const runs = joinRuns(await readLedger(spec.id));
	return {
		spec,
		state,
		next: nextFireAt(spec, state, now),
		status: state.done ? "done" : spec.paused ? "paused" : "armed",
		lastRun: runs.at(-1),
	};
}

export async function listTimers(
	now = Date.now(),
): Promise<{ rows: TimerRow[]; errors: { id: string; error: string }[] }> {
	const { specs, errors } = await listTimerSpecs();
	const rows = await Promise.all(specs.map(spec => loadTimerRow(spec, now)));
	return { rows, errors };
}

export async function requireTimer(id: string): Promise<TimerSpec> {
	const spec = await readTimerSpec(id);
	if (!spec) throw new Error(`No timer "${id}"`);
	return spec;
}

export async function setPaused(id: string, paused: boolean): Promise<TimerSpec> {
	const spec = await requireTimer(id);
	spec.paused = paused;
	await writeTimerSpec(spec);
	return spec;
}

/** Remove the spec. Run history stays under state/<id>/ so `runs` still answers what happened. */
export async function removeTimer(id: string): Promise<boolean> {
	return removeTimerSpec(id);
}

export async function timerRuns(id: string): Promise<RunView[]> {
	return joinRuns(await readLedger(id));
}

export interface TickerStatus {
	lastTickAt?: string;
	pid?: number;
}

export function tickerStatusPath(): string {
	return path.join(timersRoot(), "ticker.json");
}

export async function readTickerStatus(): Promise<TickerStatus> {
	try {
		return (await Bun.file(tickerStatusPath()).json()) as TickerStatus;
	} catch (err) {
		if (isEnoent(err)) return {};
		throw err;
	}
}

export function runLogPath(id: string, seq: number): string {
	return path.join(timerStateDir(id), "runs", `${seq}.log`);
}

export function firePayloadPath(id: string, seq: number): string {
	return path.join(timerStateDir(id), "runs", `${seq}.json`);
}
