## What

On Linux every `find()` and `ax()` asked each element about a dozen questions one after another, so a search took 1.3 to 3.7 s in LibreOffice, Kate and Dolphin; I send each element's questions together and skip the ones it can't answer, and that also makes `value()` work in Qt apps.

`find()` is about 3× faster: Kate 1.96 s → 0.63 s, LibreOffice 2.3 s → 0.79 s (GTK3) and 3.7 s → 1.29 s (KDE build).

| Live, Fedora 44 guests, median of 6 `find()` calls | elements | `main` (83de60ad992) | this PR |
|---|---|---|---|
| LibreOffice 26.2 Writer, GTK3 (GNOME 50) | 2,080 | 2.26 s | 0.79 s |
| LibreOffice 26.2 Writer, KDE build (Plasma 6.8) | 2,360 | 3.69 s | 1.29 s |
| Kate 26.08 | 1,296 | 1.96 s | 0.63 s |
| Dolphin 26.08 | 765 | 1.30 s | 0.45 s |
| `value()` of Kate's document, a LibreOffice KDE paragraph | | `undefined` | the text |

- `linux/ax.rs` `read_node` / `read_element`: one round sends name, description, role, state, interfaces and children together; the second asks text, bounds and actions, also together, only of an element that has `Text`, `Component` or `Action` (one whose interfaces can't be read is asked on each). Both rounds share one reply timeout, as a `props()` request did. `walk_node` counts `childCount` from the children read.
- An element that doesn't list `Component` is no longer asked for bounds. Qt leaves it off some elements with an empty rect; on `main` they got bounds `{0,0,0,0}`, so a click aimed at the screen origin, and now it fails with `NO_CLICKABLE_BOUNDS`.
- `text_value` reads `Text` without zbus's property cache.

## Why

A `find()` over LibreOffice made 25,000 calls in a row, about 12 per element. LibreOffice answers each in about 60 µs, yet the search took over 2 s: each call waited for the one before. About a third of them were wasted: zbus's default property cache adds a bus match rule and a `GetAll` per proxy, and `main` asked `Text` and `Action` of every element. Qt answers `GetAll` with `UnknownInterface`, so on `main` the text of no Qt element was ever read.

Decision: reading many elements at once would gain more, but needs `walk_raw`, which all three backends share, to batch; this stays inside the AT-SPI backend.

## Testing

- Live in Fedora 44 KVM guests (GNOME Shell 50.6, Plasma 6.8.2) through the real path (`AgentSession` → eval → `computer` prelude → pi-natives), `main`'s addon against this branch's, alternating twice; on the final head, LibreOffice on GNOME again took 2.1 s on `main` and 0.76 s here. `dbus-monitor --profile` counted 25,000 calls per LibreOffice `find()` on `main` and 19,700 here.
- The `main` column is 83de60ad992, before the GTK4 placement and action-name fixes; the action-name fix alone measured the same within noise.
- `an_element_is_read_in_two_rounds_and_only_on_its_interfaces` answers like Qt over peer-to-peer D-Bus, refusing `GetAll` and holding each round's replies until all of its calls have come. It checks both rounds, that a button is never asked for text, that an element whose `GetInterfaces` fails is asked on every interface, and that a read without children asks only `ChildCount`; it fails with the property cache back or the `GetInterfaces` fallback removed.
- `cargo test -p pi-natives --lib -- desktop::`: 221/221. `scripts/rust-check`: linux, macOS and Windows clean.
- Not run: X11 live (the bounds path is GTK4 placement's, unchanged), the full `bun check`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
