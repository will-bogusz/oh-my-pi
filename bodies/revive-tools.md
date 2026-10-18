## What

A subagent that got parked and then woken by a message came back with the `todo` tool and its instructions, even though subagents are spawned without them, so I made the reviver strip it the same way the spawn does.

A woken subagent now has the same tools it was spawned with: in a live Haiku run the revived transcript's `session_init` no longer lists `todo` in the tool inventory or the todo rules.

- `task/executor.ts` `createWarmSubagentReviver`: after the rebuilt session is created, the parent-owned `todo` is dropped from the enabled set before extensions start, and the same filter still guards extension `setActiveTools` calls. Prewalk runs keep `todo`, as at spawn.

## Why

`runSubprocess` strips `todo` right after `createAgentSession`, because todos are parent-owned bookkeeping and the subagent prompt says no TODO tracking. The lifecycle reviver rebuilds the session from the same spec, and `createAgentSession` enables the default tools again, `todo` included; the reviver's only todo filter was `filterActiveTools`, which applies only when an extension calls `setActiveTools`. Every warm revival therefore handed the model a tool and prompt guidance its spawn had removed, and changed the tool list and system prompt the cached conversation was sent with.

Cold revival (`persisted-revive.ts`) already clamps the revived session to the tools its transcript recorded; this brings the warm path in line for `todo`.

Non-goal: extension tools that an extension registers only from `before_agent_start` or `input` (such as an MCP bridge plugin that defers registration until the first turn) still don't come back in a revived subagent, because the wake turns that drive it run no user-prompt hooks. That is a separate contract question about which hooks wake turns fire.

## Testing

- New `persisted-revive.test.ts` case "warm-revives with the tools its spawn enabled, without the parent-owned todo": spawns through `runSubprocess` on a session that has `todo`, parks it, revives it through `AgentLifecycleManager.ensureLive`, and asserts the revived enabled tools, system prompt and tool list equal the spawn's. With the fix reverted it fails (`todo` is enabled after revival).
- `bun test test/task/persisted-revive.test.ts`: 42 pass.
- Live, `anthropic/claude-haiku-5-5`, `task.agentIdleTtlMs: 5000`: the main agent spawns one subagent, sleeps until it parks, then messages it. On `main` the revival's `session_init` gains `- Todo: \`todo\`` and the two todo rules; with this PR it equals the spawn's.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
