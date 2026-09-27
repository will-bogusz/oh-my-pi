import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord, logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { EvalPreludeContext, EvalPreludeDefinition, EvalPreludeStatus } from "../eval/preludes";
import type { ToolSession } from "../sdk";
import { enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { resolveCmuxKind } from "./browser/cmux/rpc";
import type * as DeclaredArguments from "./browser/declared-arguments";
import { resolveSpawnArgs } from "./browser/attach";
import {
	acquireChromeTab,
	browserActorId,
	ChromeTabGoneError,
	chromeChildTabs,
	chromeLifecycle,
	chromeDialog,
	closeChromeTab,
	discoverChromeTabs,
	listChromeInstances,
	matchesChromeTab,
	isManagedChromeHandle,
	type ManagedChromeHandle,
	releaseChromeTab,
	releaseChromeTabsForActor,
	requireChromeHandle,
	runOnChromePage,
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
import { resolveInitScriptSources } from "./browser/open-options";
import { resolveRelayKind } from "./browser/relay/kind";
import type { AriaSnapshotOptions } from "./browser/aria/aria-snapshot";
import { type ChromeDialogState, chromeDialogState } from "./browser/dialog-journal";
import type { InstanceTab } from "./browser/relay/instances";
import { chromeTabName } from "./browser/relay/managed-tabs";
import type { InitialBrowserState, RunResultOk, ScreenshotResult } from "./browser/tab-protocol";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import {
	type AcquireTabResult,
	acquireTab,
	cancelIdleCloseForOwner,
	dropHeadlessTabs,
	getTab,
	listTabs,
	type ManagedTabInfo,
	releaseIdleTabsForOwner,
	releaseTabsForActor,
	releaseTab,
	runInTab,
} from "./browser/tab-supervisor";
import { BROWSER_TAB_VERBS, renderTabCall } from "./browser/tab-call";
import { resolveToCwd } from "./path-utils";
import { renderCallChain, renderFunctionRun, summarizeCallChain } from "./run-code";
import { ToolAbortError, throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

import {
	cfgBrowserCdpUrl,
	cfgBrowserCmux,
	cfgBrowserHeadless,
	cfgBrowserIdleCloseSec,
	cfgBrowserRelay,
	cfgBrowserRelayUrl,
} from "./browser/settings";
import { cfgToolsMaxTimeout } from "./settings";

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
export {
	extractMarkdownOutline,
	extractReadableFromHtml,
	filterMarkdownSections,
	type ReadableExtractOptions,
	type ReadableFormat,
	type ReadableResult,
} from "./browser/readable";
export {
	ariaSnapshotBaselineKey,
	collectAriaSnapshotRefs,
	diffAriaSnapshot,
	postProcessAriaSnapshot,
	type AriaSnapshotBaseline,
	type AriaSnapshotDiffResult,
	type SnapshotPostProcessOptions,
} from "./browser/snapshot-plus";
export { DEFAULT_RELAY_URL, type RelayKind, resolveRelayKind } from "./browser/relay/kind";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

const DEFAULT_TAB_NAME = "main";
const BROWSER_RUN_SCOPE: readonly string[] = ["tab", "page", "browser", "wait", "assert"];

/**
 * The verb list for a conversation's first acquisition, then nothing: each
 * later open or claim would repeat the same ~1.8 KB into a context that
 * already holds it. `taught` lives with the prelude; the key is the relay
 * actor (session and agent, which `/new`, a session switch and a subagent
 * change) and the latest compaction on the branch, since a compaction
 * replaces the context that carried the list.
 */
function tabVerbsOnce(taught: Set<string>, session: ToolSession): string | undefined {
	const compaction = session.sessionManager?.getBranch().findLast(entry => entry.type === "compaction")?.id;
	const key = JSON.stringify([browserActorId(session), compaction ?? null]);
	if (taught.has(key)) return undefined;
	taught.add(key);
	return BROWSER_TAB_VERBS;
}

/**
 * `browser.tab("<name>")` for each tab this actor opened with `open` that
 * `matches` picks out. getTab and claim take only tabs in the
 * user's Chrome, and the relay's answer for an id it never issued (a target id
 * from `browser.tabs()`, say) suggests a restart that never happened. Only
 * tabs recorded as this actor's own are named, and never their URLs.
 */
function openedTabRoutes(session: ToolSession, matches: (tab: ManagedTabInfo) => boolean): string[] {
	const actor = browserActorId(session);
	return listTabs()
		.filter(tab => !isManagedChromeHandle(tab.name) && getTab(tab.name)?.ownerActorId === actor && matches(tab))
		.map(tab => `browser.tab(${JSON.stringify(tab.name)})`);
}

const OPENED_TABS_NOTE =
	"Tabs from browser.open() stay open across cells; getTab and claim take only tabs in the user's Chrome.";

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
		"'open' | 'close' | 'closeTab' | 'popups' | 'run' | 'call' | 'tabs' | 'instances' | 'discover' | 'create' | 'claim' | 'reveal' | 'release' | 'help'",
	).describe("operation"),
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
	// Its keys are observe()'s plus `screenshot`, checked against the declarations like any option.
	"observation?": type("object").describe("the first tree's observe() options plus screenshot"),
	"name?": type("string").describe("tab id (default 'main')"),
	"url?": type("string").describe("url to open; discover's url substring"),
	"title?": type("string").describe("discover's title substring"),
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
	"allowed_domains?": type("string[]").describe("allowed request hostnames"),
	"init_scripts?": type("string[]").describe("document-start JavaScript sources or cwd-relative file paths"),
	"downloads?": type("string").describe("cwd-relative download directory"),
	"user_agent?": type("string").describe("tab user agent override"),
	"ignore_https_errors?": type("boolean").describe("ignore invalid HTTPS certificates"),
	"allow_file_access?": type("boolean").describe("allow file URLs to read local files"),
	"headed?": type("boolean").describe("override the configured browser display mode"),
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
		const args = resolveSpawnArgs(exe, app.args, session.cwd);
		if (params.ignore_https_errors && !args.includes("--ignore-certificate-errors")) {
			args.push("--ignore-certificate-errors");
		}
		if (params.allow_file_access && !args.includes("--allow-file-access-from-files")) {
			args.push("--allow-file-access-from-files");
		}
		return { kind: "spawned", path: exe, args };
	}
	const relayUrl = cfgBrowserRelayUrl.get(session.settings);
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
			settingEnabled: cfgBrowserRelay.get(session.settings),
			url: relayUrl,
		});
		if (relayKind) return relayKind;
	}
	const configuredCdpUrl = cfgBrowserCdpUrl.get(session.settings)?.trim();
	if (configuredCdpUrl) {
		return { kind: "connected", cdpUrl: configuredCdpUrl.replace(/\/+$/, "") };
	}
	const cmuxKind = resolveCmuxKind({
		settingEnabled: cfgBrowserCmux.get(session.settings),
	});
	if (cmuxKind) {
		return cmuxKind;
	}
	const headless = params.headed === undefined ? cfgBrowserHeadless.get(session.settings) : !params.headed;
	return {
		kind: "headless",
		headless,
		ignoreHttpsErrors: params.ignore_https_errors,
		allowFileAccess: params.allow_file_access,
	};
}

