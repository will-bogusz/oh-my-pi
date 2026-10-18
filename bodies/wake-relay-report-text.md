## What

I made a woken subagent send back only its final answer, because it was gluing every bit of text from the turn together.

When an idle subagent is woken by an IRC message and answers in prose, the text relayed to the agent that woke it (and to the parent's wake job) was every text block of every assistant message in that turn, joined with no separator. A turn that says `Checking.`, calls `read`, then says `Answer.` relayed `Checking.Answer.`; with this PR it relays `Answer.`.

The wake path now picks its text with `lastReportTurnText()`, the same selection a first-run message result already uses (`finalizeRunResult`): the prose of the last assistant message that started no further work.

## Why

`attachIrcWakeTurnMonitor` read `turnMonitor.rawOutput()`, which is `finalOutputChunks.join("")` over the whole turn. The first-run path moved off `rawOutput()` for message results; the wake relay never did, so narration before tool calls ran straight into the answer for both peer relays (`relayWakeTurnOutput`) and the parent's wake-job result (`buildWakeRelayBody`).

Decisions:
- The `lastAssistantSalvageText()` fallback (the session's last assistant text) now applies only when the monitor saw no assistant message in the wake turn, which is where `main`'s relay found its text before. A turn the monitor did see never falls back to it: that text can be narration `lastReportTurnText()` set aside, such as prose before a Cursor-resolved call with no report after it. Such a turn gets the existing "produced no output" or "sent a message during this turn" notice, as a first-run message result gets its empty-message outcome.
- Structured first runs (`task.structured: true`) still finalize from `rawOutput()` when they don't yield; that path is untouched here.

Non-goals: the yielded path (it relays the `<task-result>` summary) and failure notices are unchanged.

## Testing

Two tests in `test/task/executor-result-acceptance.test.ts`, each a peer waking an idle subagent:
- The turn emits `[text "Checking." + read toolCall]`, then `[text "Answer."]`; the peer receives `Answer.`. With the `executor.ts` change reverted it fails: `Expected: "Answer." Received: "Checking.Answer."`.
- The turn ends on `[text "Running the tests." + Cursor-resolved bash call]`; the peer gets the "produced no output" notice, not the narration. With the fallback applied unconditionally it fails (`Received: "Running the tests."`).

The existing wake relay tests that drive only the session's last assistant message (`persisted-revive.test.ts`, `irc.test.ts`) still pass.

Live, with Haiku: a parent messaged an idle subagent that had to read `notes.txt` for a secret word. On `main` the reply was `I'll read notes.txt to find the secret word.MARMALADE`; with the fix it was `MARMALADE` (2 of 2 runs). That run used a build of the same fix whose salvage fallback was unconditional, its only difference from this head; the scenario has a report turn, so it never reaches the fallback.

```sh
cd packages/coding-agent && bun test test/task/executor-result-acceptance.test.ts test/task/executor-irc-wake-yield-reset.test.ts
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
