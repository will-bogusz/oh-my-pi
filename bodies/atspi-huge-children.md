## What

I stopped the Linux accessibility reader from asking an app to construct every child of a huge table just to return a bounded tree.

Against current main (`bcd5b0b996e`), a million-row Qt table now returns a truncated snapshot in about 1.3-1.5 s while the app keeps answering. After #18914, OMP itself no longer hangs on main: the read times out, but the app still freezes processing the unbounded request.

| Qt 6.12 `QTableView`, 1,000,000 rows, 3 columns | Current main | This PR |
|---|---|---|
| One run per side, n=5 fresh app instances | 5/5 `Timeout`, 5.004-5.006 s | 5/5 snapshots, 1.315-1.452 s |
| Returned tree | No tree | 799 nodes, truncated, 3,999,206 children unread |
| App afterwards | No AT-SPI answer; main-loop heartbeat about 10 s stale | Answers AT-SPI; heartbeat under 19 ms old |

Above 5,000 children the reader asks for only the indices its remaining node budget can visit, instead of `GetChildren`. Smaller known lists are read as before. The same cap applies to focused-element searches and `el.children()`.

## Why

Qt answers `GetChildren` by constructing and keeping an accessible object for every cell and row header. A million-row, three-column table reports 4,000,004 children; asking for all of them freezes the app even when the caller times out. GTK 3 also refuses very long whole-list replies.

The bounded reader preserves #18914's timeout/cancellation boundary:

- A bounded list reports the children left unread by the node budget.
- An unknown count leaves the children unread, never falling back to the whole-list request. Failed indices also mark the result incomplete; if all indices fail, the read errors.
- A batch that exceeds the request bound returns `Timeout`, not a partial list that looks complete.

Application-root enumeration still asks for all children. This changes table/element traversal, not that enumeration. `el.children()` still returns at most 5,000 without a separate marker; its parent's `childCount` exposes the total. A focused cell beyond the first 5,000 children of an unfocused container is not found.

## Testing

The live comparison above uses Ubuntu 22.04 on goliath, Qt/PyQt 6.12, a `QMainWindow` containing the table, and the real AT-SPI `ax::snapshot` path. Each side ran once with five fresh app instances; no model ran. An app-main-loop timer independently recorded its heartbeat.

Re-run on current main on Linux: `cargo test -p pi-natives --lib desktop::linux` and `cargo test -p pi-natives --lib desktop::ax`, including the long-list, unanswered-app and cancellation regressions; Linux `rust-check` passed. The unknown-count and failed-index regressions both fail with the original unsafe helper restored.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