/** Create the enabled-only browser host prelude for one tool session. */
export function createBrowserPrelude(session: ToolSession): EvalPreludeDefinition {
	// Eval-first-use boundary: source/declaration assets stay unloaded until a
	// JavaScript or Python kernel actually asks for its enabled preludes.
	const { createBrowserPreludeDefinition } = require("./browser/prelude-definition");
	const taught = new Set<string>();
	return createBrowserPreludeDefinition(session, {
		invoke: (parameters: unknown, context: EvalPreludeContext) => invokeBrowser(parameters, context, taught),
		status: describeBrowserCall,
	});
}

/** Text assets the browser host reads at call time, behind the same first-use boundary as the prelude. */
function browserAssets(): typeof import("./browser/prelude-definition").browserPreludeAssets {
	return require("./browser/prelude-definition").browserPreludeAssets;
}

/**
 * The page a browser call left in view, from what its result already holds:
 * the initial observation of an acquired tab, or an observation it printed.
 * Any other returned value is the page's data, not the page.
 */
function describedPage(details: Record<string, unknown>): { url?: string; title?: string } {
	const value = isRecord(details.value) ? details.value : {};
	const observed = isRecord(value.initialObservation)
		? value.initialObservation
		: details.rendered === true
			? value
			: {};
	const text = (field: unknown) => (typeof field === "string" && field.length > 0 ? field : undefined);
	return {
		url: text(observed.url) ?? text(details.url),
		title: text(observed.title) ?? (isRecord(value.target) ? text(value.target.title) : undefined),
	};
}

