## What

Asking `read` for a scanned PDF page as an image kept handing back an empty grey viewer, so I switched the capture to the viewport the viewer already fits the page into, and made the "no extractable text" note point at that selector instead of the browser prelude.

`read doc.pdf:page<N>.png` returned the PDF viewer's empty frame on about half of renders (28 of 56 scanned-page renders on `main`), and on none with this PR (0 of 44).

<img width="1600" alt="read scan.pdf:page2.png: main returns the empty grey PDF viewer, this PR returns the scanned invoice page" src="https://github.com/user-attachments/assets/1f01b321-7af1-484d-9fee-b05670465778" />

| PDF, rendered in headless Chromium | `main`: blank | this PR: blank |
|---|---|---|
| 3-page scanned invoice (JPEG pages) | 12 of 24 | 0 of 15 |
| 1-page 200 dpi scan | 3 of 5 | 0 of 5 |
| generated image-only pages (Flate and JPEG) | 13 of 27 | 0 of 24 |
| 3-page text PDF | 4 of 6 | 0 of 6 |

The note `read` appends to a PDF whose pages have no text layer:

```diff
- Text extraction is incomplete for PDF pages 1, 2, 3. Use the browser prelude to render those pages or OCR them.
+ Text extraction is incomplete for PDF pages 1, 2, 3. If this PDF is a file on disk, append `:page<N>.png` to its file path to read a page as an image (e.g. `doc.pdf:page1.png`).
```

## Why

`read-pdf.ts` opens the file in Chromium's PDF viewer at `#page=N&view=Fit`, waits for it to load, then took a full-page screenshot. That capture renders beyond the viewport, and the viewer's plugin, which paints in its own out-of-process frame, is often missing from it. `view=Fit` already places the whole page in the viewport, so a viewport capture holds the same pixels: painted `main` renders are byte-identical to the PR's.

Rejected: waiting longer before the full-page capture. The waits are unchanged and only the capture call differs, so the drop from half blank to none comes from the capture mode.

The old note sent agents to the browser prelude or OCR (one rendered the pages with `pdftoppm` instead). The new one is conditional on a file on disk: the same converter output reaches URL reads and the arXiv and IACR scrapers, and neither a URL (`…/scan.pdf:page2.png` is a 404) nor a `local://` path takes the member. It names no path, since that output is cached by file hash.

**Maintenance:** if the viewer stops fitting the page to the viewport, captures would crop; the test checks that the page shows, not all of it. Banner, strip and poster page shapes render whole today.

Non-goals: render size (1024x576 tab), the approval tier of page renders, and member support for URL and `local://` reads are unchanged.

## Testing

- `test/tools/read-pdf-screenshot-chromium.test.ts` (new, real headless Chromium, skipped without it): renders each page of an 8-page image-only PDF (a black square on white) through `renderPdfPageScreenshot` and checks each shot holds the white page and the square. Fix reverted: fails 3 of 3 runs on Linux, 2 of 2 on macOS; with it: passes 3 of 3 and 2 of 2.
- `test/pdf-converter.test.ts` expects the new note.
- Live, Linux: `omp read scan.pdf` prints the new note; `omp read scan.pdf:page1.png` returns the painted page.
- Table rig: `renderPdfPageScreenshot` in a loop on Linux; blank means under 5% near-white pixels.
- `bun run check:types` in `packages/coding-agent`; oxlint and oxfmt on the changed files.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
