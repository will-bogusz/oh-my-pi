/**
 * Timer card and listing drawn from stored records: the card backs `/timer`
 * reports and the `/timers` sheet, the listing backs `/timer ls`.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { compact } from "../native/describe";
import { renderStatusLine } from "../render/status-line";
import { framedToolCard } from "../render/tool-card";
import {
	PREVIEW_LIMITS,
	replaceTabs,
	shortenEmbeddedPaths,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import type { Theme, ThemeColor } from "../theme/theme";
import type { Component } from "../tui";
import { wrapTextWithAnsi } from "../utils";

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

const LABEL_WIDTH = 9;

/** Display text for any stored value on one line: control sequences stripped, whitespace runs (tabs, newlines) collapsed, home shortened. */
function clean(value: string): string {
	return shortenEmbeddedPaths(sanitizeText(value)).replace(/\s+/g, " ").trim();
}

function statusColor(status: TimerStatusName): ThemeColor {
	return status === "armed" ? "accent" : status === "paused" ? "warning" : "muted";
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
