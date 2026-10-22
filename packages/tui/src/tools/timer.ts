/**
 * Transcript renderer for the `timer` tool: a card for set/show/pause/resume
 * (rendered from the stored record the tool snapshots into `details.card`),
 * a table for list, and plain sanitized text for runs, fire and remove.
 * The same card lines back `/timer` reports and the `/timers` sheet.
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { Text } from "../components/text";
import { compact, kv, span, text } from "../native/describe";
import { OwnerMemo } from "../native/memo";
import type { NativeChild } from "../native/node";
import { renderStatusLine } from "../render/status-line";
import { framedToolCard } from "../render/tool-card";
import {
	formatErrorDetail,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenEmbeddedPaths,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import type { Theme, ThemeColor } from "../theme/theme";
import type { Component } from "../tui";
import { wrapTextWithAnsi } from "../utils";
import { errorView, resultText, toolHead } from "./native-view";
import type { OutputMeta } from "./output-meta";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";

/** Lifecycle state of a stored timer. */
export type TimerStatusName = "armed" | "paused" | "done";

/**
 * A timer's card as plain fields, read from the stored record. Values are
 * display text; renderers sanitize them.
 */
export interface TimerCardView {
	id: string;
	/** What just happened (`armed`, `re-armed`, `paused`, …); empty for `show`. */
	verb: string;
	status: TimerStatusName;
	/** Next fire as wall clock plus relative time, or `paused` / `done (…)`. */
	fires: string;
	/** `once` or `every <cadence>`. */
	cadence: string;
	/** The action: `wake this session → "…"`, `wake session <id> → "…"`, or `run \`…\``. */
	does: string;
	/** The full prompt or command, for the expanded card. */
	body?: string;
	/** Session targets only: what happens when the session is mid-turn. */
	ifBusy?: string;
	/** Session targets only: what happens when no omp has the session open. */
	ifClosed?: string;
	limits?: string;
	why: string;
	last: string;
	ticker: string;
	/** Conditions the user must know about (stale ticker, sleeping Mac, …). */
	warnings: string[];
}

/** One row of a timer listing. */
export interface TimerListRowView {
	id: string;
	status: TimerStatusName;
	next: string;
	last: string;
	reason: string;
}

/** `timer` tool details: the card or listing the transcript draws. */
export interface TimerToolDetails {
	op: string;
	id?: string;
	card?: TimerCardView;
	rows?: TimerListRowView[];
	/** Ticker liveness line under a listing. */
	ticker?: string;
	meta?: OutputMeta;
}

/** Streamed or final `timer` call arguments, as far as the preview reads them. */
export interface TimerRenderArgs {
	op?: string;
	id?: string;
	at?: string;
	every?: string;
	prompt?: string;
	shell?: string;
}

const LABEL_WIDTH = 9;

/** Display text for any stored value on one line: control sequences stripped, whitespace runs (tabs, newlines) collapsed, home shortened. */
function clean(value: string): string {
	return shortenEmbeddedPaths(sanitizeText(value)).replace(/\s+/g, " ").trim();
}

function statusColor(status: TimerStatusName): ThemeColor {
	return status === "armed" ? "accent" : status === "paused" ? "warning" : "muted";
}

/** The schedule a call asks for, in the user's words: `in 2h`, `every 30m`. */
function describeSchedule(args: TimerRenderArgs): string | undefined {
	const parts: string[] = [];
	if (args.at) parts.push(`at ${args.at}`);
	if (args.every) parts.push(`every ${args.every}`);
	return parts.length > 0 ? clean(parts.join(", ")) : undefined;
}

/** The call's action preview: the prompt or command, one line. */
function describeCallAction(args: TimerRenderArgs): string | undefined {
	if (args.shell) return `$ ${clean(args.shell)}`;
	if (args.prompt) return `"${clean(args.prompt)}"`;
	return undefined;
}

/** Labeled card rows (label, value, color), in display order. */
function cardRows(card: TimerCardView): Array<[string, string, ThemeColor?]> {
	const rows: Array<[string, string, ThemeColor?]> = [
		["fires", `${card.fires} · ${card.cadence}`],
		["does", card.does],
	];
	if (card.ifBusy || card.ifClosed) {
		rows.push(["if busy", compact([card.ifBusy, card.ifClosed && `if closed: ${card.ifClosed}`]).join(" · ")]);
	}
	if (card.limits) rows.push(["limits", card.limits]);
	rows.push(["why", card.why], ["last", card.last], ["ticker", card.ticker]);
	return rows;
}

/**
 * The card body as styled lines fitted to `width`: one labeled row per fact,
 * warnings after them, and (expanded) the full prompt or command wrapped.
 */
