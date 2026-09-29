import type { ComputerCallStep } from "./call";
import type { ComputerActionResult } from "./types";

/**
 * One eval cell's computer reply, composed once the cell has settled. Every
 * call used to print its own text the moment it returned, so a cell that
 * clicked and then observed the same window printed the click's probe line
 * and its gained-window line above a tree that already answered both. Here
 * the calls are recorded in order and said together: one line naming each
 * call and how it ended, then each call's own text, minus the lines a later
 * read of the same window in this cell supersedes.
 *
 * What a later read supersedes, and nothing else:
 * - the driver's probe line (`🔎 …`) of an action on a window this cell
 *   observed or captured afterwards — the read is the postcondition check the
 *   line asks for;
 * - a `pid P gained window N` line of an action when this cell later observed
 *   a window of that pid — the observation names or renders what is new.
 * Refusals, write verdicts, escalations and interruptions are never dropped:
 * a final tree does not say which dispatches landed.
 */
export type CallMark = "✓" | "?" | "✗";

export interface CellCall {
	/** `click n5`, `observe`, `window {"app":"Finder"}`. */
	readonly label: string;
	/** The call can change the desktop (an exec-policy chain or a run). */
	readonly action: boolean;
	readonly mark: CallMark;
	/** What the call would have printed on its own. */
	readonly text: string;
	/** The window a read call observed or captured. */
	readonly observed?: { readonly id: string; readonly pid: number };
	/** The window an action addressed. */
	readonly target?: { readonly id: string; readonly pid: number };
	/** A failed call's code or first line. */
	readonly failure?: string;
}

const PROBE_LINE = /^🔎/;
const GAINED_WINDOW_LINE = /^pid (\d+) gained window \d+ .* since your last observation\.$/;

export class CellReply {
	readonly #calls: CellCall[] = [];

	add(call: CellCall): void {
		this.#calls.push(call);
	}

	/** The cell's reply, or nothing when no computer call printed or acted. */
	compose(failed: boolean): string | undefined {
		const calls = this.#calls;
		if (!calls.length) return undefined;
		const texts = calls.map((call, index) => {
			const later = calls.slice(index + 1);
			if (!call.action || call.target === undefined || !call.text) return call.text;
			const target = call.target;
			const reread = later.some(next => next.observed?.id === target.id && next.observed.pid === target.pid);
			const roster = new Set(later.flatMap(next => (next.observed === undefined ? [] : [next.observed.pid])));
			return call.text
				.split("\n")
				.filter(line => {
					if (reread && PROBE_LINE.test(line)) return false;
					const gained = GAINED_WINDOW_LINE.exec(line);
					return gained === null || !roster.has(Number(gained[1]));
				})
				.join("\n");
		});
		const summary =
			calls.some(call => call.action) || calls.some(call => call.mark === "✗")
				? `${calls
						.map(call => `${call.mark} ${call.label}${call.failure === undefined ? "" : ` (${call.failure})`}`)
						.join(" · ")}${failed && calls.at(-1)?.mark === "✗" ? " · the rest of the cell did not run" : ""}`
				: undefined;
		const body = [summary, ...texts].filter(text => text !== undefined && text !== "");
		return body.length ? body.join("\n") : undefined;
	}
}

/** A ref the call addressed: an explicit `ref(…)` step, or a ref-shaped first argument. */
function addressedRef(chain: readonly ComputerCallStep[]): string | undefined {
	for (const step of [...chain].reverse()) {
		const first = step.args[0];
		if (step.method === "ref" && typeof first === "string") return first;
		if (typeof first === "string" && /^n\d+$/.test(first)) return first;
	}
	return undefined;
}

/** How one call chain is named in the cell's summary line. */
export function callLabel(chain: readonly ComputerCallStep[]): string {
	const last = chain.at(-1);
	if (last === undefined) return "call";
	if (last.method === "acquireWindow" || last.method === "window")
		return `window ${JSON.stringify(last.args[0] ?? {})}`;
	const ref = addressedRef(chain);
	return ref === undefined ? last.method : `${last.method} ${ref}`;
}

/** The window a handle chain rehydrates first: `window({ id, pid })`. */
export function chainWindow(chain: readonly ComputerCallStep[]): { id: string; pid: number } | undefined {
	const step = chain.find(entry => entry.method === "window");
	const identity = step?.args[0];
	if (identity === null || typeof identity !== "object") return undefined;
	const { id, pid } = identity as { id?: unknown; pid?: unknown };
	return typeof id === "string" && typeof pid === "number" ? { id, pid } : undefined;
}

/** Effects a driver reports when it dispatched and doubts the target reacted. */
const UNPROVEN_EFFECTS: Record<string, true> = { partial: true, suspected_noop: true, unverifiable: true };

/**
 * ✓ proven, ? dispatched but unproven, ✗ nothing landed. A scroll measured
 * to move nothing landed nothing, whatever the driver's effect word says
 * about the dispatch; a move is ✓ only on the driver's `confirmed`.
 */
export function actionMark(result: ComputerActionResult): CallMark {
	if (result.effect === "not_dispatched" || result.scroll?.outcome === "no_motion") return "✗";
	if (
		UNPROVEN_EFFECTS[result.effect] === true ||
		(result.committed !== undefined && result.committed !== "committed") ||
		result.escalation !== undefined
	)
		return "?";
	return "✓";
}

/** A call's returned value is an action result (it carries the driver's effect). */
export function isActionResult(value: unknown): value is ComputerActionResult {
	return value !== null && typeof value === "object" && "effect" in value && typeof value.effect === "string";
}
