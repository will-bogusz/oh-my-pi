## What

Codex [flagged this on #15574 after it merged](https://github.com/can1357/oh-my-pi/pull/15574#pullrequestreview-5560711886): a cancelled or timed-out `computer` call on macOS could still start the window lookup for its stale-ref search, and for a sheet, popover or menu that lookup walks up to 5,000 accessibility nodes without ever checking for the cancel, so I check before the lookup and on every node of it.

When an action hits a destroyed ref, the session searches the ref's window for its one replacement (`ax::refind`), after the call has released input. That search's tree walk already stops on cancel; the root lookup in front of it did not:

- `ax::refind` now checks the operation token before `backend.window_root`, so a cancel that lands during the `destroyed()` probe or the window lookup in `name_match` ends the search there.
- macOS `attached_window`, the bounded walk that finds a sheet, popover or open menu, checks the token on each node. It sits under `find_window`, so any lookup of such a window by a cancelled call now ends with `Cancelled` instead of finishing a scan whose result nothing reads. Inside `control::cleanup` the check passes, as it does everywhere.

## Why

The session runs one request at a time. A cancelled call stuck in an uncancellable 5,000-node scan keeps the next request waiting behind it, even though its input lease is already released.

The CHANGELOG line covers the window lookup, which every released version runs uncancellably; the stale-ref search itself has not shipped yet.

## Testing

- `a_cancelled_search_does_not_look_up_the_window` (`desktop/ax.rs`): a ref proven unique, its element rebuilt, the run cancelled, then `refind`. It returns `Cancelled` and the mock backend saw no `window_root` call. With the new check removed it fails: `window_root` runs once before the walk reports the cancel.
- `cargo test -p pi-natives --lib` and `CI=1 bun run check:rs` on macOS arm64.
- Not exercised live: cancelling during a real sheet lookup needs an app whose AX tree is slow enough to cancel into; the per-node check is the same `control::check()` the refind walk already uses.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
