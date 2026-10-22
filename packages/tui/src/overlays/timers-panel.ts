/**
 * The machine's timers as {@link TimersSheet}: the dismissable sheet `/timers`
 * and the timers pill open. A master–detail split lists every timer beside
 * the selected one's card (↵) or its newest run log (l); f fires it now, p
 * pauses or resumes it, d twice removes it. Nothing enters the transcript.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspTone } from "@oh-my-pi/pi-wire";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { matchesKey } from "../keys";
import { ansi, col, compact, item, kv, node, span, stableKey, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, selectList } from "../native/overlay";
import { PREVIEW_LIMITS, shortenEmbeddedPaths, TRUNCATE_LENGTHS } from "../render/render-utils";
import { theme, type ThemeColor } from "../theme/theme";
import { renderTimerCardLines, type TimerCardView, type TimerListRowView, timerCardFooter } from "../tools/timer";
import type { Component } from "../tui";
import { padToWidth } from "../render/utils";
import { replaceTabs, truncateToWidth, visibleWidth } from "../utils";

/** What the detail pane shows for the selected timer. */
export type TimersSheetView = "card" | "logs";

/** The timers the sheet lists, as the host last read them. */
export interface TimersPanelSnapshot {
	readonly rows: readonly TimerListRowView[];
	/** Ticker liveness line. */
	readonly ticker?: string;
	/** The first read has not finished yet. */
	readonly loading?: boolean;
	/** Result of the last action (`timer x fired (x#3)`), shown in the footer. */
	readonly notice?: string;
}

/** The selected timer's detail, as the host last read it. */
export interface TimersPanelDetail {
	readonly card?: TimerCardView;
	/** The newest run's log (or a note that none exists). */
	readonly log?: string;
}

/** The host behind a {@link TimersSheet}. Reads are synchronous snapshots; the host refreshes them. */
export interface TimersSheetSource {
	load(): TimersPanelSnapshot;
	/** Detail for `id` in `view`; undefined while it loads. */
	inspect(id: string, view: TimersSheetView): TimersPanelDetail | undefined;
	fire(id: string): void;
	/** Pause an armed timer, resume a paused one. */
	togglePause(id: string): void;
	remove(id: string): void;
	close(): void;
	/** Most rows the terminal sheet may take, borders included; the list scrolls and the detail is cut to fit. */
	maxRows(): number;
}

/** A status's tone in the native list and its color in terminal rows. */
const STATUS_TONE: Record<TimerListRowView["status"], TspTone & ThemeColor> = {
	armed: "accent",
	paused: "warning",
	done: "muted",
};

/** Stored text for display: control sequences stripped, tabs expanded, home shortened (newlines kept, for logs). */
function clean(value: string): string {
	return shortenEmbeddedPaths(replaceTabs(sanitizeText(value)));
}

/** {@link clean}, on one line. */
function oneLine(value: string): string {
	return clean(value).replace(/\s+/g, " ").trim();
}

/**
 * The timers sheet: a centred `lg` overlay titled Timers. ↑/↓ select, ↵
 * shows the card, l the newest run log, f fires, p pauses or resumes, d
 * twice removes, Esc closes. It re-reads the host's snapshot every frame;
 * the host refreshes it on a timer while the sheet is open.
 */
export class TimersSheet implements Component {
	readonly nativeOverlay = {
		role: "omp.overlay.timers",
		size: "lg",
		anchor: "center",
		head: "Timers",
	} as const;
	readonly #source: TimersSheetSource;
	#selectedId: string | undefined;
	#view: TimersSheetView = "card";
	/** Timer id a first `d` armed for removal; a second `d` on it removes. */
	#confirmRemove: string | undefined;
	/** First list row the terminal sheet shows; moves so the selected row stays in view. */
	#listTop = 0;

	constructor(source: TimersSheetSource) {
		this.#source = source;
	}

