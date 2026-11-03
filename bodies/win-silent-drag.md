## What

A background drag on a Tk window on Windows came back as success while the window never saw it, so I made OMP refuse that drag the way it already refuses Tk clicks, and the user's `computer.backgroundFallback` setting takes over from there.

A drag on a background tkinter window (Python's Tk, IDLE): `main` reports success and the window gets 0 events; with this PR the drag runs in takeover and the window gets its press, two moves and its release.

| Background `drag` on… | `main` | this PR |
|---|---|---|
| a Tk window (`TkTopLevel`), fallback `takeover` (default) | success, 0 events reach the window | runs in takeover with a note naming Tk; press, moves, release arrive; focus returns to the terminal |
| a Tk window, fallback `refuse` | success, 0 events | `BackgroundUnavailable`, no input sent |
| a GIMP 3.2 canvas (GTK) | stays in the background, stroke painted | same |
| every other window class | decided as a move | same |

> **Windows context.** Background input is posted to the target window instead of going through the system input queue. Each toolkit accepts or ignores posted messages by event kind; `would_be_silently_dropped` in `delivery.rs` is the table of which kinds a toolkit ignores, and a hit there sends the call to `computer.backgroundFallback`. Tk was already listed for clicks and keys: it reads button state through `GetKeyState`, which posted input never sets.

## Why

`main` classified a drag as a plain move. Tk accepts posted moves, so the drag passed the check, but the press inside it never registers, so nothing happens and the call reports success.

Decisions:
- A drag gets its own delivery kind instead of being classified as a click. GTK ignores posted button clicks, yet a GTK canvas paints a posted drag (checked live in GIMP), so a drag refused wherever clicks are refused would push GIMP drags into takeover for no reason. Every non-Tk class still decides a drag by its moves, exactly as `main` does.
- Wheel input stays as it is. A posted wheel reaches a background Tk window wherever no other window covers the point, because Tk routes it through `WindowFromPoint`; a blanket Tk scroll refusal would move the user's pointer for scrolls that work.

Maintenance: should a future Tk take posted button state, the cost is one needless takeover; drop `MouseDrag` from the Tk branch.

## Testing

Windows 11 25H2 VM, computer prelude run without a model from a Windows Terminal window, a Tk window logging its own events, GIMP on a blank image; `main` (83de60ad992), then this branch (addon built in the VM):
- Tk drag, the window covered or not: `main` got 0 events and no error. This branch gave `drag ran in takeover because window … (TkTopLevel) drops background mouse_drag events: Tk reads button and key state from GetKeyState…`, the window logged `focus-in,down,drag,drag,up,focus-out`, and the terminal kept the foreground afterwards.
- With `computer.backgroundFallback: refuse` the call threw `BackgroundUnavailable … no input was sent`, and the window logged nothing.
- On both builds, a GIMP drag painted the stroke with the foreground window and pointer unchanged, and a wheel on an uncovered background Tk window arrived with 1 event.

`cargo test -p pi-natives --lib desktop::win32::delivery`: 11 pass. With the Tk refusal reverted, `drags_follow_their_moves_except_on_tk_which_never_sees_the_press` fails. `rust-check` passes on Linux and on Windows (cargo-xwin).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
