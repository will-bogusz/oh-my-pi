import { prompt } from "@oh-my-pi/pi-utils";
import type { EvalPreludeDefinition } from "../../eval/preludes";
import browserDescription from "../../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../../sdk";
// @ts-expect-error Bun imports this declaration source as text instead of a TypeScript module.
import browserDeclarations from "./declarations.d.ts" with { type: "text" };
import initialObservationCode from "./initial-observation.js.txt" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import browserJavascript from "./prelude.js" with { type: "text" };
import browserPython from "./prelude.py" with { type: "text" };
import { resolveRelayKind } from "./relay/kind";
import { cfgBrowserEnabled, cfgBrowserRefs, cfgBrowserRelay, cfgBrowserTern } from "./settings";
import { resolveTernKind } from "./tern/kind";

/** Static browser assets loaded only when a kernel first requests browser preludes. */
export const browserPreludeAssets = {
	codeModeDeclarations: browserDeclarations as string,
	/** Run-scope function source that observes a freshly acquired tab. */
	initialObservation: initialObservationCode,
} as const;

/** Build the browser eval facade after an eval runtime first requests preludes. */
export function createBrowserPreludeDefinition(
	session: ToolSession,
	host: Pick<EvalPreludeDefinition, "invoke" | "status">,
): EvalPreludeDefinition {
	return {
		name: "browser",
		// The static prompt states only what every configuration shares; the
		// active ref style's contract, what a bare `open` does while the relay
		// is on, and the Tern backend inside a Tern pane are rendered in.
		documentation: prompt.render(browserDescription, {
			compactRefs: cfgBrowserRefs.get(session.settings) === "compact",
			relay: resolveRelayKind({ settingEnabled: cfgBrowserRelay.get(session.settings) }) !== null,
			tern: resolveTernKind({ settingEnabled: cfgBrowserTern.get(session.settings) }) !== null,
		}),
		javascript: browserJavascript,
		python: browserPython,
		exports: ["browser"],
		codeModeDeclarations: browserDeclarations,
		// Documentation is the one browser action that touches no tab.
		approval: args =>
			args !== null && typeof args === "object" && "action" in args && args.action === "help" ? "read" : "exec",
		enabled: () => cfgBrowserEnabled.get(session.settings),
		invoke: host.invoke,
		status: host.status,
	};
}
