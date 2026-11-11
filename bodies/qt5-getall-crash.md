## What

I found that one `computer` read on Linux could kill the app being read, so the element's text is now read one property at a time, the way screen readers already do.

On Ubuntu 22.04 the first `ax()` read of a window killed GTK 3, Firefox and Qt 5 apps in 10 of 10 trials each, and Qt 5 and Qt 6.4 apps die the same way on Ubuntu 24.04; with this change all of them stay up, 30 of 30 each, at no cost per read. Text fields of current Qt apps (6.9.2 and later), which read as empty before, now show their text.

The new `text_value` builds the element's Text proxy without zbus's property cache, as `text_contents` and the Action proxy already were, so `CharacterCount` goes out as one `Properties.Get`. No other proxy OMP opens toward an app reads through a cache (table at the end).

## Why

`AtSpiAx::read_props` built the Text proxy with zbus's default lazy cache, so its first `CharacterCount` read went out as `org.freedesktop.DBus.Properties.GetAll("org.a11y.atspi.Text")`, once per element. Apps handle that request badly:

- **Qt 5 and Qt 6 before 6.9.2** segfault on it ([QTBUG-137344](https://bugreports.qt.io/browse/QTBUG-137344), in the 6.9.2 release notes). Newer Qt refuses it, so main read their text as empty.
- **GTK 3 and Firefox on at-spi2-core before 2.45** (the ATK bridge of Ubuntu 22.04, Debian 11, RHEL 9): when a getter fails, as Text's does on every element without text, the bridge leaves the reply half-written and libdbus aborts the app ([at-spi2-core#68](https://gitlab.gnome.org/GNOME/at-spi2-core/-/issues/68), fixed by [4766e3be](https://github.com/GNOME/at-spi2-core/commit/4766e3be06cef19c7bc647eae0a3af61b254dc38) in 2.45.1).

Screen readers never send this request: libatspi, which Orca reads through, asks for each property with `Properties.Get`, so apps never had to get `GetAll` right.

## Testing

| one `ax()` per trial, app alive after | main | this PR |
|---|---|---|
| GTK 3.24.33, Ubuntu 22.04 arm64 | 0/10 | 30/30 |
| Firefox 160, Ubuntu 22.04 arm64 | 0/10 | 30/30 |
| Qt 5.15.3, Ubuntu 22.04 arm64 | 0/10 | 30/30 |
| Qt 5.15.13 and Qt 6.4.2, Ubuntu 24.04 x86_64 | 0/10 each | 30/30 each |
| VS Code 1.145.3 (Electron 43), Ubuntu 22.04 arm64 | 30/30 | 30/30 |

- Ubuntu 22.04 had atk-bridge 2.38.0-3 and libatspi 2.44.0-3. Every GTK 3 and Firefox death logged libdbus's `Array or variant type requires that type variant be written, but end_dict_entry was written` right after `GetAll(Text)`; Qt died with SIGSEGV. VS Code received the same calls through the same bridge and survived.
- Cost on a 500-element window (Ubuntu 24.04, 40 reads per arm in alternating blocks): median `ax()` 783 → 719 ms for GTK 3 and 946 → 940 ms for Qt 6.12, both inside block-to-block drift. Accessibility-bus calls per read fell 5,779 → 4,775: each element loses its `GetAll` and the cache's `AddMatch`/`RemoveMatch`.
- `cargo test -p pi-natives --lib -- getall_tests` (Linux) runs `text_value` against an in-process app that answers `GetAll` with an error and fails if one arrives; it fails with the `CacheProperties::No` line removed.

Review first: `text_value` returns what the inline code did for elements without Text, empty text, errors and the 16,384-character cap; only Qt 6.9.2+ text fields change, as above.

<details><summary>Every D-Bus proxy OMP opens toward an application</summary>

| Proxy | Where | Cache | Can send `GetAll` |
|---|---|---|---|
| Text, element text | `text_value` (this PR) | none | no (was yes) |
| Text, write read-back | `text_contents` | none | no |
| Accessible | `ObjectRefExt::as_accessible_proxy` (atspi-proxies) | none | no |
| Action | `AtSpiAx::action` | none | no |
| Application | `element_focus` | none | no |
| Component, EditableText | `AtSpiAx::component`, `write_text` | none (no properties) | no |
| Value | `set_value` | lazy | no: it only sends `Set`, which never fills the cache |
| atspi peer-to-peer startup | `AccessibilityConnection::new` | none | no |

Bus-daemon and registry proxies (`DBusProxy`, `BusProxy`, `RegistryProxy`) and the raw `call_method`s in `applications.rs` never ask an app for properties.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
