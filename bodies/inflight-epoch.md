## What

If I interrupted a prompt while it was still setting up and sent the next one right away, the old prompt finishing late could end my new turn's sleep and display holds partway through, so each turn's end now only counts for the turn it started.

An agent turn holds a `power.sleepPrevention` assertion and, on macOS, the `computer` tool's display hold from the moment it starts until it ends. Interrupting resets that at once, but a prompt stalled in setup (an API-key lookup, a usage preflight) still runs its cleanup later. If the next prompt has started by then, that late cleanup counts as the new turn ending: on `main` the machine can idle-sleep and the display can sleep mid-turn, and the deferred `agent_end` and queue drain can fire early.

| Interrupt during setup, send again, old setup finishes mid-turn | `main` | this PR |
|---|---|---|
| `power.sleepPrevention` assertion (`pmset -g assertions`) | gone mid-turn | held until the turn ends |
| `computer` display hold | released mid-turn | held until the turn ends |
| deferred `agent_end`, queue drain | can fire mid-turn | at the turn's end |

Reading order: `agent-session.ts` `#beginInFlight`, `#endInFlight`, `#resetInFlight`, then their five callers.

## Why

- `abort()` calls `#resetInFlight()`, which zeroes the in-flight count and releases both holds without waiting for every bracket to unwind; it has to, or a stalled setup would keep the session busy.
- `#beginInFlight()` now returns an epoch that `#resetInFlight()` advances, and `#endInFlight(epoch)` from an earlier epoch no longer decrements the count. While a newer turn is in flight it does nothing; with none in flight it still settles as before (release, `agent_end` flush, stranded-queue drain), so a turn that began while `abort()` was finishing still delivers a steer queued at its end. Every begin/end pair passes its epoch.
- Rejected: holding the next prompt until the old one unwinds; setup can stall on network calls, which is why `abort()` resets.

Non-goal: a bracket that begins while `abort()` is still running loses its holds at the reset, as on `main`.

## Testing

- `test/agent-session-computer-turn.test.ts`: abort a prompt stalled in `getApiKey`, start the next prompt and hold it mid-step, let the first prompt unwind; the turn keeps display turn 2 and nothing is released until it ends. Reverted: turn `undefined` after the stale cleanup.
- `test/agent-session-inflight-epoch.test.ts`: the same race in a sandboxed child process outside the bun test runtime, where `AgentSession` takes real power assertions (macOS only; Linux needs a login1 inhibitor), counting releases. Reverted: the stale cleanup releases the new turn's assertion (`afterInterruptedUnwinds: 2`, expected 1). A second case starts a turn while `abort()` is finishing and steers at its `agent_end`; it fails if a stale end skips the settle.
- Live on macOS 26 with a real `AgentSession` (`bun test/fixtures/inflight-epoch-power.ts --pause-ms 2500`, `pmset -g assertions` at each step): the second turn's `omp agent session` assertion is still listed after the stale cleanup, 3 s old; reverted, it is gone at that point.
- `bun run check:ts` clean; `test/agent-session*.test.ts` and `test/tools/computer.test.ts` pass, bar three message-pipeline cases needing an Ollama key here (same without this change).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
