## What

Driving my phone through iPhone Mirroring in takeover mode, typing kept losing Shift and whole runs of letters after one Delete, and sometimes Finder jumped to the front mid-sentence; this makes those keys carry only the modifiers they actually hold.

On the phone, takeover typing went from exact in 3 of 6 trials on `main` to 6 of 6, and chords and a held Shift went from 3/6 and 0/6 to 6/6.

| Takeover check, phone via iPhone Mirroring | `main` | this PR |
|---|---|---|
| `typeText` "Full Keyboard Access: Hello Will, 11:00!" | 3/6 exact, each miss "full k" then a lost-focus stop | 6/6 |
| `keyChord` Shift+A, Option+C, Shift+1 → "Aç!" | 3/6 ("ç1": Shift lost) | 6/6 |
| `holdKeys(["shift"])`, then background "abc" | 0/6 (nothing lands) | 6/6 |
| "ab", Left, "X" | "Axb": X lost Shift after the arrow | "AXb" (iOS capitalizes the first letter) |
| Front app after the run | Finder in 3 of 3 runs | the app that was in front |

**Unchanged:** Cmd+A then Delete and a held letter pass 6/6 on both, typing takes 305-311 ms per character on both, and background input does not go through this path.

> **Context.** For a remote screen (iPhone Mirroring, Screen Sharing), takeover types *bare* keys: null-source events at the HID tap, so the remote side reads modifiers from real key transitions. CoreGraphics gives such an event the HID state's flags plus the key's own marks (Fn for Delete, arrows and F-keys; Fn and Help for Insert), and posting it makes its flags the state.

So one takeover Delete left Fn (Globe) held for every later bare key, across calls, until the user's next keyboard or mouse input. On the phone Shift+F typed "f" and the letters from the next E on were lost. A later Space brought Finder to the front, so input stopped with "lost exact keyboard focus" and focus was not handed back.

## Why

`post_bare` now sets each event's flags to the modifier keys its own run holds (`BareModifiers`, from the side table in `release.rs`), passing Caps Lock and the other derived bits through. With a clean state, modifier and letter events are bit-for-bit `main`'s. What no longer reaches the remote screen: the key marks, and a modifier the user physically holds, as on the other takeover paths, which already post explicit flags.

Rejected: posting a Fn key-up after each marked key. It still leaves the mark on the key's own press, where the remote screen reads Globe held.

Maintenance: if a macOS release adds another per-key mark, it would stick the same way. `bare_keys_carry_only_the_modifiers_they_hold` models CoreGraphics' derivation, so the new bit goes into `BareModifiers::STATE`.

## Testing

- **Live, iPhone 16 Pro over iPhone Mirroring, macOS 26.1.** Builds alternated, 3 runs of 2 trials each, two starting with the terminal in front and one with Finder. A listen-only HID-tap monitor saw the state hold Fn (`0x800000`) from the first takeover Delete on with `main`, and never past the first key with this PR. One earlier pair is left out: user input during `main`, and the page receiving nothing in the PR's first trial right after a reconnect (its second trial passed all 5 checks).
- `cargo test -p pi-natives --lib bare_keys`: fails on `main`'s behaviour (Fn on the Shift press, Shift lost when other input replaces the state, Help left after Insert) and passes with the fix. `rust-check` passes on macOS and Linux.
- Not run: Screen Sharing (no remote Mac here). Its modifier transitions post the same flags as on `main`; Delete and arrows now go out without Fn.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
