/**
 * Shared verbs behind the `timer` tool and `omp timer`: set, edit, list,
 * show, runs, logs, pause/resume, remove. Mutations change spec files only,
 * through the rev-checked {@link mutateTimerSpec}; execution state stays with
 * the tick and the runner.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { readSessionInfo, resolveResumableSession } from "../session/session-listing";
import { compileCondition, type TimerCondition } from "./conditions";
import { runGate } from "./gate";
import { createTimerHost, syncMachineWake, type WakeHost } from "./install";
import { runLogPath, TIMER_ID_PATTERN, timersRoot } from "./paths";
import {
	DAY,
	hostTimeZone,
	MIN_PROMPT_INTERVAL_MS,
	MIN_SHELL_INTERVAL_MS,
	MINUTE,
	minCadenceGapMs,
	nextFireAt,
	normalizeEvery,
	parseDuration,
	resolveAt,
	formatDuration,
	assertTimeZone,
} from "./schedule";
import { assertTimerMutationAllowed, currentTimerRun } from "./scope";
import {
	DEFAULT_PAUSE_AFTER,
	type IncidentRow,
	listTimerSpecs,
	mutateTimerSpec,
	openTimerDb,
	type RunView,
	readTimerSpec,
} from "./store";
import { currentState } from "./tick";
import type { TimerCatchup, TimerOverlap, TimerSpec, TimerState, TimerTarget } from "./types";

/** Agent-set recurring session timers retire after this unless `expires` says otherwise. */
const TOOL_RECURRING_EXPIRY_MS = 7 * DAY;
/** Agent-set condition timers retire after this unless `expires` says otherwise. */
const TOOL_GATE_EXPIRY_MS = DAY;
/** Bound on the test run of a gate at set time. */
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
	overlap?: TimerOverlap;
	/** Duration: how late a slot may still run before it is recorded missed. */
	grace?: string;
	/** `skip`: a slot reached late (asleep, no ticker) is recorded missed instead of run late. */
	catchup?: TimerCatchup;
	pauseAfter?: number;
	allowTimers?: boolean;
	wakeMachine?: boolean;
	/** Replace only if the current spec is at this rev (0 = must not exist yet). */
	expectedRev?: number;
}

export interface TimerSetContext {
	by: "tool" | "cli";
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	now?: number;
	root?: string;
	/** OS seam for `wakeMachine` (tests pass a fake). */
	host?: WakeHost;
	/** Run the gate once at set time (default true). */
	testGate?: boolean;
}

