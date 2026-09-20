import { afterAll, describe, expect, it } from "bun:test";
import { createContext, runInContext } from "node:vm";
import {
	type Answer,
	type Judge,
	type JudgmentRequest,
	type JudgmentResult,
	type Questions,
	tokenUsage,
} from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import { type AchieveResult, buildCandidates, goalValues } from "@oh-my-pi/pi-coding-agent/tools/computer/achieve";
import type { ComputerBackend } from "@oh-my-pi/pi-coding-agent/tools/computer/backend";
import { ComputerSupervisor } from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import type {
	ComputerActionResult,
	ComputerBounds,
	ComputerElementSnapshot,
	ComputerInterruption,
	ComputerObservation,
	ComputerOperationContext,
	ComputerTarget,
	ComputerWindowIdentity,
	ObserveOptions,
	WindowSelector,
} from "@oh-my-pi/pi-coding-agent/tools/computer/types";
import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const capabilities: DesktopCapabilities = {
	backend: "fake",
	displayServer: "memory",
	capture: true,
	input: true,
	ax: true,
	backgroundWindowInput: true,
	deliveryModes: ["background", "foreground"],
	capturePermission: "granted",
	inputPermission: "granted",
	axPermission: "granted",
	displayCount: 1,
};

const windowFixture: ComputerWindowIdentity = {
	id: "42",
	title: "Contact",
	app: "Contacts",
	pid: 123,
	bounds: { x: 0, y: 0, width: 400, height: 300 },
	onScreen: true,
};

/** A row of the fixture tree; refs are minted per observation, as the driver does. */
interface Row {
	role: string;
	label: string;
	value?: string;
	subrole?: string;
	description?: string;
	enabled?: boolean;
	actions?: string[];
	bounds?: ComputerBounds;
}

const inWindow: ComputerBounds = { x: 10, y: 10, width: 80, height: 20 };

/** Stateful driver stand-in: every dispatch is recorded, refusals and no-ops are scripted per label. */
class AchieveBackend implements ComputerBackend {
	readonly capabilities = { ...capabilities };
	rows: Row[] = [];
	readonly dispatched: string[] = [];
	/** Label -> the refusal the driver throws for it. */
	refusals: Record<string, string> = {};
	/** Labels whose dispatch reports `suspected_noop`. */
	noops: Record<string, true> = {};
	/** Labels whose write the app keeps its own value against (`committed: not_committed`). */
	uncommitted: Record<string, true> = {};
	/** Label whose dispatch reports a panel that appeared while it ran. */
	interruptAfter?: string;
	/** Panel present at the next observation. */
	interruption?: ComputerInterruption;
	/** Reacts to a dispatch by editing the tree, the way an app would. */
	onDispatch?: (action: string, row: Row, value?: string) => void;
	observations = 0;
	generation = 0;
	readonly bindings = new Map<
		string,
		{ window: ComputerWindowIdentity; element: ComputerElementSnapshot; row: Row }
	>();

