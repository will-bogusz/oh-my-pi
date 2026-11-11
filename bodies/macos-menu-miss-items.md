## What

I wanted a menu bar path that misses to tell the agent what the menu does offer, so its next call can pick a real item instead of reading the menu first.

`menu.select()` and `menu.items()` now append offered labels to missing-path errors on macOS, Linux (AT-SPI) and Windows. Shared matching distinguishes a miss from ambiguity, and the menu-bar and open-menu listings share double-quoted titles, disabled markers and submenu arrows. Menu-bar diagnostics show at most 40 labels, each cut to 80 characters by the existing truncator; error codes and successful matching are unchanged.

On macOS, a miss after activation uses the existing bounded menu-revalidation wait before reporting item states. Successful matches retain their existing dispatch checks.

## Why

An agent guessing `Export…` where an app says `Export as PDF…` previously got only a refusal and needed another call to read available choices. Open menus already provided this context; menu-bar paths did not.

## Testing

The original TextEdit VM probe produced bare errors on main (3/3) and offered-label lists with this change (3/3). Current Rust regressions cover missing and ambiguous labels, disabled/submenu annotations, caps, Unicode truncation, and delayed macOS revalidation. Run `cargo test -p pi-natives --lib desktop::menus::tests` and `cargo test -p pi-natives --lib desktop::macos::ax::menus::tests`. Linux, Windows and macOS clippy/rustfmt checks pass on the changed Rust lines.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
