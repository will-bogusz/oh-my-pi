## What

I found that after I locked the screen on a LightDM desktop and came back, or switched to another virtual terminal and back, omp's "background" typing and clicks on X11 went into the window I was working in while the call told the agent they had reached its target; now omp puts its virtual devices back before each call, and fails instead of reporting success when it cannot.

After a screen lock and return, omp's text and click went into the user's window in 10 of 10 trials on `main`, every call reporting success; with this change they reached the target 10 of 10 times.

> **X11 context.** omp's background input runs through its own XInput2 pointer and keyboard, fed by two virtual (uinput) devices attached to them. When Xorg leaves its virtual terminal (VT), as a LightDM lock screen or user switch does, it disables every input device; when it returns it attaches each device it enables to the user's core pointer and keyboard. `xinput disable` and `enable` do the same. omp kept sending through its devices there, and its check that the server received each event still passed.

| Trigger, then omp types `b` into its target and clicks it | `main` | This PR |
|---|---|---|
| Screen lock (`dm-tool lock`, the greeter on VT 8), back to the session | text and click in the user's window, call ok, 10/10 | in the target, ok, 10/10 |
| VT 3 and back | in the user's window, ok, 10/10 | in the target, ok, 10/10 |
| A call made while on the other VT | unconfirmed `InputFailed`; every later background call refused for the session, 10/10 | refused, nothing sent; after the return, in the target, 10/10 |
| `xinput disable` then `enable` of omp's devices | in the user's window, ok, 10/10 | in the target, ok, 10/10 |
| `xinput float` by another client | delivered nowhere, ok, 10/10 | in the target, ok, 10/10 |
| `xinput reattach` to the core devices | in the user's window, ok, 10/10 | in the target, ok, 10/10 |

## Why

Each background call now asks the server where its devices sit, in one round trip: a device on another master or floating is attached back and checked again; a disabled or missing one refuses the call with nothing sent (`BackgroundUnavailable`, so `computer.backgroundFallback` applies). After a call that sent input the query runs again, and a device that left during the call makes the result `InputFailed`. Both queries take a median 62 µs per call (worst 310 µs in 6,000).

Decisions:
- A query, not XI2 hierarchy events: events help only if every event loop in the module keeps them. Nothing but omp puts its device back, so a move during the call still shows at its end.
- Attach back rather than refuse: otherwise every call after a lock refuses until the session ends. The keyboard gets the warm-up key a new one gets, with its focus cleared so the key reaches no window.
- Pointer gestures check both devices, `holdKeys` included.

Not fixed: input sent after a move and before the call ends is reported, not recalled.

## Testing

goliath KVM guest: Ubuntu 24.04, Xorg 21.1.12, LightDM, mutter 46.2, GTK 3. omp 18.18.8's `computer` worker behind a mock model (`main`'s X11 input code is identical to v18.18.8), with this branch's addon swapped in. Each trial: a fresh omp process; GTK window A is the target, B the user's (active, core pointer over it); omp types `a` and clicks A, the trigger runs, omp types `b` and clicks A.

The two live tests below fail on the base 3 of 3 rounds (the user's window got the key; the moved call returned `Ok`) and pass on this branch 3 of 3; with the after-call check removed from gestures, the second fails 3 of 3.

<details><summary>Tests</summary>

- `a_slave_the_server_moved_is_put_back_before_input` (`#[ignore]`, Xorg with uinput hotplug): keys after omp's keyboard is attached to the core keyboard, floated, or disabled and enabled reach the target, not the focused window; a call while disabled refuses; a click after the pointer is attached to the core pointer reaches the target.
- `a_call_whose_slave_moved_while_it_ran_does_not_report_success` (`#[ignore]`): another client moves the keyboard at the first of 40 keys, then the pointer at the first of 10 wheel detents; both calls fail, and the next one types into the target.
- `a_slave_counts_as_routed_only_on_its_own_master_under_its_own_name`: the attachment rules, including a freed device id taken by another device.
- `scripts/rust-check` on Linux.

</details>

Not run: unlocking by typing the password into the greeter (the lock trials return with `chvt 7`), suspend and resume, and GNOME's lock screen, which stays on the session's VT.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
