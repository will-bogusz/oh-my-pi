/**
 * `timer://`: this machine's timer registry as readable resources, plus the
 * control verbs as handler writes. Reads list (`timer://`), show a card with
 * the full prompt (`timer://<id>`), list runs (`/runs`) and open one run with
 * its log (`/runs/<seq|latest>`).
 * Writes fire (`/fire`, content = untrusted run data), edit (`/edit`, content =
 * JSON of the fields to change), pause, resume and remove. Everything renders
 * from the store.
 */
import timerPromptDoc from "../prompts/internal-urls/timer.md" with { type: "text" };
import {
	editTimer,
	fireTimerNow,
	listTimers,
	loadTimerRow,
	readTickerStatus,
	removeTimer,
	renderRuns,
	renderTimerCard,
	renderTimerTable,
	requireTimer,
	runLogPath,
	setPaused,
	TIMER_ID_PATTERN,
	type RunView,
	timerRuns,
} from "../timers";
import { cfgTimerEnabled } from "../tools/settings";
import { type TimerEditFields, timerArgsTier, timerEditPatch, timerIdTier } from "../tools/timer-view";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	LocateOptions,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	WriteContext,
} from "./types";

const WRITE_ACTIONS = ["fire", "edit", "pause", "resume", "remove"] as const;
type TimerWriteAction = (typeof WRITE_ACTIONS)[number];

type TimerTarget =
	| { kind: "list" }
	| { kind: "show"; id: string }
	| { kind: "runs"; id: string }
	| { kind: "run"; id: string; seq: number | "latest" }
	| { kind: "write"; id: string; action: TimerWriteAction };

const PATH_RE = /^(?:\/(runs)(?:\/(\d+|latest))?|\/(fire|edit|pause|resume|remove))?\/?$/;

function parseTarget(url: InternalUrl): TimerTarget {
	const href = url.rawHref ?? url.href;
	const usage =
		"Use timer://, timer://<id>, timer://<id>/runs[/<seq>|/latest], or timer://<id>/{fire,edit,pause,resume,remove}.";
	const match = PATH_RE.exec(url.rawPathname ?? url.pathname);
	if (url.search || url.hash || !match) throw new Error(`Invalid timer:// URL: ${href}. ${usage}`);
	const id = url.rawHost;
	if (!id) {
		if (match[1] || match[3]) throw new Error(`timer:// needs a timer id here: ${href}. ${usage}`);
		return { kind: "list" };
	}
	if (!TIMER_ID_PATTERN.test(id)) throw new Error(`Invalid timer id: ${id}`);
	if (match[3]) return { kind: "write", id, action: match[3] as TimerWriteAction };
	if (match[2]) return { kind: "run", id, seq: match[2] === "latest" ? "latest" : Number(match[2]) };
	if (match[1]) return { kind: "runs", id };
	return { kind: "show", id };
}

/** `timer://<id>/edit` content: a JSON object of tool-shaped edit fields. */
function parseEditFields(content: string): TimerEditFields {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error('timer://<id>/edit takes a JSON object of the fields to change, e.g. {"at":"in 3h"}');
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("timer://<id>/edit content must be a JSON object");
	}
	return value as TimerEditFields;
}

/** Best-effort fields for the approval tier; malformed content fails in `write`. */
function editTierFields(content: string): TimerEditFields {
	try {
		return parseEditFields(content);
	} catch {
		return {};
	}
}

function textResource(url: InternalUrl, content: string, extra?: Partial<InternalResource>): InternalResource {
	return {
		url: url.rawHref ?? url.href,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content),
		...extra,
	};
}

/**
 * A timer's runs. A removed timer keeps its history, so only an id with
 * neither runs nor a spec is unknown.
 */
async function runsOf(id: string): Promise<RunView[]> {
	const runs = await timerRuns(id);
	if (runs.length === 0) await requireTimer(id);
	return runs;
}

/** The stored run `seq` (or the newest), or an error naming the runs that exist. */
async function findRun(id: string, seq: number | "latest"): Promise<RunView> {
	const runs = await runsOf(id);
	const run = seq === "latest" ? runs.at(-1) : runs.find(item => item.seq === seq);
	if (!run) {
		throw new Error(
			runs.length === 0
				? `timer ${id} has no runs yet`
				: `timer ${id} has no run ${seq}; runs: ${runs.map(item => item.seq).join(", ")}`,
		);
	}
	return run;
}

