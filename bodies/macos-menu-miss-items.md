## What

I wanted a menu bar path that misses to tell the agent what the menu does offer, so its next call can pick a real item instead of reading the menu first.

`win.menu.select(["File", "Export…"])` and `win.menu.items(["File"])` with a label no item has failed with only `menu item 'Export…' was not found`. A menu opened by a press (`el.press({ menu: […] })`) already lists its items on a miss; the menu bar did not. `match_offered` wraps `match_index` for one level of a menu bar path: on a miss it appends `; this menu has 'New', 'Open…', … and N more` (at most 40 labels, each cut to 80 characters, so a History or Open Recent menu stays readable). An ambiguous label, a disabled item and a match behave as before, and the error code is unchanged. It is used at every menu bar level on macOS, Linux (X11 and Wayland, through AT-SPI) and Windows; the open-menu path keeps its own listing.

## Why

An agent that guesses a label (`Export…` where the app says `Export as PDF…`) gets a bare refusal and has to spend a call reading the menu before it can try again.

## Testing

TextEdit in a macOS 26.5.2 VM, Finder in front, addon swapped into `@oh-my-pi/pi-coding-agent`: `win.menu.select(["File", "Nope"])` on main says only `menu item 'Nope' was not found` (3/3); on this branch it goes on `; this menu has 'New', 'Open…', 'Open Recent', 'Close', …` (3/3). `select(["Nope", "X"])` and `items(["Nope"])` now name the top-level menus (`'Apple', 'TextEdit', 'File', 'Edit', 'Format', 'View', 'Window', 'Help'`). `a_menu_bar_miss_names_the_labels_on_offer` passes here; its assertions against main's `match_index` fail there (the message ends at "was not found"); it also covers the ambiguous case, the 40-label cap and the per-label cut.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
