## What

Waking a parked subagent re-sent its whole conversation uncached, because the revived session re-rendered the peer roster at the end of its system prompt, so I made the revive show the roster the agent last saw and refresh it on later rebuilds as a live agent does.

The first request after a revival now reads the whole cached prompt: in a live Haiku run it wrote 1,274 → 110 tokens to the cache. The saved write is everything after the roster, so it grows with the conversation; one real Opus revival wrote 254,328 tokens and read 0.

- `task/executor.ts`: each prompt render records the roster it shows; when a session is disposed, the roster its prompt holds is kept (`ircRoster`). While `createWarmSubagentReviver` rebuilds the session (`reviving`), the prompt builder renders that roster instead of the registry's.

Closes #15523

## Why

A parked subagent is rebuilt from its spawn spec when a message wakes it. The prompt's `# Peers` block lists live peers with status and activity plus a parked count, and the rebuild read them from the registry at that moment. Peers almost always change while an agent sleeps, so the revived system prompt differed near its end and nothing past it was cached; on Anthropic each revival re-wrote the full conversation at cache-write price.

**Decision:** the revived agent sees the roster it last saw, as it would had it stayed live: a live subagent's prompt keeps its roster until something rebuilds it. Changed peers stay discoverable through `history://`, which the prompt points to, and any later rebuild renders the live roster. Cold revival already replays the recorded prompt the same way. Rejected: a roster-delta reminder on revival, a new delivery path that tells a revived agent more than a live one gets.

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
