## What

I found that on X11, while another app had a menu open or a screen locker was asking for a password, omp's takeover typing went into that app and still told the agent the text landed in the window it asked for; now it waits briefly for that grab to end and otherwise refuses with nothing sent.

Window takeover keys probe for an active keyboard grab before sending, wait up to 500 ms for it to end, then refuse. The target's own popup remains usable only when no foreign popup is stacked above it.

## Why

XTest keys go to the client holding the keyboard grab, not necessarily the focused window. X does not identify that client: the exemption therefore requires the topmost viewable, non-passive override-redirect root child to belong to the target's process. Finding any target popup lower in the stack would let a locker above it receive the keys.

Review `Wm::topmost_grab_popup_of` and `X11Input::check_keyboard_grab` first. The popup check is still a heuristic, not proof of grab ownership; a target that grabs without a popup is refused. Desktop targets and held keys/modifiers in `holdMouse`/`drag` retain their existing behavior.

## Testing

`xtest_keys_refuse_another_clients_keyboard_grab` starts Xvfb and maps a target-owned popup below another client's grabbing popup. It fails on `a68b03f6aea` because takeover succeeds, and passes with the fix, with neither client receiving keys. The same test keeps own-popup delivery, desktop delivery to a grab, and delivery after ungrab covered. Both Xvfb tests share one `start_server()` fixture.

Reproduce with `cargo test -p pi-natives --lib desktop::linux::x11 -- --include-ignored --test-threads=1` under Xvfb on Linux. The prior GTK menu and locker-style measurements were collected before the current main rebase; a real screen locker and Xorg session were not measured.

The full Linux run passed 61 tests. Only `temporary_pair_contention_does_not_disable_mpx_for_the_session` and `a_session_hands_its_pair_to_the_next_without_removing_it` failed: both require udev/libinput hotplug unavailable in Xvfb and fail identically on main.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
