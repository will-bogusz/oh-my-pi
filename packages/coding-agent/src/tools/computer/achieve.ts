/**
 * `win.achieve(goal)`: the chooser experiment, behind `computer.achieve`.
 *
 * The model delegates one bounded, verifiable sub-goal on a window it already
 * holds. Per step: the window is observed (the call `win.observe()` makes),
 * code builds a candidate table from the typed observation, a typed judge
 * picks one row — or `reobserve`, or `abstain` — the pick runs through the
 * same call path a prelude method takes, and a second judgment over the
 * fresh tree says whether the goal is now met. The trace it returns carries
 * the driver's own replies and nothing else: a step the driver refused is a
 * refusal, a `suspected_noop` is a failed step, and a window that gets
 * interrupted hands control straight back to the model.
 */
import type { ChoiceQuestion, Judge, JsonValue, NoulQuestion } from "@oh-my-pi/pi-ai";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { throwIfAborted } from "../tool-errors";
import type { ComputerCallStep } from "./call";
import { specificRole, TEXT_INPUT_ROLES } from "./render";
import { elideObservationTree } from "./tree-elide";
import type { ComputerActionResult, ComputerElementSnapshot, ComputerInterruption, ComputerObservation } from "./types";

export type AchieveAction = "click" | "setValue" | "type" | "press";

export interface AchieveCandidate {
	/** Choice label — one word, so the keyword fallback judge can name it. */
	id: string;
	ref: string;
	action: AchieveAction;
	/** The value written or the chord pressed; clicks carry none. */
	value?: string;
	/** `role "label" = "value" -> action "value"`: the row as the judge reads it. */
	line: string;
	/** The control across observations: refs are re-minted, role and name are not. */
	control: string;
	/** `control|action|value`: the row as the loop remembers it once refused or doubted. */
	key: string;
}

/** A refusal: the message the prelude would have thrown, and the panel that caused it when one did. */
export interface AchieveRefusal {
	refusal: string;
	interruptedBy?: ComputerInterruption;
}

export interface AchieveStep {
	/** The candidate line, or `reobserve` / `abstain`. */
	candidate: string;
	/** The judge's probability for that pick. */
	probability: number;
	/** The row the judge leaned to when the pick fell under the confidence gate. */
	favored?: string;
	/** The driver's typed reply for an executed pick, exactly as a prelude method returns it. */
	reply?: ComputerActionResult | AchieveRefusal;
	/** P(goal satisfied) after the pick; absent when the pick was not executed or reported itself failed. */
	postcondition?: number;
}

export type AchieveReason = "done" | "abstain" | "max_steps" | "interrupted" | "refused";

export interface AchieveResult {
	done: boolean;
	steps: AchieveStep[];
	reason: AchieveReason;
	abstained: boolean;
	/** The verbatim interruption, refusal or gate that ended the loop, when one did. */
	detail?: string;
}

/** The two calls the loop makes, each on the path the prelude's own methods take. */
export interface AchieveHost {
	observe(): Promise<ComputerObservation>;
	/** Runs one `window.ref(r).<action>(...)` chain; a refusal is the ToolError the prelude would throw. */
	act(chain: ComputerCallStep[]): Promise<ComputerActionResult>;
}

export interface AchieveOptions {
	goal: string;
	maxSteps: number;
	/** The pick's probability must reach this; below it the loop re-observes once, then abstains. */
	confidence: number;
	signal?: AbortSignal;
}

export const ACHIEVE_DEFAULTS = { maxSteps: 8, confidence: 0.6 } as const;
/** P(goal satisfied) that counts as done. */
const SATISFIED = 0.8;
const CANDIDATE_CAP = 60;
/** Bytes of tree the postcondition judgment reads; the same elider the inline cap uses. */
const POSTCONDITION_TREE_BYTES = 16_384;
/** Values are shown to the judge, not the model: long text carries nothing a pick needs. */
const VALUE_PREVIEW = 60;

