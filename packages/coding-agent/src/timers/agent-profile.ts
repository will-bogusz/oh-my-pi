/**
 * Agent profiles for unattended timer runs. A run names a profile the way a
 * task subagent does (`agent: reviewer`), found by the same discovery
 * (project `.omp/agents`, user agents, plugins, bundled). The runner starts the
 * run's session as its own `omp --mode rpc` host, so the profile is applied
 * through that host's flags: model, thinking, appended system prompt, tools.
 */
import { normalizeModelPatternList } from "../config/model-resolver";
import { discoverAgents, getAgent } from "../task/discovery";

/** A profile as the run host's flags carry it. */
export interface RunProfile {
	name: string;
	/** First model pattern of the profile (`--model`); a single CLI flag carries no fallback list. */
	model?: string;
	thinking?: string;
	/** The profile body, appended to the system prompt (`--append-system-prompt`). */
	systemPrompt: string;
	/** Tool allowlist (`--tools`); absent means the host's defaults. */
	tools?: string[];
}

/**
 * The tool allowlist a profile grants a top-level run, mirroring how task
 * subagents widen it: no `yield` (a run is not a structured subagent), `exec`
 * stands for `bash` + `eval`, an agent that spawns gets `task`, and one that
 * can start background work gets `wait`.
 */
function profileTools(tools: string[] | undefined, spawns: string[] | "*" | undefined): string[] | undefined {
	if (!tools) return undefined;
	const names = new Set(tools.filter(name => name !== "yield"));
	if (names.delete("exec")) {
		names.add("bash");
		names.add("eval");
	}
	if (spawns !== undefined) names.add("task");
	if (names.has("task") || names.has("bash")) names.add("wait");
	return [...names];
}

/** Resolve `name` from `cwd`; throws naming the searched directories when there is no such profile. */
export async function resolveRunProfile(name: string, cwd: string): Promise<RunProfile> {
	const discovered = await discoverAgents(cwd);
	const agent = getAgent(discovered.agents, name);
	if (!agent) {
		const known = discovered.agents.map(entry => entry.name).join(", ");
		throw new Error(`No agent profile "${name}" from ${cwd} (known: ${known})`);
	}
	return {
		name: agent.name,
		model: normalizeModelPatternList(agent.model)[0],
		thinking: agent.thinkingLevel,
		systemPrompt: agent.systemPrompt,
		tools: profileTools(agent.tools, agent.spawns),
	};
}
