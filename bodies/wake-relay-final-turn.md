## What

When I message a subagent that already finished, its reply comes back with that turn's "let me check X" narration glued onto the front of the answer with no space, so this makes the reply just the final answer, like its first result already is.

A woken subagent that answers without `yield` now hands back only its final report message. On `main` the reply was every text block of the turn joined with `""`: a turn of `[text "Checking.", read]` then `[text "Answer."]` replied `Checking.Answer.`; it now replies `Answer.`. In real sessions this read like `…reply to both threads.PR 16205 is mine and is now at…`.

The fix is one line in `attachIrcWakeTurnMonitor` (`packages/coding-agent/src/task/executor.ts`): the wake turn's `turnText` reads `lastReportTurnText()` instead of `rawOutput()`, still falling back to the last assistant message's text. That one value is the answer both ways a wake reply travels: the parent's wake job (`buildWakeRelayBody`) and the IRC relay to a peer that woke the agent (`relayWakeTurnOutput`).

## Why

A first run's message result already uses `lastReportTurnText()`, the last assistant message with prose and no further work started, so narration before a tool call never reaches the parent. The wake path kept `rawOutput()`, which concatenates every assistant text block from `agent_end`. Across my sessions since 10-14, 39 relayed wake replies started with narration and about 91 had sentences run together, on 18.12.1 among others.

Unchanged: a wake turn that yields still relays its `<task-result>` summary; failed, cancelled and empty turns keep their notices; a first run's structured output still finalizes from `rawOutput()`, since its schema fallback parses the run's text. A completed wake turn whose last message has no text (it answered through `write`) now gets the existing "sent a message during this turn" / "produced no output" notice instead of its narration.

## Testing

- `test/task/executor-irc-wake-yield-reset.test.ts`, new `relays the final report turn, not the turn's narration` (structured off and on): a peer wakes an idle subagent, the turn scripts `[text "Checking.", toolCall read]` then `[text "Answer."]`, and the peer's relay is `Answer.`. With the fix reverted both rows fail with `Received: "Checking.Answer."`.
- Live, `claude-haiku-5-5`, print mode (Linux): the parent spawns `Probe`, then writes to it "say one sentence about what you will do, read notes.txt, reply with the secret word" and `wait`s. In every run Probe's wake turn was `[text "I'll read notes.txt to find the secret word.", read]` then `[text "MARMALADE"]`. The wake job the parent received carried `I'll read notes.txt to find the secret word.MARMALADE` on `main` (1 run) and `MARMALADE` with this PR (2 runs).
- Wake, task and IRC neighbours (`executor-result-acceptance`, `persisted-revive`, `irc-bridge-relay`, `executor-subagent-reminders` and 7 more): 160 pass. `bun run check:ts` passes.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
