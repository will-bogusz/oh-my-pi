## What

there was an earlier session where we looked into weird anthropic refusals and how to keep reasoning quality maintained, some finding about token labels and similar, may be worth figuring out and looking back into to increase quality as well.

A parked subagent woken after omp restarted came back with its `xd://` devices (`ast_grep`, `debug`, `github`, …) as top-level tools. Its tool list no longer matched its earlier turns', so Claude dropped all of its earlier thinking and the cache missed. Now it comes back with the tools and devices it had.

| Live check, Haiku 5.5 with thinking: subagent parks, omp exits, `omp --resume` wakes it by IRC | `main` | this PR |
|---|---|---|
| Tools sent on the wake request | 16 + the 6 devices as top-level tools, plus a `tool_addition` message | the same 16 as before parking |
| Earlier thinking blocks | 2 of 2 dropped | 0 dropped |
| Cache on the wake request | 27,563 read, 1,670 written | 28,997 read (whole parked prefix) |

Reading order: `task/executor.ts` and `/tan` record `mountedTools` in `session_init`; `task/persisted-revive.ts` passes it to `createAgentSession` as `mountedToolNames`.

## Why

Cold revival replays `session_init.tools` (devices included) as an explicit tool list, and `createAgentSession` pins every explicit name top-level unless it is in `mountedToolNames`. A warm revive rebuilds from the spawn's own options and was not affected; `/tan` already passes `mountedToolNames`, the path this reuses. A changed tool list makes Anthropic drop every earlier signed thinking block (`inputTransformations: prefix_binding_mismatch`).

- Rejected: re-deriving the devices from the replayed system prompt's catalog; it parses prompt text, and the spawn already knows the set.
- Older transcripts have no `mountedTools` and revive as on `main`. The anonymizer exports the field like `tools`; `docs/session.md` documents it.
- The revived subagent also stops paying for the devices' schemas: on `main` omp's non-message estimate went from 26,764 to 33,251 tokens after the wake.
- In a week of my sessions every overnight wake was a warm revive, so this showed up only in the live check; it applies whenever omp restarts between a park and its wake.

Non-goal: tools enabled after spawn (an MCP server added mid-run); `session_init` keeps the spawn-time set, as on `main`.

## Testing

- `test/task/revived-subagent-extension-tools.test.ts`: a real subagent spawned through `runSubprocess`, parked, cold-revived and woken by IRC sends the same tools and system prompt as before parking. Fails on `main`.
- `/tan` persisting `mountedTools`, and the anonymizer keeping it, are covered in their test files (the latter fails without the rule).
- Live, real Anthropic, Haiku 5.5 (same thinking binding as Opus 5.5), request bodies dumped before sending: the table.
- Task, session and `/tan` suites: failures match `main`'s.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
