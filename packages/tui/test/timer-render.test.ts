import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { getThemeByName, initTheme, type Theme } from "../src/theme";
import { type TimerCardView, timerToolRenderer } from "../src/tools/timer";
import { visibleWidth } from "../src/utils";

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

describe("timer tool renderer", () => {
	it("draws stored text sanitized: no tabs or injected escapes, home shortened, every row within width", () => {
		const width = 72;
		const lines = timerToolRenderer
			.renderResult(
				{
					content: [{ type: "text", text: "card" }],
					details: {
						op: "set",
						id: "finish-pull",
						card: card({
							does: `run \`make\tall\x1b[31mRED\` in ${os.homedir()}/project`,
							why: "x".repeat(300),
							warnings: ["no tick recorded yet"],
						}),
					},
				},
				{ expanded: false, isPartial: false },
				uiTheme,
			)
			.render(width);
		const plain = lines.map(line => line.replace(ANSI, ""));
		const text = plain.join("\n");
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
			timerToolRenderer
				.renderResult(
					{ content: [], details: { op: "show", card: card({ body }) } },
					{ expanded, isPartial: false },
					uiTheme,
				)
				.render(120)
				.join("\n")
				.replace(ANSI, "");
		expect(render(false)).not.toContain("verify totals");
		expect(render(true)).toContain("verify totals");
	});

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
});
