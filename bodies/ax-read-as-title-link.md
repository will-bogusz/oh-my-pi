## What

I found the macOS `computer` tool refusing a click on a sidebar list cell after its own label changed with its state ("Errands, 0 reminders, Blue" to "Errands, 1 reminder, Blue"), so a ref's element whose own label changes is now accepted while it keeps its role and its title element (`AXTitleUIElement`) still reads and shows what it did when the ref was read.

No-model scripts in a fresh macOS 26 VM, 10 trials per build:

| | v18.20.0 | this PR |
|---|---|---|
| Reminders: click the list cell read before a reminder moved into it | refused 10 of 10 | clicked, list opened 10 of 10 |
| Contacts: type the city into the City ref read from the empty card, after the street | refused 10 of 10, nothing written | refused 10 of 10, nothing written |
| Fixture: rows reused in place, the ref's cell now shows its neighbour | refused 10 of 10 | refused 10 of 10 |
| Fixture: the cell's own count changes | refused 10 of 10 | clicked 10 of 10 |
| Fixture: rows reused onto a neighbour with the same title text | refused 10 of 10 | clicked the neighbour 10 of 10 |

`check_read_as` accepts a changed role-and-label fingerprint only through `still_linked`: same role, the element's current `AXTitleUIElement` CFEqual to the one it linked to when read, and that element's own role, label and shown text (`AXValue`, else its own `AXTitle`) hashing to what it showed in the snapshot that read the ref. `AxRegistry::end_snapshot` resolves that from the same walk. A title element with no label or text, one shared by several controls, or a link the snapshot did not read vouches for nothing. The title element is read only on a mismatch, inside the same front-app check as the element.

## Why

On the raw AX attributes the Reminders cell keeps its element, role, frame, parent and index while only `AXDescription` changes; its title element keeps showing "Errands". The Contacts field #18892 protects has no title element: its placeholder and frame change, so it is held exactly as before. In three benchmark runs on v18.20.0 the refused click cost a re-read and a second click each time.

- Scope: of the live-label controls read in the VM's apps, the Reminders and Notes sidebar list cells (4 of 4) link a title element; Reminders' smart-list buttons ("Today, 0 reminders"), its list header and Calculator's All Clear / Clear do not, and stay refused as before.
- Known limit, last fixture row: a row reused onto a neighbour showing the same title text reads as the same control. Reminders itself destroyed the cell when a list was deleted (2 of 2 trials each with same and different names), so its refs did not land on a neighbour.
- Rejected: an unchanged frame, which separates the two app cases too but needs bounds in every `ax()` walk and cannot tell rows of equal height reused in place.

## Testing

- `cargo test -p pi-natives --lib -- desktop::` on macOS: 616 passed, every #18892 and #19054 test included. With `still_linked` disabled, the 4 tests that expect acceptance fail and the title-link refusal tests still pass. `rust-check` passes on macOS, Linux and Windows.
- The fixture is a small AppKit table whose cells describe themselves with a count and link their title to their own text field; a signal reuses the cell views in place or bumps the first count.

Needs #19061 (it reads `AXTitleUIElement` in the batched node read).
