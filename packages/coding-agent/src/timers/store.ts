/**
 * On-disk store: spec files (`specs/<id>.md`), per-timer `state.json`, and the
 * append-only `runs.jsonl` ledger.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { specPath, specsDir, TIMER_ID_PATTERN, timerStateDir } from "./paths";
import type { LedgerRecord, TimerSpec, TimerState, TimerTarget } from "./types";

function str(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (value instanceof Date) return value.toISOString();
	return String(value);
}

/** Parse a spec file. Throws with the file path on malformed content. */
export function parseTimerSpec(id: string, content: string, filePath: string): TimerSpec {
	const { frontmatter: fm, body } = parseFrontmatter(content, {
		level: "fatal",
		rawKeys: true,
		repair: false,
		location: filePath,
	});
	const reason = str(fm.reason);
	if (!reason) throw new Error(`${filePath}: missing reason`);
	const session = str(fm.session);
	const target: TimerTarget =
		!session || session === "fresh"
			? { kind: "fresh" }
			: { kind: "session", sessionId: session, sessionFile: str(fm.session_file) };
	const shell = str(fm.shell);
	const created = (fm.created ?? {}) as Record<string, unknown>;
	const maxRuns = fm.max_runs === undefined ? undefined : Number(fm.max_runs);
	return {
		id,
		title: str(fm.title),
		reason,
		at: str(fm.at),
		every: str(fm.every),
		until: str(fm.until),
		condition: str(fm.condition),
		tz: str(fm.tz) ?? "UTC",
		target,
		whenClosed: fm.when_closed === "hold" ? "hold" : "resume",
		action: shell ? { kind: "shell", command: shell } : { kind: "prompt", prompt: body },
		cwd: str(fm.cwd) ?? process.cwd(),
		expiresAt: str(fm.expires),
		maxRuns: Number.isFinite(maxRuns) ? maxRuns : undefined,
		overlap: "skip",
		model: str(fm.model),
		paused: fm.paused === true,
		created: {
			at: str(created.at) ?? new Date(0).toISOString(),
			by: created.by === "cli" ? "cli" : "tool",
			host: str(created.host) ?? "",
			cwd: str(created.cwd) ?? "",
			session: str(created.session),
			sessionFile: str(created.session_file),
			whenText: str(created.when_text) ?? "",
		},
	};
}

/** Serialize a spec to its file form. Keys are snake_case; the prompt is the body. */
export function serializeTimerSpec(spec: TimerSpec): string {
	const fm: Record<string, unknown> = { version: 1 };
	if (spec.title) fm.title = spec.title;
	fm.reason = spec.reason;
	if (spec.at) fm.at = spec.at;
	if (spec.every) fm.every = spec.every;
	if (spec.until) fm.until = spec.until;
	if (spec.condition) fm.condition = spec.condition;
	fm.tz = spec.tz;
	if (spec.target.kind === "session") {
		fm.session = spec.target.sessionId;
		if (spec.target.sessionFile) fm.session_file = spec.target.sessionFile;
		fm.when_closed = spec.whenClosed;
	} else {
		fm.session = "fresh";
	}
	if (spec.action.kind === "shell") fm.shell = spec.action.command;
	fm.cwd = spec.cwd;
	if (spec.expiresAt) fm.expires = spec.expiresAt;
	if (spec.maxRuns !== undefined) fm.max_runs = spec.maxRuns;
	fm.overlap = spec.overlap;
	if (spec.model) fm.model = spec.model;
	if (spec.paused) fm.paused = true;
	const created: Record<string, unknown> = {
		at: spec.created.at,
		by: spec.created.by,
		host: spec.created.host,
		cwd: spec.created.cwd,
	};
	if (spec.created.session) created.session = spec.created.session;
	if (spec.created.sessionFile) created.session_file = spec.created.sessionFile;
	created.when_text = spec.created.whenText;
	fm.created = created;
	const body = spec.action.kind === "prompt" ? spec.action.prompt : "";
	return `---\n${YAML.stringify(fm, null, 2).trimEnd()}\n---\n${body}\n`;
}