	async drain(): Promise<void> {}
	async close(): Promise<void> {}
	async windows(_context: ComputerOperationContext, selector: WindowSelector = {}) {
		return [windowFixture].filter(
			w =>
				(selector.id === undefined || w.id === selector.id) &&
				(selector.pid === undefined || w.pid === selector.pid),
		);
	}
	async window(context: ComputerOperationContext, selector: string | WindowSelector) {
		const windows = await this.windows(context, typeof selector === "string" ? { id: selector } : selector);
		if (windows.length !== 1)
			throw new ToolError(`Missing computer window ${JSON.stringify(selector)}: nothing matches it.`);
		return windows[0]!;
	}
	acquire(context: ComputerOperationContext, selector: string | WindowSelector) {
		return this.window(context, selector);
	}
	async displays() {
		return [];
	}
	async focusedWindow() {
		return windowFixture;
	}
	image(context: ComputerOperationContext, silent = false) {
		const image = {
			path: "/fixture/capture.png",
			width: 400,
			height: 300,
			sourceWidth: 400,
			sourceHeight: 300,
			surface: "window" as const,
			pointWidth: 400,
			pointHeight: 300,
			scale: 1,
			target: windowFixture.id,
		};
		context.emitImage(image, { type: "image", data: "iVBORw==", mimeType: "image/png" }, silent);
		return image;
	}
	async screenshot(context: ComputerOperationContext, options: { silent?: boolean } = {}) {
		return this.image(context, options.silent);
	}
	async captureWindow(
		context: ComputerOperationContext,
		_window: ComputerWindowIdentity,
		options: { silent?: boolean } = {},
	) {
		return this.image(context, options.silent);
	}
	async observe(
		context: ComputerOperationContext,
		window: ComputerWindowIdentity,
		options: ObserveOptions = {},
	): Promise<ComputerObservation> {
		this.observations++;
		this.bindings.clear();
		const elements: ComputerElementSnapshot[] = this.rows.map(row => {
			const ref = `e${++this.generation}`;
			const element: ComputerElementSnapshot = {
				ref,
				pid: window.pid,
				windowId: window.id,
				role: row.role,
				label: row.label,
				...(row.value === undefined ? {} : { value: row.value }),
				...(row.subrole === undefined ? {} : { subrole: row.subrole }),
				...(row.description === undefined ? {} : { description: row.description }),
				...(row.enabled === undefined ? {} : { enabled: row.enabled }),
				...(row.actions === undefined ? {} : { actions: row.actions }),
				bounds: row.bounds ?? inWindow,
			};
			this.bindings.set(ref, { window, element, row });
			return element;
		});
		return {
			snapshotId: String(this.generation),
			window,
			tree: elements
				.map(
					e =>
						`- [${e.ref}] ${e.role} ${JSON.stringify(e.label)}${e.value ? ` value=${JSON.stringify(e.value)}` : ""}`,
				)
				.join("\n"),
			elements,
			complete: true,
			backgroundInput: true,
			...(this.interruption ? { interruptedBy: this.interruption } : {}),
			...(options.screenshot === true ? { screenshot: this.image(context, options.silent) } : {}),
		};
	}
	element(ref: string, window?: ComputerWindowIdentity) {
		const binding = this.bindings.get(ref);
		if (!binding) throw new ToolError(`StaleRef: ${ref}`);
		if (window && (window.id !== binding.window.id || window.pid !== binding.window.pid))
			throw new Error("InvalidTarget");
		return binding.element;
	}
	elementWindow(ref: string) {
		this.element(ref);
		return this.bindings.get(ref)!.window;
	}
	#dispatch(action: string, ref: string, value?: string): ComputerActionResult {
		const binding = this.bindings.get(ref);
		if (!binding) throw new ToolError(`StaleRef: ${ref}`);
		const { row } = binding;
		const refusal = this.refusals[row.label];
		if (refusal !== undefined) throw new ToolError(refusal);
		this.dispatched.push(`${action} ${row.label}${value === undefined ? "" : `=${value}`}`);
		this.onDispatch?.(action, row, value);
		const noop = this.noops[row.label] === true;
		const uncommitted = action === "setValue" && this.uncommitted[row.label] === true;
		return {
			text: noop ? `⚠️ ${action} on ${row.label} delivered but nothing changed (suspected_noop).` : "",
			effect: noop ? "suspected_noop" : "verified",
			...(uncommitted ? { committed: "not_committed" as const } : {}),
			evidence: null,
			delivery: "background",
			...(this.interruptAfter === row.label
				? {
						interruptedBy: {
							app: "SecurityAgent",
							pid: 9,
							windowId: "900",
							title: "Password",
							kind: "auth" as const,
						},
					}
				: {}),
		};
	}
	async click(_context: ComputerOperationContext, _window: ComputerWindowIdentity, target: ComputerTarget) {
		if (typeof target !== "string") throw new Error("pixel click in fixture");
		return this.#dispatch("click", target);
	}
	async setValue(_context: ComputerOperationContext, _window: ComputerWindowIdentity, ref: string, value: string) {
		return this.#dispatch("setValue", ref, value);
	}
	async type(
		_context: ComputerOperationContext,
		_window: ComputerWindowIdentity,
		text: string,
		target?: ComputerTarget,
	) {
		if (typeof target !== "string") throw new Error("untargeted type in fixture");
		return this.#dispatch("type", target, text);
	}
	async press(
		_context: ComputerOperationContext,
		_window: ComputerWindowIdentity,
		chord: string | string[],
		target?: ComputerTarget,
	) {
		if (typeof target !== "string") throw new Error("untargeted press in fixture");
		return this.#dispatch("press", target, Array.isArray(chord) ? chord.join("+") : chord);
	}
	unsupported = async (): Promise<never> => {
		throw new Error("Unsupported fixture operation");
	};
	apps = this.unsupported;
	verify = this.unsupported;
	scroll = this.unsupported;
	setFrame = this.unsupported;
	menu = this.unsupported;
	clipboardRead = this.unsupported;
	clipboardWrite = this.unsupported;
	launch: ComputerBackend["launch"] = this.unsupported;
	raise = this.unsupported;
	drag = this.unsupported;
	perform = this.unsupported;
	hover = this.unsupported;
	desktopClick = this.unsupported;
	desktopMove = this.unsupported;
	desktopDrag = this.unsupported;
	desktopScroll = this.unsupported;
	desktopType = this.unsupported;
	desktopPress = this.unsupported;
}

/** A scripted judge: `next` answers come off a queue by candidate line, `satisfied` off another. */
class FakeJudge implements Judge {
	readonly label = "fake/judge";
	readonly requests: JudgmentRequest[] = [];
	/** Each entry: the candidate line to pick (or `reobserve`/`abstain`) and its probability. */
	picks: Array<{ line: string; probability: number }> = [];
	verdicts: number[] = [];
	async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		this.requests.push(request);
		const answers: Record<string, Answer> = {};
		for (const id in request.questions) {
			const question = request.questions[id]!;
			if (question.type === "choice") {
				const pick = this.picks.shift() ?? { line: "abstain", probability: 1 };
				const labels = Object.keys(question.criteria);
				const choice = labels.find(label => label === pick.line || question.criteria[label] === pick.line);
				if (choice === undefined)
					throw new Error(
						`fixture pick ${JSON.stringify(pick.line)} is not offered; offered: ${labels.map(label => question.criteria[label]).join(" | ")}`,
					);
				const probabilities: Record<string, number> = {};
				for (const label of labels)
					probabilities[label] =
						label === choice ? pick.probability : (1 - pick.probability) / Math.max(1, labels.length - 1);
				answers[id] = { type: "choice", choice, probabilities, confidence: pick.probability };
			} else if (question.type === "noul") {
				answers[id] = { type: "noul", noul: this.verdicts.shift() ?? 0 };
			} else {
				throw new Error("fixture judge answers no score questions");
			}
		}
		return {
			api: "fake",
			provider: "fake",
			model: "judge",
			answers: answers as JudgmentResult<Q>["answers"],
			usage: tokenUsage(0, 0),
		};
	}
	/** The candidate lines the last `next` question offered. */
	offered(): string[] {
		const last = [...this.requests].reverse().find(request => "next" in request.questions);
		const question = last?.questions.next;
		return question?.type === "choice"
			? Object.values(question.criteria).filter((line): line is string => line !== null)
			: [];
	}
}

