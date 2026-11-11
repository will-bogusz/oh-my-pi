## What

I found our benchmark's Contacts runs saving the city in the street field while every `computer` call reported success, so now a ref whose element has turned into another control refuses with `StaleRef` and sends nothing.

Live in Contacts on macOS 26: New Card, then `type` street, city, state and ZIP into the refs read from the empty card, one call each, no model, 10 cards per build:

| | `main` | this PR |
|---|---|---|
| values saved in the wrong field | 30 of 40 | 0 of 40 |
| wrong-field writes reported as success | 30 | 0 |
| Street typed and saved right | 0 of 10 | 10 of 10 |
| City, State, ZIP refused with `StaleRef`, nothing sent | 0 | 30 of 30 |
| Street call, median | 727 ms | 614 ms |

> **AX context.** A ref holds the accessibility element read for one control. Contacts answers an address row's elements by position: once typing the street adds a "Remove Address" button to the row, the element read as "City" answers as "Street", and so on down the row. Text goes wherever the element now answers, and the read-back from that same element confirms it.

Before an element action through a ref (`press`, `perform`, `click`, `type`, `setValue`, `selectText`, `focus`), the macOS backend reads the element's role and label, after the user's front app, and compares them with the ref's. On a mismatch it sends nothing; the error gives the element a ref as it reads now (`e108 now reads as textfield "Street" [ref=e132]`) and names the one other element that reads as the ref did, if there is exactly one. Nothing is retargeted. A text write whose element reads as another control right after it is `AxUnconfirmed`.

Reading order: `require_read_as`, `confirm_read_as`, `find_read_as` (`desktop/ax.rs`); the call sites and `read_as` under `desktop/macos/`; `Worker::execute` and `Worker::name_match` (`desktop/mod.rs`).

## Why

In six runs of one Contacts task on our benchmark (2026-11-10), four saved "10600 North Tantau AvenueCupertino" / "CA" / "95014" and the model reported the address verified. The tool prompt already says a ref lasts until its role or label changes; `AxRegistry::resolve` never checked.

- Rejected: following the control to its new element. Equal labels do not prove the same control: a version that followed rebuilt Activity Monitor rows opened the wrong process in 2 of 10 trials. In Contacts no candidate is named, since its second, empty address row also has a "City".
- Costs: a control whose own title flips (Play to Pause) is refused too; the error's new ref takes the action. Window refs, and reads the app leaves half answered, are exempt. One batched read per action; Linux and Windows unchanged.

## Testing

- Contacts: the table, a no-model script in a fresh macOS 26 VM.
- Activity Monitor (filter to "Dock", read, wait, double-click the " Dock" ref), on this branch before its review fixes (9fa8920446): after a 20 s wait 40 of 40 refused and opened nothing; after a random 0-6 s wait 23 of 30 opened Dock, 7 refused, none opened another process.
- `cargo test -p pi-natives --lib -- desktop::` passes on macOS. Of seven new tests on the fake AX backend, the four expecting a refusal or an unconfirmed write fail on `origin/main`; the three guarding against refusing (changed value, busy app, retitled window) pass on both. `rust-check` passes on macOS, Linux and Windows.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