export async function readTimerSpec(id: string): Promise<TimerSpec | undefined> {
	const file = specPath(id);
	try {
		return parseTimerSpec(id, await Bun.file(file).text(), file);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

export async function writeTimerSpec(spec: TimerSpec): Promise<void> {
	await Bun.write(specPath(spec.id), serializeTimerSpec(spec));
}

export async function removeTimerSpec(id: string): Promise<boolean> {
	try {
		await fs.unlink(specPath(id));
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

export interface LoadedTimers {
	specs: TimerSpec[];
	/** Spec files that failed to parse; listed so a broken file is never silently ignored. */
	errors: { id: string; error: string }[];
}

export async function listTimerSpecs(): Promise<LoadedTimers> {
	let names: string[];
	try {
		names = await fs.readdir(specsDir());
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
			const spec = await readTimerSpec(id);
			if (spec) specs.push(spec);
		} catch (err) {
			errors.push({ id, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return { specs, errors };
}

function statePath(id: string): string {
	return path.join(timerStateDir(id), "state.json");
}

function ledgerPath(id: string): string {
	return path.join(timerStateDir(id), "runs.jsonl");
}

export async function readTimerState(id: string): Promise<TimerState> {
	try {
		return (await Bun.file(statePath(id)).json()) as TimerState;
	} catch (err) {
		if (isEnoent(err)) return { seq: 0, runCount: 0, failStreak: 0 };
		throw err;
	}
}

/** Atomic replace: readers never see a torn state file. Only the tick (under the tick lock) writes it. */
export async function writeTimerState(id: string, state: TimerState): Promise<void> {
	const target = statePath(id);
	const tmp = `${target}.${process.pid}.tmp`;
	await Bun.write(tmp, `${JSON.stringify(state, null, 2)}\n`);
	await fs.rename(tmp, target);
}

/** Append one ledger line. Lines are small, so O_APPEND keeps concurrent writers' lines whole. */
export async function appendLedger(id: string, record: LedgerRecord): Promise<void> {
	const file = ledgerPath(id);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.appendFile(file, `${JSON.stringify(record)}\n`);
}

export async function readLedger(id: string): Promise<LedgerRecord[]> {
	let text: string;
	try {
		text = await Bun.file(ledgerPath(id)).text();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	return Bun.JSONL.parse(text) as LedgerRecord[];
}

/** A run joined with its delivery and end records, newest last. */
export interface RunView {
	runId: string;
	seq: number;
	at: string;
	slot?: string;
	trigger: string;
	outcome: string;
	missedSlots?: number;
	detail?: string;
	delivery?: { state: string; at: string; detail?: string };
	end?: { ok: boolean; exitCode?: number; durationMs: number; detail?: string };
}

export function joinRuns(records: LedgerRecord[]): RunView[] {
	const runs = new Map<string, RunView>();
	for (const record of records) {
		if (record.type === "run") {
			runs.set(record.runId, {
				runId: record.runId,
				seq: record.seq,
				at: record.at,
				slot: record.slot,
				trigger: record.trigger,
				outcome: record.outcome,
				missedSlots: record.missedSlots,
				detail: record.detail,
			});
			continue;
		}
		const run = runs.get(record.runId);
		if (!run) continue;
		if (record.type === "delivery") {
			// A later "queued"/"held" note (e.g. a runner standing down) never hides a completed delivery.
			const delivered = run.delivery?.state === "delivered-live" || run.delivery?.state === "resumed-headless";
			if (!delivered) run.delivery = { state: record.state, at: record.at, detail: record.detail };
		} else {
			run.end = { ok: record.ok, exitCode: record.exitCode, durationMs: record.durationMs, detail: record.detail };
			if (!record.ok) run.outcome = "failed";
		}
	}
	return [...runs.values()];
}
