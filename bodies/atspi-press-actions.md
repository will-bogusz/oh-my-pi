## What

I made Linux `press()` take Chromium's own names for activating an element, `select` and `doDefault`, because it refused every ARIA menu item, list option and tab in Chrome and Electron.

Pressing a Chromium page's ARIA menu item (a context menu's "Mark"): refused 10 of 10 times on `main`, pressed 10 of 10 with this PR.

## Why

A generic `press()` looks for an activation among the element's machine action names (`action_index` in `crates/pi-natives/src/desktop/linux/ax.rs`). Chromium 156 names a menu item's, list option's and tab's activation `select`, and an element with no specific verb (a `<div>` with a click handler, a page tab) `doDefault`; both perform the page's click. The table knew GTK's `click` and `activate`, Qt's `Press` and `Toggle`, Chromium's `click`, `open`, `jump` and `clickAncestor`, and the spelling `do default`, so those elements failed with "AT-SPI action 'press' is unavailable".

The names are now compared ignoring case and the spaces, hyphens and underscores toolkits spell them with, so `doDefault`, `do default` and `do-default` are one entry (`click_ancestor` would now match too; no toolkit spells one that way). `select` is taken only when an element has none of the other activations: a GTK colour swatch lists `select`, which only marks it selected, before `activate`. Explicit `perform(name)` is unchanged.

<details><summary>Action names per widget, read from the matrix fixtures (Ubuntu 22.04 arm64)</summary>

| Widget | Machine names, in order | press takes |
|---|---|---|
| GTK 3 button, check box / combo box / entry | `click` / `press` / `activate` | 0 |
| GTK 4 label | `clipboard.copy`, `link.open`, `menu.popup`, … | none, as before |
| Qt 5 and 6 button / check box | `Press`, `SetFocus` / `Toggle`, `SetFocus` | 0 |
| Qt slider | `SetFocus`, `Increase`, `Decrease` | none, as before |
| Chromium ARIA menu item, list option | `select`, `showContextMenu` | 0 (new) |
| Chromium tab, generic element | `doDefault`, `showContextMenu` | 0 (new) |
| Chromium section, slider | `clickAncestor`, … | 0, as before |

</details>

## Testing

Capability-matrix cells, Ubuntu 22.04 arm64 microVM (Xvfb, openbox, Chromium 156, GTK 3, Qt 5), the real eval path, n=10 per cell, focused window. Both arms carry PR 18823, without which `main`'s element search crashes these apps before any press:

| Cell | `main` | This PR |
|---|---|---|
| Chromium ARIA context menu, press its "Mark" item | refused 10/10 | pressed 10/10 |
| press a button / a check box: Chromium, GTK 3, Qt 5 | 60/60 | 60/60 |


- `generic_press_takes_each_toolkits_activation` replays those lists; with `select` and `doDefault` taken out of the table it fails at the Chromium menu item.
- `cargo test -p pi-natives --lib -- desktop::linux::ax` on Linux: 14 passed. `scripts/rust-check` on Linux.
- Not run live: Firefox options and LibreOffice menu items, which also name their activation `select` and become pressable.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
