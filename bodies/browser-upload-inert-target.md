## What

I made browser `uploadFile` fail when nothing on the page read the dropped file, because it reported success on any element and the agent went on believing a file was attached.

`tab.uploadFile(selector, …)` on an element that is neither a file input nor a chooser trigger falls back to a synthetic drag-and-drop. It now checks whether a page listener read the dropped files during `drop`; if none did, it throws `… opened no file chooser and nothing on the page took the dropped files; target the page's <input type=file>, the control that opens the chooser, or its drop zone`.

| Target | main | this PR |
|---|---|---|
| a real drop zone | files dropped, success | same |
| a plain `div`, or the wrong element next to the drop zone | success, no file attached | the error above |
| the same, on a page that cancels `dragover`/`drop` document-wide (react-dropzone's default) | success, no file attached | the error above |

**Overlaps #15489** in `interactions.ts` (the drop branch, `deliverToDropZone` there); merge #15489 first. Joining point: #15489 builds the files and dispatches the drop in the isolated world, so this PR's read check can't run inside that dispatch. Merged, `deliverToDropZone` first runs a main-world `watchDropRead()`: a capturing `drop` listener on `window` that redefines `files` and `items` on the event's `DataTransfer` from its own prototype's getters. If that check sees no read, the drop throws this PR's error. #15489's drop, contents and replaced-globals tests pass on that join.

## Why

Before, the drop path dispatched `dragenter`, `dragover` and `drop` and returned whatever happened. Cancellation is not proof either: drop zones cancel `dragover` to accept a drop, but many pages also cancel `dragover` and `drop` on `document` only so a stray drop does not navigate away, and react-dropzone does that by default. What a drop zone always does is read `event.dataTransfer.files` or `.items` while handling `drop`, so the dispatch counts reads of those two getters during `drop`. It runs in the page's main world, because a getter defined in Puppeteer's isolated world is invisible to the page's own listeners.

Decisions:
- Reads during `dragenter`/`dragover` do not count: libraries inspect `items` there to style the zone.
- A read is evidence the page handled the drop, not that it kept the file (FilePond reads before its own accept checks). A page that first reads the files after an `await` would now get the error; none of the libraries below does.
- A document-wide guard that reads the files (a `files.length` check) also counts, so an inert element on such a page still reports success. The browser can't tell that read from a zone's; counting only element-level reads would fail delegated zones, which read at `document` (React ≤16, jQuery `.on("drop", selector)`).
- Scoped to Chrome. Tern's `page-kit.ts` and cmux's `cmux-tab.ts` keep the same unchecked fallback; neither can be run here.

Maintenance: depends on `DataTransfer.prototype` exposing `files` and `items` as getters, which the DOM spec defines.

## Testing

- `browser-upload-drop.test.ts`, headless Chrome, page with react-dropzone-style document guards: uploads to zones reading `files`, reading only `items`, and delegated from `document` succeed with `alpha.txt`; a div that listens for `drop` without reading files fails with the error above (on `main` it succeeds; counting only element-level reads fails the delegated zone).
- `browser-interactions.test.ts` still passes.
- Source check of react-dropzone 14 (default `getFilesFromEvent`), Dropzone.js 5 and 6, FilePond, Uppy's DragDrop and GitHub's `file-attachment` element: each reads `files` or `items` synchronously inside its `drop` listener. Not run against the libraries live.
- `bun check` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

