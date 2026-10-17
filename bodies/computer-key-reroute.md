## What

I keep typing in my own app while the agent works in one behind it, and when that app popped a menu open or jumped forward mid-action my keys went into it or vanished into the menu; now they land where I'm typing.

A context menu the agent's target opens during a background action: with the rest of the series merged, 390 of 400 of the user's keys reached their app, one lost in every run (10/10) → 400/400, none lost (0/10).

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/6b6a0278-d2ff-4cf9-b075-9d1a5a305ea0">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/fa6856c2-4067-4728-87b2-b78d9c072f4f">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/8e8598f6-1efe-4b10-be3e-381b6fb45a92">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/96f8f1f8-76ff-439b-a763-cad517ec845b">
  <img width="780" alt="Routing diagram. Each of your keys that reaches app B while the agent's background action in B runs gets one check: did B take the keyboard without you choosing it (no click since the action began, no ⌘/⌃ in the 250 ms before, no Spotlight-style panel, no secure entry, not omp's own key)? Yes: the key is posted to your app and the original dropped, 27 µs a key. No: it passes to B unchanged, 1.4 µs a key (costs timed on an earlier prototype's handler; the current handler was not retimed). A key's repeats and release follow its press." src="https://github.com/user-attachments/assets/fa6856c2-4067-4728-87b2-b78d9c072f4f" />
</picture>

> **macOS context.** *Key focus* is the process WindowServer sends keystrokes to. A menu or popover takes it while its app stays behind the user's.

Reading order (`macos/key_reroute.rs`): `Theft::notify` (who holds the keyboard), `Theft::route` (which keys move), `KeyReroute::arm` (the taps and their lifetime); then the one line in `skylight.rs::with_background_guard`.

## Why

The focus guard puts the user's app back in front, but until it does, and while a menu the target opened stays open, WindowServer sends the user's keys to the target, and a menu eats them.

During each guarded action a listen-only tap reads WindowServer's front-app and key-focus notifications, and an active tap on the target's process moves the user's keys.

- **Rejected: deciding each key-up on its own.** When the target gives the keyboard back between a key's press and release, WindowServer still sends the release to it: an earlier version that did this left the target a key-up without its key-down in 36 runs below.
- **Rejected: closing the menu.** Releasing the target's key focus from omp's process (`SLPSReleaseKeyFocusWithID`) fails with error 1003.

Risk: while an action runs, every key to the target passes an active tap in omp (the costs above, from an earlier prototype's handler, not retimed; its slowest moved key took 402 µs).

Maintenance: the notification event (type 21) and its fields 40/64/73 are undocumented, checked on macOS 26.5. If they change, no theft is seen and keys behave as without this change; the menu case losing keys again would show it.

## Testing

A macOS 26.5 VM; the VNC keyboard types 40 keys into A while a computer-tool cell acts on B, 10 runs per case per arm (menu-then-idle rows: 150 keys a run; without this change, those, ⌘-Tab and password ran 5 runs, ⌘-click 9 valid):

| Case | without this change: keys in A (runs with a loss) | earlier version: runs where B got a key-up without its key-down | this change: keys in A; such runs |
|---|---|---|---|
| B's context menu (`AXShowMenu`) | 390/400 (10/10) | 6/10 | 400/400; 0/10 |
| Context-menu `menu:` choice | 392/400 (8/10) | 7/10 | 400/400; 0/10 |
| Popup `setValue` | 397/400 (3/10) | 6/10 | 400/400; 0/10 |
| Popup `menu:` path | 392/400 (8/10) | 4/10 | 400/400; 0/10 |
| ⌘-click a link in Chrome B | 346/360, 14 into Chrome (8/9) | A missed a key-up in 2/10 | 400/400; 0/10 |
| B activates itself | 399/400 (1/10) | 2/10 | 400/400; 0/10 |
| Menu, then 16 s with no action (A = receiver / Terminal) | 749/750 / 746/750 (1/5, 4/5) | 6/10 / 5/10 | 1500/1500 each; 0/20 |
| User ⌘-Tabs to B | 0 moved | — | 0 moved |
| Password field in A | 200/200 | — | 400/400 |

On the restacked series build with this change, n=5 per case: every theft case 200/200 in A, no key row of the user's reached B, ⌘-Tab still ends the action with `UserIntervened` 5/5.

With no action running (idle checks, about 135 keys per run), this change touched no key and key-event age in the receiver matched: median 0.80–0.89 ms, against 0.79–0.82 ms for the earlier version.

<details><summary>Builds and sources</summary>

- "Without this change" is the series merged on 10-13 (`0e8209b76a`); its "earlier version" column and the K13 arm are `dac88c543b`; "this change" is `24f729f0ce`, whose `key_reroute.rs` matches the queued head byte for byte outside its tests. Menu-then-idle rows ran 5 runs without this change, 10 with. Restacked series build: `24b3e98177`.
- Cost on the routes: median time in the tap's handler over the stacked runs of a measurement build (`58e204ce`): user keys passed 1.4 µs (n=335, p95 2.2 µs), moved 27 µs (n=55, p95 352 µs, max 402 µs); omp's own keys pass in 1.2 µs (n=3,000).

</details>

`key_reroute.rs` has 19 rule tests; reverting the press/release pairing fails 8. `CI=1 bun run check:rs` and `bun check` pass; `cargo test -p pi-natives --lib` passes except `emergency_stop_revokes_idle_task_control_after_retirement`, which fails the same way without this change and passes alone.

Not run: a hardware keyboard; Chrome or Electron as A.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
