## What

I made Linux `el.type` put text straight into GTK fields and Qt text editors through accessibility, because the key path kept landing the agent's text in whatever field the user was typing in.

With a user typing in another window on X11, GTK and Qt text fields got the exact text 0 of 10 times on `main` (GTK 3 reported success after typing into the user's own field 5 times, and the user lost 14 to 26 characters) and 70 of 70 times with this PR, with no user characters lost. On KDE Wayland, where `main` refuses element typing, they take it 10 of 10.

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

The field ends as focusing it and typing would: the text replaces the selection or goes in at the caret, and an unfocused GTK entry is replaced whole, since focusing one selects it. Only GTK and Qt multi-line edits take the route; other toolkits, and apps whose toolkit cannot be read, keep keys.

**Question for the maintainer: Qt single-line fields.** Qt applies an accessibility insert to a line edit, spin box, date edit or combo box editor as `setText` (`QAccessibleLineEdit::insertText` in qtbase `simplewidgets.cpp`, Qt 5.15 and 6), skipping the validator and input mask, with no `textEdited`, undo or modified flag.
- A, route everywhere: Qt line edits get the exact text on X11 (9/9, 0 user characters lost), but digits-only line edits, spin boxes and combo editors stored "AB" and reported success (5/5 each).
- B, decline (shipped): validators hold (30/30 per widget), but Qt line edits keep `main`'s takeover on X11 (0/10 exact, 23 user characters lost) and stay refused on Wayland.

If the maintainer picks decline for `el.type`, `setValue` should decline the same fields.

## Testing

Real OMP runs in Ubuntu 24.04 X11 and KDE Plasma Wayland guests, with QEMU keys typing into a second window for each whole trial and no-agent controls around each cell (0 characters lost). A false success on one arm meant 30 runs before the other was called clean.

- `cargo test -p pi-natives --lib -- desktop::`: 255 passed. The insert test in `linux/ax.rs` fails without the Qt decline (a Qt line edit holding "12" takes "AB"), without the toolkit check, and with unfocused GTK entries left on their caret.
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

