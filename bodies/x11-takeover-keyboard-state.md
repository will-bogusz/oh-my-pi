## What

With Caps Lock on, a sticky modifier latched, or my second keyboard layout active, I watched omp's takeover typing on X11 come out wrong (`AbC1x` typed as `aBc1X`) while it reported success; now omp clears those for the length of the text and puts my locks and layout back afterwards.

## Why

Takeover and `desktop` typing send keys through `XTest`, which the server interprets through the core keyboard's XKB state, the same state the user's own keys set. omp plans each character on the first layout group's plain and shifted levels (`keymap.rs`), so:
- Caps Lock inverts the case of every letter: `type("AbC1x")` arrived as `aBc1X` in a GTK 3 entry, on US and DE layouts alike, with the call reporting success.
- A StickyKeys-latched or locked Control turns the first letter into a shortcut.
- With a second layout group active (`us,ru`, group 2), keys type that layout's characters.

`NeutralKeyboard` (`crates/pi-natives/src/desktop/linux/x11/keyboard_state.rs`) clears locked and latched modifiers other than Num Lock and the locked and latched group before a text run in `X11Input::xtest_steps`, refusing with nothing sent if the server keeps any, and restores the locks and group afterwards. Chords and holds keep the user's state, so a `CapsLock` chord still toggles Caps Lock.

<details><summary>Restore rules</summary>

- `restore` re-locks only modifiers that are still clear, and the group only while it is still the first, so a Caps Lock or layout switch the user made during the run stands. A latch is not put back: the run's first key would have used it. A failed restore is reported.
- A latched Control still applies to `key("a")` as before; only text, where the characters are the contract, is neutralised.
- Num Lock is left alone: it changes only keypad keys, which no text plan uses.

</details>

Mapping the characters through the user's state instead was rejected: it cannot undo a latched Control, and it needs Caps Lock versus Shift Lock rules and a keysym table per group.

Visible effect: the Caps Lock LED and a panel's layout indicator flip off and back on around each text run with a non-neutral state, and `XkbStateNotify` events go out for both changes. If omp is killed mid-run, the locks and group stay cleared (no key stays held).

## Testing

The GTK measurements below predate the current-main rebase. The latched-group regression had not passed before this rerun; it exposed and now covers an additive XKB group-latch request.

goliath, Xvfb + openbox, a GTK 3 entry focused, takeover `type("AbC1x")` through omp's own `X11Input`; every `main` row returned success:

| keyboard state | `main` | This PR |
|---|---|---|
| none (US) | `AbC1x` 3 / 3 | `AbC1x` 3 / 3 |
| Caps Lock (US) | `aBc1X` 3 / 3 | `AbC1x` 33 / 33 |
| latched Control (StickyKeys) | `bC1x` 3 / 3 (Control+A, then the rest) | `AbC1x` 33 / 33 |
| `us,ru` with group 2 active | `ФиС1ч` 3 / 3 | `AbC1x` 33 / 33 |
| `us,ru` group 2 and Caps Lock | `фИс1Ч` 2 / 2 | `AbC1x` 2 / 2 |
| DE layout, Caps Lock | `aBc1X` 2 / 2 | `AbC1x` 2 / 2 |

Rerun on a second rig (Ubuntu 22.04 arm64, Xvfb + openbox, GTK 3 and Qt 5 fixtures, Caps Lock on, n=10 each): `main` typed inverted case and reported success 20/20; this PR typed the exact text 20/20.

After each run the user's state read back as before it (Caps Lock and group 2 still locked); a latched Control was used up, as the user's next key would have used it.

- `xtest_text_types_through_a_neutral_keyboard_state` (`#[ignore]`, starts its own Xvfb): with Caps Lock and Control locked and group 2 locked, no key event carries Lock, Control or a group and the user's locks and group are back afterwards; a latched group is cleared and stays used up; a `CapsLock` chord still turns Caps Lock off.
- Re-run on current main (`9f728bd56e1`), Xvfb 21.1.12: the latched-group test failed 10/10 before subtracting the observed group latch and passed 10/10 after; locked-group restoration passed in the same runs. A libX11-injected latched Control also cleared correctly in 10/10 runs.
- Linux `scripts/rust-check` passed; `cargo test -p pi-natives --lib desktop::linux::x11 -- --include-ignored --test-threads=1` passed 62 tests when excluding the two MPX/uinput hotplug tests that fail identically on main under Xvfb (no udev/libinput hotplug).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
