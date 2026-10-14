## What

The computer tool kept my Mac's screen on for five minutes after the agent stopped, and let it sleep and lock in the middle of a long turn, so I tied its display hold to the agent's turn instead of a timer.

On macOS the `computer` tool holds `PreventUserIdleDisplaySleep` while it acts. On `main` each desktop request holds it until 5 minutes after the last one. Now a turn's first desktop request takes it and it lasts until the turn ends (the agent stops and waits, an interrupt included); the next turn takes it again.

| macOS 26.5 VM, display sleep 1 min, lock on sleep; n=5 per cell | `main` | this PR |
|---|---|---|
| 80 s of computer work, then the turn ends: screen locks after the turn ends | 360.9 s (360.8–363.7) | 70.9 s (70.1–71.5), the VM's idle lock |
| a computer action, 7 min of other work in the same turn, then a screenshot (`power.sleepPrevention: idle`, the default) | locked 372 s in; screenshot failed 5/5 | no lock; screenshot 5/5 |
| the same with `power.sleepPrevention: system` | no lock; screenshot 5/5 | no lock; screenshot 5/5 |
| no agent session (SDK or `eval` use) | held until 5 min after the last request | unchanged |

Only the hold ends with the turn; control, AX refs, worker and runtime stay.

Reading order: `agent-session.ts` (`#beginInFlight`, `#endInFlight`, `#resetInFlight`) → `tools/computer/supervisor.ts` (`beginComputerTurnForOwner`, `computerTurnInFlight`) → `tools/computer/worker.ts` (`release-display`) → `desktop/mod.rs` (`DisplayAwake::expire`, `releaseDisplayAwake`).

## Why

- One notion of "the agent is working": the in-flight bracket that already takes and drops the `power.sleepPrevention` assertion.
- Work can outlive a turn (background eval jobs). Each run carries the turn in flight when it starts (none between turns), and the worker ignores a hold for a turn it has seen end, so work after its turn gets the grace instead of pinning the display until the next turn; work that runs during a later turn holds until that turn ends.
- Without an agent session nothing marks a turn, so SDK and `omp eval` keep the grace.
- Residual, shared with the power assertion: a continuation started outside the bracket (Gemini header-runaway recovery) keeps `main`'s grace, and a prompt aborted mid-setup that finishes after the next one began ends that one's hold early. Both are bracket fixes.

Non-goal: waking a sleeping display or unlocking the screen.

## Testing

Live in macOS VMs, each trial after powerd's post-input display hold expired: a real `AgentSession` with the eval tool, computer prelude and native backend, a scripted mock model, silent screenshots and `ax()` on a background TextEdit window. Assertion dumps show `main` dropping the hold 300 s after the last request and this branch at the turn's end.

- `test/agent-session-computer-turn.test.ts`: a turn's steps keep it live; its end releases once; the next prompt is turn 2; an interrupt releases, also while setup is still unwinding. Each fails with its call reverted.
- `computer.test.ts` "display hold follows the agent turn": `release-display` drops only the hold; a late run of an ended turn holds nothing; runs without a turn never hold. Each fails with its piece reverted.
- Rust `desktop::capture_tests` (35 pass): the hold outlives the grace until released, then the next turn holds again, later activity gets the grace, and a turn's end leaves the grace of activity outside a turn. Mutations fail 2 (`expire` ignores the turn), 3 (release keeps the hold) and 2 (no grace, including the existing grace test). Full `pi-natives` on macOS 26: 575 pass; the one failure, `emergency_stop_revokes_idle_task_control_after_retirement`, fails the same on `main` and #15761 fixes it (576/576 with it merged in). `CI=1 bun check` clean.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)


