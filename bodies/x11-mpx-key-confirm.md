## What

I found that X11 background typing only checked that the last key reached the X server, so when Xorg stalled and the kernel dropped half of the keys, the call still said all the text was typed; now every key release has to come back in order, and a short count fails instead.

With Xorg stopped for 0.8 s in the middle of a 76-character background `type`, 37 of the 76 characters arrived, and `main` returned success 30 of 30 times; with this change the same lossy run fails 30 of 30 times, and runs without a stall still succeed (10 of 10).

## Why

Background keys go through a uinput virtual keyboard attached to an XInput2 master (MPX). The kernel's evdev buffer for that device is finite: when the X server stops reading it (input thread busy, server stalled), the kernel drops the oldest queued events. `Mpx::emit_keys` waited for the raw event of the run's last key only. That key, written last, survives an overflow, so the confirmation passed while keys in the middle were gone, and the agent went on as if the text were complete.

Shape (`crates/pi-natives/src/desktop/linux/x11/mpx.rs`):
- `ReleaseOrder` walks the run's own steps and counts the server's raw key releases from the slave in the order they were sent; a release that is not the next one expected does not count, so one lost key stops the count however many keys follow (`aa` with one `a` lost is caught, where the last key alone confirmed it).
- `emit_keys` waits within the existing `KEY_CONFIRM_TIMEOUT` (1.5 s after emission) for all of them. Releases arrive in order, so a slow but complete delivery passes exactly when `main`'s last-key check would.
- A short count fails with "the X server confirmed N of the virtual keyboard's M key releases within 1500ms, so keys were lost or are still on their way, and background input stays off for this session; read the target before sending more". As with `main`'s last-key timeout, the failure marks the pair uncertain, so later background calls in the session refuse rather than risk landing elsewhere.
- Runs with no release (pressing modifiers for a gesture) still confirm their last press, as on `main`.

## Testing

goliath KVM guest, Ubuntu 24.04, real Xorg + mutter with uinput hotplug; omp's `Mpx` typing 76 characters into a mapped X window that counts `XI_KeyPress` events; the runner stops Xorg with SIGSTOP for 0.8 s, 300 ms into the run.

| | `main` | This PR |
|---|---|---|
| no stall (10 each): keys arrived, result | 76 / 76, Ok 10 / 10 | 76 / 76, Ok 10 / 10 |
| stall (30 each): keys arrived, result | 37 / 76, **Ok 30 / 30** | 37 / 76, error 30 / 30 |

- `a_lost_key_stops_the_release_count_however_many_keys_follow` covers the ordering rule (an extra release from a resync between the run's own, a lost repeat of the same key, a lost first key).
- The stall run needs a real Xorg and the right to stop it, so it is not part of the suite; the device filter, deadline and error mapping in `wait_releases` are covered by that run only.
- `scripts/rust-check` on Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
