## What

I moved the file chooser handling in browser `uploadFile` onto a CDP session omp owns, because after one upload every later chooser on the page stopped opening, and a site using the newer file picker hung the cell until the tab was killed.

| After `tab.uploadFile()` on a chooser trigger or drop zone | main | this PR |
|---|---|---|
| a later click on an upload button (the agent's or, in a relay tab, the user's own) | nothing opens; the chooser is swallowed | the chooser opens normally |
| a control that calls `showOpenFilePicker()` | the cell hangs about 25 s, then the tab is killed | fails at once: `… opened a File System Access picker (showOpenFilePicker), which automation cannot fill; upload through the page's <input type=file> or drop zone instead` |

**Overlaps #15489** in `interactions.ts`; merge #15489 first. Joining point: #15489 catches choosers on its own CDP session only on its contents route (`catchChooserInput`) and keeps Puppeteer's chooser on the paths route (`catchChooser`); merged, this PR's `fillClickedFileChooser` becomes `catchChooserInput` for both routes, and the paths route fills the adopted input with `setFileInputPaths`.

## Why

`uploadFile` on anything but a file input clicks it and waits 400 ms for a chooser through Puppeteer's `page.waitForFileChooser()`. That turns on `Page.setInterceptFileChooserDialog` and never turns it off, so every later chooser on the page goes to a listener nobody waits on; a drop zone sets it off too, since the wait starts before omp knows it is one. The same listener throws on a File System Access picker, whose event has no input node, and the cell never settles.

Now `fillClickedFileChooser` enables interception on its own session, clicks, fills the chooser's input by node with `DOM.setFileInputFiles`, and disables interception before detaching. The relay serves every session of a tab from one debugger attachment, so detach alone left the leak in place there (relay runs below); its bridge now keeps interception on while any session of the tab asks for it.

Decisions:
- The 400 ms wait still starts before the click, so a target that becomes clickable late is still treated as a drop zone, as on `main`.
- A chooser upload overlapping another on the same tab fails with a named error, since both sessions would catch the first chooser; `main` refused it too ("already handled").

Maintenance: uses only `Page.fileChooserOpened` and `DOM.setFileInputFiles`, the CDP Puppeteer already used.

## Testing

- `browser-upload-chooser.test.ts`, headless Chrome: a drop upload followed by a plain `tab.click` on an upload button now reaches a real chooser (headless Chrome cancels an un-intercepted chooser, so the page logs `cancel`); on `main` it logs nothing. The `showOpenFilePicker()` control fails with the named error, and an upload button clicked after it still reaches a real chooser; on `main` the cell hangs until the tab is killed. Also covered: chooser fill, multi-file and overlap refusals, and detaching a session that attaches after a cancel.
- Relay, live, Chrome for Testing with the relay extension, at this PR's first commit: after uploads, plain clicks on chooser controls logged `cancel`, and nothing on `main`; with the explicit disable removed they logged nothing again. The `showOpenFilePicker()` control failed with the named error in 29 ms.
- Visible managed Chrome on macOS, on a build combining this change with #15489–#15492: after a drop upload, a plain click on an upload button opened the native open panel; on `main` nothing opened.
- `bun test` on the chooser, interactions and relay-bridge tests (a second session keeps interception) and `bun check` pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

