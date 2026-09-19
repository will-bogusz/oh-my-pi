import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord, logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { EvalPreludeContext, EvalPreludeDefinition } from "../eval/preludes";
import type { ToolSession } from "../sdk";
import { enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { resolveCmuxKind } from "./browser/cmux/rpc";
import { resolveSpawnArgs } from "./browser/attach";
import {
	acquireChromeTab,
	browserActorId,
	chromeChildTabs,
	chromeLifecycle,
	chromeDialog,
	ensureChromePage,
	explainRevokedChromeControl,
	closeChromeTab,
	discoverChromeTabs,
	listChromeInstances,
	isManagedChromeHandle,
	releaseChromeTab,
	releaseChromeTabsForActor,
	requireChromeHandle,
	selectChromeTab,
} from "./browser/managed-chrome";
import {
	acquireBrowser,
	browserKey,
	type BrowserHandle,
	type BrowserKind,
	type BrowserKindTag,
	holdBrowser,
	releaseBrowser,
} from "./browser/registry";
import { ensureChromiumExecutable } from "./browser/launch";
import { resolveRelayKind } from "./browser/relay/kind";
import type { AriaSnapshotOptions } from "./browser/aria/aria-snapshot";
import type { InstanceTab } from "./browser/relay/instances";
import type { InitialBrowserState, RunResultOk, ScreenshotResult } from "./browser/tab-protocol";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import {
	type AcquireTabResult,
	acquireTab,
	cancelIdleCloseForOwner,
	dropHeadlessTabs,
	getTab,
	releaseIdleTabsForOwner,
	releaseTabsForActor,
	releaseTab,
	runInTab,
} from "./browser/tab-supervisor";
import { BROWSER_TAB_VERBS, renderTabCall } from "./browser/tab-call";
import { resolveToCwd } from "./path-utils";
import { renderCallChain, renderFunctionRun } from "./run-code";
import { ToolAbortError, throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

export type { AriaSnapshotOptions } from "./browser/aria/aria-snapshot";

/** First-use boundary for the generated Playwright ARIA evaluator bundle. */
export function buildAriaSnapshotScript(selector: string | undefined, options: AriaSnapshotOptions = {}): string {
	return require("./browser/aria/aria-snapshot").buildAriaSnapshotScript(selector, options);
}

/** First-use boundary for ARIA-ref parsing; keeps evaluator construction out of tool registration. */
export function parseAriaRefSelector(selector: string): string | null {
	return require("./browser/aria/aria-snapshot").parseAriaRefSelector(selector);
}

export { cmuxSnapshotToObservation, mapWaitUntil, resolveCmuxKind, serializeEval } from "./browser/cmux/rpc";
export { CmuxSocketClient } from "./browser/cmux/socket-client";
export { extractReadableFromHtml, type ReadableFormat, type ReadableResult } from "./browser/readable";
export { DEFAULT_RELAY_URL, type RelayKind, resolveRelayKind } from "./browser/relay/kind";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

const DEFAULT_TAB_NAME = "main";
const BROWSER_RUN_SCOPE: readonly string[] = ["tab", "page", "browser", "wait", "assert"];

const appSchema = type({
	"path?": type("string").describe("binary path to spawn"),
	"cdp_url?": type("string").describe("existing cdp endpoint"),
	"relay?": type("boolean").describe("drive the user's own tabs via the omp browser relay"),
	"args?": type("string[]").describe("extra cli args"),
	"target?": type("string").describe("substring to pick a window"),
});

const tabCallStepSchema = type({
	method: "string",
	args: "unknown[]",
});

const browserSchema = type({
	action: type(
		"'open' | 'close' | 'closeTab' | 'dialog' | 'popups' | 'run' | 'call' | 'instances' | 'discover' | 'create' | 'claim' | 'reveal' | 'release' | 'help'",
	).describe("operation"),
	"dialog?": "unknown",
	"handle?": "string",
	"id?": "string",
	"browserId?": "string",
	"label?": "string",
	"selector?": {
		"title?": "string",
		"url?": "string",
		"browserId?": "string",
		"windowId?": "number",
	},
	"observation?": {
		"includeAll?": "boolean",
		"viewportOnly?": "boolean",
		"screenshot?": "boolean",
	},
	"name?": type("string").describe("tab id (default 'main')"),
	"url?": type("string").describe("url to open"),
	"app?": appSchema,
	"viewport?": {
		width: "number",
		height: "number",
		"scale?": "number",
	},
	"wait_until?": type("'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'").describe(
		"navigation wait condition",
	),
	"dialogs?": type("'accept' | 'dismiss'").describe("auto-handle dialogs"),
	"code?": type("string").describe("js body to run in tab"),
	"fn?": type("string").describe("serialized JavaScript function to run in tab"),
	"args?": type("unknown[]").describe("arguments passed to a serialized function"),
	"chain?": tabCallStepSchema.array(),
	"timeout?": type("number").describe("timeout in seconds"),
	"all?": type("boolean").describe("release every managed tab"),
	"kill?": type("boolean").describe("also kill spawned-app browsers"),
	"persist?": type("boolean").describe("keep tab live across turn settle and idle close"),
	"full?": type("boolean").describe("discover: return every tab field instead of the compact projection"),
});

type BrowserParams = typeof browserSchema.infer;

interface BrowserPreludeDetails {
	meta?: OutputMeta;
	action: BrowserParams["action"];
	name: string;
	handle?: string;
	url?: string;
	browser?: BrowserKindTag;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	screenshots?: ScreenshotResult[];
	value?: unknown;
	/** `value` is the observation this call already printed; the cell must not echo it. */
	rendered?: boolean;
}

function resolveBrowserKind(params: BrowserParams, session: ToolSession): BrowserKind {
	const app = params.app;
	if (app?.cdp_url) {
		return { kind: "connected", cdpUrl: app.cdp_url.replace(/\/+$/, "") };
	}
	if (app?.path) {
		const exe = resolveToCwd(app.path, session.cwd);
		return { kind: "spawned", path: exe, args: resolveSpawnArgs(exe, app.args, session.cwd) };
	}
	const relayUrl = session.settings.get("browser.relayUrl");
	// Explicit app.relay wins over every setting; PI_BROWSER_RELAY stays the
	// final kill switch (a relay that is down would otherwise brick the tool).
	if (app?.relay) {
		const relayKind = resolveRelayKind({ settingEnabled: true, url: relayUrl });
		if (relayKind) return relayKind;
	}
	// Relay before cdpUrl among settings: enabling the opt-out-by-default relay
	// is a deliberate mode selection, while cdpUrl is a standing fallback
	// endpoint. A configured endpoint is a default, not an override: explicit
	// app options win.
	if (app?.relay !== false) {
		const relayKind = resolveRelayKind({
			settingEnabled: session.settings.get("browser.relay"),
			url: relayUrl,
		});
		if (relayKind) return relayKind;
	}
	const configuredCdpUrl = session.settings.get("browser.cdpUrl")?.trim();
	if (configuredCdpUrl) {
		return { kind: "connected", cdpUrl: configuredCdpUrl.replace(/\/+$/, "") };
	}
	const cmuxKind = resolveCmuxKind({
		settingEnabled: session.settings.get("browser.cmux"),
	});
	if (cmuxKind) {
		return cmuxKind;
	}
	const headless = session.settings.get("browser.headless");
	return { kind: "headless", headless };
}

/** Create the enabled-only browser host prelude for one tool session. */
export function createBrowserPrelude(session: ToolSession): EvalPreludeDefinition {
	// Eval-first-use boundary: source/declaration assets stay unloaded until a
	// JavaScript or Python kernel actually asks for its enabled preludes.
	const { createBrowserPreludeDefinition } = require("./browser/prelude-definition");
	return createBrowserPreludeDefinition(session, {
		invoke: (parameters: unknown, context: EvalPreludeContext) => invokeBrowser(session, parameters, context),
		status: describeBrowserCall,
	});
}

/** Text assets the browser host reads at call time, behind the same first-use boundary as the prelude. */
function browserAssets(): typeof import("./browser/prelude-definition").browserPreludeAssets {
	return require("./browser/prelude-definition").browserPreludeAssets;
}

/** Status-tree line for a settled browser call: `open main https://…`, `main.id(5).click()`, `close all`. */
function describeBrowserCall(parameters: unknown, result: AgentToolResult<unknown>): string | undefined {
	const parsed = browserSchema(parameters);
	if (parsed instanceof type.errors) return undefined;
	const details = isRecord(result.details) ? result.details : {};
	// A Chrome handle call reports the tab's label, not the handle id it was addressed by.
	const name = typeof details.name === "string" ? details.name : (parsed.name ?? DEFAULT_TAB_NAME);
	switch (parsed.action) {
		case "open":
		case "create":
		case "claim":
			return typeof details.url === "string" && details.url.length > 0
				? `${parsed.action} ${name} ${details.url}`
				: `${parsed.action} ${name}`;
		case "close":
			return parsed.all ? "close all" : `close ${name}`;
		case "run":
			return `${name}.run(${parsed.fn !== undefined ? "fn" : (parsed.code?.trim().split("\n", 1)[0] ?? "")})`;
		case "call":
			return `${name}.${renderCallChain(parsed.chain ?? [])}`;
		case "instances":
		case "discover":
		case "help":
			return parsed.action;
		default:
			return `${parsed.action} ${name}`;
	}
}

/** Drop headless tabs so a browser mode change applies to the next open. */
export async function restartBrowserForModeChange(): Promise<void> {
	await dropHeadlessTabs();
}

/**
 * Best-effort idle-close sweep for the calling session's owned headless
 * tabs. Never throws — callers detach it (`void`) so a slow reap cannot
 * delay the open it follows.
 */
function sweepIdleOwnedTabs(session: ToolSession): Promise<number> {
	const ownerId = session.getSessionId?.() ?? undefined;
	if (!ownerId) return Promise.resolve(0);
	const idleSec = session.settings.get("browser.idleCloseSec");
	if (!(idleSec > 0)) {
		cancelIdleCloseForOwner(ownerId);
		return Promise.resolve(0);
	}
	return releaseIdleTabsForOwner(ownerId, { idleMs: idleSec * 1000 }).catch((error: unknown) => {
		logger.debug("Browser idle-close sweep failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return 0;
	});
}

async function invokeBrowser(
	session: ToolSession,
	parameters: unknown,
	context: EvalPreludeContext,
): Promise<AgentToolResult<unknown>> {
	session = context.session;
	const parsed = browserSchema(parameters);
	if (parsed instanceof type.errors) {
		throw new ToolError(`browser received invalid arguments: ${parsed.summary}`);
	}

	try {
		throwIfAborted(context.signal);
		const timeoutSeconds = clampTimeout("browser", parsed.timeout, session.settings.get("tools.maxTimeout"));
		const timeoutMs = timeoutSeconds * 1000;
		const name = parsed.name ?? DEFAULT_TAB_NAME;
		const details: BrowserPreludeDetails = { action: parsed.action, name };
		if (parsed.action === "help") {
			const text = await enforceInlineByteCap(browserAssets().codeModeDeclarations, {
				saveArtifact: full => saveBrowserOutputArtifact(session, full),
			});
			return toolResult(details).text(text).done();
		}
		const managedOpen = parsed.action === "open" && resolveBrowserKind(parsed, session).kind === "relay";
		if (!parsed.handle && !managedOpen && ["open", "close", "run", "call"].includes(parsed.action) && !parsed.all) {
			const namedTab = getTab(name);
			if (namedTab?.ownerActorId && namedTab.ownerActorId !== browserActorId(session))
				throw new ToolError("This tab belongs to another actor. Create or claim your own exact tab.");
			if (isManagedChromeHandle(name))
				throw new ToolError("Use the immutable Chrome handle returned by create or claim, not a tab-name alias");
		}
		if (parsed.handle) {
			const handle = requireChromeHandle(parsed.handle, session);
			details.name = handle.label;
			details.handle = handle.id;
			if (parsed.action === "dialog") {
				const deadline = AbortSignal.timeout(timeoutMs);
				details.value = await chromeDialog(
					handle,
					parsed.dialog,
					context.signal ? AbortSignal.any([context.signal, deadline]) : deadline,
				);
				return toolResult(details).done();
			}
			if (parsed.action === "popups") {
				const deadline = AbortSignal.timeout(timeoutMs);
				const children = await chromeChildTabs(
					handle,
					context.signal ? AbortSignal.any([context.signal, deadline]) : deadline,
				);
				details.value = children;
				if (children.length === 0) return toolResult(details).done();
				return toolResult(details)
					.text(
						`${children.length} child tab${children.length === 1 ? "" : "s"} opened from ${JSON.stringify(handle.label)}; browser.claim(id) to drive one.`,
					)
					.done();
			}
			if (["close", "release", "reveal"].includes(parsed.action)) {
				const action = parsed.action as "close" | "release" | "reveal";
				const deadline = AbortSignal.timeout(timeoutMs);
				await chromeLifecycle(
					handle,
					action,
					context.signal ? AbortSignal.any([context.signal, deadline]) : deadline,
				);
				return toolResult(details)
					.text(`${action}: ${JSON.stringify(handle.label)}`)
					.done();
			}
			if (parsed.action !== "run" && parsed.action !== "call")
				throw new ToolError("Invalid operation for an existing Chrome handle");
			try {
				await ensureChromePage(handle, session, timeoutMs, context.signal);
				return await runBrowser(session, handle.id, parsed, details, timeoutMs, context.signal);
			} catch (error) {
				throw (await explainRevokedChromeControl(handle, error)) ?? error;
			}
		}
		if (parsed.action === "closeTab") {
			if (!parsed.id) throw new ToolError("closeTab requires the exact id returned by browser.discover()");
			const deadline = AbortSignal.timeout(timeoutMs);
			const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
			await closeChromeTab(session, parsed.id, signal, { browserId: parsed.browserId, relay: parsed.app?.relay });
			return toolResult(details)
				.text(`Closed Chrome tab ${JSON.stringify(parsed.id)}`)
				.done();
		}
		if (parsed.action === "instances") {
			const deadline = AbortSignal.timeout(timeoutMs);
			const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
			details.value = await listChromeInstances(session, signal, {
				browserId: parsed.browserId,
				relay: parsed.app?.relay,
			});
			return toolResult(details).done();
		}
		if (parsed.action === "discover") {
			const deadline = AbortSignal.timeout(timeoutMs);
			const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
			const tabs = await discoverChromeTabs(session, signal, {
				browserId: parsed.browserId,
				relay: parsed.app?.relay,
			});
			details.value = parsed.full ? tabs : compactDiscoveredTabs(tabs);
			// Let callers select which inventory fields enter the transcript.
			return toolResult(details).done();
		}
		if (parsed.action === "create" || parsed.action === "claim" || managedOpen) {
			const deadline = AbortSignal.timeout(timeoutMs);
			const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
			if (parsed.app?.target)
				throw new ToolError(
					"Chrome claims require an exact discovered id. Use browser.discover() then browser.claim(id).",
				);
			if (parsed.action === "claim" && parsed.url)
				throw new ToolError("Claim never navigates a user tab. Call goto explicitly after claiming it.");
			if (parsed.selector && (parsed.action !== "claim" || parsed.id || parsed.browserId))
				throw new ToolError(
					"getTab selectors cannot be combined with an id, creation, or a second browser selection",
				);
			const selected = parsed.selector
				? selectChromeTab(
						await discoverChromeTabs(session, signal, {
							browserId: parsed.selector.browserId,
							relay: parsed.app?.relay,
						}),
						parsed.selector,
					)
				: undefined;
			const handle = await acquireChromeTab(session, {
				action: parsed.action === "claim" ? "claim" : "create",
				id: selected?.id ?? parsed.id,
				browserId: selected?.browserId ?? parsed.browserId,
				selector: parsed.selector,
				url: parsed.url,
				label: parsed.label ?? parsed.name ?? selected?.title,
				timeoutMs,
				signal,
				relay: parsed.app?.relay,
			});
			details.handle = handle.id;
			details.name = handle.label;
			details.url = handle.lease.tab.url;
			try {
				throwIfAborted(signal);
				// A dialog-blocked renderer cannot be observed: Chrome never hands
				// out the page while a modal is up. The claim still succeeded, and
				// answering the dialog is what unblocks the page.
				if (handle.lease.dialog?.status === "open") {
					details.value = {
						created: handle.lease.created,
						target: handle.lease.tab,
						initialDialog: handle.lease.dialog,
					};
					return await browserRunResult(session, details, {
						displays: [
							{
								type: "text",
								text: `Claimed Chrome tab ${JSON.stringify(handle.label)} with an open dialog. Inspect initialDialog or tab.dialog(); answer its exact id before page interaction.\n${JSON.stringify(handle.lease.dialog)}\n${BROWSER_TAB_VERBS}`,
							},
						],
						returnValue: details.value,
						screenshots: [],
					});
				}
				const initial = await runInTab(handle.id, {
					code: renderFunctionRun(browserAssets().initialObservation, BROWSER_RUN_SCOPE, [
						parsed.observation ?? {},
					]),
					timeoutMs,
					signal,
					session,
				});
				throwIfAborted(signal);
				details.value = {
					created: handle.lease.created,
					target: handle.lease.tab,
					...(initial.returnValue as InitialBrowserState),
				};
				initial.displays.unshift({
					type: "text",
					text: `${parsed.action === "claim" ? "Claimed" : "Created inactive"} Chrome tab ${JSON.stringify(handle.label)}\nTarget: ${handle.lease.tab.id}\nURL: ${details.url}`,
				});
				// Once, with the handle itself: the verbs are what the acquisition
				// hands over, and a later observe() of the same tab repeats the
				// tree without repeating them.
				initial.displays.push({ type: "text", text: BROWSER_TAB_VERBS });
				return await browserRunResult(session, details, initial);
			} catch (error) {
				// A cancelled/failed observation cannot return its handle to the
				// caller. Hand the tab back, closing only a page OMP just opened.
				try {
					await releaseChromeTab(handle, handle.lease.created, AbortSignal.timeout(3000));
				} catch (cleanupError) {
					throw new ToolError(
						`Chrome acquisition failed for ${handle.lease.tab.id}: ${String(error)}. Cleanup also failed: ${String(cleanupError)}. Rediscover this exact tab before continuing.`,
					);
				}
				throw error;
			}
		}

		switch (parsed.action) {
			case "open":
				return await openBrowser(session, name, parsed, details, timeoutMs, context.signal);
			case "close":
				return await closeBrowser(session, name, parsed, details, timeoutMs, context.signal);
			case "run":
			case "call":
				return await runBrowser(session, name, parsed, details, timeoutMs, context.signal);
			default:
				throw new ToolError("This operation requires an immutable Chrome tab handle returned by create or claim");
		}
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		if (error instanceof Error && error.name === "AbortError") {
			throw new ToolAbortError();
		}
		throw error;
	}
}

async function openBrowser(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	const kind = resolveBrowserKind(params, session);
	details.browser = kind.kind;

	// If a tab with this name already exists on a different browser kind, fail fast — caller must close first.
	const existing = getTab(name);
	if (existing && browserKey(existing.browser.kind) !== browserKey(kind)) {
		throw new ToolError(
			`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.`,
		);
	}

	// First browser use may have to download Chrome for Testing (~180 MB).
	// That is a one-time install, not part of the open, so it runs before the
	// deadline below starts: charged against the 30s default it timed out on
	// connections where installation alone exceeds that budget.
	// The download promise is module-cached, so a caller abort here leaves it
	// finishing in the background and the next open picks up the result.
	if (kind.kind === "headless") await untilAborted(signal, () => ensureChromiumExecutable());

	// The requested timeout must cover the *entire* open — browser
	// acquisition (CDP discovery/connect), queued tab acquisition, worker
	// creation, and navigation — not only `acquireTab`. Compose one deadline
	// from the caller signal and `params.timeout` and thread it through both
	// stages so a stalled acquisition rejects at the requested boundary.
	// Capture the deadline start as well: `acquireTab` counts its
	// worker-init time against this same budget via `deadlineStartMs`
	// instead of restarting the clock after acquisition.
	const deadlineStart = performance.now();
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const openSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		const browser = await untilAborted(openSignal, () =>
			acquireBrowser(kind, {
				cwd: session.cwd,
				viewport: params.viewport
					? {
							width: params.viewport.width,
							height: params.viewport.height,
							deviceScaleFactor: params.viewport.scale,
						}
					: undefined,
				signal: openSignal,
			}),
		);

		// Hold one open-acquisition lease across the whole tab acquisition.
		// A freshly-created browser sits in the registry at refCount 0 until a
		// tab takes a hold; without this lease an abort/timeout mid-acquisition
		// (or a sibling open of a different tab name on the same browser that
		// fails) could dispose it out from under this operation. The lease is
		// released exactly once — the success and failure paths are mutually
		// exclusive — transferring ownership to the published tab on success or
		// rolling the fresh browser back on failure.
		holdBrowser(browser);
		let result: AcquireTabResult;
		try {
			result = await untilAborted(openSignal, () =>
				acquireTab(name, browser, {
					url: params.url,
					waitUntil: params.wait_until,
					viewport: params.viewport
						? {
								width: params.viewport.width,
								height: params.viewport.height,
								deviceScaleFactor: params.viewport.scale,
							}
						: undefined,
					target: params.app?.target,
					timeoutMs,
					deadlineStartMs: deadlineStart,
					dialogs: params.dialogs,
					signal: openSignal,
					ownerSessionId: session.getSessionId?.() ?? undefined,
					// Omitted stays undefined: creation defaults it to false
					// while reuse by the owner leaves a set value alone.
					persist: params.persist,
					ownerActorId: browserActorId(session),
				}),
			);
		} catch (error) {
			await releaseBrowser(browser, {
				kill: "subprocess" in browser && browser.subprocess !== undefined,
			});
			throw error;
		}
		await releaseBrowser(browser, { kill: false });
		// Opportunistic idle-close sweep for long turns that rarely settle:
		// close owned tabs idle past the timeout. Detached by design (same
		// as the orphan-target sweep on attach) — failures only log. Freeze
		// is deliberately NOT done here: freezing a sibling with an
		// in-flight run would stall it mid-execution, while turn_end is
		// race-free by construction (all tool results are paired).
		void sweepIdleOwnedTabs(session);

		const tab = result.tab;
		const url = tab.info.url;
		const title = tab.info.title ?? "";
		details.url = url;
		details.viewport = tab.info.viewport;
		const verb = result.created ? "Opened" : "Reused";
		const lines = [
			`${verb} tab ${JSON.stringify(name)} on ${describeBrowser(browser)}`,
			`URL: ${url}`,
			title ? `Title: ${title}` : null,
			// Stated with the handle this call hands over, exactly once: no
			// helper on it prints them again.
			BROWSER_TAB_VERBS,
		].filter((line): line is string => typeof line === "string");
		return toolResult(details).text(lines.join("\n")).done();
	} catch (error) {
		// Caller cancellation stays a ToolAbortError; the requested timeout
		// becomes a timeout ToolError; anything else passes through unchanged.
		if (signal?.aborted) throw error instanceof ToolAbortError ? error : new ToolAbortError();
		if (timeoutSignal.aborted) throw new ToolError(`Browser open timed out after ${timeoutMs}ms`);
		throw error;
	}
}

async function closeBrowser(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	const kill = !!params.kill;
	if (params.all) {
		let count = await releaseChromeTabsForActor(session, signal);
		count += await untilAborted(signal, () => releaseTabsForActor(browserActorId(session), { kill, timeoutMs }));
		const text = `Released ${count} managed tab${count === 1 ? "" : "s"}`;
		return toolResult(details).text(text).done();
	}
	const closed = await untilAborted(signal, () => releaseTab(name, { kill, timeoutMs }));
	const text = closed ? `Released managed tab ${JSON.stringify(name)}` : `No tab named ${JSON.stringify(name)}`;
	return toolResult(details).text(text).done();
}

function resolveBrowserRunCode(params: BrowserParams): string {
	if (params.action === "call") return renderTabCall(params.chain ?? []);
	const code = params.code?.trim();
	const fn = params.fn?.trim();
	if ((code === undefined || code.length === 0) === (fn === undefined || fn.length === 0)) {
		throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
	}
	if (fn !== undefined && fn.length > 0) {
		return renderFunctionRun(fn, BROWSER_RUN_SCOPE, params.args ?? []);
	}
	return code ?? "";
}

async function runBrowser(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	const code = resolveBrowserRunCode(params);
	const tab = getTab(name);
	if (tab) {
		details.browser = tab.browser.kind.kind;
		details.url = tab.info.url;
	}

	const result = await runInTab(name, {
		code,
		timeoutMs,
		signal,
		session,
	});

	if (result.returnValue !== undefined) details.value = result.returnValue;
	return await browserRunResult(session, details, result);
}

async function browserRunResult(
	session: ToolSession,
	details: BrowserPreludeDetails,
	{ displays, screenshots, rendered }: RunResultOk,
): Promise<AgentToolResult<unknown>> {
	if (screenshots.length) details.screenshots = screenshots;
	if (rendered) details.rendered = true;
	const content = [...displays];
	const textOnly = content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("\n");
	// Final defense at the host-result boundary: a single run can display
	// tens of KB (large JSON returns, dumped observations). Cap the combined
	// text inline; the full text stays recoverable via the artifact footer
	// when allocation succeeds.
	const cappedText = await enforceInlineByteCap(textOnly, {
		saveArtifact: full => saveBrowserOutputArtifact(session, full),
	});
	const nonText = content.filter(part => part.type !== "text");
	if (cappedText.length === 0) return toolResult(details).content(nonText).done();
	return toolResult(details)
		.content([...nonText, { type: "text", text: cappedText }])
		.done();
}

/** Persist over-cap browser run output as a session artifact; mirrors the bash minimizer's save path. */
async function saveBrowserOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("browser-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, fullText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

/**
 * Fields a tab choice needs — always present so `tab["active"]` is safe in
 * Python — plus `browserId` only when the inventory spans profiles.
 * Everything else is `{ full: true }`.
 */
export function compactDiscoveredTabs(tabs: readonly InstanceTab[]): Record<string, unknown>[] {
	const multiProfile = new Set(tabs.map(tab => tab.browserId)).size > 1;
	return tabs.map(({ id, title, url, active, ownership, popupOf, browserId }) => ({
		id,
		title,
		url,
		active,
		ownership,
		...(popupOf !== undefined ? { popupOf } : {}),
		...(multiProfile ? { browserId } : {}),
	}));
}

function describeBrowser(handle: BrowserHandle): string {
	if (!("browser" in handle)) {
		return `cmux browser (${handle.kind.surface ?? "split"})`;
	}
	switch (handle.kind.kind) {
		case "headless":
			return `headless browser (${handle.kind.headless ? "hidden" : "visible"}${handle.sharedDaemon ? ", shared" : ""})`;
		case "spawned":
			return `spawned ${handle.kind.path} (pid ${handle.pid ?? "?"})`;
		case "connected":
			return `connected ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
		case "relay":
			return `relay ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
	}
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless ${kind.headless ? "hidden" : "visible"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.surface ?? "split"}`;
	}
}