export interface TimerSetResult {
	spec: TimerSpec;
	replaced: boolean;
	/** Result of running the gate once at set time. */
	gateNow?: "met" | "not-yet" | "broken";
	gateDetail?: string;
	/** Problems that did not block the set (wake scheduling failed, …). */
	warnings: string[];
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

async function freeDerivedId(base: string, root: string): Promise<string> {
	for (let n = 1; n < 100; n++) {
		const id = n === 1 ? base : `${base}-${n}`;
		if (!(await readTimerSpec(id, root))) return id;
	}
	throw new Error(`Cannot derive a free timer id from "${base}"; pass id`);
}

async function resolveTarget(session: string | undefined, ctx: TimerSetContext): Promise<TimerTarget> {
	const requested = session?.trim() || (ctx.sessionId ? "origin" : "fresh");
	if (requested === "fresh") return { kind: "fresh" };
	if (requested === "origin") {
		if (!ctx.sessionId) throw new Error('session "origin" needs a calling session; pass a session id or "fresh"');
		return { kind: "session", sessionId: ctx.sessionId, sessionFile: ctx.sessionFile };
	}
	if (requested === ctx.sessionId) return { kind: "session", sessionId: requested, sessionFile: ctx.sessionFile };
	if (requested.endsWith(".jsonl") || requested.includes(path.sep)) {
		const info = await readSessionInfo(path.resolve(ctx.cwd, requested));
		if (!info) throw new Error(`No session file at "${requested}"`);
		return { kind: "session", sessionId: info.id, sessionFile: info.path };
	}
	const match = await resolveResumableSession(requested, ctx.cwd, undefined, { allowGlobalFallback: true });
	if (!match) throw new Error(`No session matches "${requested}"`);
	return { kind: "session", sessionId: match.session.id, sessionFile: match.session.path };
}

function resolveExpiry(
	text: string | undefined,
	defaults: { by: "tool" | "cli"; recurring: boolean; gated: boolean },
	now: number,
	tz: string,
): string | undefined {
	const trimmed = text?.trim();
	if (trimmed === "never") return undefined;
	if (trimmed) {
		try {
			return new Date(now + parseDuration(trimmed)).toISOString();
		} catch {
			return new Date(resolveAt(trimmed, now, tz)).toISOString();
		}
	}
	if (defaults.by !== "tool") return undefined;
	if (defaults.gated) return new Date(now + TOOL_GATE_EXPIRY_MS).toISOString();
	if (defaults.recurring) return new Date(now + TOOL_RECURRING_EXPIRY_MS).toISOString();
	return undefined;
}

async function assertDirectory(cwd: string): Promise<void> {
	try {
		if (!(await fs.stat(cwd)).isDirectory()) throw new Error(`cwd ${cwd} is not a directory`);
	} catch (err) {
		if (isEnoent(err)) throw new Error(`cwd ${cwd} does not exist`);
		throw err;
	}
}

/** Reject a spec that would fail or misbehave at its first fire. */
function validateSpec(spec: TimerSpec, now: number): void {
	if (!spec.reason.trim()) throw new Error("reason is required: why this timer exists, in the user's terms");
	if (spec.action.kind === "prompt" && !spec.action.prompt.trim()) throw new Error("prompt is empty");
	if (spec.action.kind === "shell" && !spec.action.command.trim()) throw new Error("shell command is empty");
	if (!spec.at && !spec.every && !spec.until) throw new Error("set at, every, or when");
	assertTimeZone(spec.tz);
	if (spec.at && Date.parse(spec.at) < now - MINUTE && !spec.every && !spec.until) {
		throw new Error(`at ${spec.at} is in the past`);
	}
	if (spec.every && !spec.until) {
		const min = spec.action.kind === "prompt" ? MIN_PROMPT_INTERVAL_MS : MIN_SHELL_INTERVAL_MS;
		const gap = minCadenceGapMs(spec.every, spec.tz, now);
		if (gap < min) {
			throw new Error(
				`every ${spec.every} runs ${formatDuration(gap)} apart; the minimum is ${formatDuration(min)} for ${spec.action.kind} timers`,
			);
		}
	}
	if (spec.expiresAt && spec.at && Date.parse(spec.expiresAt) <= Date.parse(spec.at)) {
		throw new Error("expires is before the timer's first fire");
	}
	if (spec.maxRuns !== undefined && (!Number.isInteger(spec.maxRuns) || spec.maxRuns < 1)) {
		throw new Error("maxRuns must be a positive integer");
	}
	if (!Number.isInteger(spec.pauseAfter) || spec.pauseAfter < 1)
		throw new Error("pauseAfter must be a positive integer");
}

async function testGate(spec: TimerSpec): Promise<Pick<TimerSetResult, "gateNow" | "gateDetail">> {
	if (!spec.until) return {};
	const verdict = await runGate(spec.until, spec.cwd, GATE_DRY_RUN_TIMEOUT_MS);
	if (verdict.kind !== "broken") return { gateNow: verdict.kind };
	return {
		gateNow: "broken",
		gateDetail: verdict.timedOut
			? "timed out"
			: `exit ${verdict.exitCode ?? "?"}: ${verdict.output.split("\n")[0] ?? ""}`,
	};
}

/** Bring the timer's pmset wake in line with its spec (removed when `spec` is undefined); returns warnings. */
async function syncWake(
	id: string,
	spec: TimerSpec | undefined,
	opts: { root: string; now: number; host?: WakeHost },
): Promise<string[]> {
	const db = openTimerDb(opts.root);
	return syncMachineWake({
		db,
		host: opts.host ?? createTimerHost(),
		id,
		spec,
		state: spec && currentState(spec, db.readState(id)),
		now: opts.now,
	});
}

/** Validate everything up front: a timer that would fail at its first fire is rejected here. */
export async function setTimer(input: TimerSetInput, ctx: TimerSetContext): Promise<TimerSetResult> {
	const now = ctx.now ?? Date.now();
	const root = ctx.root ?? timersRoot();
	const prompt = input.prompt?.trim();
	const shell = input.shell?.trim();
	if (!prompt === !shell) throw new Error("set exactly one of prompt or shell");
	const condition = input.when ? compileCondition(input.when) : undefined;
	const tz = input.tz?.trim() || hostTimeZone();
	assertTimeZone(tz);
	const cwd = path.resolve(ctx.cwd, input.cwd ?? ".");
	await assertDirectory(cwd);

	let id = input.id?.trim();
	if (id && !TIMER_ID_PATTERN.test(id)) throw new Error(`Invalid id "${id}": use [a-z0-9][a-z0-9._-]{0,47}`);
	await assertTimerMutationAllowed(id, "set", root);
	id ??= await freeDerivedId(deriveId(input.reason ?? ""), root);

	const nowIso = new Date(now).toISOString();
	const every = input.every ? normalizeEvery(input.every) : undefined;
	const target: TimerTarget = shell ? { kind: "fresh" } : await resolveTarget(input.session, ctx);
	const spec: TimerSpec = {
		id,
		rev: 0,
		title: input.title?.trim() || undefined,
		reason: input.reason?.trim() ?? "",
		at: input.at ? new Date(resolveAt(input.at, now, tz)).toISOString() : undefined,
		every,
		until: condition?.until,
		condition: condition?.text,
		tz,
		target,
		whenClosed: input.whenClosed ?? "resume",
		action: shell ? { kind: "shell", command: shell } : { kind: "prompt", prompt: prompt ?? "" },
		cwd,
		expiresAt: resolveExpiry(
			input.expires,
			{ by: ctx.by, recurring: every !== undefined && target.kind === "session", gated: condition !== undefined },
			now,
			tz,
		),
		maxRuns: input.maxRuns,
		overlap: input.overlap ?? "skip",
		graceMs: input.grace ? parseDuration(input.grace) : undefined,
		catchup: input.catchup ?? "run",
		pauseAfter: input.pauseAfter ?? DEFAULT_PAUSE_AFTER,
		allowTimers: input.allowTimers ?? false,
		wakeMachine: input.wakeMachine ?? false,
		model: input.model?.trim() || undefined,
		paused: false,
		armedAt: nowIso,
		created: {
			at: nowIso,
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
			run: currentTimerRun()?.runId,
		},
	};
	validateSpec(spec, now);
	const gate = ctx.testGate === false ? {} : await testGate(spec);
	const { spec: written, previous } = await mutateTimerSpec(id, () => spec, {
		expectedRev: input.expectedRev,
		root,
	});
	if (!written) throw new Error(`timer ${id} was not written`);
	const warnings = await syncWake(id, written, { root, now, host: ctx.host });
	return { spec: written, replaced: previous !== undefined, ...gate, warnings };
}

/** Fields `edit` may change; absent fields keep their value. `null` clears an optional field. */
export interface TimerEditInput {
	title?: string | null;
	reason?: string;
	at?: string | null;
	every?: string | null;
	when?: TimerCondition | null;
	tz?: string;
	prompt?: string;
	shell?: string;
	whenClosed?: "resume" | "hold";
	cwd?: string;
	expires?: string | null;
	maxRuns?: number | null;
	model?: string | null;
	overlap?: TimerOverlap;
	grace?: string | null;
	catchup?: TimerCatchup;
	pauseAfter?: number;
	allowTimers?: boolean;
	wakeMachine?: boolean;
	expectedRev?: number;
}

export interface TimerEditResult {
	spec: TimerSpec;
	/** The schedule changed: a new generation starts (slots and counters reset; history kept). */
	rearmed: boolean;
	gateNow?: "met" | "not-yet" | "broken";
	gateDetail?: string;
	warnings: string[];
}

/**
 * Change some fields of an existing timer under its spec lock. A change to
 * when it fires (at/every/when/tz) starts a new schedule generation; a prompt
 * or limit change keeps the current one, so it never re-fires a slot.
 */
export async function editTimer(id: string, patch: TimerEditInput, ctx: TimerSetContext): Promise<TimerEditResult> {
	const now = ctx.now ?? Date.now();
	const root = ctx.root ?? timersRoot();
	await assertTimerMutationAllowed(id, "edit", root);
	let rearmed = false;
	let gateChanged = false;
	const { spec } = await mutateTimerSpec(
		id,
		async current => {
			if (!current) throw new Error(`No timer "${id}"`);
			const next = structuredClone(current);
			const tz = patch.tz?.trim() || next.tz;
			assertTimeZone(tz);
			if (patch.title !== undefined) next.title = patch.title?.trim() || undefined;
			if (patch.reason !== undefined) next.reason = patch.reason.trim();
			if (patch.prompt !== undefined && patch.shell !== undefined)
				throw new Error("set at most one of prompt or shell");
			if (patch.prompt !== undefined) next.action = { kind: "prompt", prompt: patch.prompt.trim() };
			if (patch.shell !== undefined) {
				next.action = { kind: "shell", command: patch.shell.trim() };
				next.target = { kind: "fresh" };
			}
			if (patch.whenClosed !== undefined) next.whenClosed = patch.whenClosed;
			if (patch.cwd !== undefined) {
				next.cwd = path.resolve(ctx.cwd, patch.cwd);
				await assertDirectory(next.cwd);
			}
			if (patch.maxRuns !== undefined) next.maxRuns = patch.maxRuns ?? undefined;
			if (patch.model !== undefined) next.model = patch.model?.trim() || undefined;
			if (patch.overlap !== undefined) next.overlap = patch.overlap;
			if (patch.grace !== undefined) next.graceMs = patch.grace ? parseDuration(patch.grace) : undefined;
			if (patch.catchup !== undefined) next.catchup = patch.catchup;
			if (patch.pauseAfter !== undefined) next.pauseAfter = patch.pauseAfter;
			if (patch.allowTimers !== undefined) next.allowTimers = patch.allowTimers;
			if (patch.wakeMachine !== undefined) next.wakeMachine = patch.wakeMachine;
			if (patch.expires !== undefined) {
				next.expiresAt =
					patch.expires === null
						? undefined
						: resolveExpiry(patch.expires, { by: "cli", recurring: false, gated: false }, now, tz);
			}
			if (patch.tz !== undefined && tz !== current.tz) {
				next.tz = tz;
				rearmed = true;
			}
			if (patch.at !== undefined) {
				next.at = patch.at === null ? undefined : new Date(resolveAt(patch.at, now, tz)).toISOString();
				rearmed = true;
			}
			if (patch.every !== undefined) {
				next.every = patch.every === null ? undefined : normalizeEvery(patch.every);
				rearmed = true;
			}
			if (patch.when !== undefined) {
				const condition = patch.when === null ? undefined : compileCondition(patch.when);
				next.until = condition?.until;
				next.condition = condition?.text;
				rearmed = true;
				gateChanged = condition !== undefined;
			}
			if (rearmed) next.armedAt = new Date(now).toISOString();
			validateSpec(next, now);
			return next;
		},
		{ expectedRev: patch.expectedRev, root },
	);
	if (!spec) throw new Error(`No timer "${id}"`);
	const gate = gateChanged && ctx.testGate !== false ? await testGate(spec) : {};
	const warnings = await syncWake(id, spec, { root, now, host: ctx.host });
	// Wake warnings were already shown at set time; repeat them only when the edit touched the wake.
	const wakeTouched = patch.at !== undefined || patch.wakeMachine !== undefined;
	return { spec, rearmed, ...gate, warnings: wakeTouched ? warnings : [] };
}

export interface TimerRow {
	spec: TimerSpec;
	state: TimerState;
	next: number | "gate" | undefined;
	status: "armed" | "paused" | "done";
	lastRun?: RunView;
	/** Open incidents, newest last. */
	incidents: IncidentRow[];
}

export async function loadTimerRow(spec: TimerSpec, now: number, root = timersRoot()): Promise<TimerRow> {
	const db = openTimerDb(root);
	const state = currentState(spec, db.readState(spec.id));
	return {
		spec,
		state,
		next: nextFireAt(spec, state, now),
		status: state.done ? "done" : spec.paused ? "paused" : "armed",
		lastRun: db.listRuns(spec.id, 1)[0],
		incidents: db.listIncidents(spec.id).filter(incident => incident.resolvedAt === undefined),
	};
}

export async function listTimers(
	now = Date.now(),
	root = timersRoot(),
): Promise<{ rows: TimerRow[]; errors: { id: string; error: string }[] }> {
	const { specs, errors } = await listTimerSpecs(root);
	const rows = await Promise.all(specs.map(spec => loadTimerRow(spec, now, root)));
	return { rows, errors };
}

export async function requireTimer(id: string, root = timersRoot()): Promise<TimerSpec> {
	const spec = await readTimerSpec(id, root);
	if (!spec) throw new Error(`No timer "${id}"`);
	return spec;
}

/**
 * Pause (reason `user`) or resume. Resume also clears an auto-pause and restarts the failure count.
 * Pause cancels a pending machine wake; resume schedules it again if it is still ahead.
 */
export async function setPaused(
	id: string,
	paused: boolean,
	options: { now?: number; root?: string; expectedRev?: number; host?: WakeHost } = {},
): Promise<TimerSpec> {
	const root = options.root ?? timersRoot();
	await assertTimerMutationAllowed(id, paused ? "pause" : "resume", root);
	const now = options.now ?? Date.now();
	const at = new Date(now).toISOString();
	const { spec } = await mutateTimerSpec(
		id,
		current => {
			if (!current) throw new Error(`No timer "${id}"`);
			if (paused) return { ...current, paused: true, pausedReason: "user" };
			return { ...current, paused: false, pausedReason: undefined, resumedAt: at };
		},
		{ root, expectedRev: options.expectedRev },
	);
	if (!spec) throw new Error(`No timer "${id}"`);
	const warnings = await syncWake(id, spec, { root, now, host: options.host });
	if (warnings.length) logger.warn("timer machine wake not restored on resume", { id, warnings });
	return spec;
}

/**
 * Remove the spec (kept under history/) and cancel its pending machine wake. Run history stays in the
 * store so `runs` still answers what happened.
 */
export async function removeTimer(
	id: string,
	root = timersRoot(),
	options: { now?: number; host?: WakeHost } = {},
): Promise<boolean> {
	await assertTimerMutationAllowed(id, "remove", root);
	const { previous } = await mutateTimerSpec(id, () => undefined, { root });
	await syncWake(id, undefined, { root, now: options.now ?? Date.now(), host: options.host });
	return previous !== undefined;
}

export async function timerRuns(id: string, options: { limit?: number; root?: string } = {}): Promise<RunView[]> {
	return openTimerDb(options.root ?? timersRoot()).listRuns(id, options.limit);
}

export interface TimerLog {
	runId: string;
	path: string;
	text: string;
}

/** The runner log of one run (default: the newest run that has one). */
export async function timerLog(id: string, seq?: number, root = timersRoot()): Promise<TimerLog | undefined> {
	const runs = openTimerDb(root).listRuns(id);
	const candidates =
		seq !== undefined ? runs.filter(run => run.seq === seq) : runs.filter(run => run.runner).reverse();
	for (const run of candidates) {
		const file = runLogPath(id, run.seq, root);
		try {
			return { runId: run.runId, path: file, text: await Bun.file(file).text() };
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}
	return undefined;
}
