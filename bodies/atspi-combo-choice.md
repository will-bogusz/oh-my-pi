## What

I made Linux combo boxes get their option chosen through accessibility instead of being pressed open, because opening a GTK 3 or Qt combo box's list grabs the keyboard and a user typing in another window loses their keys to it.

While a user types in another window, `press()` on a GTK 3 or Qt combo box: the list opened and the user lost keys 29 of 29 times on `main`; refused with nothing sent and no key lost 29 of 29 with this PR. `setValue("Two")` on a combo box: refused 80 of 80 times on GTK 3 and Chromium on `main`; chosen 80 of 80 with this PR.

| Call on a Linux combo box | `main` | This PR |
|---|---|---|
| `press()` | opens the list; GTK 3 and Qt hold the keyboard until it closes | refused with nothing sent, naming the options and the route |
| `setValue("Two")` | "AT-SPI element has no writable value interface" | GTK 3, Chromium: the option titled exactly `Two` is chosen with no popup and read back; Qt: refused, naming the options |
| `press({ menu: ["Two"] })` | "available only on macOS" | same as `setValue("Two")` |

## Why

An accessibility press of a GTK 3 or Qt combo box opens its list as a popup window that takes an X keyboard grab, so every key goes to the popup until it closes, wherever the user was typing; the call returned success and left it open.

A closed combo box already publishes its options. GTK 3 lists them as the items of a `Menu` child and Chromium a `<select>`'s likewise; performing an option's own action (`click`, `select`) chooses it with no popup, and the combo box (GTK 3) or its list (Chromium) then reports the choice through the `Selection` interface. `combo_choose` (`crates/pi-natives/src/desktop/linux/ax/combo.rs`) does that, matching titles exactly as macOS does for a popup button, and reads the choice back for up to 500 ms before answering `AxUnconfirmed`. Qt lists its options as rows whose only action, `Toggle`, selects the row in the hidden list without choosing it, and publishes no selection, so Qt is refused before anything is sent.

Rejected: waiting for the user to stop typing before the press. Nothing on the accessibility path sees the user's keys, and the popup would still hold the keyboard after the call returned. A plain press is refused on every combo box, Chromium's included (its list took no grab here), so a press never leaves a list open, as on macOS.

Builds on `atspi-unanswered-app` (queued), whose reply timeout bounds every call here.

## Testing

Capability-matrix cells, Ubuntu 22.04 arm64 microVM (Xvfb, openbox, GTK 3, Qt 5, Qt 6, Chromium 156), the real eval path, n=10 per cell, the fixture's own state and a simulated user's keystrokes as truth. Both arms carry PR 18823, without which `main`'s reads crash these apps; one Qt 6 trial was voided by its block's control.

| Cell | `main` | This PR |
|---|---|---|
| `press()` on the combo box while the user types elsewhere: GTK 3, Qt 5, Qt 6 | list opened, user's keys lost 29/29 | refused, nothing sent, no key lost 29/29 |
| `setValue("Two")`, focused / unfocused / covered / user typing: GTK 3 | refused 40/40 | chosen 40/40 |
| same: Chromium `<select>` | refused 40/40 | chosen 40/40 |
| same: Qt 5, Qt 6 | refused 80/80 | refused 80/80, naming the options |


- `a_combo_box_option_is_chosen_without_opening_its_list` serves GTK 3-, Chromium- and Qt-shaped combo boxes over a peer-to-peer D-Bus connection: setValue and `press({ menu })` perform only the matching option's action and confirm it, an unknown title lists the options, a press is refused without performing the combo box's own action, Qt performs nothing, and an app that ignores the action ends `AxUnconfirmed`. It fails with the setValue branch removed (the parent's "no writable value interface") and with the press refusal removed.
- `cargo test -p pi-natives --lib -- desktop::linux::ax` on Linux on current main bcd5b0b996e: 28 passed. `scripts/rust-check` on Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
