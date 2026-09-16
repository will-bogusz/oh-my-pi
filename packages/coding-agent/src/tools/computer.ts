import { type Type, type } from "@oh-my-pi/omptype";
import type { AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import { once, prompt } from "@oh-my-pi/pi-utils";
import { callSessionTool } from "../eval/js/tool-bridge";
import type { EvalPreludeContext, EvalPreludeDefinition } from "../eval/preludes";
import computerDescription from "../prompts/tools/computer.md" with { type: "text" };
import { enforceInlineByteCap } from "../session/streaming-output";
import {
	COMPUTER_HANDLE_VERBS,
	type ComputerCallStep,
	handleSignatures,
	isReadOnlyComputerCall,
	renderComputerCall,
} from "./computer/call";
// @ts-expect-error Bun imports this declaration source as text instead of a TypeScript module.
import computerCodeModeDeclarations from "./computer/declarations.d.ts" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import computerJavascript from "./computer/prelude.js" with { type: "text" };
import computerPython from "./computer/prelude.py" with { type: "text" };
import { type ComputerController, ComputerSupervisor, registerComputerController } from "./computer/supervisor";
import { elideObservationTree } from "./computer/tree-elide";
import type {
	ComputerObservation,
	ComputerScreenshot,
	ComputerSessionSnapshot,
	ComputerWindowAcquisition,
} from "./computer/types";
import type { ToolSession } from "./index";
import { renderFunctionRun } from "./run-code";
import { ToolError, throwIfAborted } from "./tool-errors";
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
 * The typed surface of each handle, once per session with the first handle
 * of its kind: a model that has the acquisition in front of it is about to
 * call these, and the alternative was a `computer.help()` round trip for the
 * whole declaration file. Later handles get the verb list alone.
 */
const windowSignatures = once(() =>
	handleSignatures(computerCodeModeDeclarations as string, "ComputerWindow", "win handle:"),
);
const elementSignatures = once(() =>
	handleSignatures(computerCodeModeDeclarations as string, "ComputerElement", "el handle:"),
);

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

	return {
		name: "computer",
		// The prelude contract is the same everywhere; the backend's delivery
		// routes, tree source and interruption model are not. The driver child
		// is local, so the host platform selects the variant.
		documentation: prompt.render(computerDescription, { linux: process.platform === "linux" }),
		javascript: computerJavascript,
		python: computerPython,
		exports: ["computer"],
		codeModeDeclarations: computerCodeModeDeclarations,
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
	};
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
	readonly #taught = new Set<string>();

	constructor(session: ToolSession, createController: ComputerControllerFactory) {
		this.#session = session;
		this.#createController = createController;
		this.#unregisterOwner = registerComputerController(session.getEvalKernelOwnerId?.() ?? undefined, this);
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
			const text = await enforceInlineByteCap(computerCodeModeDeclarations, {
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

async function runComputer(
	session: ToolSession,
	controller: ComputerController,
	params: ComputerRunParams | ComputerCallParams,
	lifetime: ComputerLifetime,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
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
			// handle of the session is the one that states its types.
			acquired?.initialObservation
				? lifetime.teach("window")
					? windowSignatures()
					: COMPUTER_HANDLE_VERBS
				: undefined,
		]
			.filter(Boolean)
			.join("\n");
		// The window header, tree and screenshot notes above are this value's
		// rendering; the prelude suppresses the cell's own echo of it.
		details.rendered = true;
	}
	if (params.action === "call" && params.chain.some(step => step.method === "ref") && lifetime.teach("element"))
		text = text ? `${text}\n${elementSignatures()}` : elementSignatures();
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
