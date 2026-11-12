## What

I wanted the toggles of a SwiftUI settings form to carry their labels in `ax()`, so `find({ title: "Launch at login" })` finds the switch and the model can tell three switches apart.

In a grouped SwiftUI `Form` (System Settings style), a toggle's label is drawn as a separate static text and the toggle itself has no `AXTitle` or `AXDescription`; it points at its label through `AXTitleUIElement`. OMP never read that attribute, so on main every such toggle printed as a bare `checkbox [ref=e5]: "0"` beside an unattached `statictext "Launch at login"`, and a search by label found nothing.

`AXTitleUIElement` now rides in the batched node read (it sits with the identity-only attributes, so a batch that fails as a whole costs no extra lone read), and an element with neither an `AXTitle` nor an `AXDescription` of its own takes the linked element's `AXValue`, else its `AXTitle`, as its title. That costs one more AX message only for such an element that does link a label; an element's own title or description still wins, and the link is then not read. A label read the app does not answer leaves the element unnamed and without an identity, as an unanswered placeholder already does, so a `StaleRef` never names a control by a label it could not read.

The action guard still compares only the element's own fields, exactly as main does: a changed linked label alone is not refused. A linked title supplies the displayed/ref-registration name, not a new action-safety guarantee. One optional fingerprint field carries this distinction; five `AxProps` constructor sites initialize its absent value. Entries adding `AxProps` fields meet these constructor edits by adjacency and need the opener's pair build.

## Why

Settings-style SwiftUI apps put every switch in this shape, so an agent asked to turn one on could only guess which bare checkbox sat next to the right text.

## Testing

Before the current-main rebase, a SwiftUI fixture in a macOS 26.5.2 VM (`Toggle(isOn:) { Text("Launch at login") }`, `Toggle("Sync drafts", isOn:)`, and `LabeledContent("Mode") { Toggle("", isOn:).labelsHidden() }` in a grouped `Form`), addon swapped into `@oh-my-pi/pi-coding-agent`, `win.ax()`:

| | main | this branch |
|---|---|---|
| `Launch at login` toggle | `checkbox [ref=e5]: "0"` | `checkbox "Launch at login" [ref=e5]: "0"` |
| `Sync drafts` toggle | `checkbox [ref=e7]: "1"` | `checkbox "Sync drafts" [ref=e7]: "1"` |
| `Mode` toggle | `checkbox [ref=e9]: "1"` | `checkbox "Mode" [ref=e9]: "1"` |

In those historical runs, all three were bare in 14 of 14 reads on main and named in 5 of 5 on the measured branch. Two back-to-back `ax()` reads kept every ref on both builds in the SwiftUI form, Finder and Chrome (13, 148 and 33 refs; 10 pairs each, and two reads of different windows shared none). Two `ax()` reads of a window took a median of 207, 284 and 243 ms against 225, 289 and 228 ms on main in those three windows (builds alternated, 9 reads each). Live measurements were not repeated after rebasing.

`a_control_without_a_label_of_its_own_is_named_by_its_linked_label` covers the label read (value, title fallback, an unanswered read, no link); `a_field_without_a_label_is_named_by_its_placeholder` now also shows an own description beating a link and an unanswered link leaving no identity. Both need this branch's `linked_label`, so main's failure is the live table above rather than a test.

Re-run on current main on bench-mac: `cargo test -p pi-natives --lib desktop::macos` passed 356 tests; `cargo test -p pi-natives --lib desktop::` passed 602. macOS `rust-check` passed clippy and rustfmt. The naming tests and three action-guard tests pin an own label disappearing while a link is unread (refused), only the linked label changing (accepted), and an unchanged linked-labelled control (accepted).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