export function renderTimerCardLines(card: TimerCardView, uiTheme: Theme, width: number, expanded: boolean): string[] {
	const lines: string[] = [];
	const valueWidth = Math.max(1, width - LABEL_WIDTH);
	for (const [label, value] of cardRows(card)) {
		const shown = truncateToWidth(clean(value), valueWidth);
		lines.push(`${uiTheme.fg("dim", label.padEnd(LABEL_WIDTH))}${shown}`);
	}
	for (const warning of card.warnings) {
		lines.push(truncateToWidth(uiTheme.fg("warning", `${uiTheme.status.warning} ${clean(warning)}`), width));
	}
	if (expanded && card.body) {
		const body = shortenEmbeddedPaths(replaceTabs(sanitizeText(card.body)));
		const wrapped = body.split("\n").flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - 2)));
		lines.push("");
		for (const line of wrapped.slice(0, PREVIEW_LIMITS.EXPANDED_LINES)) lines.push(`  ${uiTheme.fg("muted", line)}`);
		const hidden = wrapped.length - PREVIEW_LIMITS.EXPANDED_LINES;
		if (hidden > 0) lines.push(uiTheme.fg("dim", `  … ${hidden} more lines`));
	}
	return lines;
}

/** Card header: icon, `Timer`, the verb and id, and a status badge. */
export function renderTimerCardHeader(card: TimerCardView, uiTheme: Theme): string {
	return renderStatusLine(
		{
			iconOverride: uiTheme.fg("accent", uiTheme.icon.timer),
			title: "Timer",
			description: clean(compact([card.verb, card.id]).join(" ")),
			badge: { label: card.status, color: statusColor(card.status) },
		},
		uiTheme,
	);
}

/** Commands that manage the timer, drawn in the card's bottom border. */
export function timerCardFooter(id: string): string {
	return `/timer show ${id} · /timer rm ${id}`;
}

/** A framed card for one timer. */
export function timerCardComponent(card: TimerCardView, uiTheme: Theme, expanded: boolean): Component {
	return framedToolCard(uiTheme, ({ contentWidth }) => ({
		header: renderTimerCardHeader(card, uiTheme),
		sections: [{ content: renderTimerCardLines(card, uiTheme, contentWidth, expanded) }],
		footerMeta: timerCardFooter(card.id),
		phase: card.warnings.length > 0 ? "warning" : "success",
		borderColor: card.warnings.length > 0 ? "warning" : "borderMuted",
	}));
}

/** Listing rows as aligned columns fitted to `width`. */
export function renderTimerListLines(
	rows: readonly TimerListRowView[],
	uiTheme: Theme,
	width: number,
	limit: number,
): string[] {
	if (rows.length === 0) return [uiTheme.fg("muted", "no timers")];
	const idWidth = Math.min(TRUNCATE_LENGTHS.SHORT, Math.max(...rows.map(row => clean(row.id).length)));
	const lines = rows.slice(0, limit).map(row => {
		const id = truncateToWidth(clean(row.id), idWidth).padEnd(idWidth);
		const status = uiTheme.fg(statusColor(row.status), row.status.padEnd(6));
		const rest = clean(`${row.next} · ${row.last} · ${row.reason}`);
		return truncateToWidth(`${id}  ${status}  ${uiTheme.fg("muted", rest)}`, width);
	});
	if (rows.length > limit) lines.push(uiTheme.fg("dim", `… ${rows.length - limit} more`));
	return lines;
}

/** Plain result text (runs, fire, remove) as sanitized lines, clamped by the expanded state. */
function plainLines(body: string, uiTheme: Theme, width: number, expanded: boolean): string[] {
	const all = shortenEmbeddedPaths(replaceTabs(sanitizeText(body))).split("\n");
	const limit = expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
	const lines = all.slice(-limit).map(line => truncateToWidth(uiTheme.fg("muted", line), width));
	if (all.length > limit) lines.unshift(uiTheme.fg("dim", `… ${all.length - limit} earlier lines`));
	return lines;
}

function opTitle(op: string | undefined, id: string | undefined): string {
	return clean(compact([op ?? "", id ?? ""]).join(" "));
}

function describeCallView(args: TimerRenderArgs): NativeToolView {
	const head: TspSpan[] = toolHead("Timer", opTitle(args.op, args.id) || undefined, describeSchedule(args));
	const action = describeCallAction(args);
	return { head, body: action ? [text([span(action, "muted")], { wrap: "word", lines: 2 })] : undefined };
}

function describeCardBody(card: TimerCardView): NativeChild[] {
	return compact<NativeChild>([
		kv(cardRows(card).map(([label, value]) => [label, clean(value)] as const)),
		...card.warnings.map(warning => text([span(`⚠ ${clean(warning)}`, "warning")], { wrap: "word" })),
		text([span(timerCardFooter(card.id), "dim")], { wrap: "none" }),
	]);
}

