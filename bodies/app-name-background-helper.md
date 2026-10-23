## What

I kept seeing omp's Contacts work on a Mac start with an error, because macOS has a hidden helper that is also called Contacts, so I made `apps.open("Contacts")` just open the Contacts app.

On macOS, `computer.apps.open("Contacts")` failed as ambiguous 9 times in a day of agent runs on macOS 26 (GPT-6.1 Sol), in every run that opened Contacts by name, and 0 times when the same tasks ran again with this change; it now opens `/System/Applications/Contacts.app`. `apps.open("Messages")` failed the same way while Messages ran, and now opens Messages.

```
InvalidTarget: application "Contacts" is ambiguous; use an exact native path
(matches include "/System/Applications/Contacts.app" and
"/System/Library/CoreServices/PeopleViewService.app")
```

| Name | Also matched on `main` | Opens now |
|---|---|---|
| Contacts | `PeopleViewService.app`, an agent app (`LSUIElement`) whose localized name is "Contacts" | Contacts.app |
| Messages (while running) | `Messages Assistant Extension.appex`, a running app extension | Messages.app |
| two regular apps with one name | | the same error, naming those two |
| helpers only (Screenshot: `screencaptureui.app` and `Screenshot.app` both declare `LSUIElement`) | | the same error |

When a display name matches several entries and exactly one is a regular app, `apps.open` picks it. A helper is an agent app (`LSUIElement`), a background-only app (`LSBackgroundOnly`) or a running bundle that is not an `.app`. Exact IDs and paths resolve as before.

Reading order: `resolve_by` and `is_helper` in `crates/pi-natives/src/desktop/applications.rs`, then `is_helper` in `crates/pi-natives/src/desktop/macos/applications.rs`.

## Why

Every agent that hit the error spent one call on it and a second opening the app by path; when the call was batched with other work, that work was thrown away with it.

I didn't drop helpers from the inventory: `apps.list` still shows them and an exact ID or path still opens one. Only the name tie-break reads their flags, and only for the entries that tied, so a unique name costs nothing extra. Linux and Windows inventories have no such kind of entry, so they are unchanged.

## Testing

- `agents_background_apps_and_extensions_lose_a_shared_name_to_the_app` (macOS) writes real bundles to a temp dir (`LSUIElement` as `<string>1</string>` and `<false/>`, `LSBackgroundOnly` as `<true/>`, an `.appex`) and resolves through the real plist reader; it fails with that reader stubbed to `false`.
- `a_name_shared_with_helpers_names_the_regular_app` covers the tie-break and that a two-app error names the two apps, not the helper.
- The same macOS 26 agent tasks (GPT-6.1 Sol) rerun with this branch merged: the Contacts ambiguity error went from 9 hits to 0.
- On a macOS 26 Mac, a throwaway (uncommitted) test over the real inventory: Contacts → `/System/Applications/Contacts.app`, Messages → `/System/Applications/Messages.app`, Finder unchanged, Screenshot still ambiguous.
- `cargo test -p pi-natives --lib desktop::applications` (13 pass on macOS); `scripts/rust-check` clippy and rustfmt on macOS and Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
