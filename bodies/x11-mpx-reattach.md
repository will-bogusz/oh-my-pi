## What

I found that after I locked the screen on a LightDM desktop and came back, or switched to another virtual terminal and back, omp's "background" typing and clicks on X11 went into the window I was working in while the call told the agent they had reached its target; now omp puts its virtual devices back before each call, and fails instead of reporting success when it cannot.

After a screen lock unlocked with the password, omp's text and click went into the user's window in 10 of 10 trials on `main`, every call reporting success; with this change they reached the target 10 of 10 times.

> **X11 context.** omp's background input runs through its own XInput2 pointer and keyboard, fed by two virtual (uinput) devices. When Xorg leaves its virtual terminal (VT) it disables every input device; when it returns it attaches each one to the user's core pointer and keyboard. omp kept sending through its devices there, and its delivery check still passed.

| Trigger, then omp types `b` into its target and clicks it | `main` | This PR |
|---|---|---|
| LightDM screen lock (`dm-tool lock`, the greeter on VT 8), unlocked by typing the password | text and click in the user's window, call ok, 10/10 | in the target, ok, 10/10 |
| The same lock, back to the session VT with `chvt 7` | in the user's window, ok, 10/10 | in the target, ok, 10/10 |
| VT 3 and back | in the user's window, ok, 10/10 | in the target, ok, 10/10 |
| A call made while on the other VT | unconfirmed `InputFailed`; every later background call refused for the session, 10/10 | refused, nothing sent; after the return, in the target, 10/10 |
| `xinput disable` then `enable` of omp's devices | in the user's window, ok, 10/10 | in the target, ok, 10/10 |
| `xinput float` by another client | delivered nowhere, ok, 10/10 (a false success too) | in the target, ok, 10/10 (a floating device counts as moved and is attached back) |
| `xinput reattach` to the core devices | in the user's window, ok, 10/10 | in the target, ok, 10/10 |

## Why

Each background call now asks the server where its devices sit, in one round trip: a device on another master or floating is attached back and checked again; a disabled or missing one refuses the call with nothing sent (`BackgroundUnavailable`, so `computer.backgroundFallback` applies). After a call that sent input it asks again; a device that left mid-call makes the result `InputFailed`. Cost: a median 62 µs per call (worst 310 µs in 6,000).

Decisions:
- A query, not XI2 hierarchy events, which help only if every event loop keeps them; nothing but omp puts its device back, so a move still shows at the call's end.
- Attach back rather than refuse, or every call after a lock would refuse; the keyboard gets a new one's warm-up key, with its focus cleared first.
- Pointer gestures check both devices, `holdKeys` included.

Input sent after a move and before the call ends is reported, not recalled.

## Testing

KVM guest: Ubuntu 24.04, Xorg 21.1.12, LightDM, mutter 46.2, GTK 3; omp 18.18.8's `computer` worker behind a mock model (`main`'s X11 input code is identical to v18.18.8), this branch's addon swapped in. Each trial: a fresh omp process types `a` into GTK window A and clicks it, the trigger runs, then `b` and a click; B is the user's active window, core pointer over it.

The two live tests below fail on the base 3 of 3 rounds (the user's window got the key; the moved call returned `Ok`) and pass on this branch 3 of 3; with the after-call check removed from gestures, the second fails 3 of 3.

<details><summary>Tests</summary>

- `a_slave_the_server_moved_is_put_back_before_input` (`#[ignore]`, Xorg with uinput hotplug): keys after omp's keyboard is attached to the core keyboard, floated, or disabled and enabled reach the target, not the focused window; a call while disabled refuses; a click after the pointer is attached to the core pointer reaches the target.
- `a_call_whose_slave_moved_while_it_ran_does_not_report_success` (`#[ignore]`): another client moves the keyboard at the first of 40 keys, then the pointer at the first of 10 wheel detents; both calls fail, and the next one types into the target.
- `a_slave_counts_as_routed_only_on_its_own_master_under_its_own_name`: the attachment rules, including a freed device id taken by another device.
- `scripts/rust-check` on Linux.

</details>

Which locks move the devices: those that show the greeter on another VT, as LightDM's lock does (`dm-tool lock`, light-locker on Xubuntu), and fast user switching on any display manager. Lockers that stay inside the session (GNOME Shell's and Cinnamon's on Xorg, xscreensaver) were not run; they should not move them.

Not measured: suspend and resume. The guest resumed from S3, but its X session then hung on window-property requests (`xprop -root`), and neither a display-manager restart nor a reboot recovered it.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
