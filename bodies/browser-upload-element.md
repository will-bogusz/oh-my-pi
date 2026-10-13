## What

I made `uploadFile()` on a browser element handle work like `tab.uploadFile()`, because on anything but a bare file input it failed with a protocol error, and relative paths pointed at the wrong folder.

In Chrome, `(await tab.waitFor(sel)).uploadFile(…)`, `tab.id(n)` and `tab.ref("e5")` handles now go through the same upload path as `tab.uploadFile(sel, …)`: file inputs, labels and buttons that open a chooser, and drop zones. Relative paths resolve against the session directory, as they do for `tab.uploadFile`. `uploadFile()` with no paths still clears a file input.

| Element handle `uploadFile()` | main | this PR |
|---|---|---|
| file input, relative path | resolved against omp's process directory | resolved against the session directory |
| `<label for=…>`, or a button that opens a chooser | `Protocol error (DOM.setFileInputFiles): Node is not a file input element` | fills the chooser |
| drop zone, two files | `Multiple file uploads only work with <input type=file multiple>` | drops both |

## Why

Handles exposed Puppeteer's own `ElementHandle.uploadFile`, which only sets files on an input and resolves paths against `process.cwd()`. The browser prompt offers `uploadFile` on every element handle, and Tern and cmux handles route it to their `tab.uploadFile`; only Chrome handles fell short.

`toActionableHandle` now takes an upload hook. The worker passes one that resolves paths with the session's cwd and calls `uploadFilesToElement`, under the same per-call guard and invalidation as the other handle actions. The hook receives the handle's preserved Puppeteer `uploadFile` and hands it to `uploadFilesToElement` for the input branch, since the handle's own `uploadFile` is now the hook; `tab.uploadFile` resolves a fresh handle and keeps its plain Puppeteer call.

Decisions:
- With no paths, the handle keeps Puppeteer's method, which clears the input; `tab.uploadFile` still requires a path, as before.

## Testing

- `browser-upload-handle.test.ts`, headless Chrome: element handles upload to an input with a relative path, a label, a chooser button and a drop zone, then clear the input with no paths; the page reads `alpha.txt:alpha`, `beta.txt:beta` and an empty list. On `main` the label, button and drop fail with the errors above, and the input's file is unreadable because the path pointed at the process directory.
- Visible managed Chrome on macOS and a relay tab (Chrome for Testing), on a build combining this change with #15489–#15491: handle uploads to the label, chooser button and drop zone landed; on `main` they failed as above.
- `bun test test/tools/browser-upload-handle.test.ts test/tools/browser-interactions.test.ts`, `bun check` in `packages/coding-agent` and `bun run check:ts` pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

