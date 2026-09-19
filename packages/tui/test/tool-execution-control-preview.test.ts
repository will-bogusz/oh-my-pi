import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ControlImageReference } from "../src/tools/eval";
import { ToolExecutionComponent, type ToolExecutionUi } from "../src/chat/tool-execution";
import { initTheme } from "../src/theme";
import * as renderUtils from "../src/render/render-utils";
import { Text } from "../src/components/text";
import { ImageBudget } from "../src/components/image";
import { getKittyGraphics, setKittyGraphics } from "../src/kitty-graphics";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	parseKittyDirectPlacementLine,
	setCellDimensions,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { withoutTerminalMultiplexer } from "../../tui/test/helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
let png: string;
let originalProtocol: ImageProtocol | null;
let originalCells: CellDimensions;
let originalGraphics = { ...getKittyGraphics() };
const components: ToolExecutionComponent[] = [];

beforeAll(async () => {
	await initTheme();
	png = (await Bun.file(new URL("../../ai/test/data/red-circle.png", import.meta.url)).bytes()).toBase64();
});

beforeEach(() => {
	originalProtocol = TERMINAL.imageProtocol;
	originalCells = { ...getCellDimensions() };
	originalGraphics = { ...getKittyGraphics() };
	terminal.imageProtocol = ImageProtocol.Kitty;
	setCellDimensions({ widthPx: 10, heightPx: 20 });
	setKittyGraphics({ unicodePlaceholders: false });
	vi.spyOn(renderUtils, "resolveImageOptions").mockImplementation(() => ({ maxWidthCells: 100, maxHeightCells: 30 }));
});

afterEach(() => {
	for (const component of components.splice(0)) component.dispose();
	terminal.imageProtocol = originalProtocol;
	setCellDimensions(originalCells);
	setKittyGraphics(originalGraphics);
	vi.restoreAllMocks();
});

function createComponent(budget = new ImageBudget(8, () => {})): ToolExecutionComponent {
	const ui: ToolExecutionUi = {
		requestRender() {},
		requestComponentRender() {},
		resetDisplay() {},
		imageBudget: budget,
	};
	// Custom renderers do not necessarily use the generic text-image fallback.
	const tool = { name: "eval", label: "Eval", renderResult: () => new Text("Observation complete", 0, 0) };
	const component = new ToolExecutionComponent(
		"eval",
		{},
		{ useBuiltInRenderer: false },
		tool as unknown as AgentTool,
		ui,
	);
	components.push(component);
	return component;
}

function images(count: number) {
	return Array.from({ length: count }, () => ({ type: "image", data: png, mimeType: "image/png" }));
}

function render(component: ToolExecutionComponent, budget: ImageBudget, width = 100): readonly string[] {
	for (let attempt = 0; attempt < 3; attempt++) {
		budget.beginPass();
		const lines = component.render(width);
		if (!budget.endPass()) return lines;
	}
	throw new Error("Image budget did not settle");
}

function placements(lines: readonly string[]): Array<{ id: number; rows: number; columns: number }> {
	return lines.flatMap(line => {
		const placement = parseKittyDirectPlacementLine(line);
		return placement ? [{ id: placement.imageId, rows: placement.rows, columns: placement.columns }] : [];
	});
}

describe("control observation previews", () => {
	it("expands only marked images and preserves their graphics identity across partial and final results", () => {
		const budget = new ImageBudget(8, () => {});
		const component = createComponent(budget);
		const controlImages: ControlImageReference[] = [{ index: 1, kind: "browser", label: "Trial page" }];
		component.updateResult({ content: [], details: { images: images(2), controlImages } }, true);
		const partial = placements(render(component, budget));
		expect(partial).toHaveLength(2);
		expect(partial[0].rows).toBeGreaterThan(renderUtils.PREVIEW_LIMITS.CONTROL_IMAGE_ROWS);
		expect(partial[1].rows).toBeLessThanOrEqual(renderUtils.PREVIEW_LIMITS.CONTROL_IMAGE_ROWS);
		expect(partial[1].columns).toBeLessThanOrEqual(renderUtils.PREVIEW_LIMITS.CONTROL_IMAGE_COLUMNS);
		budget.takeTransmits();

		component.updateResult({ content: images(2), details: { controlImages } });
		expect(placements(render(component, budget))).toEqual(partial);
		component.setExpanded(true);
		const expanded = placements(render(component, budget));
		expect(expanded[0]).toEqual(partial[0]);
		expect(expanded[1].id).toBe(partial[1].id);
		expect(expanded[1].rows).toBeGreaterThan(partial[1].rows);
		expect(expanded[1].rows).toBeLessThanOrEqual(30);
		expect(budget.takeTransmits()).toHaveLength(0);
		component.setExpanded(false);
		expect(placements(render(component, budget))).toEqual(partial);
	});

	it("honors tighter configured caps and keeps demoted observations inside the shared image budget", () => {
		vi.spyOn(renderUtils, "resolveImageOptions").mockImplementation(() => ({ maxWidthCells: 6, maxHeightCells: 2 }));
		const budget = new ImageBudget(1, () => {});
		const component = createComponent(budget);
		component.updateResult({
			content: images(2),
			details: {
				controlImages: [
					{ index: 0, kind: "computer" },
					{ index: 1, kind: "computer" },
				],
			},
		});
		const collapsed = render(component, budget);
		const live = placements(collapsed);
		expect(live).toHaveLength(1);
		expect(live[0].rows).toBeLessThanOrEqual(2);
		expect(live[0].columns).toBeLessThanOrEqual(6);
		expect(stripVTControlCharacters(collapsed.join("\n"))).toContain("[Image:");
		component.setExpanded(true);
		expect(placements(render(component, budget))).toEqual(live);
	});

	it.each(["unsupported", "disabled"] as const)("keeps a saved-image path visible when inline images are %s", mode => {
		const budget = new ImageBudget(8, () => {});
		if (mode === "unsupported") terminal.imageProtocol = null;
		const component = createComponent(budget);
		if (mode === "disabled") component.setShowImages(false);
		component.updateResult({
			content: images(1),
			details: {
				controlImages: [{ index: 0, kind: "computer", label: "Trial\n\t\x1b[2Jwindow", path: "/tmp/trial.png" }],
			},
		});
		const lines = render(component, budget, 60);
		const output = stripVTControlCharacters(lines.join("\n"));
		expect(placements(lines)).toHaveLength(0);
		expect(output).toContain("Computer snapshot · Trial window");
		expect(output).toContain("200x200");
		expect(output).toContain("Saved: /tmp/trial.png");
		expect(lines.join("\n")).not.toContain("\x1b[2J");
		expect(lines.every(line => Bun.stringWidth(line) <= 60)).toBe(true);
	});

	it("ignores invalid provenance without turning an ordinary image into a control preview", () => {
		const budget = new ImageBudget(8, () => {});
		const component = createComponent(budget);
		component.updateResult({
			content: images(1),
			details: {
				controlImages: [
					{ index: 0, kind: "chart" },
					{ index: -1, kind: "browser" },
				],
			},
		});
		const lines = render(component, budget);
		expect(placements(lines)[0].rows).toBeGreaterThan(renderUtils.PREVIEW_LIMITS.CONTROL_IMAGE_ROWS);
		expect(stripVTControlCharacters(lines.join("\n"))).not.toContain("snapshot");
	});
});
