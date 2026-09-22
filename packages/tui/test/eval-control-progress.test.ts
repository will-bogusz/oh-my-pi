import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "../src/theme";
import {
	type EvalCellResult,
	type EvalStatusEvent,
	type EvalToolDetails,
	evalToolRenderer,
	upsertStatusEvent,
} from "../src/tools/eval";

describe("eval control activity", () => {
	let theme: Theme;
	beforeAll(async () => {
		theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
	});

	function render(
		events: EvalStatusEvent[],
		width = 120,
		settlement: {
			status?: EvalCellResult["status"];
			partial?: boolean;
			async?: EvalToolDetails["async"];
			output?: string;
			expanded?: boolean;
		} = {},
	): string[] {
		const component = evalToolRenderer.renderResult(
			{
				content: [],
				details: {
					async: settlement.async,
					cells: [
						{
							index: 0,
							language: "js",
							code: "await work()",
							output: settlement.output ?? "",
							status: settlement.status ?? "running",
							statusEvents: events,
						},
					],
				},
			},
			{ expanded: settlement.expanded ?? false, isPartial: settlement.partial ?? true, spinnerFrame: 0 },
			theme,
		);
		return component.render(width).map(line => Bun.stripANSI(line));
	}

	it("keeps stopping distinct from completed operations and actual release", () => {
		const events: EvalStatusEvent[] = [];
		const base = { op: "control", id: "native-1", kind: "computer", action: "release" };
		upsertStatusEvent(events, { ...base, phase: "running" });
		upsertStatusEvent(events, { ...base, phase: "stopping" });
		const stopping = render(events);
		const border = stopping.findIndex(line => line.includes(theme.boxRound.bottomRight));
		expect(stopping.findIndex(line => line.includes("Stopping"))).toBeGreaterThan(border);
		expect(stopping.join("\n")).not.toContain("Control released");
		upsertStatusEvent(events, { ...base, phase: "failed" });
		expect(render(events).join("\n")).not.toContain("Stopping");
		expect(render(events).join("\n")).not.toContain("Control released");
		upsertStatusEvent(events, { ...base, phase: "stopped" });
		expect(render(events).join("\n")).toContain("Operation stopped");
		expect(render(events).join("\n")).not.toContain("Control released");
		expect(render(events).join("\n")).not.toContain("Failed");
		upsertStatusEvent(events, { ...base, phase: "released" });
		expect(events).toHaveLength(1);
		expect(render(events).join("\n")).toContain("Control released");
		upsertStatusEvent(events, {
			...base,
			id: "native-2",
			action: "observe",
			phase: "completed",
			summary: "observe · Notes: Search",
		});
		const completed = render(events).find(line => line.includes("observe · Notes: Search"));
		expect(completed).toContain(Bun.stripANSI(theme.styledSymbol("status.done", "success")));
		expect(completed).not.toMatch(/Working|Stopping|Failed|stopped|released|unconfirmed/);
	});

	it("replaces abandoned control spinners with an unconfirmed outcome while background work stays live", () => {
		const events: EvalStatusEvent[] = [
			{ op: "control", id: "lost", kind: "computer", action: "run", phase: "running" },
		];
		const failed = render(events, 120, { async: { state: "failed", jobId: "job", type: "eval" } }).join("\n");
		expect(failed).toContain("Outcome unconfirmed");
		expect(failed).not.toContain("Working");
		expect(failed).not.toContain("Control released");
		expect(render(events, 120, { status: "error" }).join("\n")).toContain("Outcome unconfirmed");
		expect(render(events, 120, { partial: false }).join("\n")).toContain("Outcome unconfirmed");
		expect(
			render(events, 120, { partial: false, async: { state: "running", jobId: "job", type: "eval" } }).join("\n"),
		).toContain("Working");
		upsertStatusEvent(events, { ...events[0], phase: "stopped" });
		expect(render(events, 120, { status: "error" }).join("\n")).toContain("Operation stopped");
	});

	it("does not hide active control behind completed operations or leak multiline target formatting", () => {
		const events: EvalStatusEvent[] = [
			{
				op: "control",
				id: "pending",
				kind: "browser",
				action: "fill",
				phase: "running",
				target: "Work\tChrome\n\u001b[31mTarget",
			},
		];
		for (let index = 0; index < 6; index++)
			events.push({ op: "control", id: `done-${index}`, kind: "computer", action: "observe", phase: "completed" });
		const lines = render(events, 90);
		const activity = lines.find(line => line.includes("Browser") && line.includes("Working"));
		expect(activity).toContain("Chrome Target");
		expect(activity).not.toContain("\t");
		expect(Bun.stringWidth(activity!)).toBeLessThanOrEqual(90);
		const shared: EvalStatusEvent[] = [{ op: "agent", id: "pending", status: "running" }];
		upsertStatusEvent(shared, events[0]);
		expect(shared.map(event => event.op)).toEqual(["agent", "control"]);
	});

	it("keeps the verb when a narrow status line cuts the description", () => {
		const described: EvalStatusEvent = {
			op: "control",
			id: "legacy",
			kind: "computer",
			action: "click",
			phase: "completed",
			detail: 'desktop.window({"id":"41043","pid":55206}).ref("n12").click()',
		};
		const summarized: EvalStatusEvent = {
			...described,
			id: "summarized",
			summary: "click n12 · Notes: All iCloud – 143 notes in the folder list",
		};
		for (const event of [described, summarized]) {
			const line = render([event], 48, { status: "complete", partial: false }).find(l => l.includes("Computer"));
			expect(Bun.stringWidth(line!)).toBeLessThanOrEqual(48);
			expect(line).toMatch(/Computer click/);
		}
	});

	it("collapses a settled control cell to the headers it displayed, raw output on expand", () => {
		const output = ["Notes: All iCloud (window 41043, PID 55206)", "- [n1] AXWindow", "el handle:", "  click()"].join(
			"\n",
		);
		const events: EvalStatusEvent[] = [
			{
				op: "control",
				id: "acquire",
				kind: "computer",
				action: "acquireWindow",
				phase: "completed",
				summary: "acquireWindow Notes · Notes: All iCloud",
				header: "Notes: All iCloud (window 41043, PID 55206)",
			},
			{
				op: "control",
				id: "tab",
				kind: "browser",
				action: "create",
				phase: "completed",
				summary: "create tab · Mount Elbrus - Wikipedia",
				header: "Mount Elbrus - Wikipedia — https://en.wikipedia.org/wiki/Mount_Elbrus",
			},
			{
				op: "control",
				id: "again",
				kind: "computer",
				action: "observe",
				phase: "completed",
				summary: "observe · Notes: All iCloud",
				header: "Notes: All iCloud (window 41043, PID 55206)",
			},
		];
		const collapsed = render(events, 120, { status: "complete", partial: false, output });
		const box = collapsed.slice(0, collapsed.findIndex(line => line.includes(theme.boxRound.bottomRight)));
		const window = box.findIndex(line => line.includes("Notes: All iCloud (window 41043, PID 55206)"));
		const tab = box.findIndex(line => line.includes("Mount Elbrus - Wikipedia — https://"));
		expect(window).toBeGreaterThan(-1);
		expect(tab).toBeGreaterThan(window);
		expect(box.filter(line => line.includes("(window 41043, PID 55206)"))).toHaveLength(1);
		expect(box.join("\n")).not.toContain("el handle:");
		expect(box.join("\n")).toContain("4 more lines");
		const below = collapsed.slice(box.length);
		expect(below.filter(line => /Computer|Browser/.test(line))).toHaveLength(3);

		const expanded = render(events, 120, { status: "complete", partial: false, output, expanded: true }).join("\n");
		expect(expanded).toContain("el handle:");

		// A failed cell's tail is its error; a transcript without summaries keeps its tail.
		expect(render(events, 120, { status: "error", partial: false, output }).join("\n")).toContain("el handle:");
		const legacy = events.map(({ summary: _summary, header: _header, ...event }) => event);
		expect(render(legacy, 120, { status: "complete", partial: false, output }).join("\n")).toContain("el handle:");
	});

	it("gives each reported fronting or pointer move its own line, never windowed out", () => {
		const events: EvalStatusEvent[] = [
			{
				op: "control",
				id: "menu",
				kind: "computer",
				action: "press",
				phase: "completed",
				summary: "press cmd+option+f · Notes: All iCloud",
				notices: ["brought Notes to the front", "moved the pointer"],
			},
		];
		for (let index = 0; index < 8; index++)
			events.push({
				op: "control",
				id: `read-${index}`,
				kind: "computer",
				action: "observe",
				phase: "completed",
				summary: `observe ${index}`,
			});
		const lines = render(events, 100, { status: "complete", partial: false });
		expect(lines.some(line => line.includes("press cmd+option+f"))).toBe(true);
		expect(lines.filter(line => line.includes("brought Notes to the front"))).toHaveLength(1);
		expect(lines.filter(line => line.includes("moved the pointer"))).toHaveLength(1);
		expect(lines.some(line => line.includes("observe 0"))).toBe(false);
	});
});
