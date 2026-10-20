## What

A subagent I woke up after it had parked came back without the `ida_*` tools the HexRays ida-mcp extension gives it, and paid for a fully uncached first request on top, so revival now lets extensions register those tools again.

On the first request after the wake, extension tools go from 0 to 6 of 6 and cache writes from about 14,130 to 191 tokens (Haiku 5.5, n=3 per arm, identical runs):

| First request after a parked subagent is woken | `main` | this PR |
|---|---|---|
| Tools an extension registered at the subagent's first prompt | missing for the rest of its life | present, and calls run |
| Cache read / write (tokens) | 16,157 / ~14,130 | 32,363 / 191 |

Reviving rebuilds the session: extensions are bound again and get `session_start`, but later turns are wakes (IRC, job results), which skip `before_agent_start`. ida-mcp registers its tools at the first `input` or `before_agent_start`, so a revived subagent never gets them back, and the changed tool array misses the cache. Both revive paths (warm, and cold after a restart) now run `before_agent_start` once after `session_start` with an empty prompt, dropping its result. `ensureLive` also joins a revive in flight, so a second waker can't run a turn before the tools return.

## Why

In my sessions 61 of 61 revivals with ida-mcp loaded never got the tools back; within the cache TTL their first request read about 14k cached tokens and wrote 183k on average. Any extension that registers tools from `before_agent_start` or `input` is affected.

- Rejected: save the parked session's extension tool definitions and re-register them, as #16369 does for the peer roster. Built it: tools and cache came back, but every call failed, since `execute` belongs to the disposed extension binding.
- Rejected: full `before_agent_start` preparation on any session's first agent-initiated turn, which changes the documented contract for every session.
- The result is dropped: the transcript already holds what the parked turns added, and an override would make the revived prompt differ from the parked one.

Non-goals: wakes of a live subagent still skip the hook, as documented; a first-prompt override isn't reapplied, and a tool disabled at runtime comes back enabled, as every extension tool already does on `main`. Cost: one hook dispatch per revive; handlers already must tolerate re-entry.

## Testing

- `test/task/revived-subagent-extension-tools.test.ts`: a real `runSubprocess` spawn on the mock model with an ida-mcp-style extension, parked, woken over IRC after a warm and a cold revive: the woken request carries the tool, the call runs, and (warm) tools and system prompt equal the parked request's. A third test holds discovery open during a revive and checks a second `ensureLive` waits. Each fails with its part of the fix removed.
- `test/task`, `test/registry`, `test/extensibility`, `test/session`, `test/collab` and the extension, IRC and hook tests pass, except three that fail the same on `main` on this host.
- Live, Haiku 5.5 on direct Anthropic, n=3 per arm: six ida-style tools, park, IRC wake (the table). An idle wake of a live subagent still fires no `before_agent_start`.
- Not run: the real ida-mcp extension (needs IDA); the test copies its registration pattern.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
