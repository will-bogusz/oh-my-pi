import { describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isEvalTimeoutControlEvent } from "@oh-my-pi/pi-coding-agent/eval/bridge-timeout";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import type { EvalPreludeDefinition, EvalPreludeStatus } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import type { EvalStatusEvent } from "@oh-my-pi/pi-tui/tools/eval";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function session(definitions?: () => EvalPreludeDefinition[]): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "browser.enabled": true, "computer.enabled": true }),
		...(definitions ? { getEvalPreludes: definitions } : {}),
	};
}

const computer = createComputerPrelude(session(), () => ({
	async run() {
		throw new Error("status never runs the driver");
	},
	async capabilities() {
		throw new Error("status never runs the driver");
	},
	async close() {},
}));
const browser = createBrowserPrelude(session());
const result = (details: Record<string, unknown>): AgentToolResult<unknown> => ({ content: [], details });
const notes = { app: "Notes", title: "All iCloud", id: "41043", pid: 55206 };

describe("computer call status", () => {
	const click = {
		action: "call",
		chain: [
			{ method: "window", args: [{ id: "41043", pid: 55206 }] },
			{ method: "ref", args: ["n12"] },
			{ method: "click", args: [] },
		],
	};

	it("says an action verb first against the addressed window, with one notice per reported side effect", () => {
		const status = computer.status!(
			click,
			result({
				screenshots: [],
				window: notes,
				userVisible: [{ effect: "fronted", app: "Notes", pid: 55206 }, { effect: "pointer" }],
			}),
		)!;
		expect(status.summary?.startsWith("click n12")).toBe(true);
		expect(status.summary).toContain("Notes: All iCloud");
		expect(status.header).toBeUndefined();
		expect(status.notices).toHaveLength(2);
		expect(status.notices?.[0]).toContain("Notes");
		expect(status.notices?.[1]).toContain("pointer");
	});

	it("falls back to the window id without a title and claims no side effect nobody reported", () => {
		const status = computer.status!(click, result({ screenshots: [] }))!;
		expect(status.summary?.startsWith("click n12")).toBe(true);
		expect(status.summary).toContain("41043");
		expect(status.notices).toBeUndefined();
		expect(status.label).toBeUndefined();
	});

	it("heads a displayed window with its title, id and pid, and captions its capture by title", () => {
		const status = computer.status!(
			{ action: "call", chain: [{ method: "acquireWindow", args: [{ app: "Notes" }, {}] }] },
			result({ screenshots: [], window: notes, rendered: true }),
		)!;
		expect(status.header).toContain("Notes: All iCloud");
		expect(status.header).toContain("41043");
		expect(status.header).toContain("55206");
		expect(status.label).toBe("Notes: All iCloud");
		expect(status.summary?.startsWith("acquireWindow")).toBe(true);
	});

	it("names typed text and the element it went into", () => {
		const status = computer.status!(
			{
				action: "call",
				chain: [
					{ method: "window", args: [{ id: "41043", pid: 55206 }] },
					{ method: "ref", args: ["n187"] },
					{ method: "type", args: ["warehouse pallet audit"] },
				],
			},
			result({ screenshots: [], window: notes }),
		)!;
		expect(status.summary?.startsWith('type "warehouse pallet audit"')).toBe(true);
		expect(status.summary).toContain("n187");
	});
});

describe("browser call status", () => {
	const url = "https://en.wikipedia.org/wiki/Mount_Elbrus";

	it("captions and heads a created tab by its page title, not the handle's group label", () => {
		const status = browser.status!(
			{ action: "create", url },
			result({
				name: "Oh My Pi",
				url,
				value: { created: true, target: { title: "" }, initialObservation: { url, title: "Mount Elbrus - Wikipedia" } },
			}),
		)!;
		expect(status.label).toBe("Mount Elbrus - Wikipedia");
		expect(status.header).toContain("Mount Elbrus - Wikipedia");
		expect(status.header).toContain(url);
		expect(status.summary).toContain("Mount Elbrus - Wikipedia");
		expect(status.summary).not.toContain("Oh My Pi");
	});

	it("does not mistake a returned value for the page", () => {
		const status = browser.status!(
			{
				action: "call",
				chain: [
					{ method: "id", args: [5] },
					{ method: "click", args: [] },
				],
			},
			result({ name: "main", url, value: { title: "row data", url: "https://elsewhere.example/" } }),
		)!;
		expect(status.summary?.startsWith("click 5")).toBe(true);
		expect(status.summary).toContain("en.wikipedia.org");
		expect(status.summary).not.toContain("row data");
		expect(status.header).toBeUndefined();
		expect(status.label).toBeUndefined();
	});
});

describe("bridge carries a prelude's status onto its control event and images", () => {
	async function settle(kind: "browser" | "computer", status: EvalPreludeStatus, screenshot: Record<string, unknown>) {
		const definition: EvalPreludeDefinition = {
			name: kind,
			documentation: "",
			javascript: "",
			python: "",
			exports: [],
			async invoke() {
				return {
					content: [{ type: "image", mimeType: "image/png", data: PNG }],
					details: { name: "Oh My Pi", screenshots: [{ imageIndex: 0, ...screenshot }] },
				};
			},
			status: () => status,
		};
		const events: EvalStatusEvent[] = [];
		const value = await callSessionTool(
			"__prelude__",
			{ name: kind, parameters: { action: "observe" } },
			{ session: session(() => [definition]), emitStatus: event => void (isEvalTimeoutControlEvent(event) || events.push(event)) },
		);
		if (typeof value === "string" || !("images" in value)) throw new Error("expected a value with images");
		return { event: events.at(-1)!, control: value.images?.[0]?.control };
	}

	it("settles on one event holding the summary, header and notices, captioned by the call's title", async () => {
		const status = {
			detail: "main.observe()",
			summary: "observe · Mount Elbrus - Wikipedia",
			header: "Mount Elbrus - Wikipedia — https://en.wikipedia.org/wiki/Mount_Elbrus",
			label: "Mount Elbrus - Wikipedia",
			notices: ["moved the pointer"],
		};
		const { event, control } = await settle("browser", status, { dest: "/tmp/page.png" });
		expect(event).toMatchObject({
			phase: "completed",
			summary: status.summary,
			header: status.header,
			notices: status.notices,
		});
		expect(control?.label).toBe("Mount Elbrus - Wikipedia");
	});

	it("keeps a screenshot's own label over the call's caption", async () => {
		const { control } = await settle(
			"computer",
			{ detail: "desktop.observe()", label: "Notes: All iCloud" },
			{ path: "/tmp/w.png", label: "Notes: Sheet" },
		);
		expect(control?.label).toBe("Notes: Sheet");
	});
});