/**
 * Roles a click acts on, in the spelling both providers reduce to when the
 * `AX` prefix, case and spaces are dropped: `AXPushButton` and `push button`
 * are both `pushbutton`. Rows and cells select on click (`semantic-actions`),
 * which is what a goal that names a row wants.
 */
const CLICK_ROLES: Record<string, true> = {
	button: true,
	pushbutton: true,
	togglebutton: true,
	menubutton: true,
	popupbutton: true,
	radiobutton: true,
	checkbox: true,
	checkmenuitem: true,
	radiomenuitem: true,
	switch: true,
	toggle: true,
	link: true,
	menuitem: true,
	row: true,
	tablerow: true,
	outlinerow: true,
	cell: true,
	tablecell: true,
	listitem: true,
	disclosuretriangle: true,
	pagetab: true,
	tab: true,
	combobox: true,
};
/** Text roles that take a secret; a goal never writes one through this loop. */
const SECRET_ROLES: Record<string, true> = { "password text": true, AXSecureTextField: true };
/** Actions a provider advertises that a click performs. */
const PRESS_ACTIONS: Record<string, true> = { press: true, AXPress: true, click: true, activate: true };
/** Advertised actions the goal must name before a row carrying one is offered. */
const DESTRUCTIVE = /\b(delete|remove|discard|trash|quit)\b/gi;
/** Values the goal supplies: straight, curly or backtick quoted spans. Anything unquoted is never written. */
const QUOTED = /"([^"]+)"|“([^”]+)”|`([^`]+)`/g;
const TOKEN = /[\p{L}\p{N}]{2,}/gu;
const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"into",
	"from",
	"that",
	"this",
	"then",
	"an",
	"to",
	"in",
	"on",
	"of",
	"or",
	"it",
	"is",
	"at",
	"by",
]);
/** The session's own sentence for a window the action put on screen (`cua-session` `#openedWindows`). */
const WINDOW_GAINED = /gained window .* since your last observation/;

const normalizeRole = (role: string): string =>
	role
		.replace(/^AX/, "")
		.replace(/[\s_-]+/g, "")
		.toLowerCase();

function tokens(text: string): Set<string> {
	const found = new Set<string>();
	for (const match of text.toLowerCase().matchAll(TOKEN)) if (!STOPWORDS.has(match[0])) found.add(match[0]);
	return found;
}

function destructiveWords(text: string): Set<string> {
	const words = new Set<string>();
	for (const match of text.matchAll(DESTRUCTIVE)) words.add(match[1]!.toLowerCase());
	return words;
}

/** Quoted spans of the goal, in order, deduplicated. */
export function goalValues(goal: string): string[] {
	const values: string[] = [];
	for (const match of goal.matchAll(QUOTED)) {
		const value = match[1] ?? match[2] ?? match[3];
		if (value !== undefined && !values.includes(value)) values.push(value);
	}
	return values;
}

const preview = (value: string): string =>
	value.length > VALUE_PREVIEW ? `${value.slice(0, VALUE_PREVIEW - 1)}…` : value;

function elementLine(element: ComputerElementSnapshot): string {
	const parts = [specificRole(element), JSON.stringify(element.label)];
	if (element.value !== undefined && element.value !== "") parts.push(`= ${JSON.stringify(preview(element.value))}`);
	if (element.placeholder) parts.push(`placeholder=${JSON.stringify(element.placeholder)}`);
	if (element.selected === true) parts.push("selected");
	return parts.join(" ");
}

/** The control's identity across observations: refs are re-minted, role and name are not. */
function controlKey(element: ComputerElementSnapshot): string {
	return `${specificRole(element)}|${element.label}|${element.placeholder ?? ""}`;
}

function isTextInput(element: ComputerElementSnapshot): boolean {
	if (SECRET_ROLES[element.role] === true || (element.subrole !== undefined && SECRET_ROLES[element.subrole] === true))
		return false;
	return (
		TEXT_INPUT_ROLES[element.role] === true ||
		(element.subrole !== undefined && TEXT_INPUT_ROLES[element.subrole] === true)
	);
}

