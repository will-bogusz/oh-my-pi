## What

On Windows a `computer` takeover could grab the foreground in the middle of my typing, and my keys would go into the agent's target window instead of mine, so now it waits until I pause before it takes over.

This changes only when a takeover starts: as on `main`, typing does not stop one that is already running.

On Windows 11, across 40 trials per build with the person typing as the call starts, their key events reaching the target go from 96 to 0, Space key events among them from 21 to 0.

| Windows 11 guest, 20 trials per row (10 click, 10 type) unless noted | v19.0.1 | this PR |
|---|---|---|
| Person typing as the call starts, default route | 50 key events reach the target, 10 of them Space; click 0.24 s, type 0.47 s median | 0 key events; 6.4 s median for both |
| Same, `takeover: true` | 46 key events, 11 Space; 0.21 s / 0.47 s | 0 key events; 6.4 s |
| Person idle for 6 s | 0.27 s / 0.47 s | 0.28 s / 0.46 s |
| Person only moving the mouse as the call starts (15 moves, no keys or clicks) | 0.23 s / 0.43 s | 5.3 s / 5.3 s; 18 of 20 ran, 2 refused by Windows, none `Timeout` or `UserIntervened` |
| Idle, a second takeover right after the first in the same process (10 click pairs, second click timed) | 0.26 s | 0.26 s: no extra wait for the first click's input |

## Why

- Admission, as on macOS and X11: a window or element takeover waits until the session has had no input for 5 s and no mouse button or modifier reads as held, up to the call's deadline, else `UserIntervened` with nothing sent (`Timeout` when only the deadline stopped it). It rechecks under the input lease and once more as the target comes forward, after an element's window was found. Explicit `takeover: true` and the default fallback rerun both go through it.
- **What watches the person.** `GetLastInputInfo` (the session's newest input time, from any program) and the down state of mouse buttons and modifiers. Nothing is registered and no hook or thread is added; `main`'s `WH_KEYBOARD_LL` Escape monitor is unchanged.
- **OMP's own input.** Windows dates this process's `SendInput` there too. Each send that inserts input reads the date it is about to overwrite and records its window, from just before that reading to the end of the send; the first new date read inside a window of at most 50 ms is OMP's. A new date older than the previous reading, or ahead of the clock (programs may date their injected input), counts as input at that reading.

<details><summary>Reading order, limits, maintenance</summary>

- Read `win32/activity.rs` (`History::read`, `History::sending`, `admit_with`, `activating_with`), then `Win32Backend::admit_takeover` in `win32/mod.rs` and the `activity::sending()` / `activity::activating()` calls in `win32/input.rs`.
- Limits:
  - Moving the mouse postpones a takeover, at most until its deadline: pointer moves count as input, as does other programs' injected input, another OMP process's included.
  - A key pressed in the instant OMP sends its own input can be missed (a send window longer than 50 ms counts as the person's instead).
  - Typing does not stop a running takeover; physical Escape and cancellation still can. On v19.0.1, a person who started typing 50 ms into a long typed line lost 44 characters into the target over 15 calls; this PR does not change that case.
  - Even a call Windows will refuse waits for the pause first.
- Maintenance: a new `SendInput` site in `win32` must go through `activity::sending()`, or its input reads as the person's and the next takeover waits 5 s.

</details>

## Testing

Windows 11 guest, v19.0.1 (release natives) against an addon of this branch at 1abbc33c67d (build hash checked on install; this head differs from it only in one error message's wording and the prompt line), two interleaved rounds per build; WPF target, the person's keys and pointer moves sent as real QEMU input to their own window. Windows refused to activate the target in 11 of 90 v19.0.1 trials and 12 of 90 here (`InputFailed`, nothing sent; a click pair counts its second call); the table counts every trial. The baseline is v19.0.1, not this branch's merge base.

`rust-check` passed on Linux, Windows MSVC and macOS at this head. `bun check` fails on `main` at formatting (20 TS files, `crates/edit/tests/sloppy_parse.rs`) and fails the same way here; `check:types` for coding-agent and natives passes. The prompt's `UserIntervened` sentence now names Windows; no instruction changed, no model sample run.

Units (`cargo test -p omp-natives --lib desktop::win32::activity`, run on macOS) with injected clock and tick values; each row added for a review finding fails with that fix reverted. The functions they test have no Windows-only path (each Win32 read is a `cfg(windows)` wrapper passed in as a closure), and the Windows `rust-check` (clippy on all targets) checks these tests against MSVC.

<details><summary>Unit rows</summary>

Own-send attribution (inside, both ends, one tick either side, over 50 ms, across `GetTickCount`'s wrap, ahead of the clock), a send descheduled before or after its reading, a send without a reading, a new date older than the last reading, late-registered input around a send, activation after admission (input, held button, no time left), and admission's wait, held-button, deadline and overrun rows.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
