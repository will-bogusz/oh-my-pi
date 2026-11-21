## What

On Linux I could find a slider or a list through `ax()` but never see where it stood or which row was picked, so scrolling a list by element meant writing a position blind; now both read straight from accessibility.

On Linux, an element with an AT-SPI `Value` and no text (slider, scroll bar, progress bar) now shows its number, and a `SELECTED` element reads `(selected)`. On Omarchy 4.5 and GNOME 50, slider and scroll-bar reads matched the app's own value in 100 of 100 trials (0 on `main`), and a list scrolled by element moved exactly the step.

| Read | `main` | this PR (Omarchy · GNOME, n=10 per cell) |
|---|---|---|
| slider `value()` (GTK 3, GTK 4, Qt 6) | `undefined` | the app's value, 30/30 · 30/30 |
| vertical scroll bar `value()` (GTK 3, GTK 4) | `undefined` | the list's offset, 20/20 · 20/20 |
| scroll by element: read, `setValue(v + 224)` | no value to start from | list moved 224, 20/20 · 20/20 |
| selected row in `ax()` (GTK 3, GTK 4, Qt 6, Chromium, Electron) | never marked | `(selected)` on it, not on the next row, 50/50 · 49/50 (1 reply lost by the harness) |
| LibreOffice's document scroll bar | `undefined`; an absolute write reports ok, page stays | readable; a write + 224 reads back ok, page still stays, 0/10 (Omarchy) |

`AtSpiAx::read_element` asks for the number only when an element lists `Value` and has no text (a spin button keeps its text; an element whose interfaces cannot be read shows none, as on `main`), and reads `selected` from the state set. Like `text_value` it skips zbus's property cache (Qt). The prompt's state list now names Linux for `(selected)`; no instruction changed, no model sample run.

## Why

On Wayland, `main` refuses `win.click(x, y)` and `el.click()` on a background window, while `el.press()` and `el.setValue()` act through AT-SPI: they land 21 of our 27 background-control cells on Omarchy and 21 of 25 on GNOME, the user typing undisturbed (below). Pixel clicks stay out: nothing ties an AT-SPI window to a Hyprland one, so a click could hit another window.

Two gaps left are reads: no slider or scroll-bar value, so a list scrolled only to absolute positions, and no visible selection. Selecting a GTK row by `press()` stays out.

**Limits:**

- `find({ value: "1" })` can now also match a slider at 10.
- A list with many selected rows gets one `(selected)` per row: 200 rows add about 550 tokens to `ax()`, and a GTK 3 tree view marks every cell.
- An app that lists `Value` but never answers the read makes `ax()` or `find()` fail at the per-element deadline, as an unanswered text read already does on `main`.
- LibreOffice's document scroll bar still reports a write as done while the page stays put, as on `main`.

<details><summary>Background control on Wayland with <code>main</code> (the reason pixel clicks stay out), n=10 per cell</summary>

| control | Omarchy: by pixel | by element | `el.click()` | prototype, by pixel | GNOME: by pixel | by element | `el.click()` |
|---|---|---|---|---|---|---|---|
| GTK 3 button | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| GTK 3 check | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| GTK 3 row | 0/10 | 0/10 | 0/10 | 10/10 | 0/10 | 0/10 | 0/10 |
| GTK 3 menu | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| GTK 3 scroll | 0/10 | 10/10 | – | 10/10 | 0/10 | 9/10 | – |
| GTK 4 button | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| GTK 4 check | 0/10 | 0/10 | 0/10 | 0/10 | 0/10 | 0/10 | 0/10 |
| GTK 4 row | 0/10 | 0/10 | 0/10 | 10/10 | 0/10 | 0/10 | 0/10 |
| GTK 4 scroll | 0/10 | 10/10 | – | 10/10 | 0/10 | 9/10 | – |
| Qt 6 button | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| Qt 6 check | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| Qt 6 row | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| Qt 6 menu | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| Qt 6 scroll | 0/10 | 0/10 | – | 0/10 | 0/10 | 0/10 | – |
| Chromium button | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| Chromium check | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| Chromium row | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| Chromium menu | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| Chromium scroll | 0/10 | 10/10 | – | 10/10 | 0/10 | 10/10 | – |
| Electron button | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| Electron check | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| Electron row | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| Electron menu | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| Electron scroll | 0/10 | 10/10 | – | 10/10 | 0/10 | 10/10 | – |
| LibreOffice button | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 | 10/10 | 0/10 |
| LibreOffice scroll | 0/10 | 0/10 | – | 0/10 | – | – | – |
| foot scroll | 0/10 | 0/10 | – | 0/10 | – | – | – |

Prototype = a fork build that mapped pixels through Hyprland's window list and AT-SPI hit tests, Omarchy only. "Scroll" by element on GTK writes an absolute scroll-bar value the harness supplied, since `main` reads none; GNOME's two 9/10 are the first trial writing the offset the list already had. LibreOffice and foot scroll were not run on GNOME (no readable document text there; foot has no AT-SPI).
</details>

## Testing

- `cargo test -p omp-natives --lib desktop`: 360 passed. The extended `an_element_is_read_in_two_rounds_and_only_on_its_interfaces` fails with the number read removed, with `SELECTED` ignored, and with the number asked speculatively.
- Fresh Omarchy 4.5 (Hyprland 0.56.2) and GNOME 50.6 guests, `main` and the change's first build alternating per trial while a simulated user types elsewhere; effects read from each app's own state; the user's line and focus untouched in 260/260 · 240/240. That build also asked elements whose interfaces cannot be read for a number: the scroll bars measured list `Value`, as their `setValue` requires; the sliders were not re-measured on this head.
- `ax()` of six test windows on both desktops grew 0 to 38 characters (a GTK 4 scrolled area, Chromium's resize handles and tab).
- `rust-check` Linux, Windows and macOS pass. Not run: an X11 session (same `read_element` path), progress bars (same interface as sliders).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
