## What

I found that after background typing on X11, OMP's virtual keyboard kept focusing the target window, and since Xorg only tells a window it gained focus when the first keyboard arrives, Openbox never saw a later takeover activate that window and every such takeover failed; now takeover and `raise()` take the virtual keyboard off the window first.

Under Openbox, takeover reruns into a window background typing had targeted: 0/4 delivered on `main`, 4/4 with this PR.

> **X11 context.** Background input drives a second "master" keyboard (XInput2 MPX) focused on the target, so the user's focus stays put. Xorg sends a window core `FocusIn`/`FocusOut` only when the first keyboard of any master enters it and the last one leaves (`dix/enterleave.c`, `HasFocus`). Window managers such as Openbox learn the active window from those events.

| Openbox, gedit behind System Monitor, after a refused background call | `main` | This PR |
|---|---|---|
| takeover rerun of `type`, then of `press(ctrl+s)` | `takeover target lost focus during input`, then `did not become the active, focused window within 1500ms`; every later takeover into gedit too | both delivered, file saved |
| focus after the reruns | gedit holds the keyboard, `_NET_ACTIVE_WINDOW` none | gedit active and holding the keyboard (see Non-goals) |
| `raiseWindow(gedit)` | `_NET_ACTIVE_WINDOW` none 1 s later | gedit |

**GNOME (mutter):** background calls behave as on `main`; a Chrome page counts the same `blur` events on both.

## Why

With the virtual keyboard still on the target, a takeover moving the real keyboard there gives the window no `FocusIn`, only the `FocusOut` of the window the user left. Openbox clears `_NET_ACTIVE_WINDOW` and never sets it to the target, and takeover, which waits for the target to be active, fails until the session ends.

Decisions:
- The virtual focus is dropped at takeover and `raise()`, not after every background call: dropping it per call also fixes takeover, but under mutter the target then gets a `blur` per call, which closes dropdowns between a `type` and the `press` that picks from them.
- It goes to None, not PointerRoot (focus events for whatever sits under the parked virtual pointer) nor the user's window (the same blind spot moved there). A never-focused virtual keyboard is left alone.

Non-goals: Openbox still takes the first background key into a window as an activation (Xorg sends the target a `FocusIn` for the virtual keyboard), so that call still fails with `InputFailed` as on `main`, and Openbox then reports gedit as active, so takeover finds no other window to hand focus back to. Returning focus by the user's real focus is a separate `restore_activation` change.

Reading order: `Mpx::release_focus` (`x11/mpx.rs`), then `X11Input::with_foreground` and `raise_window` (`x11/input.rs`).

## Testing

- Live, Ubuntu 24.04 VM, Xorg 21.1.11, Openbox 3.6.1, gedit behind gnome-system-monitor: background `press(ctrl+End)`, `type(" BGMARK")`, `press(ctrl+s)`, refused calls rerun in takeover with `returnFocus` as the tool does, 2 runs each. `main`: both reruns fail, file unchanged. This PR: both delivered, file saved. Then a background `type` and `raiseWindow`, results as in the table.
- Mutter 46.2: two background `typeText` calls into a Chrome page counting `blur`: 1 before, 1 after each call, 2 after `close()` on both; gedit `press`/`type`/`press` saved on both.
- Not run: a unit test; this path needs Xorg with uinput hotplug.
- `scripts/rust-check` on Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
