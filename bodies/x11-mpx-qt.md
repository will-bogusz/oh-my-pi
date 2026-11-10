## What

I found that on X11, every `computer` session that had used background input crashed whatever Qt 6.5+ apps you had open the moment it ended, because omp removed its virtual pointer and Qt frees that device twice; now omp keeps the pointer for the next session instead of removing it.

With two PySide6 6.10.1 windows open on Xorg + mutter, a session that clicks and types into a GTK window and then ends killed both windows in 10 of 10 runs on `main` and in 0 of 10 with this PR.

> **X11 context.** Background input drives a second "master" pointer and keyboard (XInput2 MPX) fed by uinput devices. Removing a master makes running Qt 6.5+ xcb clients free its child devices twice and segfault in `QXcbConnection::xi2SetupDevices()`: [QTBUG-146876](https://bugreports.qt.io/browse/QTBUG-146876), open and still in Qt 6.12.0 ([QTBUG-151420](https://bugreports.qt.io/browse/QTBUG-151420)). Qt 6.4 and 5 are not affected. Removing a master also crashes GTK3 apps when one of their popups holds a grab at that moment (Cua fixed the same in [trycua/cua@a08193ac9](https://github.com/trycua/cua/commit/a08193ac9)), so keeping masters covers GTK3 as well.

| When `main` removes a master | Qt 6.5+ apps on `main` | This PR |
|---|---|---|
| `computer.close()`, a subagent's session ending, a cancelled call | crash | the pair is marked free and kept |
| the next omp process cleaning up a killed process's pair | crash | the pair is taken over |
| a server that never binds the uinput slave (after 5 s) | crash | no pair is added |

## Why

`main` keeps one pair per session, since churning masters per action crashed mutter 42 and LibreOffice, but removed it at the end. Removal is the one event that kills Qt (measurements under Testing).

A session now takes, under a server grab, a pair whose holder property reads `free` or names a provably dead process (`main`'s reaping rule), adding one only when none is free. At its end it unplugs its slaves, waits for the server to drop them, then parks the cursor and frees the pair. New pairs are named `v2.`: older omp releases remove `v1.` masters whose creator died, as a reused pair's has. Rejected: refusing background input while Qt apps run (needs telling apps apart by name; every X11 user loses the route) and removing only at process exit (still a crash).

Cost: pairs stay until the X server exits and show in `xinput list`, as many as the most sessions that used background input at once, 4 of Xorg's 40 device slots each. A free pair's cursor rests in the bottom-right corner, as between actions on `main`.

Non-goals: KDE Plasma on X11 stays refused; that guard may be this same bug, not measured.

## Testing

Guest: Ubuntu 24.04, Xorg 21.1.12, mutter 46.2, two PySide6 6.10.1 windows per trial, omp 18.18.6's `computer` worker (`backgroundFallback: refuse`) on an addon of v18.18.6 plus this PR. Each trial clicks and types `abc` into a GTK3 entry and a Chromium page.

| n = 10 each | `main` | This PR |
|---|---|---|
| session ends with `computer.close()`: Qt windows killed | 20 / 20 | 0 / 20 |
| omp SIGKILLed, a new process sends input: Qt windows killed | 18 / 20 | 0 / 20 |
| GTK click, text delivered; Chromium click | 10, 7; 0 | 10, 7; 0 |
| input hierarchy events per session (masters removed) | 12 (1) | 10 (0) |

- `#[ignore]` tests on that Xorg: `a_session_hands_its_pair_to_the_next_without_removing_it` fails on `main`, where a Qt window watching segfaulted, and passes here with the window alive; `a_killed_holders_pair_is_parked_and_freed` passes. On Xvfb, `a_server_that_never_binds_the_slave_gets_no_pair` fails on `main` (`MASTER_ADDED`) and passes here.
- `cargo test -p pi-natives --lib desktop::linux::x11` (the `is_claimable` cases); `scripts/rust-check` on Linux.

<details><summary>Other runs</summary>

- mutter's GTK 4 frame helper, which mutter restarts, segfaulted 11 times in the 30 `main` trials and once in 40 with this PR (cause open).
- Plain `xinput create-master` then `remove-master` on Xvfb, two windows × 10 per version: Qt 6.5.3, 6.6.3, 6.7.3, 6.8.3, 6.9.3, 6.10.0 and 6.10.1 lost 20 of 20 each; Qt 6.4.2 and 5.15.13 lost none. With openbox, adding a master, reattaching a slave and floating one each killed 0 of 30 Qt 6.10 and 6.12 windows; removing one killed 20 of 30.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