function toolSession(achieve: boolean): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		settings: Settings.isolated({ "computer.enabled": true, "computer.achieve": achieve }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

afterAll(async () => {
	await disposeAllKernelSessions();
});

function fixture(achieve = true) {
	const backend = new AchieveBackend();
	const judge = new FakeJudge();
	let definitions: readonly EvalPreludeDefinition[] = [];
	const session: ToolSession = { ...toolSession(achieve), getEvalPreludes: () => definitions };
	const prelude = createComputerPrelude(
		session,
		currentSession => new ComputerSupervisor(currentSession, async () => backend, callSessionTool),
		() => judge,
	);
	definitions = [prelude];
	const displays: string[] = [];
	const realm = createContext({
		__omp_display__: (value: unknown) => displays.push(String(value)),
		__omp_presented__: () => {},
		__omp_prelude__: async (_name: string, parameters: unknown) => {
			const result = await prelude.invoke(parameters, { session, toolCallId: "fixture" });
			return {
				details: result.details,
				text: result.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join("\n"),
			};
		},
	});
	runInContext(prelude.javascript, realm);
	return { backend, judge, prelude, realm, displays, session };
}

const contactForm: Row[] = [
	{ role: "AXTextField", label: "Name", value: "", enabled: true },
	{ role: "AXTextField", label: "Email", value: "", enabled: true },
	{ role: "AXButton", label: "Save", enabled: true },
	{ role: "AXButton", label: "Delete Contact", enabled: true },
	{ role: "AXStaticText", label: "Details", enabled: true },
	{ role: "AXButton", label: "Archive", enabled: false },
];

async function achieveInRealm(realm: object, goal: string, options = "{}"): Promise<AchieveResult> {
	return (await runInContext(
		`(async () => { const win = await computer.window({ id: "42", pid: 123 }); return await win.achieve(${JSON.stringify(goal)}, ${options}); })()`,
		realm,
	)) as AchieveResult;
}

describe("win.achieve", () => {
	it("executes the row the judge names on the prelude's path and stops once the postcondition holds", async () => {
		const { backend, judge, realm, displays } = fixture();
		backend.rows = structuredClone(contactForm);
		backend.onDispatch = (action, row, value) => {
			if (action === "setValue") row.value = value;
		};
		judge.picks = [
			{ line: 'AXTextField "Name" -> setValue "Ada Lovelace"', probability: 0.9 },
			{ line: 'AXTextField "Name" = "Ada Lovelace" -> press "Return"', probability: 0.8 },
		];
		judge.verdicts = [0.3, 0.95];
		const result = await achieveInRealm(realm, 'Fill the Name field with "Ada Lovelace" and commit it');
		expect(backend.dispatched).toEqual(["setValue Name=Ada Lovelace", "press Name=Return"]);
		expect(result.done).toBe(true);
		expect(result.reason).toBe("done");
		expect(result.abstained).toBe(false);
		expect(result.steps.map(step => step.candidate)).toEqual([
			'AXTextField "Name" -> setValue "Ada Lovelace"',
			'AXTextField "Name" = "Ada Lovelace" -> press "Return"',
		]);
		expect(result.steps.map(step => step.postcondition)).toEqual([0.3, 0.95]);
		// The reply is the driver's own typed result, not a summary of it.
		expect(result.steps[0]!.reply).toMatchObject({ effect: "verified", delivery: "background" });
		// Return was offered only after the write landed on that field.
		expect(judge.offered()).toContain('AXTextField "Name" = "Ada Lovelace" -> press "Return"');
		const first = judge.requests[0]!;
		expect(first.state).toMatchObject({
			goal: 'Fill the Name field with "Ada Lovelace" and commit it',
			window: "Contacts: Contact",
		});
		// The postcondition sees the goal, the action, the reply and the fresh tree.
		const verdict = judge.requests.find(request => "satisfied" in request.questions)!;
		expect(verdict.state).toMatchObject({
			action: 'AXTextField "Name" -> setValue "Ada Lovelace"',
			reply: { effect: "verified" },
		});
		expect(String((verdict.state as Record<string, unknown>).observation)).toContain('value="Ada Lovelace"');
		expect(displays.join("\n")).toContain(
			'achieve "Fill the Name field with \\"Ada Lovelace\\" and commit it": done after 2 steps — judge fake/judge',
		);
	});

	it("re-observes once under the confidence gate, then abstains without dispatching", async () => {
		const { backend, judge, realm } = fixture();
		backend.rows = structuredClone(contactForm);
		judge.picks = [
			{ line: 'AXButton "Save" -> click', probability: 0.4 },
			{ line: 'AXButton "Save" -> click', probability: 0.5 },
		];
		const result = await achieveInRealm(realm, "Save the contact", "{ confidence: 0.6 }");
		expect(backend.dispatched).toEqual([]);
		expect(result).toMatchObject({ done: false, abstained: true, reason: "abstain" });
		expect(result.steps).toEqual([
			{ candidate: "reobserve", probability: 0.4, favored: 'AXButton "Save" -> click' },
			{ candidate: "abstain", probability: 0.5, favored: 'AXButton "Save" -> click' },
		]);
		expect(result.detail).toContain("below confidence 0.6 twice");
		// One observation for the acquisition, one to start, one after the gate.
		expect(backend.observations).toBe(3);
	});

	it("dispatches nothing when the judge abstains", async () => {
		const { backend, judge, realm } = fixture();
		backend.rows = structuredClone(contactForm);
		judge.picks = [{ line: "abstain", probability: 0.85 }];
		const result = await achieveInRealm(realm, "Print the contact");
		expect(backend.dispatched).toEqual([]);
		expect(result).toEqual({
			done: false,
			steps: [{ candidate: "abstain", probability: 0.85 }],
			reason: "abstain",
			abstained: true,
		});
		expect(judge.requests.some(request => "satisfied" in request.questions)).toBe(false);
	});

	it("stops at maxSteps and reports it", async () => {
		const { backend, judge, realm } = fixture();
		backend.rows = structuredClone(contactForm);
		judge.picks = Array.from({ length: 5 }, () => ({ line: 'AXButton "Save" -> click', probability: 0.9 }));
		judge.verdicts = [0.1, 0.1, 0.1, 0.1, 0.1];
		const result = await achieveInRealm(realm, "Save the contact", "{ maxSteps: 3 }");
		expect(backend.dispatched).toEqual(["click Save", "click Save", "click Save"]);
		expect(result).toMatchObject({ done: false, abstained: false, reason: "max_steps" });
		expect(result.steps).toHaveLength(3);
		expect(judge.picks).toHaveLength(2);
	});

	it("never offers a destructive row, even when the goal names it", async () => {
		const { backend, judge, realm } = fixture();
		backend.rows = structuredClone(contactForm);
		judge.picks = [{ line: "abstain", probability: 1 }];
		await achieveInRealm(realm, "Save the contact");
		const offered = judge.offered();
		expect(offered).toContain('AXButton "Save" -> click');
		expect(offered).not.toContain('AXButton "Delete Contact" -> click');
		// Disabled rows and text with no action are never candidates; a field is offered only with a quoted value.
		expect(offered.some(line => line.includes("Archive"))).toBe(false);
		expect(offered.some(line => line.includes("Details"))).toBe(false);
		expect(offered.some(line => line.startsWith("AXTextField"))).toBe(false);

		// Live, a chain judged done on the wrong card clicked "Remove Phone" six times: deletions are the model's own call.
		judge.picks = [{ line: "abstain", probability: 1 }];
		const result = await achieveInRealm(realm, "Delete this contact");
		expect(judge.offered()).not.toContain('AXButton "Delete Contact" -> click');
		expect(result.reason).toBe("abstain");
		expect(backend.dispatched).toEqual([]);
	});

	it("keeps the method off the prelude and refuses the host action while the setting is off", async () => {
		const { prelude, realm, session } = fixture(false);
		expect(prelude.javascript).not.toContain("achieve");
		expect(prelude.python).not.toContain("achieve");
		expect(prelude.codeModeDeclarations).not.toContain("achieve");
		expect(prelude.documentation).not.toContain("achieve");
		const type = await runInContext(
			'(async () => { const win = await computer.window({ id: "42", pid: 123 }); return typeof win.achieve; })()',
			realm,
		);
		expect(type).toBe("undefined");
		await expect(
			prelude.invoke(
				{ action: "achieve", window: { id: "42", pid: 123 }, goal: "Save" },
				{ session, toolCallId: "fixture" },
			),
		).rejects.toThrow("computer.achieve: true");

		const on = fixture(true);
		expect(on.prelude.javascript).toContain('defineMethod(win, "achieve"');
		expect(on.prelude.javascript).not.toContain("@achieve");
		expect(on.prelude.codeModeDeclarations).toContain("achieve(goal: string, options?: ComputerAchieveOptions)");
		expect(on.prelude.documentation).toContain("win.achieve(goal");
	});

	it("treats a refusal as a failed step that shrinks the table, and a second one in a row as the model's call", async () => {
		const { backend, judge, realm } = fixture();
		backend.rows = structuredClone(contactForm);
		backend.refusals = {
			Save: 'Refused: AXButton "Save" is covered by a sheet — press Escape first.',
			Email: "Refused: field is read-only.",
		};
		judge.picks = [
			{ line: 'AXButton "Save" -> click', probability: 0.9 },
			{ line: 'AXTextField "Email" -> setValue "ada@example.org"', probability: 0.9 },
		];
		const result = await achieveInRealm(realm, 'Save the contact with email "ada@example.org"');
		expect(backend.dispatched).toEqual([]);
		expect(result).toMatchObject({ done: false, reason: "refused", abstained: false });
		expect(result.steps[0]!.reply).toEqual({
			refusal: 'Refused: AXButton "Save" is covered by a sheet — press Escape first.',
		});
		// The refused row left the second table; the field was still offered.
		const second = judge.requests.filter(request => "next" in request.questions)[1]!;
		const lines = Object.values((second.questions.next as { criteria: Record<string, string | null> }).criteria);
		expect(lines).not.toContain('AXButton "Save" -> click');
		expect(lines).toContain('AXTextField "Email" -> setValue "ada@example.org"');
		expect(result.detail).toBe("Refused: field is read-only.");
	});

	it("counts suspected_noop as a failed step, offers keystrokes for a doubted write, and hands back an interrupted window", async () => {
		const { backend, judge, realm } = fixture();
		backend.rows = structuredClone(contactForm);
		backend.noops = { Name: true };
		backend.interruptAfter = "Save";
		judge.picks = [
			{ line: 'AXTextField "Name" -> setValue "Ada"', probability: 0.9 },
			{ line: 'AXTextField "Name" (write not taken) -> type "Ada"', probability: 0.9 },
			{ line: 'AXButton "Save" -> click', probability: 0.9 },
		];
		judge.verdicts = [0.2];
		const result = await achieveInRealm(realm, 'Fill Name with "Ada" and save');
		expect(backend.dispatched).toEqual(["setValue Name=Ada", "type Name=Ada", "click Save"]);
		expect(result.reason).toBe("interrupted");
		expect(result.detail).toContain("auth window 900");
		expect(result.steps[0]!.postcondition).toBeUndefined();
		expect(result.steps[2]!.reply).toMatchObject({ interruptedBy: { kind: "auth" } });
	});

	it("takes a not_committed write as failed and lands the value by keystrokes instead", async () => {
		// Live against Jev on TextEdit: setValue on the text view was confirmed but not committed
		// ("the app kept its own value"), and the loop kept re-observing until max_steps.
		const { backend, judge, realm } = fixture();
		backend.rows = structuredClone(contactForm);
		backend.uncommitted = { Name: true };
		// The AX write shows in the tree even though the app did not take it, as on TextEdit.
		backend.onDispatch = (action, row, value) => {
			if (action === "setValue") row.value = value;
		};
		judge.picks = [
			{ line: 'AXTextField "Name" -> setValue "Ada"', probability: 0.9 },
			{ line: 'AXTextField "Name" (write not taken) -> type "Ada"', probability: 0.9 },
		];
		judge.verdicts = [0.9];
		const result = await achieveInRealm(realm, 'Fill Name with "Ada"');
		// The field still showed "Ada" after the uncommitted AX write, so it was written back to empty first.
		expect(backend.dispatched).toEqual(["setValue Name=Ada", "setValue Name=", "type Name=Ada"]);
		expect(result).toMatchObject({ reason: "done", done: true });
		expect(result.steps[0]!.postcondition).toBeUndefined();
		expect(result.steps[0]!.reply).toMatchObject({ committed: "not_committed" });
		expect(result.steps[1]!.restored).toMatchObject({ effect: "verified" });
		expect(result.steps[1]!.postcondition).toBe(0.9);
	});

	it("returns control when the window itself reports an interruption before any pick", async () => {
		const { backend, judge, realm } = fixture();
		backend.rows = structuredClone(contactForm);
		backend.interruption = { app: "SecurityAgent", pid: 9, windowId: "900", title: "Password", kind: "auth" };
		const result = await achieveInRealm(realm, "Save the contact");
		expect(backend.dispatched).toEqual([]);
		expect(judge.requests).toHaveLength(0);
		expect(result).toMatchObject({ reason: "interrupted", done: false, steps: [] });
	});

	it("exposes the same surface from Python", async () => {
		const { backend, judge, session } = fixture();
		backend.rows = structuredClone(contactForm);
		judge.picks = [{ line: 'AXButton "Save" -> click', probability: 0.9 }];
		judge.verdicts = [0.9];
		const result = await executePython(
			[
				"win = await computer.window(id='42', pid=123)",
				"result = await win.achieve('Save the contact', max_steps=2)",
				"print(result['reason'], len(result['steps']), result['steps'][0]['candidate'])",
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `computer-py-achieve-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('done 1 AXButton "Save" -> click');
		expect(result.output).toContain('achieve "Save the contact": done after 1 step');
		expect(backend.dispatched).toEqual(["click Save"]);
	});
});

describe("achieve candidate builder", () => {
	const observation = (rows: Row[], bounds = windowFixture.bounds): ComputerObservation => ({
		snapshotId: "1",
		window: { ...windowFixture, bounds },
		tree: "",
		elements: rows.map((row, index) => ({
			ref: `n${index}`,
			pid: 123,
			windowId: "42",
			role: row.role,
			label: row.label,
			...(row.value === undefined ? {} : { value: row.value }),
			...(row.subrole === undefined ? {} : { subrole: row.subrole }),
			...(row.enabled === undefined ? {} : { enabled: row.enabled }),
			...(row.actions === undefined ? {} : { actions: row.actions }),
			...(row.bounds === undefined ? {} : { bounds: row.bounds }),
		})),
		complete: true,
		backgroundInput: true,
	});

	it("reads only quoted values out of the goal, once per occurrence", () => {
		expect(goalValues('set Name to "Ada Lovelace" and Email to “ada@x.org”')).toEqual(["Ada Lovelace", "ada@x.org"]);
		expect(goalValues("type Ada into the name field")).toEqual([]);
		expect(goalValues("don't touch `x`")).toEqual(["x"]);
		expect(goalValues('first "Smith", last "Smith"')).toEqual(["Smith", "Smith"]);
	});

	it("ranks goal overlap first, drops off-screen and secret rows, and caps the table with unique ids", () => {
		const rows: Row[] = [
			{ role: "AXButton", label: "Cancel", enabled: true, bounds: inWindow },
			{ role: "AXButton", label: "Send", enabled: true, bounds: inWindow },
			{ role: "AXButton", label: "Offscreen", enabled: true, bounds: { x: 900, y: 900, width: 10, height: 10 } },
			{ role: "AXSecureTextField", label: "Password", enabled: true, bounds: inWindow },
			{ role: "AXGroup", label: "Pressable group", enabled: true, actions: ["press"], bounds: inWindow },
			...Array.from({ length: 70 }, (_, index) => ({
				role: "AXRow",
				label: `Row ${index}`,
				enabled: true,
				bounds: inWindow,
			})),
		];
		const candidates = buildCandidates('send the message with password "hunter2"', observation(rows));
		expect(candidates).toHaveLength(60);
		expect(candidates[0]!.line).toBe('AXButton "Send" -> click');
		expect(candidates.some(candidate => candidate.line.includes("Offscreen"))).toBe(false);
		expect(candidates.some(candidate => candidate.line.includes("Password"))).toBe(false);
		expect(candidates.some(candidate => candidate.line === 'AXGroup "Pressable group" -> click')).toBe(true);
		expect(new Set(candidates.map(candidate => candidate.id)).size).toBe(60);
	});

	it("ranks a row of unknown state below proven ones, whatever its overlap", () => {
		const rows: Row[] = [
			{ role: "AXButton", label: "Send Message", bounds: inWindow },
			{ role: "AXButton", label: "Cancel", enabled: true, bounds: inWindow },
			{ role: "AXButton", label: "No bounds", enabled: true },
		];
		expect(buildCandidates("send the message", observation(rows)).map(candidate => candidate.line)).toEqual([
			'AXButton "Cancel" -> click',
			'AXButton "Send Message" -> click',
			'AXButton "No bounds" -> click',
		]);
	});

	it("offers a write only where the field does not already hold the value", () => {
		const [candidate] = buildCandidates(
			'write "x"',
			observation([{ role: "AXTextField", label: "Q", enabled: true }]),
		);
		expect(candidate).toMatchObject({
			id: "n0_setValue",
			action: "setValue",
			value: "x",
			line: 'AXTextField "Q" -> setValue "x"',
		});
		// Live against Jev, a field already holding the goal's value was re-written five steps running.
		const held = buildCandidates(
			'write "x"',
			observation([{ role: "AXTextField", label: "Q", value: "x", enabled: true }]),
		);
		expect(held.some(candidate => candidate.action === "setValue")).toBe(false);
	});

	it("offers a landed value to no other field unless the goal quotes it again", () => {
		// Live against Jev, "hello" confirmed in the text view was then written into the font-size box.
		const rows: Row[] = [
			{ role: "AXTextArea", label: "Text", value: "hello", enabled: true, bounds: inWindow },
			{ role: "AXComboBox", label: "font size", value: "12", enabled: true, bounds: inWindow },
		];
		const memory = { failed: new Set<string>(), written: new Set<string>(), landed: ["hello"], before: new Map() };
		const spent = buildCandidates('type "hello" into the document', observation(rows), memory);
		expect(spent.some(candidate => candidate.action === "setValue")).toBe(false);
		// A second quoted occurrence is a second write; the combo box is still a click, never a page.
		const twice = buildCandidates('type "hello" and then "hello" again', observation(rows), memory);
		expect(twice.map(candidate => candidate.line)).toEqual(['AXComboBox "font size" = "12" -> click']);
	});

	it("offers keystrokes for a doubted write even where the value already reads back", () => {
		// Live against Jev on TextEdit: the uncommitted AX write showed the text the app had not taken,
		// so the no-op rule hid the keystroke route and the only write left was the font-size box.
		const rows: Row[] = [{ role: "AXTextArea", label: "Text", value: "hello", enabled: true, bounds: inWindow }];
		const doubted = {
			failed: new Set(["AXTextArea||#0|setValue|hello"]),
			written: new Set<string>(),
			landed: [],
			before: new Map([["AXTextArea||#0", ""]]),
		};
		// Keystrokes would append to the text the view still shows, so the write is undone first.
		expect(buildCandidates('type "hello"', observation(rows), doubted)).toMatchObject([
			{ line: 'AXTextArea "Text" (write not taken) -> type "hello"', action: "type", restore: "" },
		]);
		// The same field renamed by its own text (label mirrors value) is still the doubted one.
		const renamed: Row[] = [{ role: "AXTextArea", label: "hello", value: "hello", enabled: true, bounds: inWindow }];
		expect(buildCandidates('type "hello"', observation(renamed), doubted).map(candidate => candidate.action)).toEqual(
			["type"],
		);
		// A field the app emptied again needs no write-back.
		const emptied: Row[] = [{ role: "AXTextArea", label: "Text", value: "", enabled: true, bounds: inWindow }];
		expect(buildCandidates('type "hello"', observation(emptied), doubted)[0]!.restore).toBeUndefined();
	});
});
