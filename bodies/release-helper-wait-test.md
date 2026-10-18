## What

I'm making one macOS release-helper test stop failing at random on a busy Mac: it waited 500 ms for a stand-in helper that is a shell script, and starting a shell under a parallel test run sometimes takes longer than that.

`release_guard::tests::a_request_waits_for_its_helper_to_exit_with_or_without_presses_open` checks that a call waits for its helper to exit. Its stand-in (`cat`, then `sleep 0.15`) has to start, read its stream and exit inside `EXIT_TIMEOUT`; under load it did not, and the test failed with "the helper released and exited first".

## Why

- **Pass the wait in, rather than change it for every test.** The wait is now a field of the request, set by a new `scope_waiting`. Production `scope` and `scope_with` still pass `EXIT_TIMEOUT` (500 ms), and only this test waits 10 s for its shell.
- **The 500 ms bound stays tested.** `a_request_with_nothing_open_stops_a_helper_that_outlasts_the_wait` runs on `EXIT_TIMEOUT` with a helper that never exits, so its outcome does not depend on load.
- **What production does past 500 ms** is unchanged and now written on `EXIT_TIMEOUT`: a helper with presses still open keeps its share of input ownership until it exits within its 2 s release deadline; one with nothing open is stopped and reaped.

No CHANGELOG line: test-only.

## Testing

Runs of the test binary on an Apple silicon Mac running macOS 26, 20 per row, main 4e94436137 against this branch:

| How the test ran | main | this PR |
|---|---|---|
| alone (`--exact`) | 0/20 failed | 0/20 failed |
| with the other `desktop::macos::` tests | 6/20 failed | 0/20 failed |
| same, with two more `desktop::` runs alongside | 1/20 failed | 0/20 failed |

Every failure on main is the "released and exited first" assertion. Load averages were 7–12 during the suite runs. `cargo test -p pi-natives --lib` (903 passed) and `CI=1 bun check` pass on the branch.

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
