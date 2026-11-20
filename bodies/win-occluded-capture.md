## What

This is the rest of this PR after `5a3f19facee` was merged as c72da2125ba: I'm making every opaque window count as a cover over a Chromium window, so a paused page can't come back unmarked.

On `main`, `occluder()` skips popup (`WS_POPUP`), tool (`WS_EX_TOOLWINDOW`) and click-through (`WS_EX_TRANSPARENT`) covers, mirroring Chromium's own occlusion check, because Chromium usually keeps drawing under them. That mirror can leave a paused page unmarked:

| A fully covered Chrome/Electron window, cover kind | `main` (c72da2125ba) | this PR |
|---|---|---|
| plain opaque window | marked | marked |
| a cover that restyles itself into a popup while covering (e.g. DOSBox Staging's Alt+Enter) | unmarked, page can stay paused | marked |
| a cover toggled into a tool window (e.g. mpv's taskbar toggle) | unmarked before Chromium recalculates | marked |
| a counted cover that hides or lowers, leaving an already-skipped popup or tool window over the page | unmarked, page can stay paused | marked |
| a popup, tool or click-through window that was there all along | unmarked, page current | marked (needless caution) |

The cost is the last row: under those three kinds Chromium usually keeps drawing (measured on Windows 10 over Chrome and Electron: current 10/10 under a click-through cover, 8/8 under a tool window, 8/8 under a popup), so the "may be stale" mark there is a needless caution. It stays because the same covers can sit over a paused page, and geometry alone can't tell which.

## Why

The mark exists to stop a stale read passing as current. From window styles we can't know when Chromium last recalculated occlusion, so any mirror of its exemptions can drop a mark exactly when the page is paused; a needless mark only costs a fresh look.

Limits: shaped (complex-region) windows, layered windows whose opacity can't be read, and unreadable geometry still don't count as covers, so those reads stay unmarked; a window being dragged over the target counts as a cover while Chromium ignores it.

## Testing

`a_chromium_window_is_marked_only_when_nothing_of_it_shows` now asserts that an opaque click-through, tool and popup cover each mark (reading back each style bit to prove it took) and fails on `5a3f19facee`. Windows 10 unit run: 223/223 at this head; `scripts/rust-check` on Windows, Linux and macOS: pass, recorded.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
