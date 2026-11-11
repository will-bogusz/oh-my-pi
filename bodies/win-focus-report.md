## What

I made Windows takeovers say where focus went afterwards, the way macOS already does, instead of always saying focus was not confirmed.

The foreground guard that runs every Windows takeover already knows the user's window before the takeover and whether it handed the foreground back. It now records that as the call's focus report: `handed_back`, the process that was in front before, and the process in front after restoring. The host's existing wording then reads "focus returned to Windows Explorer", "focus stayed on Chrome", or names the third app that took it.

A takeover where the target was already in front reports `handed_back: false`, since nothing was handed back.

## Why

Issue #18298 (problem 1): every successful Windows fallback takeover ended with "focus was not confirmed afterwards", because only the macOS backend recorded a focus report. A model reading that line cannot tell whether the user's window has the keyboard again, so it either re-checks every time or ignores the line.

Element takeover only hands focus back since the element takeover focus fix; before it, this report would have said, truthfully, that focus stayed on the target.

## Testing

- `element_takeover_hands_the_foreground_back_to_the_users_window` (Windows desktop test, `#[ignore]`d because it opens two windows and moves the foreground) now also asserts the report: handed back with both pids for a takeover from the user's window, `handed_back: false` when the target was already in front. Run from a focused terminal: `cargo test -p pi-natives element_takeover -- --ignored`. On the Windows 11 guest it fails with this change's recording reverted (no report after the first `type`) and passes on this branch.
- Windows 11 guest, a Chrome field with Explorer as the user's window, 12 alternating `el.type` / `el.press` takeovers: `main` says "focus was not confirmed afterwards" 12 of 12 times; this branch says "focus returned to Windows Explorer" 12 of 12 times, and Explorer was in front after each call.
- `rust-check` on Windows, Linux and macOS (the report type's doc comment is shared): clippy and rustfmt clean.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated
