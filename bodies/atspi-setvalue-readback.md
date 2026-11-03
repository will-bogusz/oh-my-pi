## What

In Firefox and Thunderbird on Linux, `setValue()` reported success while the field kept its old text, so I made it read the text back and fail naming what the field holds, as it already does on macOS.

| Live, Fedora 44 guests | `main` | this PR |
|---|---|---|
| Firefox 159 form field holding "old" (GNOME, KDE) | OK; the page still shows "old" | `wrote "omp ä€"; the field now reads "old". The app may have reformatted it or not taken it: …` |
| Thunderbird 158 account setup, Full name | OK; the field stays empty | fails, `the field now reads ""` |
| Firefox password field holding 7 characters, `setValue("1234567")` and `("xyz")` | OK both times; it still reads `●●●●●●●` | fails: `the secure text field's value could not be confirmed …`, no text quoted |
| GTK3 password entry, a GTK4 entry with visibility off (role `text box`) | OK | OK, `hunter2` and `pä😀x` read back as `●●●●●●●` and `●●●●` |
| LibreOffice Writer paragraph (GTK3 and KDE builds), GNOME Text Editor (GTK4), Kate, a GTK3 entry | OK | OK, the text read back |

- `linux/ax.rs` `write_text`: after `SetTextContents` answers true, reads the element's whole text (`text_contents`, without zbus's property cache) and passes only on an exact match, judged by `text_readback`.
- A field that hides its text reads back one repeated mask character (`●`, `•`, `*` …) per character, or per UTF-16 unit as Qt masks. That is decided from what it reads, whatever its role: GTK4 gives a hidden entry without the password purpose a plain text role. Such a field passes only if it then reads back empty after a write of `""` and masks the value after a second write, since old text of the same length shows the same mask.
- A field that reads back masked, has the password role, or whose role can't be read gets an error that quotes no text.
- `text_readback` and `truncate_chars` move unchanged from `macos/ax.rs` to `desktop/ax.rs` with their four tests, so both backends judge and word it alike.

## Why

Gecko answers `SetTextContents` true and changes nothing, in the foreground too: the form's own script still read "old". Exact equality is macOS's rule: a field that shows a rewritten value has not been shown to hold what was sent.

Decisions:
- **One read right after the write, no retry.** GTK, Qt and LibreOffice apply the write before they answer, and Gecko never applies it. A masked field costs two more writes and reads.
- **Numeric `Value` writes are unchanged.** Every one tried took effect (Dolphin's zoom slider, LibreOffice's scroll bar).

Risks: a Qt `NoEcho` field reads back empty, so a write to it now fails as unconfirmed where `main` said OK. A GTK4 entry whose invisible character is set to none also reads back empty with a plain role, so its error would quote the sent text; AT-SPI shows nothing else about it. Only single-line values were written live.

## Testing

- Live in Fedora 44 KVM guests (GNOME Shell 50.6 and Plasma 6.8.2) through the real path (`AgentSession` → eval → `computer` prelude → pi-natives), `main`'s addon against this branch's; the GTK3 and GTK4 entries come from small PyGObject windows, the Firefox password field from a local page.
- `a_text_write_the_app_ignores_fails` serves GTK-, Gecko- and Qt-like fields over a peer-to-peer D-Bus connection: plain, password, a password holding text of the same length, a Qt mask per UTF-16 unit, a hidden GTK4 entry with a text role that applies or ignores the write, and elements without a readable role or `Text`. It fails with the read-back removed, the clear-first step removed (the same-length case passes), the UTF-16 count removed, or the masked read-back no longer redacted (the error quotes the value).
- `cargo test -p pi-natives --lib -- desktop::`: 212/212 on Linux. `scripts/rust-check`: linux, macOS and Windows clean.
- Not run: the full `bun check`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
