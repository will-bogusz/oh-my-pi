## What

I found that on X11, background `el.type` and `el.press` brought the element's window to the front and took the user's keyboard, while reporting a background delivery, because OMP first asked the app over AT-SPI to focus the element and GTK and Chrome answer that by activating their window; now background element input skips that request, types through the window when the element already holds a GTK 3 window's focus, and otherwise refuses so the `computer` tool reruns it in takeover.

Background `el.type` into gedit and Chrome behind another window: the target became active in 4/4 cases on `main`, 0/4 with this PR, the text landing in the intended field.

> **X11 context.** OMP's background keys on X11 go to a window, not an element: they reach whatever widget holds that window's focus. To aim at an element, `main` first sent AT-SPI `grab_focus`. GTK 3 implements it by presenting the toplevel window (`gtk/a11y/gtkwidgetaccessible.c`, `gtk_widget_accessible_grab_focus`), and Chromium activates its window too, so the window manager makes it active.

| Background `el.type` behind System Monitor (mutter) | `main` | This PR |
|---|---|---|
| gedit's text area (its window's focus widget) | typed; gedit becomes active | typed in the background; System Monitor stays active |
| GTK 3 element that is not its window's focus widget | focused, typed; window becomes active | `BackgroundUnavailable`, nothing sent; takeover rerun |
| Chrome field, with or without page focus, or while the omnibox holds the keyboard | focused, typed; Chrome becomes active | `BackgroundUnavailable`, nothing sent; the takeover rerun types it and hands focus back |
| `takeover: true` | focuses the element, then types | same |

## Why

The call said background, yet the user's next keys went into the agent's window, and no error reached the model: the background focus check starts after the focus request.

Decisions:
- Only an element reporting AT-SPI `Focused` in a GTK 3 app is typed in the background. GTK 3 sets that state only on its window's focus widget, so keys sent to the window reach it. Chromium reports its page's focused node as `Focused` while the omnibox, find bar or DevTools holds the window's keyboard, so background keys could land in the wrong control; every Chromium element is refused.
- A refused element goes through `computer.backgroundFallback`: takeover focuses it first and types, or the call refuses.
- Only X11 changes. Wayland has no background window input, and its element input keeps `main`'s focus-then-send.

Reading order: `X11Backend::element_input` and `background_element_refusal` (`linux/x11/mod.rs`), then `AtSpiAx::element_focus` (`linux/ax.rs`).

## Testing

- `background_element_keys_go_only_to_a_gtk3_window_focus_widget`: a focused GTK 3 element passes; an unfocused GTK 3 element and a focused Chromium element are refused with `BackgroundUnavailable` and "no input was sent".
- Live, Ubuntu 24.04 VM (the bench's `x11m` image), Xorg 21.1.11, `mutter --x11`, the target behind gnome-system-monitor; `DesktopSession.axType` on the element, a `BackgroundUnavailable` rerun with `{ takeover: true, returnFocus: true }` as the `computer` tool does (`elfocus.sh`):
  - gedit text area: `main` typed and made gedit active; this PR typed, System Monitor active.
  - Chrome for Testing, autofocused field; other field; autofocused field with the omnibox focused (`ctrl+l`): `main` focused and typed each and made Chrome active; this PR refused each, the takeover rerun typed into the intended field, and System Monitor was active again afterwards.
- `scripts/rust-check` on Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
