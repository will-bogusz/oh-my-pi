## What

On X11, takeover typing died with `Cancelled` partway through whenever I had last typed on my own keyboard, because the Escape monitor took Xorg's keymap notice for that keyboard switch as a reason to stop; now it re-reads where Escape is and keeps going, and a real Escape now counts as one.

Takeover typing right after a key on the user's keyboard: 0/3 delivered on `main`, 3/3 with this PR. A physical Escape during takeover now stops computer use for the turn (`escapeStops` 0 → 1), where `main` ended only the call.

> **X11 context.** The core keyboard that apps see is fed by several devices: your keyboard, and the XTEST device takeover injects through. Each time the feeding device changes, Xorg copies that device's keymap onto the core keyboard and sends every client a `MappingNotify`. Takeover's Escape monitor (`control/linux.rs`) watches raw key presses for Escape and stopped the operation on any `MappingNotify`.

| Takeover call | `main` | This PR |
|---|---|---|
| `type`/`press` after you typed on your keyboard | `Cancelled: desktop operation cancelled; input may be partial` partway through | delivered |
| `type`/`press` when XTEST typed last | delivered | delivered |
| physical Escape mid-typing | ends the call as a plain `Cancelled`; `escapeStops` stays 0, so the agent goes on | ends the call and counts the stop (`escapeStops` 1), so computer use stops for the turn |
| keymap change that leaves no Escape | stops it | stops it |

## Why

A takeover's first XTEST key after you typed switches the core keyboard's source, so Xorg sends `MappingNotify` to every client without XKB, the monitor's x11rb connection included, and the monitor cancelled the operation it guarded. Your Escape hit the same notice first: pressing it switches the source back, Xorg sends the notice before the key, and `main` cancelled without ever counting an Escape stop.

Decisions:
- On a keyboard `MappingNotify` the monitor re-reads the core keymap and watches the new Escape keycode; it stops only when the new keymap has no Escape, as `main` already refuses to start without one. Ignoring the notice would keep watching a keycode a layout change may have moved.
- Modifier and pointer mapping notices change no keycode, so they no longer stop anything.

Reading order: `step` in `control/linux.rs` (the per-event decision, testable without a server), then `X11::run`.

## Testing

- `a_core_keymap_switch_keeps_the_escape_stop_on_the_new_keymap`: a keyboard `MappingNotify` moves Escape to the new keycode, the old one is ignored, the new one stops, a keymap without Escape stops. With the keyboard arm returning `Step::Stop` as on `main`, it fails.
- Live, Ubuntu 24.04 VM, Xorg 21.1.11, Openbox, a uinput keyboard as the user's: Shift on it, then `typeText(gedit, text, { takeover: true })`, 3 runs each: `main` 3/3 `Cancelled` about 200 ms in; this PR 3/3 delivered.
- Escape, same VM, a 1,080-character takeover `typeText`, Escape on the uinput keyboard 1 s in, 2 runs each: both `Cancelled` at about 1.1 s; `escapeStops` 0 on `main`, 1 here. Without the Escape this PR's call completes in 1.55 s.
- `scripts/rust-check` on Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
