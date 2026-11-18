## What

The loop profiler a TUI starts never stopped, so I made the last watchdog to stop pause it, which also stops it from pinning objects in later test files.

Samples recorded after the only TUI watchdog stopped, over a 10 s CPU-bound loop: 8,368 → 0. A test file that starts a real Composer no longer breaks a later file's "object is collected" assertions in the same process:

| First file, then `test/task/parked-subagent-session-release.test.ts` | `main` | this PR | `main`, `PI_LOOP_SAMPLER=0` |
|---|---|---|---|
| `test/startup-composer.test.ts` | 2 fail (3/3 runs) | 0 fail (3/3) | 0 fail (3/3) |
| `test/issue-9597-cold-launch-double-clear.test.ts` | 2 fail (3/3) | 0 fail (3/3) | 0 fail (3/3) |
| `test/collab/controller.test.ts` | 2 fail (3/3) | 0 fail (3/3) | 0 fail (3/3) |

The failures are the two parked-subagent tests that wait for a released session to be collected; alone, that file passes.

## Why

`LoopWatchdog.start()` starts bun:jsc's sampling profiler, which is process-wide and has no stop call, so after `TUI.stop()` (an external editor, the end of a session) it kept sampling the JS thread for the rest of the process. Each sample keeps the functions on its stack, and what they close over, alive until the buffer is drained. In production a 2 s timer drained it while no watchdog ran; `bun test` cancels a file's timers when the file ends, so after any file that starts a real TUI the buffer pins whatever later files run, such as `AgentSession#handleAgentEvent`.

Each sampler now counts as running from `start()` to `stop()`, and `LoopWatchdog.stop()` stops its own. When the last one stops, `profile(() => {})` pauses the profiler and clears its buffer; the next `start()` resumes it. Nothing records while no watchdog runs, so the 2 s discard timer is gone.

- **Counted, not stopped outright:** each TUI has its own watchdog, and stopping one must not blind another's.
- **Rejected: drain on stop and keep sampling.** Later samples would still pin objects, and the process would keep sampling with no reader.
- **Maintenance:** this relies on `profile()` pausing rather than shutting down the shared profiler, which [Bun does on purpose so it can restart](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/jsc/modules/BunJSCModule.h). If that changes, the new test fails.
- **Limit:** the debug menu's performance report records through the same profiler. While a TUI runs, the watchdog's drains already empty it on `main` (8 samples of 1 s of CPU work); if the TUI stops mid-report, `main` kept the samples taken after the stop and this PR pauses them too.

Non-goal: the sampler's cost while a TUI runs (Related: #19634).

## Testing

- New test in `packages/tui/test/loop-watchdog.test.ts`, in a fresh process: with two watchdogs on the real sampler, the profiler starts once, is not paused when the first stops, is paused when the second stops (empty buffer after more JS), and records again after a restart. 3/3 pass; 3/3 fail with `src/` reverted. Three tests in that file that left a real-sampler watchdog running now pass `sampler: null`.
- Table: `bun test <first> test/task/parked-subagent-session-release.test.ts --parallel=1 --timeout=30000` in `packages/coding-agent`.
- `packages/tui` `bun test`: same 25 failures as bare `main` (local native addon is 18.22.0); `check:types` clean for `tui` and `coding-agent`.
- Not run: Linux, Windows.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
