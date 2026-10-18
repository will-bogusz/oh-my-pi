## What

I wanted the browser tool to say "the page is waiting on you" instead of hanging until the tab gets killed, and to stop throwing a native file dialog or auto-closing alerts in someone's own Chrome.

On Chromium, a JavaScript dialog the page leaves open and a file chooser omp holds are one pending state per tab. `tab.dialog()` reports it (`alert`/`confirm`/`prompt`/`beforeunload`, or `file-chooser` with `multiple`, `accept`, `folder`); `tab.handleDialog({ accept, text?, files? })` answers any of them. While it is pending, other tab, frame and handle calls fail at once naming it; the click or key press that opened it returns, and its result says what waits.

- Choosers are held instead of opening the OS file dialog: for the tab's life in browsers omp launched, and in connected and relay browsers only during omp's calls and 1.5 s after, so the user's own upload clicks still get Chrome's picker. File System Access pickers are cancelled with a notice.
- Alerts in connected and relay browsers stay open for the user instead of being accepted. Managed browsers and beforeunload are unchanged.
- A call that times out behind a dialog dismisses it, so the tab recovers instead of being killed.

A `print()` omp holds is reported but never pending. Tern rejects `files`; cmux still rejects dialog calls. Also fixed: `tab.id(n)` called an element stale in a later run once an earlier run had used it (the deadline wrapper here bound the cached handle to the run that first used it).

## Why

`uploadFile` now takes its chooser through the tab's catcher instead of a chooser wait of its own (`pagesAwaitingChooser`); the paths and contents routes, the route check's own deadline and the refusal of folders on the contents route stay. #15915 already stopped `uploadFile` swallowing later choosers; this PR reverses its cancel of a chooser `uploadFile` did not fill (7d50d3d815): a chooser whose delivery failed stays held and answerable. `handleDialog({ files })` uses the tab's route and staging, folder refusal included.

On `main` a `confirm()` stops the page's script, so the click that opened it waits out the cell, the tab is reset from a fresh session that cannot see the dialog, and then killed. In a relay tab that is the user's Chrome, and an `alert()` there is accepted before the user sees it. A chooser click raises the macOS Open panel on the user's screen or is cancelled, and the model is told nothing.

## Testing

Headless Chrome for Testing on macOS; `user-` cases drive a separate Chromium through `cdp_url`. Base: the same tree without this change; n = 5 per arm.

| case | arm | n | result |
|---|---|---|---|
| confirm | base | 5 | click returns 0/5, click ms med 16853; next call fails fast 0/5; tab killed 5/5; answered 0/5 |
| confirm | after | 5 | click returns 5/5, click ms med 29; next call fails fast 5/5; tab killed 0/5; answered 5/5 |
| confirm-one-cell | base | 5 | cell ok 0/5, ms med 16859 |
| confirm-one-cell | after | 5 | cell ok 5/5, ms med 39 |
| user-confirm | base | 5 | click returns 0/5, click ms med 16755; next call fails fast 0/5; tab killed 5/5; answered 0/5 |
| user-confirm | after | 5 | click returns 5/5, click ms med 28; next call fails fast 5/5; tab killed 0/5; answered 5/5 |
| alert | base | 5 | auto-accepted 5/5; pending in dialog() 0/5 |
| alert | after | 5 | auto-accepted 5/5; pending in dialog() 0/5 |
| user-alert | base | 5 | auto-accepted 5/5; pending in dialog() 0/5 |
| user-alert | after | 5 | auto-accepted 0/5; pending in dialog() 5/5 |
| user-alert-between | base | 5 | user saw the alert (page blocked) 0/5; omp's next call ok after the user closed it 5/5 |
| user-alert-between | after | 5 | user saw the alert (page blocked) 5/5; omp's next call ok after the user closed it 5/5 |
| chooser | base | 5 | dialog() reports file-chooser 0/5; handleDialog files filled 0/5 |
| chooser | after | 5 | dialog() reports file-chooser 5/5; handleDialog files filled 5/5 |
| user-chooser | base | 5 | dialog() reports file-chooser 0/5; handleDialog files filled 0/5 |
| user-chooser | after | 5 | dialog() reports file-chooser 5/5; handleDialog files filled 5/5 |
| user-chooser-past-tail | base | 5 | notice in click result 0/5; filled after 2.5 s 0/5 |
| user-chooser-past-tail | after | 5 | notice in click result 5/5; filled after 2.5 s 5/5 |
| user-chooser-later | base | 5 | user's own later click reaches Chrome's chooser 5/5 |
| user-chooser-later | after | 5 | user's own later click reaches Chrome's chooser 5/5 |
| picker | base | 5 | page gets AbortError 5/5; notice in result 0/5 |
| picker | after | 5 | page gets AbortError 5/5; notice in result 5/5 |

- On the tree without this change, 24 of its tests fail: 12 in `browser-nav-frames-dialogs.test.ts`, 10 in `browser-upload-chooser.test.ts` (one is main's chooser-cancel test, now expecting the hold) and 2 in `browser-upload-contents.test.ts`; the `tab.id(n)` test fails with its fix reverted.
- `browser-nav-frames-dialogs`, `browser-upload-chooser` and `browser-upload-contents` with the stacked suites (`browser-interactions`, `browser-native-windows`, `browser-input-release`, `browser-relay-bridge`, `browser-relay-tab-isolation`): 239 pass; `check:types`, oxlint and oxfmt pass.
- `handleDialog({ files })` vs a separate `tab.chooseFiles()`, 15 runs each on gpt-5.6-luna: both 15/15, but with `chooseFiles` the model read `dialog()` as closed while a chooser waited.
- Visible relay run of the prototype (macOS VM, CfT 150, before #16119 opened omp's own relay tabs in the background): no Open panel, focus stays in the front app, uploads answered (3/3); `main` shows the panel and reports nothing (2/2).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)