	/**
	 * Terminal rows, at most {@link TimersSheetSource.maxRows}: a rounded frame
	 * titled with the armed count, a window of the timer list that keeps the
	 * selected row in view, the selected timer's card (head) or log (tail) in
	 * the rows left, the last action's outcome, and the key hints in the bottom
	 * border. Rows are padded to the frame so the transcript behind the overlay
	 * never shows through.
	 */
	render(width: number): readonly string[] {
		const { snapshot, selected } = this.#current();
		const { rows } = snapshot;
		const inner = Math.max(1, width - 4);
		const notice = this.#confirmRemove
			? theme.fg("warning", `Press d again to remove ${oneLine(this.#confirmRemove)}`)
			: snapshot.notice
				? theme.fg("muted", oneLine(snapshot.notice))
				: snapshot.ticker
					? theme.fg("dim", oneLine(snapshot.ticker))
					: "";
		// Rows inside the frame; the selected row and the notice come first, the detail takes what is left.
		const room = Math.max(1, this.#source.maxRows() - 2);
		const noticeLines = !notice ? [] : room >= 3 ? ["", notice] : room >= 2 ? [notice] : [];
		const avail = room - noticeLines.length;
		const body: string[] = [];
		if (snapshot.loading) body.push(theme.fg("muted", "Loading…"));
		else if (rows.length === 0) body.push(theme.fg("muted", "No timers. /timer in 2h <prompt> sets one."));
		const detail: string[] = [];
		if (selected) {
			detail.push("");
			const view = this.#source.inspect(selected.id, this.#view);
			if (!view) detail.push(theme.fg("muted", "Loading…"));
			else if (this.#view === "card" && view.card)
				detail.push(...renderTimerCardLines(view.card, theme, inner, true));
			else {
				const log = clean(view.log ?? "no log")
					.trimEnd()
					.split("\n");
				for (const line of log.slice(-PREVIEW_LIMITS.EXPANDED_LINES)) detail.push(theme.fg("muted", line));
			}
		}
		const listRows = Math.min(rows.length, Math.max(1, avail - body.length - detail.length, Math.ceil(avail / 2)));
		const index = selected ? rows.indexOf(selected) : 0;
		this.#listTop = Math.max(0, index - listRows + 1, Math.min(this.#listTop, index, rows.length - listRows));
		const idWidth = Math.min(TRUNCATE_LENGTHS.SHORT, Math.max(0, ...rows.map(entry => entry.id.length)));
		for (const entry of rows.slice(this.#listTop, this.#listTop + listRows)) {
			const cursor = entry === selected ? theme.fg("accent", theme.nav.cursor) : " ";
			const id = padToWidth(truncateToWidth(oneLine(entry.id), idWidth), idWidth);
			const status = theme.fg(STATUS_TONE[entry.status], entry.status.padEnd(6));
			const facts = theme.fg("muted", oneLine(`${entry.next} · ${entry.reason}`));
			body.push(`${cursor} ${id}  ${status}  ${facts}`);
		}
		// A log keeps its newest lines, a card its head.
		const detailRoom = Math.max(0, avail - body.length);
		if (detail.length <= detailRoom || detailRoom <= 1 || this.#view === "card")
			body.push(...detail.slice(0, detailRoom));
		else body.push("", ...detail.slice(1 - detailRoom));
		body.push(...noticeLines);
		const armed = rows.filter(entry => entry.status === "armed").length;
		const position = listRows < rows.length ? ` · ${index + 1}/${rows.length}` : "";
		const box = theme.boxRound;
		const border = (text: string) => theme.fg("borderMuted", text);
		// Only the strokes are border-colored: `borderMuted` sits near the background, so a label in it is unreadable.
		const edge = (left: string, label: string, tone: "muted" | "dim", right: string): string => {
			const text = truncateToWidth(label, Math.max(0, width - 5));
			const fill = box.horizontal.repeat(Math.max(0, width - 5 - visibleWidth(text)));
			return `${border(`${left}${box.horizontal} `)}${theme.fg(tone, text)}${border(` ${fill}${right}`)}`;
		};
		const lines = [
			edge(box.topLeft, `${theme.icon.timer} Timers · ${armed} armed${position}`, "muted", box.topRight),
			...body.map(
				line =>
					`${border(box.vertical)} ${padToWidth(truncateToWidth(line, inner), inner)} ${border(box.vertical)}`,
			),
			// Fits the 72-column sheet an 80-column terminal opens.
			edge(
				box.bottomLeft,
				`↑↓ · ↵ card · l logs · f fire · p ${selected?.status === "paused" ? "resume" : "pause"} · d remove · esc close`,
				"dim",
				box.bottomRight,
			),
		];
		// Under five columns the frame alone is wider than the sheet.
		return width < 5 ? lines.map(line => truncateToWidth(line, width)) : lines;
	}

	describe(_cx: DescribeContext): NativeNode {
		const { snapshot, selected } = this.#current();
		const close = actionButton("Close", "close", { keys: "escape" });
		if (!selected) {
			return col([
				node(
					"col",
					{ role: "omp.timers.empty", align: "center" },
					[
						node("icon", { name: "clock" }),
						text(snapshot.loading ? "Loading timers…" : "No timers", { role: "omp.timers.empty.title" }),
						text("/timer in 2h <prompt> wakes this session later; timers show up here until they retire.", {
							role: "omp.timers.empty.note",
							wrap: "word",
						}),
					],
					"empty",
				),
				actionBar([null, close]),
			]);
		}
		const detail = this.#source.inspect(selected.id, this.#view);
		const items = snapshot.rows.map(entry =>
			item(entry.id, {
				label: [span(oneLine(entry.id), "mono")],
				value: [span(oneLine(entry.next), "muted")],
				icon: "clock",
				tone: STATUS_TONE[entry.status],
				title: `${oneLine(entry.reason)}\n${entry.status} · last ${oneLine(entry.last)}`,
				aria: `${entry.id}, ${entry.status}, ${entry.next}`,
			}),
		);
		const pauseLabel = selected.status === "paused" ? "Resume" : "Pause";
		const body =
			this.#view === "card" && detail?.card
				? compact<NativeChild>([
						kv([
							["fires", oneLine(`${detail.card.fires} · ${detail.card.cadence}`)],
							["does", oneLine(detail.card.does)],
							["limits", detail.card.limits && oneLine(detail.card.limits)],
							["why", oneLine(detail.card.why)],
							["last", oneLine(detail.card.last)],
							["ticker", oneLine(detail.card.ticker)],
						]),
						...detail.card.warnings.map(warning =>
							text([span(`⚠ ${oneLine(warning)}`, "warning")], { wrap: "word" }),
						),
						text([span(timerCardFooter(detail.card.id), "dim")], { wrap: "none" }),
					])
				: [
						detail
							? ansi(detail.log ?? "no log", { role: "omp.timers.log", max: { h: "16lines" } })
							: text("Loading…", { role: "omp.timers.loading" }),
					];
		return col([
			node(
				"row",
				{ role: "omp.timers.split" },
				[
					node(
						"col",
						{ role: "omp.timers.master" },
						[selectList("timers", items, { selected: selected.id, max: { lines: 12 } })],
						"master",
					),
					node("col", { role: "omp.timers.detail" }, body, stableKey(`${selected.id}:${this.#view}`)),
				],
				"split",
			),
			actionBar([
				text(
					this.#confirmRemove
						? `Press d again to remove ${this.#confirmRemove}`
						: (snapshot.notice ?? snapshot.ticker ?? ""),
					{
						role: "omp.timers.summary",
						wrap: "none",
					},
				),
				null,
				actionButton(this.#view === "card" ? "Logs" : "Card", this.#view === "card" ? "logs" : "card", {
					keys: this.#view === "card" ? "l" : "enter",
				}),
				actionButton("Fire", "fire", { keys: "f", tone: "accent" }),
				actionButton(pauseLabel, "pause", { keys: "p" }),
				actionButton("Remove", "remove", { keys: "d", tone: "error" }),
				close,
			]),
		]);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesSelectCancel(data)) this.#source.close();
		else if (matchesSelectUp(data)) this.#move(-1);
		else if (matchesSelectDown(data)) this.#move(1);
		else if (matchesKey(data, "enter") || matchesKey(data, "return")) this.#act("card");
		else if (matchesKey(data, "l")) this.#act("logs");
		else if (matchesKey(data, "f")) this.#act("fire");
		else if (matchesKey(data, "p")) this.#act("pause");
		else if (matchesKey(data, "d")) this.#act("remove");
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "select" || event.type === "activate") {
			this.#selectedId = event.item;
			this.#confirmRemove = undefined;
		} else if (event.type === "action") {
			if (event.act === "close") this.#source.close();
			else this.#act(event.act);
		}
	}

	/** The snapshot and the selected row (the first when the selection left). */
	#current(): { snapshot: TimersPanelSnapshot; selected: TimerListRowView | undefined } {
		const snapshot = this.#source.load();
		const selected = snapshot.rows.find(entry => entry.id === this.#selectedId) ?? snapshot.rows[0];
		this.#selectedId = selected?.id;
		return { snapshot, selected };
	}

	#move(delta: number): void {
		const { snapshot, selected } = this.#current();
		if (!selected) return;
		const index = Math.max(0, Math.min(snapshot.rows.length - 1, snapshot.rows.indexOf(selected) + delta));
		this.#selectedId = snapshot.rows[index]?.id;
		this.#confirmRemove = undefined;
	}

	#act(act: string): void {
		const { selected } = this.#current();
		if (!selected) return;
		const armedRemove = this.#confirmRemove === selected.id;
		this.#confirmRemove = undefined;
		switch (act) {
			case "card":
			case "logs":
				this.#view = act;
				return;
			case "fire":
				this.#source.fire(selected.id);
				return;
			case "pause":
				this.#source.togglePause(selected.id);
				return;
			case "remove":
				if (armedRemove) this.#source.remove(selected.id);
				else this.#confirmRemove = selected.id;
				return;
		}
	}
}
