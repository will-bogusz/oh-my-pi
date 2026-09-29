import type { AgentToolContext, AgentToolResult, AgentToolUpdateCallback, ToolApproval } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { denyError, formatApprovalPrompt, resolveApproval, resolveApprovalFromContext } from "../tools/approval";

/** Host context supplied when an eval prelude calls back out of its language VM. */
export interface EvalPreludeContext {
	/** Live owning session; authorization is always resolved against its current preludes. */
	session: ToolSession;
	/** Tool-call-shaped identifier assigned to this individual host invocation. */
	toolCallId: string;
	/** Cancellation signal for the active eval cell. */
	signal?: AbortSignal;
	/** Ordinary agent tool context used for settings, UI, and provider metadata. */
	context?: AgentToolContext;
	/** Progress receiver shared with the active eval call. */
	onUpdate?: AgentToolUpdateCallback<unknown>;
	/**
	 * The eval cell this call runs in, keyed by the signal the eval tool
	 * announced to `beginCell`; absent outside an eval cell. `signal` above is
	 * the call's own and may be derived per call.
	 */
	cell?: EvalPreludeCell;
}

/**
 * A language prelude whose snippets run in eval VMs while its privileged handler
 * remains in the host process. Prelude definitions are capabilities, not tools:
 * they have no parameter schema, renderer, label, or load mode and never enter a
 * model tool inventory.
 */
export interface EvalPreludeDefinition {
	/** Stable bridge name and registration key. */
	name: string;
	/** Static Markdown documentation shown only while this prelude is enabled. */
	documentation: string;
	/**
	 * Where the documentation also arrives without a `read`, e.g. with the first
	 * reply of a session. The eval description names it on this prelude's line
	 * so the model does not spend a call fetching what it is about to be given.
	 */
	documentationDelivery?: string;
	/** JavaScript source installed into an ordinary JavaScript eval realm. */
	javascript: string;
	/** Python source installed into a Python eval kernel. */
	python: string;
	/** Globals owned by the snippets and removed when the prelude is replaced or disabled. */
	exports: readonly string[];
	/**
	 * Model-facing policy appended as its own system-prompt block while this
	 * prelude is advertised. Replayed by the hidden prelude notice when enabled
	 * mid-session, since the cached system prompt is not rebuilt for the toggle.
	 */
	guidance?: string;
	/** Optional declarations appended to code-mode TypeScript context while enabled. */
	codeModeDeclarations?: string;
	/** Approval tier or argument-dependent approval decision for host calls. */
	approval?: ToolApproval;
	/** Live availability predicate. Omission means enabled. */
	enabled?: () => boolean;
	/** Execute a host call outside the language VM. */
	invoke(parameters: unknown, context: EvalPreludeContext): Promise<AgentToolResult<unknown>>;
	/**
	 * Description of a successful host call for the eval status tree.
	 * `undefined` records nothing; omit the hook when the call has nothing
	 * worth showing. Failures are recorded by the bridge regardless.
	 */
	status?(parameters: unknown, result: AgentToolResult<unknown>): EvalPreludeStatus | undefined;
	/**
	 * A cell is about to run. Host calls this prelude receives with
	 * `cell.signal` as their `EvalPreludeContext.signal` belong to it until
	 * `settleCell`; a prelude may hold their text back and say it once there.
	 */
	beginCell?(cell: EvalPreludeCell): void;
	/**
	 * The cell has finished. What this prelude's calls in it compose,
	 * printed ahead of the cell's own output; `failed` when the cell ended
	 * in an error. Called once per `beginCell`.
	 */
	settleCell?(cell: EvalPreludeCell, outcome: { failed: boolean }): string | undefined;
}

/** What a settled host call shows the user, built from the call and its result details. */
export interface EvalPreludeStatus {
	/** The call as written (`main.goto("https://…")`). */
	detail: string;
	/** Verb first, then what it acted on and where: `click n12 · Notes: All iCloud`. Absent → `detail`. */
	summary?: string;
	/** Header of the window or tab this call displayed. Absent: the call displayed none. */
	header?: string;
	/** Caption for the images this call captured (window or page title). Absent: the image's own label. */
	label?: string;
	/**
	 * One line per user-visible side effect the result reported (an app brought
	 * to the front, the real pointer moved). Absent: none was reported, which
	 * is not proof that none happened.
	 */
	notices?: string[];
}

