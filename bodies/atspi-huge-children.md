## What

I made the Linux accessibility reader stop asking an app for every child of an element that has thousands of them, because one `ax()` of a window holding a long Qt table froze the app for up to 45 s, left it over 1 GB larger and cut it off the accessibility bus for the rest of its life.

`ax()` of a Qt 6 window with a 1,000,000-row table went from 45 s, with the app frozen and gone from AT-SPI, to 1.0 s with the app untouched; the tree now ends with how many children were left out.

| Qt 6 `QTableView` (3 columns) | `main`: app stall, memory, still on the bus | this PR | `ax()` `main` → this PR |
|---|---|---|---|
| 10,000 rows | 1.0 s, +17 MB, yes | 0.7 s, +1 MB, yes | 6.6 s → 1.0 s |
| 100,000 rows | 4.4 s, +166 MB, yes | 0 s, +1 MB, yes | 7.4 s → 0.9 s |
| 1,000,000 rows | 45 s, +1,244 MB, **no** | 0 s, +1 MB, yes | 45 s → 1.0 s |

## Why

OMP read an element's children with one `GetChildren` call on every element it walked, in the focused-element search and in `el.children()`. Qt answers that call by building and keeping an accessible object for every child, with no cap, and a table reports one per cell and row header (4,000,004 for a million rows); at that size the reply outgrows the bus's message limit and the bus drops the app. GTK 3 refuses lists over 65,536, so a 100,000-row `GtkTreeView` showed as an empty window and `find()` found nothing in it.

Above 5,000 children, OMP now asks for children one at a time by index, as libatspi clients do, and only as many as the walk can still visit; smaller elements are read as before. `ax()`'s truncation line adds the count left unread.

<details><summary>Reading order (crates/pi-natives/src/desktop/)</summary>

- `linux/ax.rs` `MAX_CHILDREN`, `children_of`: one `GetChildren` up to 5,000 children (or when the count is unreadable); above that the first `limit` by `GetChildAtIndex`, 256 in flight, a child that fails dropped, all failing an error.
- `backend.rs` `AxBackend::walk_node` takes `max_children`, the walk's remaining node budget; `linux/ax.rs` `walk_node` passes it with the `ChildCount` `read_props` already read, so ordinary trees make no extra call.
- `ax.rs` `AxProps::unread_children`, `walk_raw` (marks the walk truncated, sums the count; 0 children asked past the depth limit), `snapshot`'s trailer.
- `linux/ax.rs` `find_focused` reads `ChildCount` beside `GetState` and the children through `children_of` capped at 5,000; `children()` (`el.children()`) the same.
- macOS, Windows and the test backends take the parameter and ignore it.

</details>

## Testing

Fedora 44 KDE Wayland guest, Qt 6.11.2, PyQt fixture tables, through the eval `computer` path with no model; app stall is the longest gap of a 20 ms timer on the app's main loop.

| Also | `main` | this PR |
|---|---|---|
| Qt 6 `QTableWidget`, 1M rows: `ax()` | 12.8 s, app +1,245 MB, dropped from the bus | 1.0 s, +1 MB, stays |
| GTK 3 `GtkTreeView`, 100k rows: `ax()` / `find()` | window only / 0 found | 800 nodes / 4,994 found |
| Dolphin (723 lines, 1,352 found), `ax()` / `find()` medians of n=10, 3 alternating runs | 1.24, 1.21, 1.13 / 2.37, 2.24, 2.20 s | 1.16, 1.19, 1.11 / 2.17, 2.29, 2.10 s |

New tests: `a_long_table_is_read_up_to_the_node_budget_and_its_unread_children_counted` (`ax.rs`), and in `linux/ax.rs` `tests::long_lists` three over a peer-to-peer zbus table reporting 1,000,000 children whose `GetChildren` is counted and refused. With `children_of` forced back to `GetChildren` all three fail; without the walk's unread handling the first fails. `cargo test -p pi-natives --lib desktop::` (Linux): 256 passed.

Not changed: `el.children()` returns the first 5,000 with no marker (the parent's `childCount` shows the total), and `focusedElement()` finds no cell past child 5,000 of an unfocused long table.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
