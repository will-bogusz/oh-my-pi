## What

I added `--no-context-files` because omp already has `--no-rules`, `--no-skills` and `--no-extensions`, but the only way to keep a project's `AGENTS.md` out of a scripted run is to run it from an empty directory.

With the flag, no context file (`AGENTS.md`, `CLAUDE.md` and the rest the context-file providers load, plus their `@imports`) reaches the session:

| | `main` | `--no-context-files` |
|---|---|---|
| Working directory and its ancestors | loaded | none |
| `--add-dir` roots, `workspace.additionalDirectories`, roots restored on resume | loaded | none |
| Prompt rebuilds (cwd change, `/move`, refresh) | rediscovered | none |
| Workspace tree's "MUST read these nested AGENTS.md" list | shown | hidden |
| Subagents (task, eval, isolated worktree) | inherit the parent's | inherit none |

Everything else is unchanged: rules, skills, extensions, MCP, settings and explicit `--append-system-prompt` text still load unless their own flags say otherwise.

## Why

Scheduled and scripted `omp -p` runs need the same prompt in any working directory. Today a caller passes `--no-rules --no-skills --no-extensions` and then `cd`s into a scratch directory, because nothing stops context-file discovery.

Decision for the maintainer: one more `--no-*` flag in the existing family, rather than a bundle such as `--hermetic`. I prototyped the bundle first; keeping its promise would mean threading a discovery policy through `SYSTEM.md`/`APPEND_SYSTEM.md`, agent definitions, `WATCHDOG` files, memory and slash-command reloads, a much larger change. The narrow flag composes with the flags that exist.

How it works, in review order:
1. `buildSessionOptions` pins `contextFiles = []`, as `--no-rules` pins `rules = []`. A pinned set already survives prompt rebuilds and flows to subagents through `ToolSession.contextFiles`.
2. A pinned set can't say "and none for additional roots": `buildSystemPrompt` rediscovers those itself, and subagents rely on that. So `noContextFiles` (one boolean on `CreateAgentSessionOptions`, `ToolSession` and `BuildSystemPromptOptions`) skips the additional-root discovery and the nested `AGENTS.md` list. SDK callers that don't set it behave as before.
3. `structured-subagent.ts`, `executor.ts` and `vibe/runtime.ts` forward it to child sessions.

Known gap, shared with `--no-rules`: a parked subagent revived cold from disk after its parent is gone doesn't get the flag. Its own saved prompt stays clean, but a subagent it then spawns could see context files.

## Testing

- Live from the branch with `anthropic/claude-haiku-4-5`, `AGENTS.md` saying `Project codeword: PURPLE-OTTER-42.` and an `--add-dir` root saying `Second codeword: TEAL-HERON-7.`, prompt "No tools. Reply with any codewords you were told, or NONE.": without the flag `PURPLE-OTTER-42` / `TEAL-HERON-7`; with it `NONE`.
- `bun test test/cli-no-context-files.test.ts` runs `parseArgs` → `buildSessionOptions` → `createAgentSession` with markers in the project `AGENTS.md`, an `--add-dir` root, an `@import` and a nested `AGENTS.md`. Without the flag all four appear; with it none do, also after `refreshBaseSystemPrompt()` and in a subagent spawned through the session's `task` tool. Reverting any behaviour hunk alone fails a named assertion.
- `bun run check` passes; 163 tests across the CLI, workspace-roots, context-file refresh, prompt-dedup and subagent test files pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
