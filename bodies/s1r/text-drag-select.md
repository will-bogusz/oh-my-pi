## What

Dragging across a sentence in TextEdit never needed the mouse, so instead of refusing it or taking over the app I'm typing in, the agent now just sets that selection through accessibility.

A background drag across a TextEdit document's text went from `BackgroundUnavailable`, whose takeover retry pulled the user out of their app and typed 3 of their 15–16 keys over the agent's new selection (5/5), to the same selection made in 0.34–0.44 s with every user key landing in their own app and that app kept in front (10/10).

| Background left drag while the user types in another app | before | this PR |
|---|---|---|
| across text in one native text view (TextEdit) | `BackgroundUnavailable` | selected through accessibility, no mouse event; `drag` returns `{ start, length, text, focused }` and prints `drag selected "…" through accessibility instead of dragging` |
| pressing on selected text, a link or an attachment in that view | `BackgroundUnavailable` | still `BackgroundUnavailable` (it would pick the item up) |
| Chrome page text, links, draggable page elements, Finder files | `BackgroundUnavailable` | still `BackgroundUnavailable` |

Reading order: `macos/input.rs` `drag_selection`, `selecting_drag` → `ax/selection.rs` `select_dragged`, `character_caret`, `dragged_range`, `write_selection` → `desktop/mod.rs` `Request::Drag` → `worker.ts` `Win.drag`.

## Why

Background left drags run only from sliders, scroll bars, splitters and steppers: any other press can pick up an item into a drag-and-drop session that macOS finishes at the user's real pointer. A drag across text needs no press. Each end becomes a caret from `AXRangeForPosition` and `AXBoundsForRange` (before the character on its leading half, after it on the trailing half), and the range is written as `AXSelectedTextRange` through `selectText`'s verified write. No mouse event, no session.

Decisions:
- **Chrome page text keeps the refusal.** Chrome applies `AXSelectedTextMarkerRange` only to editable nodes, `AXTextMarkerForPosition` answers nothing, and character bounds exist only after `AXEnhancedUserInterface` switches all of Chrome into screen-reader mode.
- **Posting the drag when the press lands on plain text** was rejected for the same reason the drag gate exists: which presses start a session is up to each app.
- **`takeover: true` still posts a real drag**, for dragging text to move it.

Maintenance: an app whose text view answers those two queries wrongly (Chrome's own views answer `(0, 0)` with empty bounds) fails the bounds check and keeps the refusal; nothing else changes on its drags.

## Testing

On a macOS 26.5 VM, a scripted computer-tool cell drags in app B while a simulated user types a letter every 125 ms into the rig's receiver app A and wiggles the real pointer over it. Before = the drag gate (f2f8fd0c5d); each refusal retried with `takeover: true` as `computer.backgroundFallback` does:

| B, drag | n (before / this PR) | before | this PR |
|---|---|---|---|
| TextEdit, across a line of text | 5 / 10 | refused; takeover: A loses focus 5/5, 3 of 15–16 keys typed into B over the selection | `"ck brown fox jumps"` selected 10/10; A keeps focus and every key 10/10; B's text unchanged |
| TextEdit, starting on selected text | 3 / 6 | refused; takeover: A loses focus | the same |
| TextEdit rich text, starting on a link | 3 / 5 | refused | refused: the press lands on an `AXLink` |
| Chrome text, link, draggable card; Finder file | 5 each | refused; takeover: A loses focus, nothing dropped into A | the same |

The AX caret placement selected exactly what a real drag between the same points selected on 6 of 6 point pairs (reversed, across lines, past the line's end).

`cargo test -p pi-natives --lib -- desktop::` (308 pass), `bun test packages/coding-agent/test/tools/computer.test.ts` (73 pass). Each new test fails with its change removed: the session posting the drag, the selected-text check, and the old `Win.drag`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