function isClickable(element: ComputerElementSnapshot): boolean {
	if (CLICK_ROLES[normalizeRole(element.role)] === true) return true;
	if (element.subrole !== undefined && CLICK_ROLES[normalizeRole(element.subrole)] === true) return true;
	return element.actions?.some(action => PRESS_ACTIONS[action] === true) ?? false;
}

function onScreen(element: ComputerElementSnapshot, observation: ComputerObservation): boolean | undefined {
	const box = element.bounds;
	if (!box) return undefined;
	if (box.width <= 0 || box.height <= 0) return false;
	const win = observation.window.bounds;
	return (
		box.x < win.x + win.width && box.x + box.width > win.x && box.y < win.y + win.height && box.y + box.height > win.y
	);
}

/** What the loop remembers between steps, keyed on controls rather than refs. */
export interface AchieveMemory {
	/** Candidate keys that were refused or reported `suspected_noop`: never re-fired unchanged. */
	failed: Set<string>;
	/** Controls a `setValue` landed on: their end-of-edit Return is offered next. */
	written: Set<string>;
}

/**
 * The candidate table for one observation: every enabled on-screen row with a
 * ref, crossed with the actions its role allows, ranked by lexical overlap
 * with the goal and capped. A value is only ever one the goal quotes.
 */
export function buildCandidates(
	goal: string,
	observation: ComputerObservation,
	memory: AchieveMemory = { failed: new Set(), written: new Set() },
): AchieveCandidate[] {
	const goalTokens = tokens(goal);
	const named = destructiveWords(goal);
	const values = goalValues(goal);
	const ranked: Array<{ candidate: AchieveCandidate; tier: number; overlap: number; order: number }> = [];
	for (const [order, element] of observation.elements.entries()) {
		if (element.enabled === false) continue;
		const visible = onScreen(element, observation);
		if (visible === false) continue;
		let destructive = false;
		for (const word of destructiveWords(`${element.label} ${element.description ?? ""}`))
			if (!named.has(word)) destructive = true;
		if (destructive) continue;
		const control = controlKey(element);
		const line = elementLine(element);
		const tier = element.enabled === true && visible === true ? 0 : 1;
		const overlap = [...tokens(`${line} ${element.description ?? ""}`)].filter(token => goalTokens.has(token)).length;
		const offer = (action: AchieveAction, index: number, value?: string): void => {
			const key = `${control}|${action}|${value ?? ""}`;
			if (memory.failed.has(key)) return;
			const suffix = value === undefined ? "" : ` ${JSON.stringify(preview(value))}`;
			ranked.push({
				candidate: {
					id: index === 0 ? `${element.ref}_${action}` : `${element.ref}_${action}_${index}`,
					ref: element.ref,
					action,
					...(value === undefined ? {} : { value }),
					line: `${line} -> ${action}${suffix}`,
					control,
					key,
				},
				tier,
				overlap,
				order,
			});
		};
		if (isTextInput(element)) {
			for (const [index, value] of values.entries()) {
				// A value the field already holds is no progress: live against Jev,
				// the row a goal names most was re-written five times running.
				if (element.value === value) continue;
				// A write the driver refused or doubted is offered as keystrokes next.
				const wrote = `${control}|setValue|${value}`;
				offer(memory.failed.has(wrote) ? "type" : "setValue", index, value);
			}
			if (memory.written.has(control)) offer("press", 0, "Return");
		}
		if (isClickable(element)) offer("click", 0);
	}
	ranked.sort((a, b) => a.tier - b.tier || b.overlap - a.overlap || a.order - b.order);
	return ranked.slice(0, CANDIDATE_CAP).map(row => row.candidate);
}

/** The chain a prelude method sends for this pick: `desktop.window({ id, pid }).ref(r).<action>(...)`. */
export function candidateChain(window: { id: string; pid: number }, candidate: AchieveCandidate): ComputerCallStep[] {
	const args = candidate.value === undefined ? [] : [candidate.value];
	return [
		// The handle carries exact identity and nothing else; a selector with more fields is refused.
		{ method: "window", args: [{ id: window.id, pid: window.pid }] },
		{ method: "ref", args: [candidate.ref] },
		{ method: candidate.action, args },
	];
}

