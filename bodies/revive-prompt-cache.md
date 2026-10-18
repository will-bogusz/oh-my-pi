## What

Waking a parked subagent re-sent its whole conversation uncached, because the revived session re-rendered the peer roster at the end of its system prompt, so I made the revive show the roster the agent last saw and refresh it on later rebuilds as a live agent does.

The first request after a revival now reads the whole cached prompt: in a live Haiku run it wrote 1,274 → 110 tokens to the cache and read 18,197 → 19,342. The write that goes away is everything after the roster, so it grows with the conversation; one real Opus revival wrote 254,328 tokens and read 0.

- `task/executor.ts`: `SubagentPromptInputs` records the roster each prompt render shows and, when a session is disposed, keeps the one its prompt holds (`ircRoster`). `createWarmSubagentReviver` sets `reviving` while it rebuilds the session, and the prompt builder renders that roster again instead of the registry's; once the revive returns, rebuilds read the live registry.

Closes #15523

## Why

A subagent parked after `task.agentIdleTtlMs` is rebuilt from its spawn spec when a message wakes it. The subagent prompt's `# Peers` block lists live peers with their status and activity plus a parked count, and the rebuild read them from the registry at that moment. Peers almost always change while an agent sleeps (it parked itself, siblings finished), so the revived system prompt differed near its end and the provider cached nothing past it. On Anthropic each such revival re-wrote the full conversation at cache-write price.

**Decision:** the revived agent sees the roster it last saw, exactly what it would see had it stayed live: a live subagent's prompt keeps its roster until something rebuilds it, and so does a revived one. Changed peers stay discoverable through `history://`, which the prompt already points to, and any later rebuild (a work-pool batch, a tool change) renders the live roster. Cold revival already replays the transcript's recorded prompt the same way. Rejected: delivering a roster delta as a reminder message on revival, a new delivery path that would tell a revived agent more than a live one gets.

Non-goal: tools an extension registers only from `before_agent_start` still don't come back on revival, so a revived agent using such a plugin still misses the cache.

## Testing

- New `persisted-revive.test.ts` cases, both through `runSubprocess` with the executor's real prompt builder and a warm revive through `AgentLifecycleManager.ensureLive`:
  - a running peer registers while the subagent is parked: the revived request's system blocks equal the spawn's last request, and a later `refreshBaseSystemPrompt` shows the peer. With the fix reverted it fails on the `# Peers` block.
  - a rebuild that renders a new peer is discarded (`refreshBaseSystemPrompt(() => false)`) and the peer leaves before the revive: the revived request still equals the last one sent, with no ghost peer.
- `bun test test/task/persisted-revive.test.ts`: 44 pass; `bun run check` in `packages/coding-agent` passes.
- Live, `anthropic/claude-haiku-5-5`, `task.agentIdleTtlMs: 5000`, `--no-extensions`: the main agent spawns subagent Probe, waits until it parks, spawns Other and waits until it parks, then messages Probe. Probe's first revived request:

| | cache read | cache write | revived prompt |
|---|---|---|---|
| `main` | 18,197 | 1,274 | spawn's plus `1 parked peer(s) omitted.` |
| this PR | 19,342 | 110 | spawn's (no new `session_init` recorded) |

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
