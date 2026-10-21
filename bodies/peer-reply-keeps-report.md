## What

My subagents kept handing back a one-line "not for me" reply instead of the review they had just written whenever another agent messaged them as they finished, so a message that lands at the end of a subagent's run now gets its own turn after the report is delivered.

In a week of my sessions, 6 of 16 subagents that got a peer message during their final report turn delivered only their reply to it (a 4,476-character review reached its parent as 190 characters); with this PR the parent gets the report and the peer still gets the reply.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/7ae76208-bbba-4784-a8f0-e5ac8f2d1edd">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/a6250209-9335-451f-a53c-88fcb8ad395e">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/93049702-2f1a-4f67-b76f-53e0920b654c">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/d702f5da-bcb5-40aa-bf91-04fcf0b52270">
  <img width="780" alt="Timeline, main against this PR. Both: the subagent streams its final report and a peer's message is queued. On main the turn's end drains the message, the agent takes one more turn to answer it, and that answer becomes the parent's result, so the report is lost. With this PR the message stays queued, the run ends with the report as the parent's result, and the message then wakes a turn of its own whose reply is relayed to the peer." src="https://github.com/user-attachments/assets/a6250209-9335-451f-a53c-88fcb8ad395e" />
</picture>

| A message from anyone but the parent, or any `agent://all` broadcast, that reaches a message-result subagent… | `main`: the parent receives | This PR: the parent receives |
|---|---|---|
| during its final report turn | the reply to that message | the report; the message gets its own turn, whose reply goes to a direct sender |
| after that turn, before the run settles | the reply to that message | the report; same |
| while its run waits on background work | the report; the reply reaches no one | the report; same |
| during a wake turn its parent started | the reply to that message, as the parent's wake result | the wake turn's answer; same |
| while it is still working (tool calls) | the report (message shown at the next tool boundary) | same |
| from its parent, directly, during its final turn | the answer to the parent (issue 16305 semantics) | same |

Reading order: `getAsideMessages(boundary)` (`agent/src/agent-loop.ts`) -> `IrcBridge.deliver` / `drainPending` (`session/irc-bridge.ts`) -> `AgentSession.holdIrcWakes` (`session/agent-session.ts`) -> `runSubprocess` (`task/executor.ts`).

## Why

A message-result subagent's result is its last report turn. A peer message queued during that turn is drained at the stop boundary into one more turn, which the run's monitor takes as the report; one arriving just after wakes a turn under the same monitor before `runSubprocess` finalizes.

The agent loop now tells aside providers which boundary it polls. At `"stop"`, a subagent session leaves non-parent records queued; while `runSubprocess` drives a kept-alive run, one that would wake the idle session waits for the published result (a parent's direct message still wakes in-run). They then wake a monitored turn of their own, whose reply the existing wake relay sends to a direct sender (none to a broadcaster, as in #16312); the sender's `wait` stays open meanwhile.

**Beyond the fix:** a parent's `agent://all` broadcast to a busy child is queued like a peer's, not steered; on `main` it already was not a parent request.

Rejected, each prototyped on the same tests:
- Keep the earlier report in the run monitor: loses it when the answer needs a tool call, and the parent waits for that turn.
- Hold every non-parent message until the run ends: the agent stops seeing peers mid-work.

Related: #15707, #16302, #16305.

Maintenance: a new run driver needs `holdIrcWakes()` too.

## Testing

Live, `claude-haiku-5-5` for every role: the main agent spawns Writer (a 2,500-word report, no tools) and Pinger (sleeps 9 s, messages Writer, waits); the message landed mid-report each time. omp 18.12.2: Writer's result was "Yes, the report is finished. I replied to Pinger…" (78 characters). This PR, 2 runs: the reports (17.7 and 12.8 KB); Pinger got the reply.

`test/task/peer-message-after-report.test.ts` drives the real `runSubprocess`, `AgentSession` and `IrcBus` with a gated mock model: 11 cases, 8 fail with `src/` reverted, and the 3 controls (the parent's own messages, a mid-work peer message) pass on both. A `wait.test.ts` case covers the open `wait`.

```
cd packages/coding-agent && bun test test/task/peer-message-after-report.test.ts test/session/irc-bridge-relay.test.ts test/tools/wait.test.ts test/task/focused-subagent-manual-yield.test.ts test/tools/irc.test.ts
```

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
