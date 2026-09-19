import { prompt } from "@oh-my-pi/pi-utils";
import computerDescription from "../../prompts/tools/computer.md" with { type: "text" };
// @ts-expect-error Bun imports this declaration source as text instead of a TypeScript module.
import computerCodeModeDeclarations from "./declarations.d.ts" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import computerJavascript from "./prelude.js" with { type: "text" };
import computerPython from "./prelude.py" with { type: "text" };

/** Static eval-facade assets loaded only when a kernel first requests computer preludes. */
export const computerPreludeAssets = {
	// The prelude contract is the same everywhere; the backend's delivery
	// routes, tree source and interruption model are not. The driver child
	// is local, so the host platform selects the variant.
	documentation: prompt.render(computerDescription, { linux: process.platform === "linux" }),
	javascript: computerJavascript as string,
	python: computerPython,
	codeModeDeclarations: computerCodeModeDeclarations as string,
} as const;
