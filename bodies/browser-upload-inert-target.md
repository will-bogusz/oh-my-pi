## What

I made browser `uploadFile` fail when nothing on the page read the dropped file, because it reported success on any element and the agent went on believing a file was attached.

When the target is neither a file input nor a chooser trigger, `uploadFile` drops the files on it (`deliverToDropZone`). It now checks whether a page listener read them during `drop`, on both upload routes (`paths` and `contents`); if none did, it throws `… opened no file chooser and nothing on the page took the dropped files; target the page's <input type=file>, the control that opens the chooser, or its drop zone`.

| Target | main | this PR |
|---|---|---|
| a real drop zone | files dropped, success | same |
| a plain `div`, or the wrong element next to the drop zone | success, no file attached | the error above |
| the same, on a page that cancels `dragover`/`drop` document-wide (react-dropzone's default) | success, no file attached | the error above |

## Why

Cancellation proves nothing: many pages cancel `dragover` and `drop` on `document` only so a stray drop does not navigate away. What a drop zone always does is read `dataTransfer.files` or `.items` while handling `drop`, so the upload counts reads of those getters then. The files are still built and dropped from the isolated world; the page's listeners see the main-world wrapper, so a capturing `drop` listener in the main world on the element's root wraps the getters there for that drop.

Decisions:
- Reads during `dragenter`/`dragover` do not count: libraries inspect `items` there to style the zone.
- A read shows the page handled the drop, not that it kept the file. A page that first reads after an `await` would get the error; none of the libraries below does.
- A document guard that reads the files also counts, so an inert element on such a page still succeeds; counting only element-level reads would fail delegated zones (React ≤16, jQuery `.on("drop", selector)`).
- Scoped to Chrome; Tern's `page-kit.ts` and cmux's `cmux-tab.ts` keep the unchecked fallback.

## Testing

- `browser-upload-drop.test.ts` (headless Chrome, react-dropzone-style document guards): zones reading `files`, only `items`, and delegated from `document` get `alpha.txt`; a div that handles `drop` without reading fails with the error (on `main` it succeeds).
- `browser-upload-contents.test.ts`, connected Chrome on each route: an unread element fails with the error and a shadow-root zone gets the file; the rest of the file passes (19 pass across both files). `browser-interactions.test.ts`: 20 pass.
- Source check of react-dropzone 14, Dropzone.js 5/6, FilePond, Uppy DragDrop and GitHub's `file-attachment`: each reads `files` or `items` synchronously in `drop`. Not run live.
- `oxlint`, `oxfmt --check` and every package's `check:types` pass; `bun run check:ts` stops only at `check:tools` on `builtin-hooks.test.ts` formatting, as on `main`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