export class TimerProtocolHandler implements ProtocolHandler {
	readonly scheme = "timer";
	readonly spec: SchemeSpec = {
		backing: "virtual",
		selectors: "lines",
		immutable: false,
		write: {
			via: "handler",
			payload: "verbatim",
			scope: "workspace",
			tier: (url, content, session) => {
				const sessionId = session?.getSessionId?.() ?? undefined;
				const path = url.rawPathname ?? url.pathname;
				if (!/^\/edit\/?$/.test(path)) return timerIdTier(url.rawHost, sessionId);
				return timerArgsTier({ ...editTierFields(content ?? ""), op: "edit", id: url.rawHost }, sessionId);
			},
			contentOptional: () => true,
		},
	};

	promptDoc(): string {
		return timerPromptDoc.trim();
	}

	/** A run's log file, so `grep`/`bash` can address `timer://<id>/runs/<seq>` directly. */
	async locate(url: InternalUrl, _context?: ResolveContext, options?: LocateOptions): Promise<string | null> {
		const target = parseTarget(url);
		if (target.kind !== "run") return null;
		const seq = target.seq === "latest" ? (await timerRuns(target.id)).at(-1)?.seq : target.seq;
		if (seq === undefined) return null;
		const logPath = runLogPath(target.id, seq);
		return options?.create || (await Bun.file(logPath).exists()) ? logPath : null;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const target = parseTarget(url);
		const now = Date.now();
		const selfSessionId = context?.sessionId ?? context?.session?.getSessionId?.() ?? undefined;
		switch (target.kind) {
			case "list": {
				const { rows, errors } = await listTimers(now);
				const lines = [rows.length > 0 ? renderTimerTable(rows, now, await readTickerStatus()) : "no timers"];
				for (const { id, error } of errors) lines.push(`invalid spec ${id}: ${error}`);
				return textResource(url, lines.join("\n"), { isDirectory: true });
			}
			case "show": {
				const spec = await requireTimer(target.id);
				const row = await loadTimerRow(spec, now);
				const card = renderTimerCard(row, now, { verb: "", selfSessionId, ticker: await readTickerStatus() });
				const action =
					spec.action.kind === "shell" ? `shell:\n${spec.action.command}` : `prompt:\n${spec.action.prompt}`;
				return textResource(url, `${card}\n\n${action}`);
			}
			case "runs": {
				const runs = await runsOf(target.id);
				return textResource(url, renderRuns(runs), { isDirectory: true });
			}
			case "run": {
				const run = await findRun(target.id, target.seq);
				const logPath = runLogPath(target.id, run.seq);
				const log = Bun.file(logPath);
				const hasLog = await log.exists();
				const parts = [renderRuns([run]), `log: ${logPath}`];
				if (hasLog) parts.push((await log.text()).trimEnd());
				else
					parts.push(
						`no log file for this run${run.delivery ? " (it was delivered into its session's transcript)" : ""}`,
					);
				return textResource(url, parts.join("\n\n"), hasLog ? { sourcePath: logPath } : undefined);
			}
			case "write":
				throw new Error(`timer://${target.id}/${target.action} is writable only`);
		}
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const target = parseTarget(url);
		if (target.kind !== "write") {
			throw new Error(
				`${url.rawHref ?? url.href} is read-only; write timer://<id>/fire, /edit, /pause, /resume, or /remove`,
			);
		}
		const session = context?.session;
		if (session && !cfgTimerEnabled.get(session.settings)) {
			throw new Error("Timers are disabled in this session (setting timer.enabled)");
		}
		const { id, action } = target;
		const now = Date.now();
		let text: string;
		switch (action) {
			case "fire": {
				const line = await fireTimerNow(id, now, { data: content.trim() ? content : undefined });
				text = `timer ${line.id} ${line.action}${line.runId ? ` (${line.runId})` : ""}${line.detail ? `: ${line.detail}` : ""}`;
				break;
			}
			case "edit": {
				const result = await editTimer(id, timerEditPatch(parseEditFields(content)), {
					cwd: context?.cwd ?? session?.cwd ?? process.cwd(),
					now,
				});
				text = renderTimerCard(await loadTimerRow(result.spec, now), now, {
					verb: result.rearmed ? "re-armed" : "edited",
					selfSessionId: session?.getSessionId?.() ?? undefined,
					ticker: await readTickerStatus(),
					warnings: result.warnings,
				});
				break;
			}
			case "pause":
			case "resume": {
				const spec = await setPaused(id, action === "pause");
				text = renderTimerCard(await loadTimerRow(spec, now), now, {
					verb: action === "pause" ? "paused" : "resumed",
					selfSessionId: session?.getSessionId?.() ?? undefined,
					ticker: await readTickerStatus(),
				});
				break;
			}
			case "remove":
				if (!(await removeTimer(id))) throw new Error(`No timer "${id}"`);
				text = `timer ${id} removed (run history kept)`;
				break;
		}
		return { content: [{ type: "text", text }] };
	}
}
