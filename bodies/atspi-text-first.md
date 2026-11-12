## What

I made Linux `el.type` put text straight into GTK fields and Qt text editors through accessibility, because the key path kept landing the agent's text in whatever field the user was typing in.

While a user typed elsewhere, X11 GTK and Qt fields got exact text 0/10 on `main`, versus 70/70 here with no user characters lost. On KDE Wayland, `main` refuses; this PR delivers 10/10.

**X11** (GNOME/mutter), a simulated user typing in another window throughout:

| Field | `main`: exact text | `main`: success reported, text wrong | user characters lost | this PR: exact text | user characters lost |
|---|---|---|---|---|---|
| GTK 3 entry | 0/10 | 10 (5 typed into the user's field) | 14 | 30/30 | 0 |
| GTK 4 entry | 0/10 (`AxFailed` after takeover) | 0 | 21 | 10/10 | 0 |
| Qt 6 plain-text edit | 0/10 | 10 | 26 | 30/30 | 0 |
| Qt 6 line edit | 0/10 | 10 | 22 | 0/10, keys as on `main` (question below) | 23 |

**KDE Plasma Wayland**, same setup:

| Field | `main` | this PR: exact text | focus changes | user characters lost |
|---|---|---|---|---|
| GTK 3 entry | refused, 0/10 | 10/10 | 0 | 0 |
| GTK 4 entry | refused, 0/10 | 10/10 | 0 | 0 |
| Qt 6 plain-text edit | refused, 0/10 | 10/10 | 0 | 0 |
| Qt 6 line edit | refused, 0/10 | refused, naming the validator reason | 0 | 0 |

**No route, unchanged:** Chrome and Electron fields lack the interface, Firefox 160 accepts the write and keeps its old text, and LibreOffice took it once in 10 tries, so all three keep `main`'s behaviour, as does non-ASCII text.

**Beyond the fix:** a GTK 4 entry records no undo step for inserted text, where typing records one; declining GTK 4 is one condition if undo parity outweighs delivery.

## Why

On X11, `el.type` sends background keys only to focused GTK 3 elements; otherwise takeover races the user's typing. Wayland cannot focus another app's field, so `main` refuses. AT-SPI inserts need no focus or keys; read-back checks success.

Text replaces the selection or enters at the caret; unfocused GTK entries are replaced whole, matching focus-and-type. Only GTK and Qt multi-line edits take this route; other or unreadable toolkits keep keys.

**Question for the maintainer: Qt single-line fields.** Qt applies an accessibility insert to a line edit, spin box, date edit or combo box editor as `setText` (`QAccessibleLineEdit::insertText` in qtbase `simplewidgets.cpp`, Qt 5.15 and 6), skipping the validator and input mask, with no `textEdited`, undo or modified flag.
- A, route everywhere: Qt line edits get the exact text on X11 (9/9, 0 user characters lost), but digits-only line edits, spin boxes and combo editors stored "AB" and reported success (5/5 each).
- B, decline (shipped): validators hold (30/30 per widget), but Qt line edits keep `main`'s takeover on X11 (0/10 exact, 23 user characters lost) and stay refused on Wayland.

`setValue` takes the same write on a Qt single-line field: on `main` it stores the text without `textEdited` and reports success (Qt 5 and Qt 6 `QLineEdit`, unfocused, 20 of 20; Ubuntu 22.04 Xvfb microVM), and a validator is bypassed as for typing (QTBUG-152232). If you pick declining for `el.type`, `setValue` should decline the same fields; that is one condition in `set_value`.

## Testing

Real OMP runs on Ubuntu 24.04 X11 and KDE Plasma Wayland, with QEMU keys typing elsewhere throughout and no-agent controls (0 characters lost). A false success triggered 30 runs per arm.

- On current main 9f728bd56e (goliath): `cargo test -p pi-natives --lib desktop::` 308 passed (`desktop::linux` 104), 30 ignored; Linux `scripts/rust-check` passed. The insert test in `linux/ax.rs` fails without the Qt decline (a Qt line edit holding "12" takes "AB"), without the toolkit check, and with unfocused GTK entries left on their caret.
- Not run: GNOME Wayland, Qt 5 on Wayland.

<details><summary>Field semantics per widget: route on every field vs this PR (n=5 per input; n=30 where the route broke something)</summary>

| Widget | Route on every field | This PR |
|---|---|---|
| Qt 5 and 6 `QLineEdit` | text stored; no `textEdited`, undo or modified | declined; keys keep all three |
| Qt 5 and 6 `QLineEdit` + `QIntValidator` | "AB" stored, success reported | declined; "AB" rejected |
| Qt 6 input mask `999` | edit state lost; read-back `AxFailed` | declined |
| Qt 6 `QSpinBox` / `QDoubleSpinBox` | "AB0" / "AB0.00" stored, success reported | declined; letters rejected |
| Qt 6 editable `QComboBox` editor | validator bypassed, edit state lost | declined |
| Qt 6 `QDateTimeEdit` | "AB01/01/2000 12:00" stored, then `AxFailed` | declined |
| Qt 6 QML `TextField` | no route (no editable-text interface) | keys, as on `main` |
| Qt 6 `QTextEdit` / `QPlainTextEdit` | `textChanged`, `contentsChange`, undo, modified all set | same |
| GTK 3 entry, `insert-text` handler rejecting letters | `changed` fires, letters rejected | same; unfocused "hello" becomes "AB", as on `main` |
| GTK 4 entry, same handler | `changed` fires, letters rejected, no undo step | same |
| GTK 3 / GTK 4 spin button | shows "70" for "7" at the unfocused caret | shows "7", commits on focus-out, as on `main` |

Qt 6.10.1 (PySide6), Qt 5.15.13 (PyQt5), GTK 3.24.41, GTK 4.14.5. The measured builds carried a run note in the TypeScript worker, since dropped; the native route is the one in this diff.

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

