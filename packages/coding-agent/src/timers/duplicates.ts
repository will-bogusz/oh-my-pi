/**
 * Near-duplicate detection for `set` with a new id: an agent that does not
 * look at the registry first sets a second timer for a job one already does
 * (the user's sweep, a CI watcher, the check it is re-running after a fire).
 * The comparison is lexical and deliberately coarse: a false alarm costs one
 * `force: true`, a missed duplicate costs a second wake-up for every fire.
 */
import type { TimerSpec } from "./types";

/** Words that say nothing about which job a timer does. */
const STOPWORDS = new Set(
	(
		"the and for with that this then them they from into onto when what which while once after before until " +
		"than have has had was were are is be been being not no yes any all each every its it's you your will " +
		"would should could can may must just also only more less very about over under again still here there " +
		"tell let know me my our us run runs running check checks checked set timer timers fire fires fired " +
		"now later today tomorrow minute minutes hour hours day days time times session this conversation agent " +
		"report result results done finish finished make sure keep watch watching wake up need needs want wants"
	).split(" "),
);

/** Lower-case content words; numbers lose their thousands separators so `$3,200` matches `3200`. */
export function timerWords(text: string): Set<string> {
	const words = new Set<string>();
	for (const raw of text
		.toLowerCase()
		.replace(/(\d),(\d{3})/g, "$1$2")
		.split(/[^a-z0-9_./-]+/)) {
		const word = raw.replace(/^[./-]+|[./-]+$/g, "");
		if (word.length < 3 || STOPWORDS.has(word)) continue;
		words.add(word);
	}
	return words;
}

/** Numbers of 3+ digits: a PR, a pid, a price, a run id. */
function numbers(words: Set<string>): Set<string> {
	return new Set([...words].filter(word => /^\d{3,}$/.test(word)));
}

/** Tokens that name one specific thing: those numbers and file names (`notes/markets.md`, `sweep.py`); not `owner/repo`. */
function distinctive(words: Set<string>): Set<string> {
	return new Set([...words].filter(word => /^\d{3,}$/.test(word) || /[a-z0-9_-]\.[a-z]{1,5}$/.test(word)));
}

/** Words both sets hold. */
function sharedCount(a: Set<string>, b: Set<string>): number {
	let shared = 0;
	for (const word of a) if (b.has(word)) shared++;
	return shared;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
	return sharedCount(a, b) > 0;
}

function jobText(spec: Pick<TimerSpec, "action" | "condition" | "until" | "reason">): string {
	const action = spec.action.kind === "shell" ? spec.action.command : spec.action.prompt;
	return `${action} ${spec.condition ?? ""} ${spec.until ?? ""} ${spec.reason}`;
}

/**
 * The existing timer that `candidate` most plausibly duplicates, if any:
 * the same condition, or the same action kind and cadence about the same
 * things (shared distinctive tokens, or most content words in common).
 */
export function findDuplicateTimer(candidate: TimerSpec, existing: readonly TimerSpec[]): TimerSpec | undefined {
	const words = timerWords(jobText(candidate));
	const marks = distinctive(words);
	const ids = numbers(words);
	let best: { spec: TimerSpec; score: number } | undefined;
	for (const other of existing) {
		if (other.id === candidate.id || other.action.kind !== candidate.action.kind) continue;
		if (candidate.until && other.until && candidate.until.trim() === other.until.trim()) return other;
		const otherWords = timerWords(jobText(other));
		// PR #482 is not PR #479: both name numbers and none match
		const otherIds = numbers(otherWords);
		if (ids.size > 0 && otherIds.size > 0 && !intersects(ids, otherIds)) continue;
		// a word or two in common is chance, not the same job
		const shared = sharedCount(words, otherWords);
		if (shared < 2) continue;
		const overlap = shared / (words.size + otherWords.size - shared);
		const sameKind =
			Boolean(candidate.until) === Boolean(other.until) && Boolean(candidate.every) === Boolean(other.every);
		const sameCadence = candidate.every !== undefined && candidate.every === other.every;
		const sharedMark = intersects(marks, distinctive(otherWords));
		const duplicate =
			overlap >= 0.5 || (sameKind && sharedMark && overlap >= 0.15) || (sameCadence && overlap >= 0.25);
		if (duplicate && (!best || overlap > best.score)) best = { spec: other, score: overlap };
	}
	return best?.spec;
}
