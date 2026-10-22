import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { TUI } from "@oh-my-pi/pi-tui";
import { type TimersPanelDetail, TimersSheet, type TimersSheetView } from "../src/overlays/timers-panel";
import { getThemeByName, initTheme, type Theme } from "../src/theme";
import { theme } from "../src/theme/theme";
import {
	renderTimerListLines,
	type TimerCardView,
	type TimerListRowView,
	timerCardComponent,
	timerToolRenderer,
} from "../src/tools/timer";
import { visibleWidth } from "../src/utils";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

let uiTheme: Theme;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme missing");
	uiTheme = theme;
});

const ANSI = /\x1b\[[0-9;]*m/g;

function card(overrides: Partial<TimerCardView> = {}): TimerCardView {
	return {
		id: "finish-pull",
		verb: "armed",
		status: "armed",
		fires: "Wed 2026-10-22 08:00 (in 6h 18m)",
		cadence: "once",
		does: 'wake this session → "Resume the pull"',
		ifBusy: "after the current turn",
		ifClosed: "resume headless",
		why: "Will asked to wake at 8",
		last: "never ran",
		ticker: "last tick 4s ago",
		warnings: [],
		...overrides,
	};
}

describe("timer card", () => {
	it("draws stored text sanitized: no tabs or injected escapes, home shortened, every row within width", () => {
		const width = 72;
		const lines = timerCardComponent(
			card({
				does: `run \`make\tall\x1b[31mRED\` in ${os.homedir()}/project`,
				why: "x".repeat(300),
				warnings: ["no tick recorded yet"],
			}),
			uiTheme,
			false,
		).render(width);
		const text = lines.map(line => line.replace(ANSI, "")).join("\n");
		expect(text).not.toContain("\t");
		expect(text).not.toContain("[31m");
		expect(text).toContain("~/project");
		expect(text).toContain("no tick recorded yet");
		expect(text).toContain("/timer rm finish-pull");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("expanding the card reveals the full prompt body", () => {
		const body = "Read HANDOFF.md, run the remaining steps, verify totals";
		const render = (expanded: boolean) =>
			timerCardComponent(card({ body }), uiTheme, expanded).render(120).join("\n").replace(ANSI, "");
		expect(render(false)).not.toContain("verify totals");
		expect(render(true)).toContain("verify totals");
	});
});

describe("timer listing", () => {
	it("aligns rows within width, sanitizes the reason, and counts the rows past the limit", () => {
		const width = 60;
		const rows = ["a", "bb", "ccc"].map(id => ({
			id,
			status: "armed" as const,
			next: "08:00 (in 6h)",
			last: "never ran",
			reason: `check\x1b[31m the\tbuild ${"y".repeat(80)}`,
		}));
		const lines = renderTimerListLines(rows, uiTheme, width, 2);
		const plain = lines.map(line => line.replace(ANSI, ""));
		expect(plain).toHaveLength(3);
		expect(plain[0]).toStartWith("a    armed");
		expect(plain.join("\n")).not.toContain("[31m");
		expect(plain.join("\n")).not.toContain("\t");
		expect(plain[2]).toBe("… 1 more");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(renderTimerListLines([], uiTheme, width, 5).map(line => line.replace(ANSI, ""))).toEqual(["no timers"]);
	});
});

describe("timers sheet in the terminal", () => {
	const DOWN = "\x1b[B";
	const FOOTER = "esc close";

	/** The sheet over `count` timers, shown as interactive mode shows it, recording the actions it takes. */
	async function openSheet(columns: number, rows: number, count: number, log = "no log") {
		const terminal = new VirtualTerminal(columns, rows);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.start();
		const timers: TimerListRowView[] = Array.from({ length: count }, (_, i) => ({
			id: `timer-${String(i).padStart(2, "0")}`,
			status: "armed",
			next: "08:00 (in 6h)",
			last: "never ran",
			reason: "nightly",
		}));
		const acted: string[] = [];
		const sheet = new TimersSheet({
			load: () => ({ rows: timers }),
			inspect: (id: string, view: TimersSheetView): TimersPanelDetail =>
				view === "logs" ? { log } : { card: card({ id, body: "step\n".repeat(60) }) },
			fire: id => acted.push(`fire ${id}`),
			togglePause: id => acted.push(`pause ${id}`),
			remove: id => acted.push(`remove ${id}`),
			close: () => {},
			maxRows: () => Math.floor(terminal.rows * 0.9),
		});
		tui.showOverlay(sheet, { anchor: "center", width: "90%", maxHeight: "90%" });
		tui.setFocus(sheet);
		await scheduler.settle(terminal);
		const screen = () => terminal.getViewport().map(row => Bun.stripANSI(row));
		const press = async (key: string, times = 1) => {
			for (let i = 0; i < times; i++) terminal.sendInput(key);
			await scheduler.settle(terminal);
		};
		return { terminal, scheduler, tui, acted, screen, press };
	}

	const selectedRow = (screen: string[]) => screen.find(row => row.includes(`${theme.nav.cursor} timer-`));

	it("keeps the selected timer and the key hints on screen at 80x24 and acts on the timer shown", async () => {
		const { tui, acted, screen, press } = await openSheet(80, 24, 30);
		try {
			await press(DOWN, 29);
			expect(selectedRow(screen())).toContain("timer-29");
			expect(screen().join("\n")).toContain(FOOTER);
			expect(screen().join("\n")).toContain("30/30");
			await press("f");
			await press("p");
			await press("d");
			expect(screen().join("\n")).toContain("Press d again to remove timer-29");
			await press("d");
			expect(acted).toEqual(["fire timer-29", "pause timer-29", "remove timer-29"]);
			await press("\x1b[A", 15);
			expect(selectedRow(screen())).toContain("timer-14");
		} finally {
			tui.stop();
		}
	});

	it("cuts a long log to its newest lines and keeps the list and hints when the terminal shrinks", async () => {
		const log = Array.from({ length: 200 }, (_, i) => `log line ${i}`).join("\n");
		const { terminal, scheduler, tui, screen, press } = await openSheet(80, 24, 30, log);
		try {
			await press(DOWN, 20);
			await press("l");
			expect(selectedRow(screen())).toContain("timer-20");
			expect(screen().join("\n")).toContain("log line 199");
			expect(screen().join("\n")).toContain(FOOTER);
			terminal.resize(80, 12);
			await scheduler.advance(terminal, 160);
			expect(selectedRow(screen())).toContain("timer-20");
			expect(screen().join("\n")).toContain(FOOTER);
			await press(DOWN, 9);
			expect(selectedRow(screen())).toContain("timer-29");
		} finally {
			tui.stop();
		}
	});

	it("draws its title and key hints in readable text tones, and only the frame strokes in the border tone", () => {
		const sheet = new TimersSheet({
			load: () => ({ rows: [{ id: "nightly", status: "armed", next: "08:00", last: "never ran", reason: "x" }] }),
			inspect: () => undefined,
			fire: () => {},
			togglePause: () => {},
			remove: () => {},
			close: () => {},
			maxRows: () => 20,
		});
		const lines = sheet.render(72);
		expect(lines[0]).toContain(theme.fg("muted", `${theme.icon.timer} Timers · 1 armed`));
		expect(lines.at(-1)).toContain(theme.fg("dim", "↑↓ · ↵ card · l logs · f fire · p pause · d remove · esc close"));
		for (const line of [lines[0]!, lines.at(-1)!]) {
			expect(visibleWidth(line)).toBe(72);
			expect(line).not.toContain(theme.fg("borderMuted", `${theme.boxRound.horizontal} ${theme.icon.timer}`));
		}
	});

	it("fits rows to widths narrower than its frame", () => {
		const sheet = new TimersSheet({
			load: () => ({ rows: [] }),
			inspect: () => undefined,
			fire: () => {},
			togglePause: () => {},
			remove: () => {},
			close: () => {},
			maxRows: () => 20,
		});
		for (const width of [1, 2, 3, 4, 8]) {
			for (const line of sheet.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("timer tool renderer", () => {
	it("previews a streaming set call from partial args: op, id, schedule, and the prompt", () => {
		const text = timerToolRenderer
			.renderCall(
				{ op: "set", id: "babysit", every: "30m", prompt: "check\tthe build" },
				{ expanded: false, isPartial: true },
				uiTheme,
			)
			.render(100)
			.join("\n")
			.replace(ANSI, "");
		expect(text).toContain("set babysit");
		expect(text).toContain("every 30m");
		expect(text).toContain('"check the build"');
		const partial = timerToolRenderer
			.renderCall({ op: "set" }, { expanded: false, isPartial: true }, uiTheme)
			.render(100)
			.join("\n")
			.replace(ANSI, "");
		expect(partial).toContain("Timer");
		expect(partial).toContain("set");
	});

	it("draws the stored card, a listing, or the error a call ended with", () => {
		const render = (result: Parameters<typeof timerToolRenderer.renderResult>[0]) =>
			timerToolRenderer
				.renderResult(result, { expanded: false, isPartial: false }, uiTheme)
				.render(100)
				.join("\n")
				.replace(ANSI, "");
		const armed = render({ content: [{ type: "text", text: "card" }], details: { op: "set", card: card() } });
		expect(armed).toContain("armed finish-pull");
		expect(armed).toContain('wake this session → "Resume the pull"');
		expect(armed).toContain("/timer rm finish-pull");
		const rows: TimerListRowView[] = [
			{ id: "nightly", status: "armed", next: "02:00 (in 3h)", last: "fired", reason: "nightly digest" },
		];
		const listing = render({
			content: [{ type: "text", text: "table" }],
			details: { op: "list", rows, ticker: "last tick 4s ago" },
		});
		expect(listing).toContain("1 timer");
		expect(listing).toContain("nightly");
		expect(listing).toContain("last tick 4s ago");
		const refused = render({
			content: [{ type: "text", text: 'not armed: timer "nightly" already looks like this job.' }],
			details: { op: "set" },
			isError: true,
		});
		expect(refused).toContain("already looks like this job");
	});
});
