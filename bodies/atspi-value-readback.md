## What

I saw that on Linux, `setValue` with a number told the agent it worked whenever the app answered the write, even when the slider clamped 150 to 100 or kept its old value; now it reads the value back, the way text writes already do since #18220, and fails naming what the control holds.

On a 0–100 GTK 3 scale and a Qt 5 slider, a write of 150 reads back as 100 and a Qt write of 37.5 reads back as 38, each answered without an error; those writes now fail with what the control holds instead of reporting success.

## Why

AT-SPI `setValue` with a number sets `org.a11y.atspi.Value.CurrentValue` and the app answers the property write whether or not it took the number. A toolkit clamps it to the control's range, rounds it to its step, or ignores it, and the call still reported success, so an agent that set a volume to 150 or a spin box to 37.5 went on with a value the control does not hold. #18220 closed the same gap for text.

Shape (`write_value` in `crates/pi-natives/src/desktop/linux/ax.rs`):
- After the write, it reads `CurrentValue` back through a `ValueProxy` built without a property cache, so no `GetAll` is sent (the cached proxy `set_value` used before sent one, and `GetAll` crashes Qt 6 before 6.9.2, QTBUG-137344).
- Equal within float precision passes (a toolkit storing `float` reads 0.3 back as 0.30000001192092896). Otherwise it retries for up to 500 ms, for a toolkit that applies the write a moment after answering, then fails: "wrote 150; the control now reads 100 (its range is 0 to 100). The app may have clamped, rounded or not taken it: inspect the target before writing again". The range is named only when the written value lies outside it.
- A value that matches on the first read returns at once; only a mismatch waits.

Elements with `EditableText` (GTK 3 spin buttons) still take numbers through the text path, unchanged. macOS and Windows are untouched.

## Testing

- `a_numeric_write_the_app_clamps_or_ignores_fails` serves `org.a11y.atspi.Value` over a peer-to-peer D-Bus connection with controls that take the write, take it from the second read on, store it as `float`, clamp it to 0–100, ignore it, or clamp without reporting a range. With the read-back removed (the parent's behaviour) it fails at the clamped control, whose write returns `Ok(())`.
- What toolkits do with the write (goliath KVM guest, Ubuntu 24.04; `CurrentValue` set from `pyatspi` on a 0–100 slider, step 1, read back at once and again 0.5 s later, same both times): a GTK 3 `Gtk.Scale` read 150 back as 100, -5 as 0, and kept 37 and 37.5; a Qt 5 `QSlider` read 150 back as 100, -5 as 0, 37.5 as 38, and kept 37. Each of those writes was answered without an error, which is all `main` checks.
- `cargo test -p pi-natives --lib desktop::linux` on current main bcd5b0b996e (goliath): 100 passed, 30 ignored, including `a_numeric_write_the_app_clamps_or_ignores_fails`; `scripts/rust-check --base bcd5b0b996e` passed on Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
