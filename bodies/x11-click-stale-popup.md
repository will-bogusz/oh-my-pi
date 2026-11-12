## What

I found that on X11, once an app had a popup menu open, for example one an earlier omp session opened and never closed, a click on that app's window in the background or in takeover reported success while the menu swallowed it; now omp refuses that click with nothing sent and says how to get through.

One session opening a GTK 3 app's menu and ending, then a second session clicking a button in that app in the background: on `main` the click returned success and never reached the button 30 of 30 times; with this change it is refused with nothing sent 30 of 30, and so is the takeover rerun, with the menu left open.

## Why

A GTK or Qt popup menu grabs the pointer while it is open: a press outside it goes to the menu, which closes and drops it. The pointer routes only confirm the press reached the server, so the call returned success and the agent went on from a click that never happened.

`X11Input::popup_outside` looks for a mapped override-redirect popup of the target window's process (`Wm::grab_popups_of`, the test background keys already refuse on) and refuses a press, hold, drag or scroll outside every such popup before sending anything: `BackgroundUnavailable` in the background, as background keys do, and `InputFailed` in takeover, so the default takeover rerun cannot report the same lost click. The error names the popup and says to target its window to press inside it, or to close it first. Plain moves, presses inside the popup or a submenu, and apps with no popup open are unchanged.

Risk: any mapped override-redirect window of the app other than a tooltip, notification or drag icon counts, such as an open combo dropdown. Those grab the pointer too, so a click outside them should be lost on `main` as well (not run here).

Open question: should a session also close its open popups with Escape when it ends? I recommend against: it fixes only the left-behind case, not a menu the user or app opened, and sends a key into the desktop after the agent is gone. It would be a hook in session teardown.

Not changed: macOS and Windows. From the code, neither checks for a menu the target app already has open before a background click (macOS `ax::open_menu::guard` handles only a menu the press opened), so both may have the same hole; not run here.

## Testing

The measurements below were collected before the current main rebase; activation and admission timing has since changed.

Two `X11Input` sessions against one app: A opens its Menu popup and ends; B clicks the app's Bump button (outside the popup) or the popup's middle (inside), in the background, and a refused click is rerun in takeover as `backgroundFallback: takeover` does.

| | GTK 3 `main` | GTK 3 this PR | Qt 6 check off | Qt 6 this PR |
|---|---|---|---|---|
| B clicks Bump, menu open | Ok, Bump 0, 30/30 | refused, takeover refused, Bump 0, menu still open, 30/30 | Ok, Bump 0, 30/30 | refused, takeover refused, Bump 0, menu still open, 30/30 |
| B clicks inside the menu | item activated 10/10 | item activated 30/30 | not run | item activated 30/30 |
| No menu, B clicks Bump | Bump 1, 10/10 | Bump 1, 30/30 | Bump 1, 10/10 | Bump 1, 30/30 |

<details><summary>Rig and versions</summary>

KVM guest, Ubuntu 24.04, GNOME (Mutter) on Xorg 21.1.12, GTK 3.24.41, Qt 6.10.1 (PyQt6), XInput2 MPX route. Qt 6 ran on a branch with the queued Qt 6 MPX pair fix, since on `main` session A's end closes the Qt 6 app; its left column is that build with this check switched off by a measurement-only flag.

</details>

- `a_press_outside_an_open_popup_is_refused` (`#[ignore]`, own Xvfb; `cargo test -p pi-natives --lib -- --ignored open_popup`): refused outside the popup in the background and in takeover with nothing reaching the window; delivered inside the popup, inside a submenu over it, and with no popup; a plain move passes. Fails on `main` 30 of 30 runs, passes here 30 of 30 (Xvfb 21.1.12).
- Re-run on current main (`bcd5b0b996e`): Linux `scripts/rust-check` passed; `cargo test -p pi-natives --lib desktop::linux::x11 -- --include-ignored --test-threads=1` under Xvfb passed 61 tests, including the regression, typing-user admission and named-change tests. Two MPX hotplug tests require an Xorg server with udev/libinput and fail under Xvfb.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