/**
 * What a settled browser call shows: `detail` is the call as written (`open
 * main https://…`, `main.id(5).click()`, `close all`); `summary` says it verb
 * first against the page title (`click 5 · Cars.com`); a call that displayed
 * a page (acquisition, observe) heads it with title and URL, and captions its
 * screenshots with the title rather than the tab's handle label.
 */
function describeBrowserCall(parameters: unknown, result: AgentToolResult<unknown>): EvalPreludeStatus | undefined {
	const parsed = browserSchema(parameters);
	if (parsed instanceof type.errors) return undefined;
	const details = isRecord(result.details) ? result.details : {};
	// A Chrome handle call reports the tab's label, not the handle id it was addressed by.
	const name = typeof details.name === "string" ? details.name : (parsed.name ?? DEFAULT_TAB_NAME);
	const page = describedPage(details);
	let host: string | undefined;
	if (page.url) host = URL.parse(page.url)?.host || undefined;
	const where = page.title ?? host;
	const acquired = parsed.action === "open" || parsed.action === "create" || parsed.action === "claim";
	const status = (detail: string, summary: string): EvalPreludeStatus => ({
		detail,
		summary,
		...(page.url && (acquired || details.rendered === true)
			? { header: page.title ? `${page.title} — ${page.url}` : page.url }
			: {}),
		...(page.title ? { label: page.title } : {}),
	});
	switch (parsed.action) {
		case "open":
		case "create":
		case "claim": {
			const detail = page.url ? `${parsed.action} ${name} ${page.url}` : `${parsed.action} ${name}`;
			return status(detail, `${parsed.action} tab · ${where ?? name}`);
		}
		case "close":
			return parsed.all ? status("close all", "close all tabs") : status(`close ${name}`, `close ${name}`);
		case "run": {
			const source = parsed.fn !== undefined ? "fn" : (parsed.code?.trim().split("\n", 1)[0] ?? "");
			return status(`${name}.run(${source})`, `run ${source} · ${where ?? name}`);
		}
		case "call": {
			const chain = parsed.chain ?? [];
			return status(`${name}.${renderCallChain(chain)}`, `${summarizeCallChain(chain) ?? "call"} · ${where ?? name}`);
		}
		case "instances":
		case "discover":
		case "tabs":
		case "help":
			return status(parsed.action, parsed.action);
		default:
			return status(`${parsed.action} ${name}`, `${parsed.action} ${name}`);
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
	const idleSec = cfgBrowserIdleCloseSec.get(session.settings);
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

/**
 * Check the caller's options on a host action against the prelude verb it
 * carries in `declarations.d.ts`, rebuilt from the fields the preludes add
 * beside those options. Tab helpers are checked where they run: the tab's
 * run scope.
 */
function checkPreludeOptions(params: BrowserParams): void {
	const { action, ...rest } = params;
	let call: Parameters<typeof DeclaredArguments.checkDeclaredArguments>;
	switch (action) {
		case "open":
		case "discover":
		case "create":
			call = ["browser", action, [rest]];
			break;
		case "close": {
			const { handle, name: _name, ...options } = rest;
			call = handle ? ["BrowserTab", "close", [options]] : ["browser", "close", [rest]];
			break;
		}
		case "closeTab": {
			const { id, ...options } = rest;
			call = ["browser", "closeTab", [id, options]];
			break;
		}
		case "claim": {
			const { id, selector, ...options } = rest;
			call = selector ? ["browser", "getTab", [selector, options]] : ["browser", "claim", [id, options]];
			break;
		}
		case "run": {
			const { name: _name, handle: _handle, fn, code, ...options } = rest;
			call = ["BrowserTab", "run", [fn ?? code, options]];
			break;
		}
		default:
			// call, popups, reveal, release, instances, tabs and help carry no caller options.
			return;
	}
	// First-use boundary: the declarations and their parser load with the first checked call.
	(require("./browser/declared-arguments") as typeof DeclaredArguments).checkDeclaredArguments(...call);
}

async function invokeBrowser(
	parameters: unknown,
	context: EvalPreludeContext,
	/** Conversations whose context holds the tab verbs; see {@link tabVerbsOnce}. */
	taught: Set<string>,
): Promise<AgentToolResult<unknown>> {
	const session = context.session;
	const parsed = browserSchema(parameters);
	if (parsed instanceof type.errors) {
		throw new ToolError(`browser received invalid arguments: ${parsed.summary}`);
	}
	checkPreludeOptions(parsed);

	try {
		throwIfAborted(context.signal);
		const timeoutSeconds = clampTimeout("browser", parsed.timeout, cfgToolsMaxTimeout.get(session.settings));
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
			// The relay journal answers dialogs in the user's Chrome: a modal-blocked
			// renderer cannot host the tab worker, and the worker never auto-answers there.
			const dialogStep = parsed.action === "call" && parsed.chain?.length === 1 ? parsed.chain[0] : undefined;
			if (dialogStep && MANAGED_DIALOG_METHODS.includes(dialogStep.method)) {
				const deadline = AbortSignal.timeout(timeoutMs);
				details.value = await managedDialogCall(
					handle,
					dialogStep,
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
						`${children.length} child tab${children.length === 1 ? "" : "s"} opened from ${chromeTabName(handle.lease.tab)}; browser.claim(id) to drive one.`,
					)
					.done();
			}
			if (["close", "release", "reveal"].includes(parsed.action)) {
				const action = parsed.action as "close" | "release" | "reveal";
				const deadline = AbortSignal.timeout(timeoutMs);
				const tab = await chromeLifecycle(
					handle,
					action,
					context.signal ? AbortSignal.any([context.signal, deadline]) : deadline,
				);
				return toolResult(details)
					.text(`${action}: ${chromeTabName(tab)} (tab.target.id ${JSON.stringify(tab.id)})`)
					.done();
			}
			if (parsed.action !== "run" && parsed.action !== "call")
				throw new ToolError("Invalid operation for an existing Chrome handle");
			return await runOnChromePage(handle, session, timeoutMs, context.signal, async rerun => {
				const result = await runBrowser(session, handle.id, parsed, details, timeoutMs, context.signal);
				if (!rerun) return result;
				const note =
					"Chrome dropped OMP's debugger during this call (usually another extension's frame, such as a password manager's menu); OMP reattached and ran it again, so a step before the drop may have run twice.";
				return { ...result, content: [{ type: "text", text: note }, ...result.content] };
			});
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
			// Filtered with getTab's own matcher, so a filter lists exactly what getTab would choose among.
			const tabs = (
				await discoverChromeTabs(session, signal, {
					browserId: parsed.browserId,
					relay: parsed.app?.relay,
				})
			).filter(tab => matchesChromeTab(tab, { title: parsed.title, url: parsed.url }));
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
			const ownedOnly = OWNED_BROWSER_OPEN_OPTIONS.filter(option => parsed[option] !== undefined);
			if (ownedOnly.length > 0)
				throw new ToolError(
					`${ownedOnly.join(", ")} configure a browser OMP launches or attaches; a tab in the user's Chrome keeps that browser's own settings.`,
				);
			if (parsed.selector && (parsed.action !== "claim" || parsed.id || parsed.browserId))
				throw new ToolError(
					"getTab selectors cannot be combined with an id, creation, or a second browser selection",
				);
			const claimId = parsed.action === "claim" ? parsed.id : undefined;
			// A CDP target id is Chrome's own opaque token for an opened tab, never a
			// relay discovery id; a tab name is the caller's choice and could equal
			// one, so a name is looked up only once Chrome has refused the id.
			const openedById = claimId ? openedTabRoutes(session, tab => tab.targetId === claimId) : [];
			if (openedById.length > 0)
				throw new ToolError(
					`${JSON.stringify(claimId)} is the target id of a tab this session opened with browser.open(), not a Chrome tab id: ${openedById.join(" or ")} returns it. ${OPENED_TABS_NOTE}`,
				);
			let selected: InstanceTab | undefined;
			if (parsed.selector) {
				const selector = parsed.selector;
				// Only a bare title or URL can mean an opened tab; a profile or window is Chrome's.
				const openedBySelector = () =>
					(selector.title?.trim() || selector.url?.trim()) &&
					selector.browserId === undefined &&
					selector.windowId === undefined
						? openedTabRoutes(session, tab => matchesChromeTab(tab, { title: selector.title, url: selector.url }))
						: [];
				const alsoOpened = (routes: readonly string[]) =>
					`${routes.length > 1 ? "Tabs this session opened with browser.open() match" : "A tab this session opened with browser.open() matches"} this selector; if that is what you meant, ${routes.join(" or ")} returns it. ${OPENED_TABS_NOTE}`;
				let discovered: InstanceTab[];
				try {
					discovered = await discoverChromeTabs(session, signal, {
						browserId: selector.browserId,
						relay: parsed.app?.relay,
					});
				} catch (error) {
					const routes = !signal.aborted && error instanceof Error ? openedBySelector() : [];
					throw routes.length > 0 ? new ToolError(`${(error as Error).message} ${alsoOpened(routes)}`) : error;
				}
				const routes = discovered.some(tab => matchesChromeTab(tab, selector)) ? [] : openedBySelector();
				if (routes.length > 0) throw new ToolError(`No Chrome tab matches this selector. ${alsoOpened(routes)}`);
				selected = selectChromeTab(discovered, selector);
			}
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
			}).catch(error => {
				const routes =
					claimId && !signal.aborted && error instanceof ToolError
						? openedTabRoutes(session, tab => tab.name === claimId)
						: [];
				if (routes.length === 0) throw error;
				// Chrome never knew the id (not one it remembers ending), and it is the name
				// of a tab this session opened: that answer, not "the relay may have
				// restarted", is the one to give. A known ending keeps its reason.
				if (error instanceof ChromeTabGoneError && error.message.includes("is unknown to this relay"))
					throw new ToolError(
						`${JSON.stringify(claimId)} is the name of a tab this session opened with browser.open(), not a Chrome tab id: ${routes.join(" or ")} returns it. ${OPENED_TABS_NOTE}`,
					);
				throw new ToolError(
					`${error.message} ${JSON.stringify(claimId)} is also the name of a tab this session opened with browser.open(); if that is what you meant, ${routes.join(" or ")} returns it. ${OPENED_TABS_NOTE}`,
				);
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
						initialDialog: chromeDialogState(handle.lease.dialog),
					};
					return await browserRunResult(session, details, {
						displays: [
							{
								type: "text",
								text: [
									`Claimed Chrome tab ${chromeTabName(handle.lease.tab)} with an open dialog. Answer it with tab.handleDialog({ accept, id: tab.initialDialog.id, text? }) before page interaction.`,
									`tab.target.id: ${JSON.stringify(handle.lease.tab.id)}`,
									JSON.stringify(chromeDialogState(handle.lease.dialog)),
									tabVerbsOnce(taught, session),
								]
									.filter(line => line !== undefined)
									.join("\n"),
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
				const state = initial.returnValue as InitialBrowserState;
				details.value = {
					created: handle.lease.created,
					target: handle.lease.tab,
					...state,
				};
				// The page as its first observation saw it; the lease only knows what
				// Chrome reported when the tab was acquired.
				const page = {
					title: state.initialObservation?.title || handle.lease.tab.title,
					url: state.initialObservation?.url || handle.lease.tab.url,
				};
				details.url = page.url;
				initial.displays.unshift({
					type: "text",
					text: `${parsed.action === "claim" ? "Claimed" : "Created inactive"} Chrome tab ${chromeTabName(page)}\ntab.target.id: ${JSON.stringify(handle.lease.tab.id)}\nURL: ${page.url}\nTab group: ${JSON.stringify(handle.label)}`,
				});
				// Once per conversation, with its first handle: the verbs are what
				// the acquisition hands over, and a later observe() of the same tab
				// repeats the tree without repeating them.
				const verbs = tabVerbsOnce(taught, session);
				if (verbs) initial.displays.push({ type: "text", text: verbs });
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
				return await openBrowser(session, name, parsed, details, timeoutMs, taught, context.signal);
			case "close":
				return await closeBrowser(session, name, parsed, details, timeoutMs, context.signal);
			case "tabs":
				details.value = listTabs();
				return toolResult(details).done();
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

const MANAGED_DIALOG_METHODS: readonly string[] = ["dialog", "handleDialog", "setDialogs"];

/** `tab.dialog()`, `tab.handleDialog()` and `tab.setDialogs()` on a Chrome handle, against the relay journal. */
async function managedDialogCall(
	handle: ManagedChromeHandle,
	step: { method: string; args: unknown[] },
	signal: AbortSignal,
): Promise<ChromeDialogState | undefined> {
	if (step.method === "dialog") return chromeDialogState(await chromeDialog(handle, undefined, signal));
	if (step.method === "setDialogs")
		throw new ToolError(
			"The user's Chrome never answers dialogs automatically: read each one with tab.dialog() and answer it with tab.handleDialog({ accept, id }).",
		);
	const [options] = step.args;
	if (!isRecord(options) || typeof options.accept !== "boolean")
		throw new ToolError("tab.handleDialog() expects { accept: boolean, id: string, text?: string }");
	if (typeof options.id !== "string" || options.id.length === 0)
		throw new ToolError(
			"In the user's Chrome, tab.handleDialog() needs the id of the dialog it answers: read it with await tab.dialog(), then pass { accept, id, text? }.",
		);
	if (options.text !== undefined && typeof options.text !== "string")
		throw new ToolError("tab.handleDialog() text must be a string");
	await chromeDialog(
		handle,
		{
			action: options.accept ? "accept" : "dismiss",
			id: options.id,
			...(options.text === undefined ? {} : { promptText: options.text }),
		},
		signal,
	);
	return undefined;
}

/** Options that configure a browser OMP launches or attaches; the user's Chrome keeps its own. */
const OWNED_BROWSER_OPEN_OPTIONS = [
	"allowed_domains",
	"init_scripts",
	"downloads",
	"user_agent",
	"ignore_https_errors",
	"allow_file_access",
	"headed",
] as const;

async function openBrowser(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	taught: Set<string>,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	const kind = resolveBrowserKind(params, session);
	const downloadsPath = params.downloads === undefined ? undefined : resolveToCwd(params.downloads, session.cwd);
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
	let stillLoading: ToolError | undefined;
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
			const initScripts = await untilAborted(openSignal, () =>
				resolveInitScriptSources(params.init_scripts, session.cwd),
			);
			// Worker-init options cannot be applied to a live tab: recycle it so the
			// reopened tab starts with them.
			if (
				existing &&
				(initScripts.length > 0 ||
					params.downloads !== undefined ||
					params.user_agent !== undefined ||
					params.ignore_https_errors === true)
			) {
				await untilAborted(openSignal, () => releaseTab(name, { kill: false, timeoutMs }));
			}
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
					allowedDomains: params.allowed_domains,
					initScripts,
					downloadsPath,
					userAgent: params.user_agent,
					ignoreHttpsErrors: params.ignore_https_errors,
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
		const header = `${verb} tab ${JSON.stringify(name)} on ${describeBrowser(browser)}`;
		if (!result.navigationTimeout) {
			const lines = [
				header,
				`URL: ${url}`,
				title ? `Title: ${title}` : null,
				// Once per conversation: a reuse or a second tab would repeat them.
				tabVerbsOnce(taught, session),
			].filter((line): line is string => typeof line === "string");
			return toolResult(details).text(lines.join("\n")).done();
		}
		// The page outlasted the budget: goto stopped the load and said where.
		// Thrown like goto's own timeout, but the tab and what arrived stay.
		stillLoading = new ToolError(
			`${header}, but its page did not finish loading: ${result.navigationTimeout}. The tab stays open on what loaded${title ? ` (title ${JSON.stringify(title)})` : ""}: browser.tab(${JSON.stringify(name)}) drives it.`,
		);
	} catch (error) {
		// Caller cancellation stays a ToolAbortError; the requested timeout
		// becomes a timeout ToolError; anything else passes through unchanged.
		if (signal?.aborted) throw error instanceof ToolAbortError ? error : new ToolAbortError();
		if (timeoutSignal.aborted) throw new ToolError(`Browser open timed out after ${timeoutMs}ms`);
		throw error;
	}
	throw stillLoading;
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
