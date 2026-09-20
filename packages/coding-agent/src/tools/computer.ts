import { type Type, type } from "@oh-my-pi/omptype";
import type { AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { Judge, Model } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import { once } from "@oh-my-pi/pi-utils";
import { callSessionTool } from "../eval/js/tool-bridge";
import type { EvalPreludeContext, EvalPreludeDefinition } from "../eval/preludes";
import { resolveJudge } from "../judgment";
import { ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";
import { enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { ACHIEVE_DEFAULTS, achieve, renderAchieve } from "./computer/achieve";
import {
	COMPUTER_HANDLE_VERBS,
	type ComputerCallStep,
	handleSignatures,
	isReadOnlyComputerCall,
	renderComputerCall,
} from "./computer/call";
import type * as PreludeDefinition from "./computer/prelude-definition";
import { type ComputerController, ComputerSupervisor, registerComputerController } from "./computer/supervisor";
import { elideObservationTree } from "./computer/tree-elide";
import type {
	ComputerActionResult,
	ComputerObservation,
	ComputerRunOk,
	ComputerScreenshot,
	ComputerSessionSnapshot,
	ComputerWindowAcquisition,
} from "./computer/types";
import type { ToolSession } from "./index";
import { renderCallChain, renderFunctionRun } from "./run-code";
import { throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { clampTimeout } from "./tool-timeouts";

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
 * actually asks for its enabled preludes. The `achieve` surface ships only
 * with `computer.achieve` on, read once per session.
 */
function computerAssets(achieve: boolean): PreludeDefinition.ComputerPreludeAssets {
	const definition = require("./computer/prelude-definition") as typeof PreludeDefinition;
	return definition.computerPreludeAssets(achieve);
}

/**
 * The typed surface of both handles, once per session with the first
 * acquisition: a model that has the acquisition in front of it is about to
 * call these, and the alternative was a `computer.help()` round trip for the
 * whole declaration file. Later handles get the verb list alone.
 */
function handleSurface(lifetime: ComputerLifetime): string {
	if (!lifetime.teach("window")) return COMPUTER_HANDLE_VERBS;
	const window = handleSignatures(lifetime.assets.codeModeDeclarations, "ComputerWindow", "win handle:");
	return lifetime.teach("element") ? `${window}\n${elementSignatures(lifetime)}` : window;
}
function elementSignatures(lifetime: ComputerLifetime): string {
	return handleSignatures(lifetime.assets.codeModeDeclarations, "ComputerElement", "el handle:");
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

interface ComputerAchieveParams {
	action: "achieve";
	window: { id: string; pid: number };
	goal: string;
	maxSteps?: number;
	confidence?: number;
	timeout?: number;
}

type ComputerParams =
	| ComputerRunParams
	| ComputerCallParams
	| ComputerAchieveParams
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
		.or({
			action: "'achieve'",
			window: { id: "string", pid: "number" },
			goal: type("string").describe("one bounded, verifiable sub-goal on the window; values to write are quoted"),
			"maxSteps?": type("number").describe("steps before the loop stops with max_steps; default 8"),
			"confidence?": type("number").describe("probability a pick must reach; default 0.6"),
			"timeout?": type("number").describe("per-step run budget in seconds"),
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
}

/** Creates the session-scoped controller used by the computer prelude. */
export type ComputerControllerFactory = (session: ToolSession) => ComputerController;
/** Resolves the judge `win.achieve()` asks; the eval `judge()` helper's own resolution by default. */
export type ComputerJudgeFactory = (session: ToolSession) => Judge;

const sessionJudge: ComputerJudgeFactory = session => {
	const registry = session.modelRegistry;
	if (!registry) throw new ToolError("win.achieve() has no model registry.");
	return resolveJudge({
		settings: session.settings,
		registry,
		backend: ONLINE_MEMORY_MODEL_KEY,
		sessionId: session.getSessionId?.() ?? undefined,
	});
};

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
	createJudge: ComputerJudgeFactory = sessionJudge,
): EvalPreludeDefinition {
	const lifetime = new ComputerLifetime(session, createController, createJudge);
	const { assets } = lifetime;

	return {
		name: "computer",
		documentation: assets.documentation,
		javascript: assets.javascript,
		python: assets.python,
		exports: ["computer"],
		codeModeDeclarations: assets.codeModeDeclarations,
		approval: computerApproval,
		enabled: () => session.settings.get("computer.enabled") === true,
		invoke: async (parameters, context) => {
			const parsed = getComputerParamsSchema()(parameters);
			if (parsed instanceof type.errors) {
				throw new ToolError(`computer received invalid arguments: ${parsed.summary}`);
			}
			// An aborted operation cancels its driver call and drains; the driver
			// child stays up for the next call. Turn settle releases it.
			return await invokeComputer(session, parsed, context, lifetime);
		},
		status: describeComputerCall,
	};
}

/** Status-tree line for a settled computer call: `desktop.window(3).focus()`, `run(fn)`, `release`. */
function describeComputerCall(parameters: unknown): string | undefined {
	const parsed = getComputerParamsSchema()(parameters);
	if (parsed instanceof type.errors) return undefined;
	switch (parsed.action) {
		case "call":
			return `desktop.${renderCallChain(parsed.chain)}`;
		case "run":
			return `run(${parsed.fn !== undefined ? "fn" : (parsed.code?.trim().split("\n", 1)[0] ?? "")})`;
		case "achieve":
			return `achieve(${JSON.stringify(parsed.goal)})`;
		default:
			return parsed.action;
	}
}

class ComputerLifetime {
	readonly #session: ToolSession;
	readonly #createController: ComputerControllerFactory;
	readonly #createJudge: ComputerJudgeFactory;
	readonly #unregisterOwner: () => void;
	/** Whether `win.achieve()` ships this session; the setting is read once, with the prelude's own text. */
	readonly achieve: boolean;
	readonly assets: PreludeDefinition.ComputerPreludeAssets;
	#controller?: ComputerController;
	#closed = false;
	#releasing?: Promise<void>;
	#closing?: Promise<void>;
	#releaseFailure?: Error;
	readonly #taught = new Set<string>();

	constructor(session: ToolSession, createController: ComputerControllerFactory, createJudge: ComputerJudgeFactory) {
		this.#session = session;
		this.#createController = createController;
		this.#createJudge = createJudge;
		this.achieve = session.settings.get("computer.achieve") === true;
		this.assets = computerAssets(this.achieve);
		this.#unregisterOwner = registerComputerController(session.getEvalKernelOwnerId?.() ?? undefined, this);
	}

	judge(): Judge {
		return this.#createJudge(this.#session);
	}

	isClosed(): boolean {
		return this.#closed;
	}

	/** True once per session, for the first handle of its kind. */
	teach(handle: "window" | "element"): boolean {
		if (this.#taught.has(handle)) return false;
		this.#taught.add(handle);
		return true;
	}

	async controller(): Promise<ComputerController> {
		if (this.#releasing) await this.#releasing;
		if (this.#releaseFailure) throw this.#releaseFailure;
		if (this.#closed) throw new ToolError("Computer session is closed");
		if (!this.#session.settings.get("computer.enabled")) throw new ToolError("Computer use is disabled");
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

	close(): Promise<void> {
		this.#closed = true;
		this.#unregisterOwner();
		return (this.#closing ??= this.release());
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
		case "call":
			if (lifetime.isClosed()) throw new ToolError("Computer session is closed");
			return await runComputer(session, await lifetime.controller(), params, lifetime, context.signal);
		case "achieve":
			if (!lifetime.achieve)
				throw new ToolError(
					"win.achieve() is off: the experimental chooser sub-loop ships only with `computer.achieve: true`, read at session start.",
				);
			if (lifetime.isClosed()) throw new ToolError("Computer session is closed");
			return await achieveComputer(session, await lifetime.controller(), params, lifetime, context.signal);
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
			const text = await enforceInlineByteCap(lifetime.assets.codeModeDeclarations, {
				saveArtifact: full => saveComputerOutputArtifact(session, full),
			});
			return { content: [{ type: "text", text }], details: { screenshots: [] } };
		}
		case "release":
			await lifetime.release();
			throwIfAborted(context.signal);
			return { content: [{ type: "text", text: "Released computer resources" }], details: {} };
		case "close":
			await lifetime.close();
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

/** One run on the session's realm with the host's frozen capture settings: every call and every achieve step takes this path. */
async function executeComputer(
	session: ToolSession,
	controller: ComputerController,
	params: ComputerRunParams | ComputerCallParams,
	signal?: AbortSignal,
): Promise<{ code: string; snapshot: ComputerSessionSnapshot; run: ComputerRunOk }> {
	const code = resolveComputerRunCode(params);
	// Direct inspection calls run read-only so the desktop guard backs the read approval tier.
	const readOnly = params.action === "call" ? isReadOnlyComputerCall(params.chain) : (params.read_only ?? false);
	const timeoutSeconds = clampTimeout("computer", params.timeout, session.settings.get("tools.maxTimeout"));
	const coordinateSafe = usesCoordinateSafeImageSizing(session.getActiveModel?.());
	const configuredMaxWidth = session.settings.get("computer.maxWidth");
	const configuredMaxHeight = session.settings.get("computer.maxHeight");
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
		display: session.settings.get("computer.display") ?? "all",
		readOnly,
	};
	const run = await controller.run(code, timeoutSeconds * 1000, snapshot, signal);
	throwIfAborted(signal);
	return { code, snapshot, run };
}

/**
 * The chooser sub-loop. Each observation and each pick is one `call` run on
 * the same realm the prelude's own methods use, so refusals, typed replies
 * and evidence are exactly what `win.observe()` and `win.ref(r).click()`
 * would have returned; the loop itself lives in `./computer/achieve`.
 */
async function achieveComputer(
	session: ToolSession,
	controller: ComputerController,
	params: ComputerAchieveParams,
	lifetime: ComputerLifetime,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	if (params.goal.trim().length === 0) throw new ToolError("win.achieve() requires a non-empty goal.");
	const call = async (chain: ComputerCallStep[]): Promise<unknown> =>
		(await executeComputer(session, controller, { action: "call", chain, timeout: params.timeout }, signal)).run
			.returnValue;
	const judge = lifetime.judge();
	const result = await achieve(
		{
			observe: async () =>
				(await call([
					{ method: "window", args: [params.window] },
					{ method: "observe", args: [] },
				])) as ComputerObservation,
			act: async chain => (await call(chain)) as ComputerActionResult,
		},
		judge,
		{
			goal: params.goal,
			maxSteps: Math.max(1, Math.floor(params.maxSteps ?? ACHIEVE_DEFAULTS.maxSteps)),
			confidence: params.confidence ?? ACHIEVE_DEFAULTS.confidence,
			signal,
		},
	);
	const text = await enforceInlineByteCap(renderAchieve(params.goal, result, judge.label), {
		saveArtifact: full => saveComputerOutputArtifact(session, full),
	});
	// The trace is this value's rendering; the prelude suppresses the cell's own echo of it.
	const details: ComputerPreludeDetails = { screenshots: [], value: result, rendered: true };
	return { content: [{ type: "text", text }], details };
}

async function runComputer(
	session: ToolSession,
	controller: ComputerController,
	params: ComputerRunParams | ComputerCallParams,
	lifetime: ComputerLifetime,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	const { code, snapshot, run } = await executeComputer(session, controller, params, signal);

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
	if (observedWindow) {
		text = [
			`${observedWindow.app}: ${observedWindow.title || "Untitled window"} (window ${observedWindow.id}, PID ${observedWindow.pid})`,
			observation?.tree,
			observation && !observation.complete
				? 'Partial accessibility tree; omitted controls remain unknown — narrow the next observe ({ maxDepth } or { query: "<text>" }) or read the screenshot before concluding a control is absent.'
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
	}
	if (params.action === "call" && params.chain.some(step => step.method === "ref") && lifetime.teach("element"))
		text = text ? `${text}\n${elementSignatures(lifetime)}` : elementSignatures(lifetime);
	const cappedText = await enforceInlineByteCap(text, {
		saveArtifact: full => saveComputerOutputArtifact(session, full),
		elide: elideObservationTree,
	});
	const content: AgentToolResult<ComputerPreludeDetails>["content"] = [];
	if (cappedText) content.push({ type: "text", text: cappedText });
	for (const image of run.displays) {
		if (image.type === "image") content.push({ ...image, detail: "original" });
	}
	return { content, details };
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
