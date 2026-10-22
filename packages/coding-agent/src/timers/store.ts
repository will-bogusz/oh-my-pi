/**
 * Timer storage.
 *
 * Specs (desired configuration) are Markdown files `specs/<id>.md`. Every
 * write goes through {@link mutateTimerSpec}: it holds the spec's lock while
 * it reads, applies the change and atomically renames the new file into place
 * with `rev + 1`, so two processes editing one timer serialize instead of
 * losing an update, and a caller that names the rev it saw gets a
 * {@link TimerConflictError} instead of overwriting a newer spec. The
 * previous revision is kept under `history/<id>/<rev>.md`.
 *
 * Execution state is SQLite `timers.db` (WAL, busy_timeout). Each table has
 * one writer kind:
 * - `timer_state`, `runs`, `incidents`, `meta` ticker heartbeat: the tick
 *   (and manual fire, which takes the tick lock);
 * - `run_ends`: the runner process that carried the run (the tick only to
 *   close a run whose runner never started);
 * - `deliveries`: whoever delivered the mail (runner, mailbox consumer).
 * Everything else reads.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireFileLock, isEnoent, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { specHistoryPath, specLockPath, specPath, specsDir, TIMER_ID_PATTERN, timersDbPath, timersRoot } from "./paths";
import { parseDuration, serializeDuration } from "./schedule";
import type {
	AgentRunSettings,
	DeliveryRecord,
	EndRecord,
	RunOutcome,
	RunRecord,
	RunTrigger,
	TimerDoneWhy,
	TimerFireData,
	TimerReport,
	TimerSpec,
	TimerState,
	TimerTarget,
} from "./types";

/** Spec file format this omp reads and writes; a newer file is listed as invalid rather than misread. */
export const TIMER_SPEC_VERSION = 1;
/** `timers.db` schema this omp reads and writes. */
export const TIMER_DB_SCHEMA_VERSION = 1;
/** Default for `pauseAfter`. */
export const DEFAULT_PAUSE_AFTER = 3;

// ─── Specs ──────────────────────────────────────────────────────────────────

/** A spec write named a rev that is no longer current. */
export class TimerConflictError extends Error {
	constructor(
		readonly id: string,
		readonly expectedRev: number | undefined,
		readonly actualRev: number | undefined,
	) {
		super(
			actualRev === undefined
				? `timer ${id} was removed by another writer`
				: `timer ${id} changed since rev ${expectedRev} (now rev ${actualRev}); re-read it and apply your change again`,
		);
		this.name = "TimerConflictError";
	}
}

function str(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (value instanceof Date) return value.toISOString();
	return String(value);
}

function int(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) ? parsed : undefined;
}

