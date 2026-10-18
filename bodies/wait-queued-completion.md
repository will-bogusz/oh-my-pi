## What

I kept hitting `wait` erroring out right after the job it was waiting for finished, so now it hands back that job's result instead of a skip.

When a background job finishes while the model streams a `wait` call, `wait` failed in under 10 ms with `Skipped due to a queued background completion…` (`isError: true`) and the job's notice was injected after it; the model then retried `wait` (`Nothing to wait for…`) or polled with `bash`. In my sessions since Oct 14 that was 156 of 2,229 `wait` calls (7%). Now that `wait` returns the finished job (`## Completed (1)` with its output), and the queued notice is dropped as delivered.

**Beyond the fix:** a steer, peer message or queued aside that aborts the same refresh (below) now ends the wait the way it does on `main` when it lands just after the refresh: with a waiting peer message or a settled job of yours if there is one, else the same skip as before.

## Why

A queued completion hard-aborts interruptible tools (`checkAsideInterrupts` in `agent-loop.ts`). `WaitTool.execute` returns waiting peer messages and undelivered completions of the caller's jobs, but first refreshes owned services through the broker with the call's signal (`listServicesTolerant`), which rethrows on abort. The notice of an already-finished job aborts that refresh within a millisecond, so `wait` threw before its own checks and the loop recorded the skip.

The fix is in `wait.ts` only: when the refresh aborts with `TOOL_INTERRUPT_ABORT_REASON`, `wait` still runs those two checks, and throws the abort only if neither finds anything. The agent loop, `vibe_wait` and user aborts are unchanged.

Non-goals: a `wait` the loop skips before it starts, batched behind another call (`write`, then `wait`; 25 of the 156), since running it is a loop policy change that would also run `vibe_wait` under an aborted signal; and supervised-service exit notices, which are not jobs and still skip.

## Testing

- Live on `anthropic/claude-haiku-5-5` (`omp -p`, default `launch.enabled`): an `async` bash `sleep 0.1; echo payload-731`, then a lone `wait`. `main`: 3 of 3 runs skipped the `wait` (8 ms, `isError: true`), notice injected after it. This PR: 5 of 5 returned `## Completed (1)` with `payload-731`, no notice followed.
- `agent-session-consumed-completion-peek.test.ts`: real `AgentSession` and agent loop, mock model; the job finishes while the model streams `wait`, and the broker list rejects on abort like the real client. Fails on `main` (`isError` true), passes here.
- `tools/wait.test.ts`, refresh aborted by an interrupt: a settled job and a peer message that arrived during the refresh are returned (both fail on `main`); with only running jobs the wait still rejects.
- Focused `bun test` of the wait, aside-delivery, skip-render, `vibe/wait` and `async` suites; `bun run check:ts`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
