import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalCellResult, EvalStatusEvent, EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { evalToolRenderer, upsertStatusEvent } from "@oh-my-pi/pi-coding-agent/tools/eval-render";

describe("eval control activity", () => {
	let theme: Theme;
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
	});
	afterAll(() => resetSettingsForTest());

	function render(
		events: EvalStatusEvent[],
		width = 120,
		settlement: { status?: EvalCellResult["status"]; partial?: boolean; async?: EvalToolDetails["async"] } = {},
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
							output: "",
							status: settlement.status ?? "running",
							statusEvents: events,
						},
					],
				},
			},
			{ expanded: false, isPartial: settlement.partial ?? true, spinnerFrame: 0 },
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
		upsertStatusEvent(events, { ...base, id: "native-2", action: "observe", phase: "completed" });
		expect(render(events).join("\n")).toContain("Operation complete");
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
});
