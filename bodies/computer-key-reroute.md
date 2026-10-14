## What

I keep typing in my own app while the agent works in one behind it, and when that app popped a menu open or jumped forward mid-action my keys went into it or vanished into the menu; now they land where I'm typing.

On macOS, while a background action runs, a target that takes the keyboard without the user choosing it no longer gets the user's keystrokes: omp posts them to the user's app and drops the originals until the user's app has the keyboard back. A key's repeats and release go where its press went.

| While the agent works in app B behind app A, the user types in A | `main` | this PR |
|---|---|---|
| B's context menu opens (`AXShowMenu`) and keeps the keyboard | 177 of 400 keys lost in the menu, 10/10 runs | 400/400 in A |
| B activates itself (a button calling `activate`) | 400/400 in A | 400/400 in A, nothing moved |
| User ⌘-Tabs to B mid-action | keys follow the user to B | unchanged, 0 moved |
| Password field focused in A (secure input) | — | never tapped |

> **macOS context.** *Key focus* is the process WindowServer sends keystrokes to. A menu or popover takes it while its app stays behind the user's.

Reading order (`macos/key_reroute.rs`): `Theft::notify` (who holds the keyboard), `Theft::route` (which keys move), `KeyReroute::arm` (the taps and their lifetime); then the one line in `skylight.rs::with_background_guard`.

## Why

The focus guard puts A back in front, but until it does, and while a menu B opened stays open, WindowServer sends the user's keys to B, and a menu eats them.

During each guarded action a listen-only tap reads WindowServer's front-app and key-focus notifications, and an active tap on B's process moves the user's keys. Nothing moves after a mouse button, ⌘ or ⌃ within 250 ms of B coming forward, a Spotlight-style panel, or a key pressed during secure keyboard entry; omp's own keys never move. The taps outlive the action while B still holds the keyboard (at most 30 s) or a moved key is still down.

- **Rejected: deciding each key-up on its own.** When B gives the keyboard back between a key's press and release, WindowServer still sends the release to B: an earlier head that did this left B a key-up without its key-down in 36 of 70 runs below.
- **Rejected: closing the menu.** Releasing B's key focus from omp's process (`SLPSReleaseKeyFocusWithID`) fails with error 1003.

Risk: while an action runs, every key to B passes an active tap in omp (callback median 1.2 µs passed through, 27 µs moved).

Maintenance: the notification event (type 21) and its fields 40/64/73 are undocumented, checked on macOS 26.5. If they change, no theft is seen and keys behave as on `main`; the menu case losing keys again would show it.

## Testing

A macOS 26.5 VM; the VNC keyboard types 40 keys into A while a computer-tool cell acts on B, 10 runs per case per arm, on a build with our other open macOS computer-use changes:

| Case | earlier head: keys in A; runs where B got a key-up without its key-down | this PR |
|---|---|---|
| B's context menu (`AXShowMenu`) | 400/400; 6/10 | 400/400; 0/10 |
| Context-menu `menu:` choice | 400/400; 7/10 | 400/400; 0/10 |
| Popup `setValue` | 400/400; 6/10 | 400/400; 0/10 |
| Popup `menu:` path | 400/400; 4/10 | 400/400; 0/10 |
| ⌘-click a link in Chrome B | 400/400; A missed a key-up in 2/10 | 400/400; 0/10 |
| B activates itself | 400/400; 2/10 | 400/400; 0/10 |
| Menu, then 16 s with no action (A = receiver / Terminal) | 1500/1500 each; 11/20 | 1500/1500 each; 0/20 |
| User ⌘-Tabs to B | 0 moved (9 valid) | 0 moved |
| Password field in A | 400/400 | 400/400 |

While no action ran (5 idle checks, about 135 keys per run), neither arm touched a key and key-event age matched: receiver median 0.79–0.89 ms in both. The What table: same rig, `main` against an earlier head.

`key_reroute.rs` has 19 rule tests; reverting the press/release pairing fails 8. `CI=1 bun run check:rs` and `bun check` pass; `cargo test -p pi-natives --lib` passes except `emergency_stop_revokes_idle_task_control_after_retirement`, which fails the same way without this change and passes alone.

Not run: a hardware keyboard; Chrome or Electron as A.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
