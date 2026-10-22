/**
 * The registry as the `timer` tool description shows it at session start: an
 * agent that does not know "the market check" or "the price watcher" is a
 * timer greps the repo instead of listing timers. Synchronous, because tool
 * descriptions are built synchronously; read once per tool instance so the
 * prompt prefix stays stable for the session.
 *
 * The description reaches the model unasked, so it lists only the calling
 * session's timers and those set from inside its project, with URL
 * credentials and token-shaped secrets redacted; `list` stays the explicit
 * way to see the whole registry.
 */
import * as fs from "node:fs";
import { logger, pathIsWithin } from "@oh-my-pi/pi-utils";
import { redactUrlForLog } from "../mcp/json-rpc";
import { redactMemorySecrets } from "../memory-backend/redact";
import { specPath, specsDir, timersRoot } from "./paths";
import { openTimerDb, parseTimerSpec } from "./store";
import { currentState } from "./tick";
import type { TimerSpec } from "./types";

/** Most timers listed in the description; the rest are counted. */
const SNAPSHOT_MAX = 12;

/** Whose timers the snapshot lists: the session building its tool, and the project it runs in. */
export interface SnapshotScope {
	sessionId: string | undefined;
	cwd: string;
}

/** Set or woken by this session, or set from inside its project. */
function inScope(spec: TimerSpec, scope: SnapshotScope): boolean {
	if (scope.sessionId !== undefined) {
		if (spec.created.session === scope.sessionId) return true;
		if (spec.target.kind === "session" && spec.target.sessionId === scope.sessionId) return true;
	}
	return pathIsWithin(scope.cwd, spec.created.cwd);
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

/** A reason as one description line: URL userinfo and secret query values, then token-shaped secrets, redacted. */
function reasonLine(reason: string): string {
	const text = reason.replace(/\s+/g, " ").replace(URL_PATTERN, url => redactUrlForLog(url));
	return redactMemorySecrets(text).slice(0, 90);
}

/** One line per live (armed or paused) timer in `scope`: `id · schedule · reason`, or undefined when there are none. */
export function timerRegistrySnapshot(scope: SnapshotScope, root = timersRoot()): string | undefined {
	let names: string[];
	try {
		names = fs.readdirSync(specsDir(root)).filter(name => name.endsWith(".md"));
	} catch {
		return undefined;
	}
	if (names.length === 0) return undefined;
	const lines: string[] = [];
	try {
		const db = openTimerDb(root);
		for (const name of names.sort()) {
			const id = name.slice(0, -3);
			const file = specPath(id, root);
			const spec = parseTimerSpec(id, fs.readFileSync(file, "utf8"), file);
			if (!inScope(spec, scope) || currentState(spec, db.readState(id)).done) continue;
			const schedule = spec.every ? `every ${spec.every}` : "once";
			const paused = spec.paused ? " · paused" : "";
			lines.push(`- ${id} · ${schedule}${paused} · ${reasonLine(spec.reason)}`);
		}
	} catch (error) {
		logger.debug("timer registry snapshot unavailable", { error: String(error) });
		return undefined;
	}
	if (lines.length === 0) return undefined;
	const more = lines.length > SNAPSHOT_MAX ? [`- … and ${lines.length - SNAPSHOT_MAX} more`] : [];
	return [...lines.slice(0, SNAPSHOT_MAX), ...more].join("\n");
}
