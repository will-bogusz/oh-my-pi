## What

My #18012 left a race in the Wayland tests: `a_desktop_without_a_remote_desktop_portal_reports_and_refuses_input` fails at random when the suite runs in parallel, so I made it unset `LIBEI_SOCKET` under the lock the other env tests already hold.

- `wayland/mod.rs` (tests only): new `without_libei_socket` takes `LIBEI_ENV_LOCK`, removes `LIBEI_SOCKET`, runs the test and restores the previous value. The no-portal test runs inside it. No runtime code changes.

## Why

#18012 made `input_unavailable()` read `LIBEI_SOCKET` on every call, so a socket set later in a session still reaches EIS. This test caches a missing portal and expects `capabilities().input` to be `false`, but it never took `LIBEI_ENV_LOCK`. While a `with_fake_libei` test on another thread had the variable set, the check saw a socket and reported input as reachable. A queue rebase hit it on Linux: 636 passed, 1 failed (`assertion failed: !capabilities.input`); a serial rerun passed.

## Testing

| `LIBEI_SOCKET=/nonexistent`, this test alone | `main` | this PR |
|---|---|---|
| Result | `assertion failed: !capabilities.input` (mod.rs:576) | passes |

- That is the race made deterministic: the env value a concurrent `with_fake_libei` test sets. With the variable unset, `main` passes too.
- `cargo test -p pi-natives --lib -- desktop::linux::wayland` with `LIBEI_SOCKET` set: 38/38. `scripts/rust-check` on Linux: clean. The code is Linux-only.
- A 300-run parallel loop never hit the race on `main` either, so it is not cited as proof.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
