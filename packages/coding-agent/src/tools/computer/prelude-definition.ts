import { prompt } from "@oh-my-pi/pi-utils";
import computerDescription from "../../prompts/tools/computer.md" with { type: "text" };
// @ts-expect-error Bun imports this declaration source as text instead of a TypeScript module.
import computerCodeModeDeclarations from "./declarations.d.ts" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import computerJavascript from "./prelude.js" with { type: "text" };
import computerPython from "./prelude.py" with { type: "text" };

export interface ComputerPreludeAssets {
	documentation: string;
	javascript: string;
	python: string;
	codeModeDeclarations: string;
}

/**
 * The `achieve` surface lives between `<comment> @achieve` and `<comment>
 * @end achieve` lines in each source, so every file stays valid for its own
 * tooling; the region ships only with `computer.achieve` on and the marker
 * lines never ship.
 */
function gateAchieve(source: string, comment: string, achieve: boolean): string {
	const kept: string[] = [];
	let inside = false;
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === `${comment} @achieve`) inside = true;
		else if (trimmed === `${comment} @end achieve`) inside = false;
		else if (achieve || !inside) kept.push(line);
	}
	return kept.join("\n");
}

const variants: Partial<Record<"on" | "off", ComputerPreludeAssets>> = {};

/**
 * Static eval-facade assets, loaded only when a kernel first requests
 * computer preludes. The prelude contract is the same everywhere; the
 * backend's delivery routes, tree source and interruption model are not, so
 * the host platform selects the documentation variant. `achieve` adds the
 * experimental chooser surface to all four texts.
 */
export function computerPreludeAssets(achieve: boolean): ComputerPreludeAssets {
	const variant = achieve ? "on" : "off";
	return (variants[variant] ??= {
		documentation: prompt.render(computerDescription, { linux: process.platform === "linux", achieve }),
		javascript: gateAchieve(computerJavascript as string, "//", achieve),
		python: gateAchieve(computerPython, "#", achieve),
		codeModeDeclarations: gateAchieve(computerCodeModeDeclarations as string, "//", achieve),
	});
}
