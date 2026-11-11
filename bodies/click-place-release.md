## What

I found that clicking in my own app could leave the omp background target in front: a menu-bar drag, a resize or selection ending over the target, or a click just before the session's first action, every time. This places each click from the event itself, so my app comes back unless I picked the target.

Guard A/B, macOS 26.5 VM, n=10; the replacement cells ran before the disabled-tap flag was added (that flag has two unit tests only): trials where my app ended in front, or the target stayed when picked; a trial counts when the target came forward 0-250 ms after my last button event (timed by a guest tap).

| Case | Picked the target? | `main` | previous head of this PR | this PR |
|---|---|---|---|---|
| click in my app | no | 10/10 | 10/10 | 10/10 |
| drag across my app's menu bar | no | 0/10 | 0/10 | **10/10** |
| resize ending over the target | no | 0/10 | 0/10 | **10/10** |
| text selection ending over the target | no | 0/10 | 0/10 | **9/9** |
| click in my app just before the session's first action | no | 0/10 | 0/10 | **10/10** |
| drag and drop onto the target | yes | 8/9 | 10/10 | 10/10 |
| Dock pick | yes | 10/10 | 10/10 | 10/10 |
| Dock pick just before the session's first action | yes | 10/10 | 10/10 | 10/10 |
| remote tool posting at the HID tap: click in my app | no | 10/10 | 10/10 | 10/10 |
| remote tool posting at the session tap: click in my app | no | 9/9 | 10/10 | 10/10 |
| remote tool posting at the HID tap: click on the target | yes | 10/10 | 10/10 | 10/10 |
| remote tool posting at the session tap: click on the target | yes | 0/10 | 0/10 | 0/10 |
| my app's middle click swallowed by a remapper at the HID tap | no | 10/10 | 10/10 | 10/10 |
| my app's middle click swallowed by a remapper at the session tap | no | 10/10 | 10/10 | **10/10** |
| click in my app while its main thread is blocked | no | 0/10 | 0/10 | 0/10 |
| click in my app while it is stopped (SIGSTOP) | no | 0/10 | 0/10 | 0/10 |
| no event-listening access: click in my app | no | 10/10 | 0/10 | 10/10 |
| no event-listening access: menu-bar drag | no | 1/10 | 0/10 | 0/10 |
| no event-listening access: blocked app | no | 0/10 | 0/10 | 0/10 |
| no event-listening access: Dock pick | yes | 10/10 | 10/10 | 10/10 |

A press goes where `WindowServer` routed it (`kCGEventTargetUnixProcessID`, read by `main`'s annotated user-input tap, which now also takes releases). A release keeps its press's place unless the drag pasteboard changed meanwhile (a real drop), and then goes to the owner of the window it was released over. No accessibility query takes part.

## Why

`main` hit-tests the pointer after the event: that blocks, fails in a busy app and misplaces releases over the menu bar or past the window edge; any such answer counts as a click elsewhere, so the target stays. The previous head kept that hit-test behind a tap.

- A click is unknown, counted as outside the user's app, until the tap has seen as many presses and releases as the HID counters. If the tap still trails after 50 ms without button events, the missed click counts as the user's (a remapper swallowed it, no app got it), unless macOS had disabled the tap: then it stays unknown.
- A click from before the session's tap counts as the user's. Remote and remapping tools posting at the HID or session tap count as the user; omp's own posts and posts to a pid do not.
- Without event-listening access, `main`'s hit-test runs unchanged.

## Testing

- The A/B above: fixture apps, VNC pointer input; no-access rows with `kTCCServiceListenEvent` denied, counted raw.
- A Dock pick 0-600 ms before the first action was never undone (0 of 75, all arms).
- `cargo test -p pi-natives --lib -- desktop::`: 561 pass; each placement rule's test fails with the rule removed. `rust-check` passes on macOS and Linux.

## Risk

- Blocked or stopped app: this decides to send the target back but macOS cannot raise the app, so the call returns the usual "input may already have been delivered, but restoration failed" error; `main` and the previous head return ok.
- Unchanged failures in every arm: a remote tool's session-tap click on the target (those posts never reach the HID counters), and a no-access menu-bar drag.
- Open from review: `UserSwitchWatch::observe` records no click when a reading flips to elsewhere on unchanged counters (the session-tap pick above); the session-tap wording is probed only for clicks in the user's app.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