function num(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function strList(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	const list = (Array.isArray(value) ? value : [value]).map(item => String(item).trim()).filter(Boolean);
	return list.length ? list : undefined;
}

const REPORT_MODES: Record<TimerReport, true> = { always: true, said: true, failure: true, never: true };

function isTimerReport(value: unknown): value is TimerReport {
	return typeof value === "string" && Object.hasOwn(REPORT_MODES, value);
}

/** `report` when the spec does not say. */
export const DEFAULT_TIMER_REPORT: TimerReport = "said";

function parseTarget(session: string | undefined, sessionFile: string | undefined): TimerTarget {
	if (!session || session === "fresh") return { kind: "fresh" };
	if (session === "own") return { kind: "own" };
	return { kind: "session", sessionId: session, sessionFile };
}

function parseRunSettings(fm: Record<string, unknown>): AgentRunSettings {
	const maxTime = str(fm.max_time);
	return {
		agent: str(fm.agent),
		thinking: str(fm.thinking),
		hermetic: fm.hermetic === true || undefined,
		runCwd: fm.cwd === "run" || undefined,
		maxTimeMs: maxTime ? parseDuration(maxTime) : undefined,
		maxCost: num(fm.max_cost),
		expect: strList(fm.expect),
		before: str(fm.before),
		after: str(fm.after),
	};
}

/** Parse a spec file. Throws with the file path on malformed or newer-format content. */
export function parseTimerSpec(id: string, content: string, filePath: string): TimerSpec {
	const { frontmatter: fm, body } = parseFrontmatter(content, {
		level: "fatal",
		rawKeys: true,
		repair: false,
		location: filePath,
	});
	const version = int(fm.version) ?? 1;
	if (version > TIMER_SPEC_VERSION) {
		throw new Error(`${filePath}: spec version ${version} is newer than this omp supports (${TIMER_SPEC_VERSION})`);
	}
	const reason = str(fm.reason);
	if (!reason) throw new Error(`${filePath}: missing reason`);
	const session = str(fm.session);
	const target = parseTarget(session, str(fm.session_file));
	const shell = str(fm.shell);
	const created = (fm.created ?? {}) as Record<string, unknown>;
	const createdAt = str(created.at) ?? new Date(0).toISOString();
	const grace = str(fm.grace);
	return {
		id,
		rev: int(fm.rev) ?? 1,
		title: str(fm.title),
		reason,
		at: str(fm.at),
		every: str(fm.every),
		tz: str(fm.tz) ?? "UTC",
		target,
		whenClosed: fm.when_closed === "hold" ? "hold" : "resume",
		action: shell ? { kind: "shell", command: shell } : { kind: "prompt", prompt: body.trim() },
		cwd: (fm.cwd === "run" ? str(created.cwd) : str(fm.cwd)) || process.cwd(),
		expiresAt: str(fm.expires),
		maxRuns: int(fm.max_runs),
		overlap: fm.overlap === "queue" ? "queue" : "skip",
		graceMs: grace ? parseDuration(grace) : undefined,
		catchup: fm.catchup === "skip" ? "skip" : "run",
		pauseAfter: int(fm.pause_after) ?? DEFAULT_PAUSE_AFTER,
		allowTimers: fm.allow_timers === true,
		model: str(fm.model),
		run: parseRunSettings(fm),
		report: isTimerReport(fm.report) ? fm.report : DEFAULT_TIMER_REPORT,
		paused: fm.paused === true,
		pausedReason: str(fm.paused_reason),
		armedAt: str(fm.armed_at) ?? createdAt,
		resumedAt: str(fm.resumed_at),
		created: {
			at: createdAt,
			by: created.by === "tool" ? "tool" : "cli",
			host: str(created.host) ?? "",
			cwd: str(created.cwd) ?? "",
			session: str(created.session),
			sessionFile: str(created.session_file),
			whenText: str(created.when_text) ?? "",
			run: str(created.run),
		},
	};
}

/** Serialize a spec to its file form. Keys are snake_case; the prompt is the body. */
export function serializeTimerSpec(spec: TimerSpec): string {
	const fm: Record<string, unknown> = { version: TIMER_SPEC_VERSION, rev: spec.rev };
	if (spec.title) fm.title = spec.title;
	fm.reason = spec.reason;
	if (spec.at) fm.at = spec.at;
	if (spec.every) fm.every = spec.every;
	fm.tz = spec.tz;
	if (spec.target.kind === "session") {
		fm.session = spec.target.sessionId;
		if (spec.target.sessionFile) fm.session_file = spec.target.sessionFile;
		fm.when_closed = spec.whenClosed;
	} else {
		fm.session = spec.target.kind;
	}
	if (spec.action.kind === "shell") fm.shell = spec.action.command;
	fm.cwd = spec.run.runCwd ? "run" : spec.cwd;
	if (spec.expiresAt) fm.expires = spec.expiresAt;
	if (spec.maxRuns !== undefined) fm.max_runs = spec.maxRuns;
	fm.overlap = spec.overlap;
	if (spec.graceMs !== undefined) fm.grace = serializeDuration(spec.graceMs);
	if (spec.catchup === "skip") fm.catchup = "skip";
	fm.pause_after = spec.pauseAfter;
	if (spec.allowTimers) fm.allow_timers = true;
	if (spec.model) fm.model = spec.model;
	if (spec.run.agent) fm.agent = spec.run.agent;
	if (spec.run.thinking) fm.thinking = spec.run.thinking;
	if (spec.run.hermetic) fm.hermetic = true;
	if (spec.run.maxTimeMs !== undefined) fm.max_time = serializeDuration(spec.run.maxTimeMs);
	if (spec.run.maxCost !== undefined) fm.max_cost = spec.run.maxCost;
	if (spec.run.expect?.length) fm.expect = spec.run.expect;
	if (spec.run.before) fm.before = spec.run.before;
	if (spec.run.after) fm.after = spec.run.after;
	if (spec.report !== DEFAULT_TIMER_REPORT) fm.report = spec.report;
	if (spec.paused) {
		fm.paused = true;
		if (spec.pausedReason) fm.paused_reason = spec.pausedReason;
	}
	fm.armed_at = spec.armedAt;
	if (spec.resumedAt) fm.resumed_at = spec.resumedAt;
	const created: Record<string, unknown> = {
		at: spec.created.at,
		by: spec.created.by,
		host: spec.created.host,
		cwd: spec.created.cwd,
	};
	if (spec.created.session) created.session = spec.created.session;
	if (spec.created.sessionFile) created.session_file = spec.created.sessionFile;
	created.when_text = spec.created.whenText;
	if (spec.created.run) created.run = spec.created.run;
	fm.created = created;
	const body = spec.action.kind === "prompt" ? spec.action.prompt : "";
	return `---\n${YAML.stringify(fm, null, 2).trimEnd()}\n---\n${body}\n`;
}

async function readSpecFile(id: string, root: string): Promise<{ spec: TimerSpec; text: string } | undefined> {
	const file = specPath(id, root);
	let text: string;
	try {
		text = await Bun.file(file).text();
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	return { spec: parseTimerSpec(id, text, file), text };
}

export async function readTimerSpec(id: string, root = timersRoot()): Promise<TimerSpec | undefined> {
	return (await readSpecFile(id, root))?.spec;
}

/** The spec as it was at `rev`: the current file, or its archived revision; `undefined` when neither exists. */
export async function readTimerSpecAt(id: string, rev: number, root = timersRoot()): Promise<TimerSpec | undefined> {
	const current = await readSpecFile(id, root);
	if (current?.spec.rev === rev) return current.spec;
	const file = specHistoryPath(id, rev, root);
	try {
		return parseTimerSpec(id, await Bun.file(file).text(), file);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

/** Newest archived rev of `id` (0 when none): a re-created id continues after it instead of overwriting history. */
async function lastArchivedRev(id: string, root: string): Promise<number> {
	let names: string[];
	try {
		names = await fs.promises.readdir(path.dirname(specHistoryPath(id, 1, root)));
	} catch (err) {
		if (isEnoent(err)) return 0;
		throw err;
	}
	return Math.max(0, ...names.map(name => Number.parseInt(name, 10)).filter(Number.isInteger));
}

/** Atomic replace: readers never see a torn spec. */
async function writeSpecFile(file: string, content: string): Promise<void> {
	const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
	await Bun.write(tmp, content);
	await fs.promises.rename(tmp, file);
}

export interface SpecMutation {
	/** Fail with {@link TimerConflictError} unless the current spec has this rev (or is absent, for `0`). */
	expectedRev?: number;
	root?: string;
}

/**
 * Read-modify-write one spec under its lock. `mutate` receives the current
 * spec (or undefined) and returns the next one, or `undefined` to delete it.
 * The written spec gets the next rev after the current one, or after the
 * newest archived one when the id was removed, so a rev names one revision
 * for good; the previous file is kept in history. Returns the written spec
 * and the one it replaced.
 */
export async function mutateTimerSpec(
	id: string,
	mutate: (current: TimerSpec | undefined) => TimerSpec | undefined | Promise<TimerSpec | undefined>,
	options: SpecMutation = {},
): Promise<{ spec: TimerSpec | undefined; previous: TimerSpec | undefined }> {
	const root = options.root ?? timersRoot();
	await fs.promises.mkdir(specsDir(root), { recursive: true });
	const lock = await acquireFileLock(specLockPath(id, root), { retries: 200, retryDelayMs: 50 });
	try {
		const current = await readSpecFile(id, root);
		const currentRev = current?.spec.rev;
		if (options.expectedRev !== undefined && (currentRev ?? 0) !== options.expectedRev) {
			throw new TimerConflictError(id, options.expectedRev, currentRev);
		}
		const next = await mutate(current ? structuredClone(current.spec) : undefined);
		if (current) await Bun.write(specHistoryPath(id, current.spec.rev, root), current.text);
		if (!next) {
			if (current) await fs.promises.unlink(specPath(id, root));
			return { spec: undefined, previous: current?.spec };
		}
		next.id = id;
		next.rev = (currentRev ?? (await lastArchivedRev(id, root))) + 1;
		await writeSpecFile(specPath(id, root), serializeTimerSpec(next));
		return { spec: next, previous: current?.spec };
	} finally {
		lock.release();
	}
}

export interface LoadedTimers {
	specs: TimerSpec[];
	/** Spec files that failed to parse; listed so a broken file is never silently ignored. */
	errors: { id: string; error: string }[];
}

export async function listTimerSpecs(root = timersRoot()): Promise<LoadedTimers> {
	let names: string[];
	try {
		names = await fs.promises.readdir(specsDir(root));
	} catch (err) {
		if (isEnoent(err)) return { specs: [], errors: [] };
		throw err;
	}
	const specs: TimerSpec[] = [];
	const errors: { id: string; error: string }[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".md")) continue;
		const id = name.slice(0, -3);
		if (!TIMER_ID_PATTERN.test(id)) continue;
		try {
			const spec = await readTimerSpec(id, root);
			if (spec) specs.push(spec);
		} catch (err) {
			errors.push({ id, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return { specs, errors };
}

// ─── Execution state (SQLite) ───────────────────────────────────────────────

// The gate_* columns belong to condition timers; they are part of schema 1 so a store created before
// conditions existed needs no migration.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS timer_state (
	id TEXT PRIMARY KEY,
	armed_at TEXT,
	last_slot INTEGER,
	seq INTEGER NOT NULL DEFAULT 0,
	run_count INTEGER NOT NULL DEFAULT 0,
	fail_streak INTEGER NOT NULL DEFAULT 0,
	streak_reset_at TEXT,
	pending_pause TEXT,
	gate_checks INTEGER,
	gate_last_check_at TEXT,
	gate_last_exit INTEGER,
	done_at TEXT,
	done_why TEXT,
	queued_seq INTEGER,
	queued_slot INTEGER,
	queued_missed INTEGER,
	queued_data TEXT
);
CREATE TABLE IF NOT EXISTS runs (
	timer_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	run_id TEXT NOT NULL UNIQUE,
	at TEXT NOT NULL,
	slot TEXT,
	trigger TEXT NOT NULL,
	outcome TEXT NOT NULL,
	missed_slots INTEGER,
	gate_exit INTEGER,
	detail TEXT,
	rev INTEGER NOT NULL,
	generation TEXT,
	runner INTEGER NOT NULL DEFAULT 0,
	dispatched_at TEXT,
	settled_at TEXT,
	PRIMARY KEY (timer_id, seq)
);
CREATE TABLE IF NOT EXISTS run_ends (
	run_id TEXT PRIMARY KEY,
	timer_id TEXT NOT NULL,
	started_at TEXT,
	at TEXT,
	ok INTEGER,
	exit_code INTEGER,
	duration_ms INTEGER,
	detail TEXT
);
CREATE TABLE IF NOT EXISTS deliveries (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	timer_id TEXT NOT NULL,
	at TEXT NOT NULL,
	state TEXT NOT NULL,
	session TEXT,
	detail TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_run ON deliveries(run_id);
CREATE TABLE IF NOT EXISTS incidents (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	timer_id TEXT NOT NULL,
	signature TEXT NOT NULL,
	summary TEXT NOT NULL,
	first_at TEXT NOT NULL,
	last_at TEXT NOT NULL,
	count INTEGER NOT NULL,
	alerted_at TEXT,
	resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_open ON incidents(timer_id, signature) WHERE resolved_at IS NULL;
`;

/** `busy_timeout`: writers are short transactions, so a contended one waits rather than failing. */
const BUSY_TIMEOUT_MS = 5000;

export interface TickerStatus {
	lastTickAt?: string;
	pid?: number;
	version?: string;
}

/** A run joined with its delivery and end, as `runs`/`ls`/`show` present it. */
export interface RunView {
	runId: string;
	seq: number;
	at: string;
	slot?: string;
	trigger: RunTrigger;
	outcome: RunOutcome;
	missedSlots?: number;
	detail?: string;
	rev: number;
	generation?: string;
	dispatchedAt?: string;
	settledAt?: string;
	runner: boolean;
	delivery?: { state: string; at: string; detail?: string };
	end?: { startedAt?: string; at?: string; ok?: boolean; exitCode?: number; durationMs?: number; detail?: string };
}

export interface IncidentRow {
	id: number;
	timerId: string;
	signature: string;
	summary: string;
	firstAt: string;
	lastAt: string;
	count: number;
	alertedAt?: string;
	resolvedAt?: string;
}

interface StateRow {
	armed_at: string | null;
	last_slot: number | null;
	seq: number;
	run_count: number;
	fail_streak: number;
	streak_reset_at: string | null;
	pending_pause: string | null;
	done_at: string | null;
	done_why: string | null;
	queued_seq: number | null;
	queued_slot: number | null;
	queued_missed: number | null;
	queued_data: string | null;
}

interface RunRow {
	timer_id: string;
	seq: number;
	run_id: string;
	at: string;
	slot: string | null;
	trigger: string;
	outcome: string;
	missed_slots: number | null;
	detail: string | null;
	rev: number;
	generation: string | null;
	runner: number;
	dispatched_at: string | null;
	settled_at: string | null;
	end_started_at: string | null;
	end_at: string | null;
	end_ok: number | null;
	end_exit_code: number | null;
	end_duration_ms: number | null;
	end_detail: string | null;
}

interface IncidentDbRow {
	id: number;
	timer_id: string;
	signature: string;
	summary: string;
	first_at: string;
	last_at: string;
	count: number;
	alerted_at: string | null;
	resolved_at: string | null;
}

const nullable = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

function toIncident(row: IncidentDbRow): IncidentRow {
	return {
		id: row.id,
		timerId: row.timer_id,
		signature: row.signature,
		summary: row.summary,
		firstAt: row.first_at,
		lastAt: row.last_at,
		count: row.count,
		alertedAt: nullable(row.alerted_at),
		resolvedAt: nullable(row.resolved_at),
	};
}

const DELIVERED: Record<string, true> = { "delivered-live": true, "resumed-headless": true };

const RUN_SELECT = `SELECT r.*, e.started_at AS end_started_at, e.at AS end_at, e.ok AS end_ok,
	e.exit_code AS end_exit_code, e.duration_ms AS end_duration_ms, e.detail AS end_detail
	FROM runs r LEFT JOIN run_ends e ON e.run_id = r.run_id`;

/** The execution-state database of one timers root. */
export class TimerDb {
	readonly path: string;
	#db: Database;

	constructor(file: string) {
		this.path = file;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		this.#db = new Database(file, { create: true });
		this.#db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#db.run("PRAGMA synchronous = NORMAL");
		const stored = this.#metaRaw("schema_version");
		if (stored !== undefined && Number(stored) > TIMER_DB_SCHEMA_VERSION) {
			this.#db.close();
			throw new Error(
				`${file} has schema ${stored}, newer than this omp supports (${TIMER_DB_SCHEMA_VERSION}); update omp`,
			);
		}
		// IMMEDIATE: a deferred transaction that reads the schema and then writes fails at once with
		// SQLITE_BUSY (busy_timeout does not apply to a stale read snapshot) when another process commits in
		// between, e.g. two runners dispatched by the same tick.
		this.#db
			.transaction(() => {
				this.#db.run(SCHEMA);
				this.#db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)", [
					String(TIMER_DB_SCHEMA_VERSION),
				]);
			})
			.immediate();
	}

	#metaRaw(key: string): string | undefined {
		try {
			return (
				this.#db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ??
				undefined
			);
		} catch {
			return undefined; // fresh file: no meta table yet
		}
	}

	close(): void {
		this.#db.close();
	}

	/** Run `fn` in one `BEGIN IMMEDIATE` transaction (the write lock is taken up front, so no upgrade deadlock). */
	write<T>(fn: () => T): T {
		return this.#db.transaction(fn).immediate();
	}

	schemaVersion(): number | undefined {
		const value = this.#metaRaw("schema_version");
		return value === undefined ? undefined : Number(value);
	}

	// tick: heartbeat
	writeHeartbeat(status: Required<TickerStatus>): void {
		this.#db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('ticker', ?)", [JSON.stringify(status)]);
	}

	readHeartbeat(): TickerStatus {
		const raw = this.#metaRaw("ticker");
		return raw ? (JSON.parse(raw) as TickerStatus) : {};
	}

	/** doctor: prove this process can take the write lock and commit. */
	writeProbe(at: string): void {
		this.#db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('doctor_probe', ?)", [at]);
	}

	// tick: timer_state
	readState(id: string): TimerState {
		const row = this.#db.query<StateRow, [string]>("SELECT * FROM timer_state WHERE id = ?").get(id);
		if (!row) return { seq: 0, runCount: 0, failStreak: 0 };
		return {
			armedAt: nullable(row.armed_at),
			lastSlot: nullable(row.last_slot),
			seq: row.seq,
			runCount: row.run_count,
			failStreak: row.fail_streak,
			streakResetAt: nullable(row.streak_reset_at),
			pendingPause: nullable(row.pending_pause),
			done: row.done_at !== null ? { at: row.done_at, why: (row.done_why ?? "once") as TimerDoneWhy } : undefined,
			queued:
				row.queued_seq !== null
					? {
							seq: row.queued_seq,
							slot: nullable(row.queued_slot),
							missedSlots: row.queued_missed ?? 0,
							data: row.queued_data ? (JSON.parse(row.queued_data) as TimerFireData) : undefined,
						}
					: undefined,
		};
	}

	writeState(id: string, state: TimerState): void {
		this.#db.run(
			`INSERT OR REPLACE INTO timer_state (id, armed_at, last_slot, seq, run_count, fail_streak, streak_reset_at,
				pending_pause, done_at, done_why, queued_seq, queued_slot, queued_missed, queued_data)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				state.armedAt ?? null,
				state.lastSlot ?? null,
				state.seq,
				state.runCount,
				state.failStreak,
				state.streakResetAt ?? null,
				state.pendingPause ?? null,
				state.done?.at ?? null,
				state.done?.why ?? null,
				state.queued?.seq ?? null,
				state.queued?.slot ?? null,
				state.queued?.missedSlots ?? null,
				state.queued?.data ? JSON.stringify(state.queued.data) : null,
			],
		);
	}

	// tick: runs
	insertRun(id: string, run: RunRecord, runner: boolean): void {
		this.#db.run(
			`INSERT INTO runs (timer_id, seq, run_id, at, slot, trigger, outcome, missed_slots, detail, rev, generation,
				runner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				run.seq,
				run.runId,
				run.at,
				run.slot ?? null,
				run.trigger,
				run.outcome,
				run.missedSlots ?? null,
				run.detail ?? null,
				run.rev,
				run.generation ?? null,
				runner ? 1 : 0,
			],
		);
	}

	/** A queued run is dispatched: it becomes `fired` at `at`. */
	promoteQueuedRun(runId: string, at: string, runner: boolean): void {
		this.#db.run("UPDATE runs SET outcome = 'fired', at = ?, runner = ? WHERE run_id = ? AND outcome = 'queued'", [
			at,
			runner ? 1 : 0,
			runId,
		]);
	}

	/** The side effect happened, by the route actually taken (`runner`: a detached runner carries the run). */
	markDispatched(runId: string, at: string, runner: boolean): void {
		this.#db.run("UPDATE runs SET dispatched_at = ?, runner = ? WHERE run_id = ?", [at, runner ? 1 : 0, runId]);
	}

	/** The tick has applied this run's terminal result to the failure policy. */
	markSettled(runId: string, at: string, outcome?: RunOutcome, detail?: string): void {
		this.#db.run(
			"UPDATE runs SET settled_at = ?, outcome = COALESCE(?, outcome), detail = COALESCE(?, detail) WHERE run_id = ?",
			[at, outcome ?? null, detail ?? null, runId],
		);
	}

	/** Fired runs whose result the tick has not yet applied, oldest first. */
	unsettledRuns(id: string): RunView[] {
		return this.#db
			.query<RunRow, [string]>(
				`${RUN_SELECT} WHERE r.timer_id = ? AND r.outcome = 'fired' AND r.settled_at IS NULL ORDER BY r.seq`,
			)
			.all(id)
			.map(row => this.#view(row));
	}

	listRuns(id: string, limit?: number): RunView[] {
		const rows =
			limit === undefined
				? this.#db.query<RunRow, [string]>(`${RUN_SELECT} WHERE r.timer_id = ? ORDER BY r.seq`).all(id)
				: this.#db
						.query<RunRow, [string, number]>(
							`SELECT * FROM (${RUN_SELECT} WHERE r.timer_id = ? ORDER BY r.seq DESC LIMIT ?) ORDER BY seq`,
						)
						.all(id, limit);
		return rows.map(row => this.#view(row));
	}

	getRun(runId: string): RunView | undefined {
		const row = this.#db.query<RunRow, [string]>(`${RUN_SELECT} WHERE r.run_id = ?`).get(runId);
		return row ? this.#view(row) : undefined;
	}

	#view(row: RunRow): RunView {
		const deliveries = this.#db
			.query<{ state: string; at: string; detail: string | null }, [string]>(
				"SELECT state, at, detail FROM deliveries WHERE run_id = ? ORDER BY id",
			)
			.all(row.run_id);
		let delivery: RunView["delivery"];
		for (const record of deliveries) {
			// A later "queued"/"held" note (a runner standing down) never hides a completed delivery.
			if (delivery && DELIVERED[delivery.state]) continue;
			delivery = { state: record.state, at: record.at, detail: nullable(record.detail) };
		}
		const hasEnd = row.end_started_at !== null || row.end_at !== null;
		const end = hasEnd
			? {
					startedAt: nullable(row.end_started_at),
					at: nullable(row.end_at),
					ok: row.end_ok === null ? undefined : row.end_ok === 1,
					exitCode: nullable(row.end_exit_code),
					durationMs: nullable(row.end_duration_ms),
					detail: nullable(row.end_detail),
				}
			: undefined;
		return {
			runId: row.run_id,
			seq: row.seq,
			at: row.at,
			slot: nullable(row.slot),
			trigger: row.trigger as RunTrigger,
			outcome: (end?.ok === false ? "failed" : row.outcome) as RunOutcome,
			missedSlots: nullable(row.missed_slots),
			detail: nullable(row.detail),
			rev: row.rev,
			generation: nullable(row.generation),
			runner: row.runner === 1,
			dispatchedAt: nullable(row.dispatched_at),
			settledAt: nullable(row.settled_at),
			delivery,
			end,
		};
	}

	// runner: run_ends
	/**
	 * Claim a run for execution: exactly one runner ever wins a run id, so a
	 * re-dispatched or doubly spawned runner never repeats a side effect.
	 */
	claimRunStart(timerId: string, runId: string, at: string): boolean {
		return (
			this.#db.run("INSERT OR IGNORE INTO run_ends (run_id, timer_id, started_at) VALUES (?, ?, ?)", [
				runId,
				timerId,
				at,
			]).changes === 1
		);
	}

	/**
	 * tick: record the end of a runner-carried run whose runner is gone without claiming it, taking the
	 * claim so a runner that starts late stands down. `false` when a runner claimed it first.
	 */
	closeUnclaimedRun(timerId: string, runId: string, at: string, ok: boolean, detail: string): boolean {
		return (
			this.#db.run("INSERT OR IGNORE INTO run_ends (run_id, timer_id, at, ok, detail) VALUES (?, ?, ?, ?, ?)", [
				runId,
				timerId,
				at,
				ok ? 1 : 0,
				detail,
			]).changes === 1
		);
	}

	recordRunEnd(timerId: string, end: EndRecord): void {
		this.#db.run(
			`INSERT INTO run_ends (run_id, timer_id, at, ok, exit_code, duration_ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(run_id) DO UPDATE SET at = excluded.at, ok = excluded.ok, exit_code = excluded.exit_code,
				duration_ms = excluded.duration_ms, detail = excluded.detail`,
			[end.runId, timerId, end.at, end.ok ? 1 : 0, end.exitCode ?? null, end.durationMs, end.detail ?? null],
		);
	}

	// runner / mailbox consumer: deliveries
	recordDelivery(timerId: string, delivery: DeliveryRecord): void {
		this.#db.run("INSERT INTO deliveries (run_id, timer_id, at, state, session, detail) VALUES (?, ?, ?, ?, ?, ?)", [
			delivery.runId,
			timerId,
			delivery.at,
			delivery.state,
			delivery.session ?? null,
			delivery.detail ?? null,
		]);
	}

	// tick: incidents
	openIncident(timerId: string, signature: string): IncidentRow | undefined {
		const row = this.#db
			.query<IncidentDbRow, [string, string]>(
				"SELECT * FROM incidents WHERE timer_id = ? AND signature = ? AND resolved_at IS NULL",
			)
			.get(timerId, signature);
		return row ? toIncident(row) : undefined;
	}

	listIncidents(timerId: string): IncidentRow[] {
		return this.#db
			.query<IncidentDbRow, [string]>("SELECT * FROM incidents WHERE timer_id = ? ORDER BY id")
			.all(timerId)
			.map(toIncident);
	}

	/** Count one occurrence; opens the incident when none is open for this signature. */
	bumpIncident(timerId: string, signature: string, summary: string, at: string): IncidentRow {
		this.#db.run(
			`INSERT INTO incidents (timer_id, signature, summary, first_at, last_at, count) VALUES (?, ?, ?, ?, ?, 1)
				ON CONFLICT(timer_id, signature) WHERE resolved_at IS NULL
				DO UPDATE SET count = count + 1, last_at = excluded.last_at, summary = excluded.summary`,
			[timerId, signature, summary, at, at],
		);
		const incident = this.openIncident(timerId, signature);
		if (!incident) throw new Error(`incident ${timerId}/${signature} vanished`);
		return incident;
	}

	markIncidentAlerted(id: number, at: string): void {
		this.#db.run("UPDATE incidents SET alerted_at = ? WHERE id = ?", [at, id]);
	}

	/** Close open incidents; `alertedOnly` keeps silent ones counting (a flaky timer that also succeeds). */
	resolveIncidents(timerId: string, at: string, options: { alertedOnly?: boolean } = {}): number {
		const alerted = options.alertedOnly ? " AND alerted_at IS NOT NULL" : "";
		return this.#db.run(`UPDATE incidents SET resolved_at = ? WHERE timer_id = ? AND resolved_at IS NULL${alerted}`, [
			at,
			timerId,
		]).changes;
	}

	resolveIncident(id: number, at: string): void {
		this.#db.run("UPDATE incidents SET resolved_at = ? WHERE id = ?", [at, id]);
	}
}

const openDbs = new Map<string, TimerDb>();

/** The (cached) execution-state database of a timers root. */
export function openTimerDb(root = timersRoot()): TimerDb {
	const file = timersDbPath(root);
	let db = openDbs.get(file);
	if (!db) {
		db = new TimerDb(file);
		openDbs.set(file, db);
	}
	return db;
}

/** Close every cached connection (tests that delete their store). */
export function closeTimerDbs(): void {
	for (const db of openDbs.values()) db.close();
	openDbs.clear();
}

/** A delivery record from whoever delivered a fire (runner, mailbox consumer). */
export function recordDelivery(timerId: string, delivery: DeliveryRecord, root = timersRoot()): void {
	openTimerDb(root).recordDelivery(timerId, delivery);
}

export function readTickerStatus(root = timersRoot()): TickerStatus {
	return openTimerDb(root).readHeartbeat();
}

export interface StoreHealth {
	writable: boolean;
	schemaVersion?: number;
	expectedSchemaVersion: number;
	error?: string;
}

/** Whether this process can open and write the store (doctor). */
export function storeHealth(root = timersRoot()): StoreHealth {
	try {
		const db = openTimerDb(root);
		db.write(() => db.writeProbe(new Date().toISOString()));
		return { writable: true, schemaVersion: db.schemaVersion(), expectedSchemaVersion: TIMER_DB_SCHEMA_VERSION };
	} catch (err) {
		return {
			writable: false,
			expectedSchemaVersion: TIMER_DB_SCHEMA_VERSION,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
