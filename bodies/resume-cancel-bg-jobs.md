## What

I made `/resume` cancel the old session's background jobs the way `/new` already does, since otherwise a job from the old session finishes after the switch and starts a turn in the session you just resumed.

Before: a `bash` job started in session A and still running at `/resume` B posts its result into B, and B's agent starts an unprompted turn about it. Now the job is cancelled when the switch commits, and B's transcript holds only its own messages.

- Applies to every different-session switch: the `/resume` picker, RPC `switch_session` and `open_session`, and SDK switches.
- A same-session reload keeps its jobs, and so does a switch that rolls back (a declined cwd change, an unrestorable model, a throwing fallback callback): the cancel runs after the last step that can roll back.
- While any session transition is in flight, idle yield-queue deliveries wait until it settles, so a job finishing mid-switch cannot start a turn before the cancel drops its result.

## Why

`AgentSession.switchSession` never called `#cancelOwnAsyncJobs`, though the async delivery epoch's doc already counts session transitions as evicting the owner's jobs. Both sessions share one agent id, so outgoing results land in whichever transcript is loaded when they finish.

Decision: cancel, as `/new` does, rather than carry jobs over: their results answer a conversation that is no longer loaded.

Not changed: tree navigation inside one session still delivers jobs from an abandoned branch, as on `main`. Related: #13699 records cancelled jobs in the transcript at dispose.

Review first: the cancel's placement after the fallback callback in `switchSession`, and the yield queue's `isStreaming` hold.

## Testing

- Live, over RPC from the branch with `anthropic/claude-haiku-4-5`: create session B, start session A, run `sleep 6 && echo MARKER_FROM_A` in the background, `switch_session` to B, wait 15 s. On `main`, B's transcript gets the `async-result` with `MARKER_FROM_A` and an unprompted assistant turn; on the branch, `MARKER_FROM_A` is absent from B.
- `bun test test/agent-session-async-delivery.test.ts`: 25 pass, including five new cases:
  - a running job is cancelled by a switch, with no model call and nothing in the new transcript;
  - a job finishing while the target file loads starts no turn;
  - a same-session reload, a declined cwd change, and a fallback callback that throws all keep the job running.
- Negative controls: with the fix reverted, the cancel test fails (`completed`, not `cancelled`); without the transition hold, the mid-switch test fails; with the cancel at its first position (before the agent reconnects), the fallback rollback test fails.
- 98 test files touching session switches, `newSession`, tree navigation or the yield queue: 2160 pass. The 3 `agent-session-message-pipeline` failures also fail on `main`; one GC-timing test (`prefix-binding-tool-roster`) failed once under that load and passes alone.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
