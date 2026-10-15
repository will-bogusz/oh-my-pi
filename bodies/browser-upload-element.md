## What

I made `uploadFile()` on a browser element handle work like `tab.uploadFile()`, because on anything but a bare file input it failed with a protocol error.

In Chrome, `(await tab.waitFor(sel)).uploadFile(…)`, `tab.id(n)` and `tab.ref("e5")` handles now go through the same upload path as `tab.uploadFile(sel, …)`: file inputs, labels and buttons that open a chooser, and drop zones. `uploadFile()` with no paths still clears a file input, as Puppeteer's does.

| Element handle `uploadFile()` | main | this PR |
|---|---|---|
| `<label for=…>`, or a button that opens a chooser | `Node is not a file input element` | fills the chooser |
| drop zone, two files | `Multiple file uploads only work with <input type=file multiple>` | drops both |

## Why

The browser prompt offers `uploadFile` on every element handle, and Tern and cmux handles route it to their `tab.uploadFile`; Chrome handles only prepared a file-input upload (`prepareInputUpload`), so anything else was refused.

The handle's upload hook (`HandleUploads`) now calls `prepareElementUpload`, the function `tab.uploadFile` uses, so there is one upload path: staged copies or chunked contents, chooser, drop zone, and the folder refusal on the contents route. The hook also gained a `route` step: `uploadThroughHandle` reads `UploadStaging.route` under its own action deadline before preparing, as `tab.uploadFile` does, so the first upload's check doesn't eat into the handle action's deadline. Relative paths still resolve against the session directory.

## Testing

- `browser-upload-handle.test.ts`, headless Chrome: element handles upload to an input with a relative path, a label, a chooser button and a drop zone, then clear the input with no paths; the page reads `alpha.txt:alpha`, `beta.txt:beta` and an empty list. With `main`'s `tab-worker.ts` the label and button fail `Node is not a file input element` and the two-file drop fails `Multiple file uploads only work with <input type=file multiple>`.
- `bun test test/tools/browser-upload-handle.test.ts test/tools/browser-upload-contents.test.ts test/tools/browser-interactions.test.ts` passes, as do `oxlint`, `oxfmt --check` on the changed files and `check:types` across packages.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
