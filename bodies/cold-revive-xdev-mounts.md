## What

there was an earlier session where we looked into weird anthropic refusals and how to keep reasoning quality maintained, some finding about token labels and similar, may be worth figuring out and looking back into to increase quality as well.

A parked subagent woken after omp restarted came back with its `xd://` devices (`ast_grep`, `ast_edit`, `debug`, `github`, `security_scan`, `generate_image`) as top-level tools. Its tool list no longer matched the one its earlier turns were sent with, so Claude dropped all of its earlier thinking and the prompt cache missed. With this PR it comes back with the tools and devices it had.

| Live check, Haiku 5.5 with thinking: subagent finishes, omp exits, `omp --resume` wakes it by IRC | `main` | this PR |
|---|---|---|
| Tools sent on the wake request | 16 + the 6 devices as deferred top-level tools, a `tool_addition` system message, and an `eval` description listing tools in a new order | the same 16 as before parking |
| Earlier thinking blocks | 2 of 2 dropped | 0 dropped |
| Cache on the wake request | 27,563 read, 1,670 written | 28,997 read (the whole parked prefix) |

Reading order: `task/executor.ts` and `/tan` (`tan-command-controller.ts`) record `mountedTools` in `session_init`; `session/session-manager.ts` reads it back (`extractSessionInit`); `task/persisted-revive.ts` hands it to `createAgentSession` as `mountedToolNames`. `session-anonymizer.ts` exports it like `tools`, and `docs/session.md` describes it.

## Why

`session_init.tools` records the subagent's enabled set, devices included, and cold revival replays it as an explicit tool list. `createAgentSession` pins every explicitly named tool top-level unless it is listed in `mountedToolNames`, so every device came back as a regular tool. A warm revive (same process) rebuilds from the spawn's own options and was not affected; `/tan` already passes `mountedToolNames` for its clone, which is the path this reuses.

Anthropic binds each signed thinking block to the exact system prompt and tools before it, and omp asks for `drop_block`, so the changed tool list silently dropped every earlier block (`inputTransformations: prefix_binding_mismatch`).

- Rejected: re-deriving the device set on revive from the replayed system prompt's device catalog. It parses prompt text, and the spawn already knows the set.
- A transcript written before this PR has no `mountedTools` and revives as on `main`.
- The revived subagent also stops paying for the devices' schemas on every request: omp's own estimate of the non-message prompt went from 26,764 to 33,251 tokens after the wake on `main`.
- How often: in one week of my sessions, every subagent woken overnight was a warm revive inside a long-running omp, so this path showed up only in the live check; it applies whenever omp restarts between a subagent parking and its wake.

Non-goals: subagents whose enabled tools change after spawn (an MCP server added mid-run); `session_init` records the spawn-time set, as on `main`.

## Testing

- New test in `test/task/revived-subagent-extension-tools.test.ts`: spawns a real subagent through `runSubprocess` with a mock model, parks it, cold-revives it through `createPersistedSubagentReviverFactory` and wakes it by IRC. The wake request's tools and system prompt equal the parked agent's last request. It fails on `main` (`ast_edit`, `debug` and `ida` arrive top-level).
- `test/modes/controllers/tan-command-controller.test.ts` now checks `/tan` persists `mountedTools`.
- `test/session-anonymizer.test.ts`: a `session_init`'s `mountedTools` keeps built-in names and gives an MCP name the same placeholder as in `tools`; fails without the anonymizer rule.
- Live, real Anthropic, Haiku 5.5 (same prefix binding and binding controls as Opus 5.5 in `classes/anthropic.kdl`), request bodies dumped before sending: the table above; the cache numbers come from the replies' usage.
- `bun test test/task test/session test/modes/controllers/tan-command-controller.test.ts test/rpc-cancel-subagent.test.ts`: 1783 pass, 6 fail; the same 6 `executor-async-quiescence` tests fail in that combined run on `main` and pass alone on both.
- `bun run check:types`, `oxlint`, `oxfmt` clean.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