/** One eval cell, as the prelude calls made inside it identify it. */
export interface EvalPreludeCell {
	/** The cell's own abort signal: the one its prelude calls carry. */
	signal: AbortSignal;
}

/**
 * Resolve enabled candidates without consulting a session getter (and therefore
 * without recursion). Later definitions replace earlier definitions of the same
 * name, matching extension tool registration precedence.
 */
export function getEnabledEvalPreludes(definitions: readonly EvalPreludeDefinition[]): EvalPreludeDefinition[] {
	const enabledByName = new Map<string, EvalPreludeDefinition>();
	for (const definition of definitions) {
		if (definition.enabled?.() !== false) enabledByName.set(definition.name, definition);
	}
	return Array.from(enabledByName.values());
}

/** First documentation line, advertised as the prelude's one-line summary; undefined when undocumented. */
export function evalPreludeSummary(definition: Pick<EvalPreludeDefinition, "documentation">): string | undefined {
	const doc = definition.documentation.trim();
	return doc ? doc.split("\n", 1)[0] : undefined;
}

/** Resolve a prelude from the session's live enabled set. Captured stale VM functions therefore fail closed. */
export function findEnabledEvalPrelude(session: ToolSession, name: string): EvalPreludeDefinition | undefined {
	const definition = session.getEvalPreludes?.().find(candidate => candidate.name === name);
	return definition?.enabled?.() === false ? undefined : definition;
}

async function approvePreludeInvocation(
	definition: EvalPreludeDefinition,
	parameters: unknown,
	context: EvalPreludeContext,
): Promise<void> {
	context.signal?.throwIfAborted();
	// Fourth execute-time site: same helper as wrapper/cursor/mcp so a missing
	// context cannot silently yolo. Empty `context.context` fail-closes;
	// omitting it inherits the live session settings (schema default yolo).
	const { approvalMode: mode, userPolicies: policies } = resolveApprovalFromContext(
		context.context ?? (context.session.settings ? { settings: context.session.settings } : undefined),
	);
	const subject: { name: string; approval?: ToolApproval } = { name: definition.name };
	if (definition.approval !== undefined) subject.approval = definition.approval;
	const resolved = resolveApproval(subject, parameters, mode, policies);
	if (resolved.policy === "deny") throw denyError(resolved, definition.name);
	if (resolved.policy !== "prompt") return;

	const ui = context.context?.ui;
	if (!ui || context.context?.hasUI === false) {
		throw new Error(
			`Eval prelude "${definition.name}" requires approval but no interactive UI is available.\n` +
				`Set tools.approval.${definition.name}: allow or use an interactive UI to approve the call.`,
		);
	}
	const choice = await untilAborted(context.signal, () =>
		ui.select(formatApprovalPrompt(subject, parameters, resolved.reason), ["Approve", "Deny"]),
	);
	if (choice !== "Approve") throw new Error(`Eval prelude call denied by user: ${definition.name}`);
}

/**
 * Invoke a prelude through the live session registry. Authorization is resolved
 * before the handler runs and repeated when an awaited approval raced with a
 * replacement, so a disabled or replaced captured function cannot retain host
 * access under stale policy.
 */
export async function invokeEvalPrelude(
	name: string,
	parameters: unknown,
	context: EvalPreludeContext,
): Promise<AgentToolResult<unknown>> {
	context.signal?.throwIfAborted();
	let definition = findEnabledEvalPrelude(context.session, name);
	if (!definition) throw new Error(`Eval prelude "${name}" is not enabled in the current session.`);

	await approvePreludeInvocation(definition, parameters, context);
	context.signal?.throwIfAborted();
	const current = findEnabledEvalPrelude(context.session, name);
	if (!current) throw new Error(`Eval prelude "${name}" is not enabled in the current session.`);
	if (current !== definition) {
		definition = current;
		await approvePreludeInvocation(definition, parameters, context);
		context.signal?.throwIfAborted();
		if (findEnabledEvalPrelude(context.session, name) !== definition) {
			throw new Error(`Eval prelude "${name}" changed while authorizing the call.`);
		}
	}
	return definition.invoke(parameters, context);
}