const describe = (interruption: ComputerInterruption): string =>
	`${interruption.kind} window ${interruption.windowId} ${JSON.stringify(interruption.title)} (${interruption.app}, pid ${interruption.pid})`;

function choiceQuestion(candidates: readonly AchieveCandidate[]): ChoiceQuestion {
	const criteria: Record<string, string | null> = {};
	for (const candidate of candidates) criteria[candidate.id] = candidate.line;
	criteria.reobserve = "Nothing listed fits yet: read the window again before acting.";
	criteria.abstain = "The goal cannot be advanced from this window with these controls.";
	return {
		type: "choice",
		instructions:
			"Pick the single next action that makes progress toward the goal on this window. Pick reobserve if nothing fits yet, or abstain if the goal cannot be advanced from this window.",
		criteria,
	};
}

const POSTCONDITION: NoulQuestion = {
	type: "noul",
	instructions:
		"Given the goal, the action just taken, the driver's reply to it and the fresh accessibility tree of the same window, is the goal now satisfied?",
	criteria: {
		true: "The tree shows the goal's end state.",
		false: "The end state is not visible in the tree, or the reply says the action did not land.",
	},
};

function replyState(reply: ComputerActionResult | AchieveRefusal): { [key: string]: JsonValue } {
	if ("refusal" in reply) return { refusal: reply.refusal };
	const state: { [key: string]: JsonValue } = { text: reply.text, effect: reply.effect };
	if (reply.committed !== undefined) state.committed = reply.committed;
	if (reply.escalation !== undefined) state.escalation = reply.escalation;
	return state;
}

function treeForJudge(observation: ComputerObservation): string {
	const elided = elideObservationTree(observation.tree, POSTCONDITION_TREE_BYTES);
	return elided ? `${elided.text}\n${elided.notice}` : observation.tree;
}

