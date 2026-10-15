## What

I moved the file chooser handling in browser `uploadFile` onto a CDP session omp owns, because after one upload every later chooser on the page stopped opening, and a site using the newer file picker hung the cell until the tab was killed.

| After `tab.uploadFile()` on a chooser trigger or drop zone, where the browser takes file paths (a Chrome omp launched or one on this machine) | main | this PR |
|---|---|---|
| a later click on an upload button (the agent's or, in a relay tab, the user's own) | nothing opens; the chooser is swallowed | the chooser opens normally |
| a control that calls `showOpenFilePicker()` | the cell hangs about 25 s, then the tab is killed | fails at once: `… opened a File System Access picker (showOpenFilePicker), which automation cannot fill; upload through the page's <input type=file> or drop zone instead` |

## Why

On the "paths" upload route, `uploadFile` on anything but a file input clicks it and waits 400 ms for a chooser through Puppeteer's `page.waitForFileChooser()`. That turns on `Page.setInterceptFileChooserDialog` and never turns it off, so every later chooser on the page goes to a listener nobody waits on; a drop zone sets it off too, since the wait starts before omp knows it is one. The same listener throws on a File System Access picker, whose event has no input node, and the cell never settles. The "contents" route already catches the chooser on its own session (`catchChooserInput`) and lets go of interception once the input is adopted.

Now both routes go through `catchChooserInput`; on the paths route the caught input gets the staged copies through `setFileInputPaths` (`DOM.setFileInputFiles`), as a plain file input already does, and Puppeteer's `FileChooser` is no longer used. The relay serves every session of a tab from one debugger attachment, so one session switching interception off would cancel another's chooser wait, and a session that went away with it on would leave it on; its bridge now keeps interception on while any session of the tab asks for it, and switches it off when the last one that asked goes away.

Maintenance: uses only `Page.fileChooserOpened` and `DOM.setFileInputFiles`, the CDP Puppeteer already used.

## Testing

- `browser-upload-chooser.test.ts`, headless Chrome omp launched (paths route): a drop upload followed by a plain `tab.click` on an upload button now reaches a real chooser (headless Chrome cancels an un-intercepted chooser, so the page logs `cancel`); on `main` it logs nothing. The `showOpenFilePicker()` control fails with the named error, and an upload button clicked after it still reaches a real chooser. Also covered: chooser fill and the multi-file refusal.
- `browser-relay-bridge.test.ts`: a second session of a tab keeps interception on when the first switches it off, and interception goes off when the last session that asked for it goes away.
- `bun test` on `browser-upload-chooser`, `browser-upload-contents`, `browser-interactions` and `browser-relay-bridge` passes; `oxlint`, `oxfmt --check` on the changed files and `check:types` pass.
- Before this was rebased onto the merged upload rework: relay, live, Chrome for Testing with the relay extension, plain clicks on chooser controls after uploads logged `cancel` (nothing on `main`), and the `showOpenFilePicker()` control failed with the named error in 29 ms; in a visible managed Chrome on macOS, a plain click on an upload button after a drop upload opened the native open panel (nothing on `main`).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
