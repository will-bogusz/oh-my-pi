## What

I made macOS element clicks find the window of a suggestion list, so clicking a row of Safari's password autofill dropdown by its element or ref fills the login instead of failing.

| Safari autofill dropdown, 10 tries each | `main` | this branch |
|---|---|---|
| `elementAt(row).click()` | `AxFailed: AX element has no identifiable owning window`, nothing filled | filled (user and 14-character password) |
| ref click on a row from `window(id).ax()` | same failure | filled |

An element's window is still its `AXWindow`, else the nearest `AXWindow` above it. Only when neither exists does the lookup now climb the `AXParent` chain to the nearest element the app lists in `AXWindows`, which is how `window(id).ax()` already finds that window; the id is then checked against the window list by number and pid, as before.

## Why

The dropdown is a small window of Safari's own process. Safari lists it in `AXWindows` as a scroll area whose parent is the application, so its rows have no `AXWindow` and no window ancestor. `computer.windows()` lists it and `window(id).ax()` returns its rows, but clicking one of those rows failed, which reads as "flaky" to an agent that only clicks elements. A pixel click on the window worked all along.

## Testing

- macOS 26.5.2 VM, Safari with a saved throwaway login, 10 tries per route on `main` and on this branch. Fields were read back through the page's accessibility tree after each click: user `probe-user`, password 14 characters, dropdown closed. Pixel clicks, typing and Escape behave the same on both.
- A SkyLight/AX probe in the VM confirmed the shape: the dropdown's `AXWindows` entry is an `AXScrollArea` with the dropdown's window id, and its rows (`statictext > cell > row > table > scroll area > application`) report no `AXWindow` or `AXTopLevelUIElement`.
- `cargo test -p pi-natives --lib -- an_element_belongs_to_the_nearest_listed_window_above_it` passes; with the ascent removed (only the element itself checked, as on `main`) it fails.
- Not found: two other apps' lists are different kinds. TextEdit's completion window is not in `AXWindows` (`window(id).ax()` fails on it too), and Finder's search suggestions are a menu. Safari's dropdown is the only window of this kind I found.
- `rust-check` on macOS and Linux.

---

- [ ] `bun check` passes (no TypeScript changes)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
