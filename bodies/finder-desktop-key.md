## What

I made macOS background input and takeover work while Finder is in front with its focus on the desktop and one of its windows open. Before, every input in that state was refused before anything was sent.

On main, after a click on the desktop with a Finder window open, `win.press('shift')` on a TextEdit window throws `InputFailed: … cannot establish the user's key window for background focus restoration, and the takeover failed: cannot identify the previous key window for takeover restoration; no input was sent`, and `{takeover: true}` throws the second half. With this PR both go through, and Finder stays in front with its focus still on the desktop. On a computer-use benchmark task that moves between Chrome and a Finder folder window, an OMP run failed this way on each of three dates, since no desktop input worked for the rest of the run.

> **macOS context.** After a click on the desktop, Finder reports the desktop (an `AXScrollArea` that `_AXUIElementGetWindow` cannot map) as both its `AXFocusedWindow` and `AXMainWindow`. Main restores the user's app with its key window, or with only its front status when the app provably shows no window. Finder with a window open fitted neither case, so nothing could be put back afterwards and the input was refused.

Reading order: `restorable_key` and `takeover_key` in `crates/pi-natives/src/desktop/macos/skylight.rs`, then `ax::restoration_window`.

## Why

- An app whose focused window is no window at all now counts as `UserKey::OutsideWindows`. Like the windowless case, only its front status is restored, which leaves its focus where it was.
- Takeover of another window of that same app is still refused, now with a message that says why: it makes that window key, and no window could hand the desktop focus back.
- Only an unmapped `AXScrollArea`, the desktop's role, counts. A real window that fails to map, or any other element, keeps main's refusal.

## Testing

Live, on a macOS 26.5 VM, the same cells on main and on this branch. TextEdit has a document open behind Finder, Finder shows a folder window, and the cell clicks the desktop first:

| call after the desktop click | main | this PR |
|---|---|---|
| `te.press('shift')` (background) | `InputFailed`, nothing sent | sent; Finder still in front, focus on the desktop |
| `te.press('shift', {takeover: true})` | `InputFailed`, nothing sent | sent; Finder still in front, focus on the desktop |
| `finderWindow.press('shift', {takeover: true})` | `InputFailed` | `InputFailed`, saying the desktop focus could not be put back |
| `finderWindow.press('shift')` (background) | `UserIntervened` | `UserIntervened` (unchanged) |

Unit tests in `skylight.rs`: `a_front_app_without_a_key_window_is_restored_only_when_nothing_is_lost` covers the new state, and `takeover_in_the_users_own_app_refuses_focus_it_cannot_put_back` covers the same-app refusal, and `only_an_unmapped_scroll_area_is_focus_outside_windows` in `ax.rs` covers which focused element counts.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
