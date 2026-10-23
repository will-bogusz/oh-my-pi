## What

I made a relay tab's worker take one more round trip before it reports that a session closed under a call, so when Chrome detaches omp mid-call the agent hears that instead of a bare `Target closed`.

When Chrome detaches omp from a relay tab while a call is working in a cross-site frame (an embedded sign-in form), the call now fails with the message a call in the page itself already gets: Chrome detached omp, the likely cause, that its input may have landed, and whether omp reattached the tab. On `main` it fails with `TargetCloseError: Protocol error (Runtime.callFunctionOn): Target closed`, and the next call meets a reattached tab whose element ids are gone (`Unknown element id 2`) or a released one, with nothing having said either.

In `TabWorker#run`, a run that failed with puppeteer's `TargetCloseError` (a session closed under its command) sends `Target.getTargetInfo` on the page's own session, bounded at 500 ms (inside the supervisor's 750 ms grace), and answers only if the relay's `OMP.debuggerDetached` has not answered the run meanwhile.

## Why

Chrome ends the cross-site frame's session a moment before it ends the tab's attachment. The relay forwards the frame's `Target.detachedFromTarget` at once, puppeteer rejects the frame's command, and the worker answered the run before `OMP.debuggerDetached` arrived, so the detach handling `main` already has for calls in the page never reached this one. Chrome reports the detach to the relay extension before it answers a later command, and the relay sends its event ahead of that answer on the worker's socket, so one page command puts the report first.

Holding the frame's detach in the bridge instead was rejected: nothing in a frame detach says a tab detach follows (Chrome never answers a command pending on a frame that was removed or navigated away), so every such hold would run to its timeout and could reorder the frame's detach and re-attach.

Cost: one page command on a run that already failed because a session closed under it.

## Testing

- `bun test packages/coding-agent/test/tools/browser-relay-detach.test.ts`: the new case opens a page with a cross-site frame, hangs a call in that frame, and detaches the way Chrome does (frame session, the command in flight, then the detach report). On `main` it fails with `TargetCloseError: Protocol error (Runtime.callFunctionOn): Target closed`; with this PR it passes, 5 of 5 runs and the other 10 still pass. The test's stand-in extension now sends its detach report before handling any later request, the order measured in Chrome for Testing 154 (frame session detach, `onDetach`, failure of the pending command, all in one millisecond).
- Live, relay harness with Chrome for Testing 154 and a test extension that opens a `chrome-extension://` menu frame beside a focused password field inside a cross-site frame: the fill's error changed from `Target closed` to `Chrome detached omp from this tab (target_closed) during this call; ...`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