function describeResultView(result: ToolRenderResult<TimerToolDetails>, args?: TimerRenderArgs): NativeToolView {
	const details = result.details;
	const op = details?.op ?? args?.op;
	const title = opTitle(op, details?.id ?? args?.id);
	if (result.isError) return errorView("Timer", resultText(result) || "timer failed", title);
	const card = details?.card;
	if (card) {
		return {
			head: [
				...toolHead("Timer", clean(compact([card.verb, card.id]).join(" "))),
				span(" "),
				span(card.status, statusColor(card.status)),
			],
			body: describeCardBody(card),
			tone: card.warnings.length > 0 ? "warning" : undefined,
		};
	}
	if (details?.rows) {
		const rows = details.rows.map(row =>
			text([span(clean(`${row.id}  ${row.status}  ${row.next} · ${row.last} · ${row.reason}`), "muted")], {
				wrap: "none",
			}),
		);
		return {
			head: toolHead("Timer", "list", `${details.rows.length}`),
			body: [...rows, ...(details.ticker ? [text([span(clean(details.ticker), "dim")])] : [])],
		};
	}
	return {
		head: toolHead("Timer", title),
		body: [text([span(clean(resultText(result)), "muted")], { wrap: "word" })],
	};
}

const timerResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Renders timer calls (with a streaming preview of the schedule and action) and their cards. */
export const timerToolRenderer = {
	renderCall(args: TimerRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const safeArgs = typeof args === "object" && args !== null ? args : {};
		const meta = compact([describeSchedule(safeArgs)]);
		const header = renderStatusLine(
			{
				icon: "pending",
				spinnerFrame: options.spinnerFrame,
				title: "Timer",
				description: opTitle(safeArgs.op, safeArgs.id),
				meta,
			},
			uiTheme,
		);
		const action = describeCallAction(safeArgs);
		const body = action
			? `\n  ${uiTheme.italic(uiTheme.fg("muted", truncateToWidth(action, TRUNCATE_LENGTHS.LONG)))}`
			: "";
		return new Text(`${header}${body}`, 0, 0);
	},

	renderResult(
		result: ToolRenderResult<TimerToolDetails>,
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: TimerRenderArgs,
	): Component {
		const details = result.details;
		const op = details?.op ?? args?.op;
		const title = opTitle(op, details?.id ?? args?.id);
		const fallback = resultText(result);
		if (result.isError) {
			return framedToolCard(uiTheme, () => ({
				header: renderStatusLine({ icon: "error", title: "Timer", description: title }, uiTheme),
				sections: [{ content: formatErrorDetail(fallback || "timer failed", uiTheme).split("\n") }],
				phase: "error",
				borderColor: "error",
			}));
		}
		if (details?.card) return timerCardComponent(details.card, uiTheme, options.expanded);
		const rows = details?.rows;
		if (rows) {
			return framedToolCard(uiTheme, ({ contentWidth }) => ({
				header: renderStatusLine(
					{
						iconOverride: uiTheme.fg("accent", uiTheme.icon.timer),
						title: "Timer",
						description: "list",
						meta: [`${rows.length} ${rows.length === 1 ? "timer" : "timers"}`],
					},
					uiTheme,
				),
				sections: [
					{
						content: renderTimerListLines(
							rows,
							uiTheme,
							contentWidth,
							options.expanded ? rows.length : PREVIEW_LIMITS.COLLAPSED_ITEMS,
						),
					},
				],
				footerMeta: details.ticker ? clean(details.ticker) : undefined,
				phase: "success",
				borderColor: "borderMuted",
			}));
		}
		return framedToolCard(uiTheme, ({ contentWidth }) => ({
			header: renderStatusLine(
				{ iconOverride: uiTheme.fg("accent", uiTheme.icon.timer), title: "Timer", description: title },
				uiTheme,
			),
			sections: [{ content: plainLines(fallback, uiTheme, contentWidth, options.expanded) }],
			phase: "success",
			borderColor: "borderMuted",
		}));
	},

	describeCall(args: TimerRenderArgs): NativeToolView {
		return describeCallView(typeof args === "object" && args !== null ? args : {});
	},

	describeResult(
		result: ToolRenderResult<TimerToolDetails>,
		_options: RenderResultOptions,
		args?: TimerRenderArgs,
	): NativeToolView | undefined {
		return timerResultMemo.get(result, [args?.op], () => describeResultView(result, args));
	},

	mergeCallAndResult: true,
} satisfies ToolRenderer<TimerRenderArgs, TimerToolDetails>;
