## What

I found that clicking in my own app could leave the omp background target in front: a menu-bar drag, a resize or selection ending over the target, or a click just before the session's first action, every time. This places each click from the event itself, so my app comes back unless I picked the target.

Guard A/B, macOS 26.5 VM, n=10: my app in front afterwards, or the target kept when picked; a trial counts when the target came forward 0-250 ms after my last button event. Builds: `main` 679691a781, previous head cacd8a129d, this PR 5817854bd4.

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
| remote tool posting at the session tap: click on the target | yes | 0/10 | 0/10 | 0/10, fixed below |
| my app's middle click swallowed by a remapper at the HID tap | no | 10/10 | 10/10 | 10/10 |
| my app's middle click swallowed by a remapper at the session tap | no | 10/10 | 10/10 | **10/10** |
| click in my app while its main thread is blocked | no | 0/10 | 0/10 | 0/10 |
| click in my app while it is stopped (SIGSTOP) | no | 0/10 | 0/10 | 0/10 |
| no event-listening access: click in my app | no | 10/10 | 0/10 | 10/10 |
| no event-listening access: menu-bar drag | no | 1/10 | 0/10 | 0/10 |
| no event-listening access: blocked app | no | 0/10 | 0/10 | 0/10 |
| no event-listening access: Dock pick | yes | 10/10 | 10/10 | 10/10 |

After Codex's first review, n=10: `main` f680ea91b1, previous head cacd8a129d, 320154a644 (rebased), f85976a6bb.

| Case | Picked the target? | `main` | previous head | 320154a644 | this PR |
|---|---|---|---|---|---|
| remote tool posting at the session tap: click on the target, a second after a click of mine | yes | 0/10 | 0/10 | 0/10 | **10/10** |
| click in my app's own Open panel (TextEdit, drawn out of process) | no | 10/10 | 10/10 | 0/10 | 10/10 |
| target started from my terminal: I click its window | yes | | | 10/10 | 10/10 |
| target started from my terminal, sandboxed: I click in its own Open panel | yes | | | 10/10 | 10/10 |
| click in another regular app: my app is not put back | it picked that app | | | 10/10 | 10/10 |
| drag across my app's menu bar | no | | | | 10/10 |
| resize ending over the target | no | | | | 10/10 |
| text selection ending over the target | no | | | | 10/10 |
| click in my app just before the session's first action | no | | | | 10/10 |

After Codex's second review, n=10: `main` f680ea91b1, ba8d2789f4, this PR (4560880467, rebased as 4350f38c5f).

| Case | Picked the target? | `main` | ba8d2789f4 | this PR |
|---|---|---|---|---|
| click in my app whose press a slower tap ahead of omp's delivers 170 ms late, after its release | no | | 8/10 | **10/10** |
| remote tool posting at the session tap: click on the target, a second after a click of mine | yes | | | 10/10 |
| my app's middle click swallowed by a remapper at the session tap | no | | | 10/10 |
| Dock pick just before the session's first action | yes | | | 10/10 |
| another regular app started from my terminal: I click it, my terminal is not put back | it picked that app | | | 10/10 |
| drag and drop from my app onto its emoji picker | no | 0/10 | | **9/10** |
| click on my app's emoji picker | no | 0/10 | | 0/10 |

## Why

`main` hit-tests the pointer after the event: that blocks, fails in a busy app and misplaces releases over the menu bar or past the window edge. A press goes where `WindowServer` routed it (`kCGEventTargetUnixProcessID`). A release keeps its press's place unless the drag pasteboard changed (a real drop); then it goes to the owner of the window under it.

- A click is unknown until the tap has seen as many button events as the HID counters. One still missing after 50 ms idle counts as the user's (a remapper swallowed it), unless macOS had disabled the tap.
- A click from before the session's tap counts as the user's. Tools posting at the HID or session tap count as the user; omp's own posts and posts to a pid do not.
- Without event-listening access, `main`'s hit-test runs unchanged.

<details><summary>Remote tools' session-tap posts and out-of-process panels</summary>

- Session-tap posts never reach the HID counters: the events they skipped join every reading, dated by delivery.
- `WindowServer` routes a click in a sandboxed app's Open panel to `openAndSavePanelService`. A press routed to a non-regular process counts for the app macOS holds responsible for it, only while my app and the target have different responsible processes.

</details>

## Testing

- Fixture apps, VNC input; no-access rows with `kTCCServiceListenEvent` denied.
- A build with one piece removed scores 0/10 on its row: the session-tap post dated by the HID state, or the panel mapping without the shared-host check.
- A Dock pick 0-600 ms before the first action was never undone (0 of 75).
- `cargo test -p pi-natives --lib -- desktop::`: 618 pass, each rule's test failing without it. `rust-check` passes on macOS and Linux.

## Risk

- Blocked or stopped app: the target is sent back but macOS cannot raise the app, so the call returns "restoration failed".

## Limits

| Limit | What happens |
|---|---|
| A drag release whose window-owner lookup outlasts the delivery window | its press expires first, so a drop on the target counts as staying in my app and the guard restores the target I picked |
| A press the tap delivers only after my app has begun the drag (its callback running tens of milliseconds late) | my drop reads as a plain release: a target the drop brought forward is sent back once, and the call's later steps continue in the background |
| My app and the target share a responsible process (target started from my terminal) | nothing is mapped, so a click in my app's out-of-process panel counts as elsewhere |
| My app's emoji picker, which belongs to CharacterPalette, a process macOS holds responsible for itself | a click on it counts as elsewhere, as on `main` |
| A press a remapper swallowed | it stays owed, so a remote tool's next session-tap press of that button is not counted |
| A press in the instant the tap starts | it reads as in my app until the tap delivers it; if the tap delivered it before the record began, that reading is not corrected |
| A press the tap has not delivered after 50 ms without a button event | it counts as mine, also once it arrives: a target it picked is sent back |
| A press of mine the tap has not delivered yet, from the press until 50 ms after my last button event | it may be my click on the target: a target that comes forward then stays in front for the rest of that call, and its later steps stop as if I had gone to it |
| A remote tool's session-tap press still queued when my press of the same button is counted | it stands in for mine until mine arrives |

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution




