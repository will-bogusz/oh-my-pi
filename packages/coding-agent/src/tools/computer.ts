import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Type, type } from "@oh-my-pi/omptype";
import type { AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import { once } from "@oh-my-pi/pi-utils";
import { callSessionTool } from "../eval/js/tool-bridge";
import type { EvalPreludeContext, EvalPreludeDefinition, EvalPreludeStatus } from "../eval/preludes";
import { DEFAULT_MAX_BYTES, enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import {
	COMPUTER_HANDLE_VERBS,
	type ComputerCallStep,
	handleSignatures,
	isReadOnlyComputerCall,
	renderComputerCall,
} from "./computer/call";
import { actionMark, CellReply, callLabel, chainWindow, isActionResult } from "./computer/cell-reply";
import { type ComputerController, ComputerSupervisor, registerComputerController } from "./computer/supervisor";
import { elideObservationTree } from "./computer/tree-elide";
import type {
	ComputerActionResult,
	ComputerObservation,
	ComputerScreenshot,
	ComputerSessionSnapshot,
	ComputerWindowAcquisition,
	ComputerWindowIdentity,
} from "./computer/types";
import type { ToolSession } from "./index";
import { renderCallChain, renderFunctionRun, summarizeCallChain } from "./run-code";
import { throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { clampTimeout } from "./tool-timeouts";

import {
	cfgComputerDisplay,
	cfgComputerEnabled,
	cfgComputerMaxHeight,
	cfgComputerMaxWidth,
	cfgToolsMaxTimeout,
} from "./settings";

// Image transports that re-resize a frame past their own vision budget report
// nothing back, so the model reads coordinates off pixels OMP never measured.
// Anthropic's budget is 1568 px on the long edge and ~1.15 M pixels of area
// (1280x896, the shape this was first verified at). Keeping a capture inside
// it is what lets the delivered frame stay the window's own point grid: a
// 1033x900 pt window is 930 k pixels and survives intact, where a box alone
// would have shaved it to 1028x896 for nothing.
const COORDINATE_SAFE_MAX_CAPTURE_EDGE = 1568;
const COORDINATE_SAFE_MAX_CAPTURE_PIXELS = 1280 * 896;

function usesCoordinateSafeImageSizing(model: Model | undefined): boolean {
	if (!model) return false;
	const compat = model.compat;
	return (
		(!!compat && "supportsImageDetailOriginal" in compat && compat.supportsImageDetailOriginal === false) ||
		model.identity.class === "anthropic" ||
		(model.requestModelId !== undefined &&
			classifyModel(model.provider, model.requestModelId, { lenient: true }).class === "anthropic")
	);
}

/**
 * Text assets the computer host reads at call time. Eval-first-use boundary:
 * source/declaration assets stay unloaded until a JavaScript or Python kernel
 * actually asks for its enabled preludes.
 */
function computerAssets(): typeof import("./computer/prelude-definition").computerPreludeAssets {
	return require("./computer/prelude-definition").computerPreludeAssets;
}

/**
 * The typed surface of both handles, once per session with the first
 * acquisition: a model that has the acquisition in front of it is about to
 * call these, and the alternative was a `computer.help()` round trip for the
 * whole declaration file. Later handles get the verb list alone.
 */
const windowSignatures = once(() =>
	handleSignatures(computerAssets().codeModeDeclarations, "ComputerWindow", "win handle:"),
);
const elementSignatures = once(() =>
	handleSignatures(computerAssets().codeModeDeclarations, "ComputerElement", "el handle:"),
);
function handleSurface(lifetime: ComputerLifetime): string {
	if (!lifetime.teach("window")) return COMPUTER_HANDLE_VERBS;
	return lifetime.teach("element") ? `${windowSignatures()}\n${elementSignatures()}` : windowSignatures();
}

interface ComputerRunParams {
	action: "run";
	code?: string;
	fn?: string;
	args?: unknown[];
	read_only?: boolean;
	timeout?: number;
}

interface ComputerCallParams {
	action: "call";
	chain: ComputerCallStep[];
	timeout?: number;
}

type ComputerParams =
	| ComputerRunParams
	| ComputerCallParams
	| { action: "capabilities" }
	| { action: "help" }
	| { action: "release" }
	| { action: "close" };
type ComputerParamsSchema = Type<ComputerParams>;

const getComputerParamsSchema: () => ComputerParamsSchema = once(() =>
	type({
		action: "'run'",
		"code?": type("string").describe(
			"JavaScript executed in the persistent computer session; top-level await allowed; `desktop`, `wait`, `assert` in scope",
		),
		"fn?": type("string").describe("serialized function receiving the computer run scope and positional args"),
		"args?": type("unknown[]").describe("positional function arguments"),
		"read_only?": type("boolean").describe(
			"true = desktop inspection only: screenshots and ax reads allowed, desktop input/mutation blocked",
		),
		"timeout?": type("number").describe("run budget in seconds"),
		"+": "reject",
	})
		.or({
			action: "'call'",
			chain: type({ method: "string", args: "unknown[]" })
				.array()
				.describe("desktop helper invocation with at most one window/element handle hop"),
			"timeout?": type("number").describe("run budget in seconds"),
			"+": "reject",
		})
		.or({ action: "'capabilities'", "+": "reject" })
		.or({ action: "'help'", "+": "reject" })
		.or({ action: "'release'", "+": "reject" })
		.or({ action: "'close'", "+": "reject" }),
);

interface ComputerPreludeDetails {
	code?: string;
	readOnly?: boolean;
	screenshots: ComputerScreenshot[];
	value?: unknown;
	/** `value` is already in this result's text; the cell must not echo it. */
	rendered?: boolean;
	backend?: string;
	capturePermission?: string;
	inputPermission?: string;
	axPermission?: string;
	/**
	 * The window this call displayed (acquisition, observe) or, for an action
	 * chain, the window it addressed as the session last knew it. Absent when
	 * the call addressed no single window.
	 */
	window?: { app: string; title: string; id: string; pid: number };
	/**
	 * What the call did that the user could see: the real pointer moved
	 * (global-input rungs and drags). Absent when no reply of this call
	 * reported it — which is not a claim that nothing happened.
	 */
	userVisible?: Array<{ effect: "pointer" }>;
}

/** Creates the session-scoped controller used by the computer prelude. */
export type ComputerControllerFactory = (session: ToolSession) => ComputerController;

/** Documentation, capability inspection, explicitly read-only runs, and inspection-only direct calls use read approval. */
export function computerApproval(args: unknown): ToolApprovalDecision {
	if (args === null || typeof args !== "object" || Array.isArray(args) || !("action" in args)) return "exec";
	if (args.action === "capabilities" || args.action === "release" || args.action === "help") return "read";
	if (args.action === "call") {
		// Malformed chains fall to exec here and fail schema validation at invoke time.
		try {
			return "chain" in args && Array.isArray(args.chain) && isReadOnlyComputerCall(args.chain) ? "read" : "exec";
		} catch {
			return "exec";
		}
	}
	return args.action === "run" && "read_only" in args && args.read_only === true ? "read" : "exec";
}

/** Create the enabled-only computer host prelude for one tool session. */
export function createComputerPrelude(
	session: ToolSession,
	createController: ComputerControllerFactory = currentSession =>
		new ComputerSupervisor(currentSession, undefined, callSessionTool),
): EvalPreludeDefinition {
	const lifetime = new ComputerLifetime(session, createController);
	const assets = computerAssets();

	return {
		name: "computer",
		documentation: assets.documentation,
		documentationDelivery:
			"arrives unasked, once, ahead of this conversation's first successful `computer.window(selector)` reply; read it only if that reply has left your context",
		javascript: assets.javascript,
		python: assets.python,
		exports: ["computer"],
		codeModeDeclarations: assets.codeModeDeclarations,
		approval: computerApproval,
		enabled: () => cfgComputerEnabled.get(session.settings) === true,
		invoke: async (parameters, context) => {
			const parsed = getComputerParamsSchema()(parameters);
			if (parsed instanceof type.errors) {
				throw new ToolError(`computer received invalid arguments: ${parsed.summary}`);
			}
			// An aborted operation cancels its driver call and drains; the driver
			// child stays up for the next call. Turn settle releases it.
			return await invokeComputer(session, parsed, context, lifetime);
		},
		beginCell: cell => lifetime.beginCell(cell.signal),
		settleCell: (cell, outcome) => lifetime.settleCell(cell.signal, outcome.failed),
		status: describeComputerCall,
	};
}

/** The window a computer call displayed or addressed, as its result details carry it. */
interface DescribedWindow {
	app: string;
	title: string;
	id: string;
	pid: number;
}

/** A user-visible side effect one driver reply in the call reported. */
type UserVisibleEffect = { effect: "pointer" };

function describedWindow(details: Record<string, unknown>): DescribedWindow | undefined {
	const window = details.window;
	if (window === null || typeof window !== "object") return undefined;
	const { app, title, id, pid } = window as Record<string, unknown>;
	if (typeof app !== "string" || typeof id !== "string" || typeof pid !== "number") return undefined;
	return { app, title: typeof title === "string" ? title : "", id, pid };
}

function userVisibleNotices(details: Record<string, unknown>): string[] {
	if (!Array.isArray(details.userVisible)) return [];
	return (details.userVisible as UserVisibleEffect[]).flatMap(entry =>
		entry?.effect === "pointer" ? ["moved the pointer"] : [],
	);
}

/**
 * What a settled computer call shows: `detail` is the call as written
 * (`desktop.window(3).focus()`, `run(fn)`, `release`); `summary` says it verb
 * first against the window's title (`click n12 · Notes: All iCloud`); a call
 * that displayed a window heads it; each pointer move the replies reported
 * gets its own notice.
 */
function describeComputerCall(parameters: unknown, result: AgentToolResult<unknown>): EvalPreludeStatus | undefined {
	const parsed = getComputerParamsSchema()(parameters);
	if (parsed instanceof type.errors) return undefined;
	const details =
		result.details !== null && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {};
	const window = describedWindow(details);
	const name = window && `${window.app}: ${window.title || "Untitled window"}`;
	const notices = userVisibleNotices(details);
	const status = (detail: string, summary: string | undefined): EvalPreludeStatus => ({
		detail,
		...(summary ? { summary } : {}),
		...(window && details.rendered === true
			? { header: `${name} (window ${window.id}, PID ${window.pid})` }
			: {}),
		...(name ? { label: name } : {}),
		...(notices.length > 0 ? { notices } : {}),
	});
	switch (parsed.action) {
		case "call": {
			const selector = parsed.chain[0]?.method === "window" ? parsed.chain[0].args[0] : undefined;
			const selectorId =
				selector !== null && typeof selector === "object" ? (selector as Record<string, unknown>).id : selector;
			const where =
				name ??
				(typeof selectorId === "string" || typeof selectorId === "number" ? `window ${selectorId}` : undefined);
			// A bare `window(…)` hop resolves a handle and does nothing else.
			const verb = summarizeCallChain(parsed.chain.filter(step => step.method !== "window")) ?? "window";
			return status(`desktop.${renderCallChain(parsed.chain)}`, where ? `${verb} · ${where}` : verb);
		}
		case "run": {
			const source = parsed.fn !== undefined ? "fn" : (parsed.code?.trim().split("\n", 1)[0] ?? "");
			return status(`run(${source})`, name ? `run ${source} · ${name}` : `run ${source}`);
		}
		default:
			return status(parsed.action, undefined);
	}
}

class ComputerLifetime {
	readonly #session: ToolSession;
	readonly #createController: ComputerControllerFactory;
	readonly #unregisterOwner: () => void;
	#controller?: ComputerController;
	#closed = false;
	#releasing?: Promise<void>;
	#closing?: Promise<void>;
	#releaseFailure?: Error;
	/** What each conversation was taught, by session id; the prelude outlives `/new` and session switches. */
	readonly #taught = new Map<string | null, Set<string>>();
	/** Capture files this session's runs wrote; closing the session removes these and nothing else. */
	readonly #captures = new Set<string>();
	/** The reply of each eval cell running now, by the signal its calls carry. */
	readonly #cells = new WeakMap<AbortSignal, CellReply>();

	constructor(session: ToolSession, createController: ComputerControllerFactory) {
		this.#session = session;
		this.#createController = createController;
		this.#unregisterOwner = registerComputerController(session.getEvalKernelOwnerId?.() ?? undefined, this);
	}

	isClosed(): boolean {
		return this.#closed;
	}

	/**
	 * True once per conversation, for the first handle of its kind or the first
	 * delivery of the guide. The prelude (and this lifetime) is kept across
	 * `/new` and session switches: a new conversation's transcript never saw
	 * what another was taught, and one switched back to still holds it.
	 */
	teach(handle: "window" | "element" | "guide"): boolean {
		const conversation = this.#session.getSessionId?.() ?? null;
		let taught = this.#taught.get(conversation);
		if (!taught) this.#taught.set(conversation, (taught = new Set()));
		if (taught.has(handle)) return false;
		taught.add(handle);
		return true;
	}

	/**
	 * Take ownership of capture files a run wrote. Only the driver session's
	 * own naming (`$TMPDIR/omp-computer-*`) is accepted, so a path from
	 * anywhere else can never be scheduled for removal.
	 */
	own(paths: Iterable<string>): void {
		const directory = os.tmpdir();
		for (const file of paths)
			if (path.dirname(file) === directory && path.basename(file).startsWith("omp-computer-"))
				this.#captures.add(file);
	}

	beginCell(signal: AbortSignal): void {
		this.#cells.set(signal, new CellReply());
	}

	/** The reply a call made under this signal belongs to; absent outside a composed cell. */
	cell(signal: AbortSignal | undefined): CellReply | undefined {
		return signal === undefined ? undefined : this.#cells.get(signal);
	}

	settleCell(signal: AbortSignal, failed: boolean): string | undefined {
		const cell = this.#cells.get(signal);
		this.#cells.delete(signal);
		return cell?.compose(failed);
	}
	async controller(): Promise<ComputerController> {
		if (this.#releasing) await this.#releasing;
		if (this.#releaseFailure) throw this.#releaseFailure;
		if (this.#closed) throw new ToolError("Computer session is closed");
		if (!cfgComputerEnabled.get(this.#session.settings)) throw new ToolError("Computer use is disabled");
		return (this.#controller ??= this.#createController(this.#session));
	}

	release(): Promise<void> {
		if (this.#releasing) return this.#releasing;
		if (this.#releaseFailure) return Promise.reject(this.#releaseFailure);
		const controller = this.#controller;
		if (!controller) return Promise.resolve();
		// Detach before awaiting close. New calls wait for confirmed process exit;
		// a failed close poisons this lifetime instead of creating a second driver.
		this.#controller = undefined;
		this.#releasing = (async () => {
			try {
				await controller.close();
			} catch (error) {
				this.#releaseFailure = new ToolError(
					`Computer release failed; this session cannot restart: ${String(error)}`,
				);
				throw this.#releaseFailure;
			}
		})().finally(() => {
			this.#releasing = undefined;
		});
		return this.#releasing;
	}

	/**
	 * `computer.close()`: ends the desktop session a conversation asked to end.
	 * The driver is released and the capture files this lifetime owns are
	 * removed; the lifetime stays open, so a later call starts a fresh session.
	 */
	end(): Promise<void> {
		return this.release().finally(async () => {
			const files = [...this.#captures];
			this.#captures.clear();
			await Promise.allSettled(files.map(file => fs.rm(file, { force: true })));
		});
	}

	/** Owner teardown (agent session end): permanent, unlike `end()`. */
	close(): Promise<void> {
		this.#closed = true;
		this.#unregisterOwner();
		return (this.#closing ??= this.end());
	}
}

async function invokeComputer(
	session: ToolSession,
	params: ComputerParams,
	context: EvalPreludeContext,
	lifetime: ComputerLifetime,
): Promise<AgentToolResult<unknown>> {
	throwIfAborted(context.signal);

	switch (params.action) {
		case "run":
		case "call": {
			if (lifetime.isClosed()) throw new ToolError("Computer session is closed");
			const cell = lifetime.cell(context.cell?.signal);
			const controller = await lifetime.controller();
			if (cell === undefined) return await runComputer(session, controller, params, lifetime, context.signal);
			// Inside a composed cell the text waits for the cell to settle;
			// images still go out now.
			const label = params.action === "call" ? callLabel(params.chain) : "run";
			const action = params.action === "call" ? !isReadOnlyComputerCall(params.chain) : params.read_only !== true;
			let result: AgentToolResult<ComputerPreludeDetails>;
			try {
				result = await runComputer(session, controller, params, lifetime, context.signal);
			} catch (error) {
				const failure = error instanceof ToolError ? error.context : undefined;
				const code =
					failure !== null && typeof failure === "object" && "code" in failure && typeof failure.code === "string"
						? failure.code
						: "failed";
				cell.add({ label, action, mark: "✗", text: "", failure: code });
				throw error;
			}
			const chain = params.action === "call" ? params.chain : [];
			const last = chain.at(-1)?.method;
			const observed =
				last === "observe" || last === "acquireWindow" || last === "screenshot"
					? (result.details?.window ?? chainWindow(chain))
					: undefined;
			const target = action ? chainWindow(chain) : undefined;
			const value = result.details?.value;
			cell.add({
				label,
				action,
				mark: action && isActionResult(value) ? actionMark(value) : "✓",
				text: result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n"),
				...(observed === undefined ? {} : { observed: { id: observed.id, pid: observed.pid } }),
				...(target === undefined ? {} : { target }),
			});
			return { ...result, content: result.content.filter(block => block.type !== "text") };
		}
		case "capabilities": {
			if (lifetime.isClosed()) throw new ToolError("Computer session is closed");
			const capabilities = await (await lifetime.controller()).capabilities();
			throwIfAborted(context.signal);
			return {
				content: [{ type: "text", text: stringifyReturnValue(capabilities) }],
				details: capabilities,
			};
		}
		// Documentation, not desktop state: no driver child, alive or closed.
		case "help": {
			const text = await enforceInlineByteCap(computerAssets().codeModeDeclarations, {
				saveArtifact: full => saveComputerOutputArtifact(session, full),
			});
			return { content: [{ type: "text", text }], details: { screenshots: [] } };
		}
		case "release":
			await lifetime.release();
			throwIfAborted(context.signal);
			return { content: [{ type: "text", text: "Released computer resources" }], details: {} };
		case "close":
			await lifetime.end();
			throwIfAborted(context.signal);
			return { content: [{ type: "text", text: "Closed computer session" }], details: {} };
	}
}

const COMPUTER_RUN_SCOPE: readonly string[] = ["desktop", "wait", "assert"];

function resolveComputerRunCode(params: ComputerRunParams | ComputerCallParams): string {
	if (params.action === "call") return renderComputerCall(params.chain);
	const code = params.code?.trim();
	const fn = params.fn?.trim();
	const hasCode = code !== undefined && code.length > 0;
	const hasFunction = fn !== undefined && fn.length > 0;
	if (hasCode === hasFunction) {
		throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
	}
	if (hasFunction && fn !== undefined) {
		return renderFunctionRun(fn, COMPUTER_RUN_SCOPE, params.args ?? []);
	}
	if (hasCode && code !== undefined) return code;
	throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
}

async function runComputer(
	session: ToolSession,
	controller: ComputerController,
	params: ComputerRunParams | ComputerCallParams,
	lifetime: ComputerLifetime,
	signal?: AbortSignal,
): Promise<AgentToolResult<ComputerPreludeDetails>> {
	const code = resolveComputerRunCode(params);
	// Direct inspection calls run read-only so the desktop guard backs the read approval tier.
	const readOnly = params.action === "call" ? isReadOnlyComputerCall(params.chain) : (params.read_only ?? false);
	const timeoutSeconds = clampTimeout("computer", params.timeout, cfgToolsMaxTimeout.get(session.settings));
	const coordinateSafe = usesCoordinateSafeImageSizing(session.getActiveModel?.());
	const configuredMaxWidth = cfgComputerMaxWidth.get(session.settings);
	const configuredMaxHeight = cfgComputerMaxHeight.get(session.settings);
	const snapshot: ComputerSessionSnapshot = {
		cwd: session.cwd,
		sessionId: session.getEvalSessionId?.() ?? session.getSessionId?.() ?? "computer",
		captureMaxWidth: coordinateSafe
			? Math.min(configuredMaxWidth, COORDINATE_SAFE_MAX_CAPTURE_EDGE)
			: configuredMaxWidth,
		captureMaxHeight: coordinateSafe
			? Math.min(configuredMaxHeight, COORDINATE_SAFE_MAX_CAPTURE_EDGE)
			: configuredMaxHeight,
		captureMaxPixels: coordinateSafe ? COORDINATE_SAFE_MAX_CAPTURE_PIXELS : 0,
		display: cfgComputerDisplay.get(session.settings),
		readOnly,
	};
	const run = await controller.run(code, timeoutSeconds * 1000, snapshot, signal);
	lifetime.own(run.screenshots.map(shot => shot.path));
	throwIfAborted(signal);

	const details: ComputerPreludeDetails = {
		code,
		readOnly: snapshot.readOnly,
		screenshots: run.screenshots,
	};
	if (run.returnValue !== undefined) details.value = run.returnValue;
	populateCapabilityDetails(details, run.capabilities);

	let text = run.displays
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map(content => content.text)
		.join("\n");
	const acquired =
		params.action === "call" && params.chain.length === 1 && params.chain[0]?.method === "acquireWindow"
			? (run.returnValue as ComputerWindowAcquisition)
			: undefined;
	const observation =
		acquired?.initialObservation ??
		(params.action === "call" && params.chain.at(-1)?.method === "observe"
			? (run.returnValue as ComputerObservation)
			: undefined);
	const observedWindow = acquired ?? observation?.window;
	const window = observedWindow ?? run.window;
	if (window) details.window = { app: window.app, title: window.title, id: window.id, pid: window.pid };
	const visible = userVisible(run.returnValue, params.action === "call" ? params.chain.at(-1)?.method : undefined);
	if (visible.length) details.userVisible = visible;
	if (observedWindow) {
		const keys = keyRoute(observation?.backgroundInput);
		text = [
			`${observedWindow.app}: ${observedWindow.title || "Untitled window"} (window ${observedWindow.id}, PID ${observedWindow.pid})${
				keys === undefined ? "" : ` · ${keys}`
			}`,
			observation?.tree,
			observation?.truncation !== undefined && observation.elements.length >= TRIVIAL_TREE_ROWS
				? `Partial tree (${observation.truncation}): omitted controls remain unknown.`
				: undefined,
			acquired?.inspectionError ? `Initial inspection unavailable: ${acquired.inspectionError}` : undefined,
			(observation?.screenshotError ?? acquired?.screenshotError)
				? `Screenshot unavailable: ${observation?.screenshotError ?? acquired?.screenshotError}`
				: undefined,
			text,
			// Once, with the handle itself: an observe of the same window repeats
			// the tree, never the surface the model already holds. The first
			// acquisition of the session is the one that states its types.
			acquired?.initialObservation ? handleSurface(lifetime) : undefined,
		]
			.filter(Boolean)
			.join("\n");
		// The window header, tree and screenshot notes above are this value's
		// rendering; the prelude suppresses the cell's own echo of it.
		details.rendered = true;
	} else if (
		params.action === "call" &&
		(!isReadOnlyComputerCall(params.chain) || params.chain.at(-1)?.method === "screenshot")
	) {
		// An action's value is said by its own line (and by the cell's summary
		// where the cell is composed), a capture's by its pixels; the JSON echo
		// only repeats them.
		details.rendered = true;
	}
	if (params.action === "call" && params.chain.some(step => step.method === "ref") && lifetime.teach("element"))
		text = text ? `${text}\n${elementSignatures()}` : elementSignatures();
	// The guide rides the conversation's first acquisition, the call every
	// native task starts with, instead of costing a `read` step before it. It
	// shares the reply's byte budget, so the tree is elided structurally to
	// fit beside it rather than cut blindly by the output spill. A session
	// that cannot `read` already has it inline in the eval description.
	const guide =
		acquired !== undefined && session.isToolActive?.("read") !== false && lifetime.teach("guide")
			? `Computer guide (once per conversation; also at xd://eval/computer):\n${computerAssets().documentation}\n\n`
			: "";
	const cappedText = await enforceInlineByteCap(text, {
		maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(guide, "utf-8"),
		saveArtifact: full => saveComputerOutputArtifact(session, full),
		elide: elideObservationTree,
	});
	const content: AgentToolResult<ComputerPreludeDetails>["content"] = [];
	const replyText = cappedText ? `${guide}${cappedText}` : guide.trimEnd();
	if (replyText) content.push({ type: "text", text: replyText });
	for (const image of run.displays) {
		if (image.type === "image") content.push({ ...image, detail: "original" });
	}
	return { content, details };
}

/** A tree under this many rows is not worth a "Partial" line whatever the walk says. */
const TRIVIAL_TREE_ROWS = 20;

/**
 * The keyboard route an observation's `background_input` reports for the
 * window's process, said only when background keys are refused — the case
 * where a call has to carry `{ delivery: "foreground" }`. Informational: the
 * caller chooses the route.
 */
function keyRoute(backgroundInput: unknown): string | undefined {
	if (backgroundInput === null || typeof backgroundInput !== "object" || !("routes" in backgroundInput)) return undefined;
	const routes = backgroundInput.routes;
	if (!Array.isArray(routes)) return undefined;
	for (const route of routes) {
		if (route === null || typeof route !== "object" || !("route" in route) || route.route !== "pid_keyboard") continue;
		if (!("status" in route) || route.status !== "refused") return undefined;
		return `keys: foreground only${"reason" in route && typeof route.reason === "string" ? ` (${route.reason})` : ""}`;
	}
	return undefined;
}

/** What one call's reply says the user could see; see `ComputerPreludeDetails.userVisible`. */
function userVisible(value: unknown, method: string | undefined): NonNullable<ComputerPreludeDetails["userVisible"]> {
	if (!isActionResult(value)) return [];
	return value.route === "global_input" || method === "drag" ? [{ effect: "pointer" }] : [];
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function populateCapabilityDetails(
	details: ComputerPreludeDetails,
	capabilities: DesktopCapabilities | undefined,
): void {
	if (!capabilities) return;
	details.backend = capabilities.backend;
	details.capturePermission = capabilities.capturePermission;
	details.inputPermission = capabilities.inputPermission;
	details.axPermission = capabilities.axPermission;
}

/** Persist over-cap computer run output as a session artifact; mirrors the browser run save path. */
async function saveComputerOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("computer-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, fullText);
		return alloc.id;
	} catch {
		return undefined;
	}
}
