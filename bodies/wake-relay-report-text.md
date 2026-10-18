## What

I made a woken subagent send back only its final answer, because it was gluing every bit of text from the turn together.

When an idle subagent is woken by an IRC message and answers in prose, the text relayed to the agent that woke it (and to the parent's wake job) was every text block of every assistant message in that turn, joined with no separator. A turn that says `Checking.`, calls `read`, then says `Answer.` relayed `Checking.Answer.`; with this PR it relays `Answer.`.

The wake path now picks its text with `lastReportTurnText()`, the same selection a first-run message result already uses (`finalizeRunResult`): the prose of the last assistant message that started no further work.

## Why

`attachIrcWakeTurnMonitor` read `turnMonitor.rawOutput()`, which is `finalOutputChunks.join("")` over the whole turn. The first-run path moved off `rawOutput()` for message results; the wake relay never did, so narration before tool calls ran straight into the answer for both peer relays (`relayWakeTurnOutput`) and the parent's wake-job result (`buildWakeRelayBody`).

Decisions:
- The `lastAssistantSalvageText()` fallback is dropped. It held the last message's text even when that text came before tool or Cursor server work, which is the narration `lastReportTurnText()` deliberately leaves out; the failed and cancelled branches of `buildWakeRelayBody` never read the turn text. A turn with no report now gets the existing "produced no output" or "sent a message during this turn" notice, as a first-run message result gets its empty-message outcome.
- Structured first runs (`task.structured: true`) still finalize from `rawOutput()` when they don't yield; that path is untouched here.

Non-goals: the yielded path (it relays the `<task-result>` summary) and failure notices are unchanged.

## Testing

New test in `test/task/executor-result-acceptance.test.ts`: a peer wakes an idle subagent, the turn emits `[text "Checking." + read toolCall]`, then `[text "Answer."]`, then `agent_end`; the relay the peer receives is `Answer.`. With the `executor.ts` change reverted it fails: `Expected: "Answer." Received: "Checking.Answer."`.

Live, with Haiku: a parent messaged an idle subagent that had to read `notes.txt` for a secret word. On `main` the reply was `I'll read notes.txt to find the secret word.MARMALADE`; with the fix it was `MARMALADE` (2 of 2 runs). That run used a build of the same fix that still fell back to `lastAssistantSalvageText()`, its only difference from this head; the scenario never reaches that fallback.

```sh
cd packages/coding-agent && bun test test/task/executor-result-acceptance.test.ts test/task/executor-irc-wake-yield-reset.test.ts
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
