## What

I run the native tests on my Mac, and on `main` a full `cargo test -p pi-natives --lib` fails every time: `desktop::control::tests::emergency_stop_revokes_idle_task_control_after_retirement` panics with `test kernel owner: InputBusy`. This makes the desktop worker tests wait for the same lock the ownership tests already share, so the full run passes. Tests only; no product code changes.

## Why

The ownership tests in `desktop::control` hold `OWNERSHIP_TEST` while they take and assert on this process's one input lease (`KernelOwner`, `ProcessLease`). The worker tests in `desktop::capture_tests` send input through `Worker::execute`, which takes that same lease without the lock. Run together, one of them loses: on a macOS host it's the emergency-stop test, every time. Running just that test and `desktop::capture_tests` reproduces it; either alone passes.

- `OWNERSHIP_TEST` moves out of `control::tests` to a `#[cfg(test)] pub(crate)` static beside the lease it guards.
- `capture_tests::worker_with` returns a `TestWorker` that holds the guard for the test and derefs to `Worker`.
- Tests that serve a worker on a thread (display-awake, and #15414's hung requests) send it no input and time their calls, so they use `unlocked_worker`; waiting for the lock inside a timed call failed `a_timed_out_call_releases_the_display_while_its_request_hangs`.

## Testing

Full `cargo test -p pi-natives --lib` on a macOS 26 host:

| | runs passing |
|---|---|
| `main` (818dd42b73) | 0/3 (542 passed, 1 failed each) |
| #15414 before its rebase onto `main` (e031530484) | 0/3 (529 passed, 1 failed each) |
| this PR before the rebase (b040ba5f58) | 3/3 (530 passed) |
| that head merged into `main` | 3/3 (546 passed) |
| this PR rebased onto `main` (d50a7d2191) | 1/1 (548 passed) |

`CI=1 bun check` passes. Not run: Linux and Windows. The changed code is test-only and has no platform gates.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)