export async function achieve(host: AchieveHost, judge: Judge, options: AchieveOptions): Promise<AchieveResult> {
	const { goal, maxSteps, confidence, signal } = options;
	const steps: AchieveStep[] = [];
	const memory: AchieveMemory = { failed: new Set(), written: new Set() };
	const finish = (reason: AchieveReason, detail?: string): AchieveResult => ({
		done: reason === "done",
		steps,
		reason,
		abstained: reason === "abstain",
		...(detail === undefined ? {} : { detail }),
	});
	let observation = await host.observe();
	// A window that is gone or refuses to be read ends the loop the way an
	// interruption does: the message is the driver's, and control returns.
	const reobserve = async (): Promise<AchieveResult | undefined> => {
		try {
			observation = await host.observe();
			return undefined;
		} catch (error) {
			if (!(error instanceof ToolError)) throw error;
			return finish("interrupted", error.message);
		}
	};
	let refusedInARow = 0;
	/** Runs one pick on the prelude's own path, then judges the fresh tree. A result ends the loop. */
	const execute = async (pick: AchieveCandidate, record: AchieveStep): Promise<AchieveResult | undefined> => {
		let reply: ComputerActionResult;
		try {
			reply = await host.act(candidateChain(observation.window, pick));
		} catch (error) {
			if (!(error instanceof ToolError)) throw error;
			const interruptedBy = error.context?.interruptedBy as ComputerInterruption | undefined;
			record.reply = { refusal: error.message, ...(interruptedBy === undefined ? {} : { interruptedBy }) };
			if (interruptedBy) return finish("interrupted", error.message);
			// A refusal shrinks the table; a second one in a row means the window
			// is refusing this class of action and its reply names the route —
			// that is the model's call, not the chooser's.
			memory.failed.add(pick.key);
			if (++refusedInARow === 2) return finish("refused", error.message);
			return reobserve();
		}
		refusedInARow = 0;
		record.reply = reply;
		if (reply.interruptedBy) return finish("interrupted", describe(reply.interruptedBy));
		if (reply.effect === "suspected_noop") {
			// Positive reason to think nothing happened: a failed step, no verdict asked.
			memory.failed.add(pick.key);
			return reobserve();
		}
		if (pick.action === "setValue" || pick.action === "type") memory.written.add(pick.control);
		const interrupted = await reobserve();
		if (interrupted) return interrupted;
		const verdict = await judge.judge(
			{
				state: { goal, action: pick.line, reply: replyState(reply), observation: treeForJudge(observation) },
				questions: { satisfied: POSTCONDITION },
			},
			{ signal },
		);
		record.postcondition = verdict.answers.satisfied.noul;
		if (record.postcondition >= SATISFIED) return finish("done");
		const gained = reply.text.split("\n").find(line => WINDOW_GAINED.test(line));
		return gained === undefined ? undefined : finish("interrupted", gained);
	};
	let gated = false;
	for (let step = 0; step < maxSteps; step++) {
		throwIfAborted(signal);
		if (observation.interruptedBy) return finish("interrupted", describe(observation.interruptedBy));
		const candidates = buildCandidates(goal, observation, memory);
		const window = `${observation.window.app}: ${observation.window.title || "Untitled window"}`;
		const { answers } = await judge.judge(
			{
				state: { goal, window, candidates: candidates.map(candidate => `${candidate.id}: ${candidate.line}`) },
				questions: { next: choiceQuestion(candidates) },
			},
			{ signal },
		);
		const { choice, probabilities } = answers.next;
		const probability = probabilities[choice] ?? 0;
		if (choice === "abstain") {
			steps.push({ candidate: "abstain", probability });
			return finish("abstain");
		}
		const pick = candidates.find(candidate => candidate.id === choice);
		if (pick === undefined) {
			if (choice !== "reobserve") {
				steps.push({ candidate: "abstain", probability });
				return finish("abstain", `judge answered ${JSON.stringify(choice)}, which is not a candidate`);
			}
			steps.push({ candidate: "reobserve", probability });
		} else if (probability < confidence) {
			// Below the gate the pick is not acted on: once it is a re-read, twice it is an abstention.
			if (gated) {
				steps.push({ candidate: "abstain", probability, favored: pick.line });
				return finish("abstain", `pick below confidence ${confidence} twice`);
			}
			gated = true;
			steps.push({ candidate: "reobserve", probability, favored: pick.line });
		} else {
			const record: AchieveStep = { candidate: pick.line, probability };
			steps.push(record);
			const ended = await execute(pick, record);
			if (ended) return ended;
			continue;
		}
		const interrupted = await reobserve();
		if (interrupted) return interrupted;
	}
	return finish("max_steps");
}

/** The trace as the cell prints it: one line per step, the driver's own words where it had any. */
export function renderAchieve(goal: string, result: AchieveResult, judge: string): string {
	const lines = [
		`achieve ${JSON.stringify(goal)}: ${result.reason}${result.done ? "" : " (not done)"} after ${result.steps.length} step${result.steps.length === 1 ? "" : "s"} — judge ${judge}`,
	];
	for (const [index, step] of result.steps.entries()) {
		let line = `${index + 1}. ${step.candidate} (p=${step.probability.toFixed(2)})`;
		if (step.favored !== undefined) line += ` — leaned to ${step.favored}`;
		if (step.reply !== undefined) {
			line +=
				"refusal" in step.reply
					? ` → refused: ${step.reply.refusal}`
					: ` → ${step.reply.effect}${step.reply.committed === undefined ? "" : `, ${step.reply.committed}`}${step.reply.text ? `: ${step.reply.text}` : ""}`;
		}
		if (step.postcondition !== undefined) line += ` — goal satisfied p=${step.postcondition.toFixed(2)}`;
		lines.push(line);
	}
	if (result.detail !== undefined) lines.push(result.detail);
	return lines.join("\n");
}
