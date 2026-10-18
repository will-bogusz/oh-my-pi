## What

I hit this with an extension that relays messages from other sessions: when two arrived together while the session was idle, only the first showed up and the second was gone for good.

An extension that calls `pi.sendMessage(…, { deliverAs: "aside", triggerTurn: true })` twice in the same tick on an idle session now gets both messages to the agent, in order. On `main` the first wakes the session; the second send rejects with `AgentBusyError` and never reaches the transcript, the session file or the model.

## Why

`#dispatchCustomMessage` checks `isStreaming` once, after image normalization. The idle aside branch then awaits `#sessionGenerationChanged`, which always yields, before `#promptAgentInitiatedMessage` raises the in-flight count. Two sends in one tick both pass the check, both reach `agent.prompt`, and the second throws.

The fix re-checks `isStreaming` right before that dispatch and queues the loser with `#irc.queueAside`, as the streaming branch does. No await sits between the check and `#beginInFlight`, the same pattern `#dispatchPrompt` and `#dispatchCustomPrompt` use. The queued aside rides the winner's step-boundary poll, or `#endInFlight`'s stranded-aside resume once the winner ends.

The re-check sits after the plan-mode, interrupt and ACP-deferral gates, so every outcome that starts no turn (plan-mode fold, post-interrupt fold, ACP hidden next-turn) stays as on `main`; only the path that threw changes. The plain `triggerTurn` and `nextTurn` branches have no await between their check and `#beginInFlight`, so they already queue a second send.

## Testing

- New test `two asides sent back to back to an idle session both reach the model, in order` (`agent-session-aside-delivery.test.ts`) drives the real `AgentSession` with a stub stream and asserts both asides persist as `custom_message` entries and reach the model, first before second. With the source change reverted it fails with `AgentBusyError: Agent is already processing`. The file's 25 tests pass with the fix.
- Live: interactive omp on Haiku 5.5 with a throwaway extension whose `/asides` command fires two such sends from one timer callback. On `main`, `TICK_ONE` is shown and answered and `TICK_TWO` appears nowhere (screen, session file, omp log). With this PR both are shown and answered, in order.
- Control: the same two sends from separate timer callbacks already worked on `main` (the first turn is in flight before the second checks) and still do with this PR.

```
bun test packages/coding-agent/test/agent-session-aside-delivery.test.ts
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
