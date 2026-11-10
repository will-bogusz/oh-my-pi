## What

I made X11 window screenshots read a covered window's own pixels instead of cropping the screen, which handed the agent the window on top as if it were the target.

On X11, `win.screenshot()` (and `observe()`, `zoom()`) of a covered window returned the covering window's pixels there, with nothing to say so. Now:

| Target window | main | this PR |
|---|---|---|
| Nothing covers it | crop of the screen | same crop, byte-identical |
| Covered, a compositing manager runs (GNOME's mutter, KWin, picom) | the covering window's pixels | the window's own pixels, with its own open menus drawn over them |
| Covered, no compositing manager | the covering window's pixels | `CaptureFailed: window N is covered by another window, and without a compositing manager the X server keeps no image of its covered part; win.ax() still reads it, and a screenshot of its display shows what is on top` |

<img width="3200" alt="Window screenshot of a gedit window that an xterm covers, under openbox and picom on X11: on main the capture shows the xterm over lines 3 to 5; with this PR it shows gedit's own lines" src="https://github.com/user-attachments/assets/8a2f9069-3866-487d-84dd-f8cbb17f729b" />

## Why

The capture was `GetImage` on the root window, which holds what is on screen. macOS (`SCScreenshotManager` with a window filter) and Windows (`PrintWindow`) both return the window's own pixels when it is covered, so an agent on X11 was the only one shown the wrong window.

> **X11 context.** A compositing manager owns `_NET_WM_CM_S<screen>` and redirects every top-level window into a pixmap of its own, which `GetImage` on the window reads, covered parts included. Without one, the covered part exists nowhere on the server.

Decisions:
- Covered means a top-level the server stacks above the target's (`QueryTree` of the root, bottom to top) overlaps it, measured by its outer geometry. So a window manager's frame and title bar count, a window manager that publishes no `_NET_CLIENT_LIST_STACKING` (dwm) cannot make the window on top look covered, and override-redirect windows of the target's own client (its menus, tooltips) are not cover.
- An uncovered window keeps the root crop, so its menus and the compositor's shadows stay in the frame exactly as before. A covered one under a compositor gets its own menus read the same way and drawn over it; windows of other clients are left out, as on macOS.
- Without a compositing manager it refuses rather than redirecting windows itself: a fresh redirect makes every client repaint, and knowing when they finished would take a settle delay.
- Not XComposite `NameWindowPixmap`: `GetImage` on the redirected window needs no new x11rb feature.
- ARGB windows' premultiplied colour is decoded to straight alpha.

Left as is: under `refuse`, `win.raise()` is still refused with "Background input and screenshots reach a covered window, so no raise is needed" (`tools/computer/worker.ts`), untrue on X11 without a compositing manager; it is model guidance, so I left it.

## Testing

- Three `#[ignore]` Xvfb tests (red under blue in a grey frame whose title strip alone overlaps red, plus a popup of red's client) and one CI test for the alpha decoding: `cargo test -p pi-natives --lib -- --include-ignored desktop::linux::x11::capture`. One reaches the compositor read, one the refusal, one the server-stacking read (frame lowered below red while `_NET_CLIENT_LIST_STACKING` says it is on top). Put back to main's root crop, the first two fail; the third passes on main and guards the stacking read.
- Live on Xvfb with openbox, GTK3 windows painted solid colours, main = the omp 18.18.6 addon:

  | Case | main | this PR |
  |---|---|---|
  | red covered by blue, picom, 5 captures, 1,900 sampled pixels each | blue 1900/1900, 5/5 | red 1900/1900, 5/5 |
  | the same, no compositing manager | blue 1900/1900, 5/5 | `CaptureFailed … covered …`, 5/5 |
  | the uncovered blue window, both modes | | PNG byte-identical to main's |
  | only blue's title bar over red's bottom rows, picom | 12 rows not red | all red |
  | the same, no compositing manager | 12 rows not red | `CaptureFailed … covered …` |
  | red raised over blue, no WM, `_NET_CLIENT_LIST` in map order only | red 1900/1900 | red 1900/1900 |
  | red's own green popup over it, covered, picom | 6000 green pixels | 6000 green pixels |

  A header-bar (ARGB) red window under picom: 2652/2756 red, 0 blue. The figure is gedit under an xterm.
- `scripts/rust-check` on Linux.
- Not run: GNOME's mutter (the same EWMH mechanism as picom).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
