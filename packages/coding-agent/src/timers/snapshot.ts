/**
 * The registry as the `timer` tool description shows it at session start: an
 * agent that does not know "the market check" or "the price watcher" is a
 * timer greps the repo instead of listing timers. Synchronous, because tool
 * descriptions are built synchronously; read once per tool instance so the
 * prompt prefix stays stable for the session.
 */
import * as fs from "node:fs";
import { logger } from "@oh-my-pi/pi-utils";
import { specPath, specsDir, timersRoot } from "./paths";
import { openTimerDb, parseTimerSpec } from "./store";
import { currentState } from "./tick";

/** Most timers listed in the description; the rest are counted. */
const SNAPSHOT_MAX = 12;

/** One line per live (armed or paused) timer: `id · schedule · reason`, or undefined when there are none. */
export function timerRegistrySnapshot(root = timersRoot()): string | undefined {
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
			if (currentState(spec, db.readState(id)).done) continue;
			const schedule = spec.every
				? `every ${spec.every}`
				: spec.until
					? `when ${spec.condition ?? spec.until}`
					: "once";
			const paused = spec.paused ? " · paused" : "";
			lines.push(`- ${id} · ${schedule}${paused} · ${spec.reason.replace(/\s+/g, " ").slice(0, 90)}`);
		}
	} catch (error) {
		logger.debug("timer registry snapshot unavailable", { error: String(error) });
		return undefined;
	}
	if (lines.length === 0) return undefined;
	const more = lines.length > SNAPSHOT_MAX ? [`- … and ${lines.length - SNAPSHOT_MAX} more`] : [];
	return [...lines.slice(0, SNAPSHOT_MAX), ...more].join("\n");
}
