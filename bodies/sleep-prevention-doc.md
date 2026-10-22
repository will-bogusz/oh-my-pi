## What

I reworded the sleep prevention setting because it says it keeps the machine awake while a session is open, but omp only holds the assertion while the agent is running a turn.

`/settings` and `omp config get power.sleepPrevention` now say the hold lasts for a turn, and that an idle session, including one only waiting on background jobs, holds nothing.

| | Text |
|---|---|
| Setting, before | Prevent the system sleeping **during active sessions**. Each level is cumulative — it adds the flags of all lower levels. |
| Setting, now | Prevent the system sleeping **while the agent is running a turn; an idle session, including one waiting on background jobs, does not hold it**. Each level is cumulative — it adds the flags of all lower levels. |
| `idle` option, before | Keep the system awake **while a session is open** (macOS `caffeinate -i`) |
| `idle` option, now | Keep the system awake **while the agent is running a turn** (macOS `caffeinate -i`) |

Text only; no behaviour changes.

## Why

`AgentSession` acquires the power assertion when the first prompt goes in flight (`#beginInFlight`) and releases it when the last one settles (`#endInFlight`, or `#resetInFlight` on abort). Between turns nothing holds it: `settleAsyncWork()` waits on background jobs without opening an in-flight bracket. Someone who starts a long background job, ends the turn, and walks away trusting "while a session is open" comes back to a machine that slept.

Paths that do hold it, so the new text stays true: a turn resumed by a background result (async-result delivery brackets its prompt), a foreground `wait` call (it runs inside the turn), and a running subagent, which holds its own assertion under the same setting.

Non-goal: keeping the machine awake while background jobs run. That would change what the setting does and belongs in its own PR.

## Testing

- `omp config get power.sleepPrevention --json` from the branch prints the new description.
- Live `AgentSession` runs with real macOS assertions, read through `pmset -g assertions`: `off` held none; `idle`, `display` and `system` held 1, 2 and 4 during the turn and none once it settled. A subagent held and released its own `idle` assertion.
- `bun test test/power-assertion-options.test.ts test/agent-session-computer-turn.test.ts test/settings-manager.test.ts test/agent-session-async-delivery.test.ts`: 184 pass.
- Not run: Linux and Windows. Their release paths in `crates/pi-natives/src/power.rs` (inhibitor fd close, `SetThreadExecutionState` reset) were read, not executed.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
