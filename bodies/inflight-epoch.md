## What

If I hit Esc and sent my next prompt before the interrupt had finished, a message I steered in as that turn ended just sat in the queue, so the end of that turn now settles the session like any other.

`abort()` resets the in-flight bracket at its end. A prompt that started while `abort()` was still finishing (it awaits the goal runtime and other teardown) began its bracket before that reset, so its bracket carries the old epoch. Since #15947 (the fix for #15946), `#endInFlight` returns at once for an old epoch, so when that turn ends nothing settles: no stranded-queue drain, no yield-queue idle flush.

| Prompt sent while an interrupt is finishing, steer lands as its turn ends | `main` | this PR |
|---|---|---|
| the steered message | stays queued | runs as the next turn |

Reading order: `agent-session.ts` `#endInFlight`.

## Why

- #15947 stopped an interrupted prompt's late cleanup from counting a newer turn out, which this keeps: a stale `#endInFlight` still leaves the count alone, and returns early while a newer turn is in flight. What changes is the case with nothing in flight: it settles as `main` did before #15947, so a turn whose bracket `abort()` reset still settles when it ends.
- Rejected: holding a prompt until `abort()` returns; a prompt sent right after Esc would wait on teardown it does not depend on.

Non-goal: that turn still loses its `power.sleepPrevention` and `computer` display holds at the reset, as on `main`.

## Testing

- `test/agent-session-prompt-abort-race.test.ts`, new case: hold `abort()` at its last await, start a prompt and hold its turn mid-stream, let `abort()` finish, then end the turn and steer at its `agent_end`. Passes here; on `main` the steer never runs (`The steer queued as the turn ended never ran`). On `main` with #15947's change reverted it passes, so #15947 introduced it.
- #15947's own case in that file (`keeps the next prompt busy when an interrupted setup unwinds late`) and `test/agent-session-computer-turn.test.ts` pass.
- `bun run check:ts` clean; `test/agent-session*.test.ts` pass (1402), bar three `agent-session-message-pipeline.test.ts` cases that fail the same on `main` here.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated: no entry, since the regression came from #15947 and no release has shipped it
