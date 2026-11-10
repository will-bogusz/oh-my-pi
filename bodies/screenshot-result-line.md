## What

I cut the text omp adds to every browser screenshot and every `browser.open` down to one line each, keeping only what a model uses: the image size, where the full-size file is, the factor for click coordinates, and where the tab landed.

Per call in one user's 27 days of sessions, screenshot text goes from 96 to 57 tokens and open text from 45 to 39; in a game-testing session with 4,384 screenshots it is 26% of all browser result text.

`main`, headless Chrome at 1440x900, scale 2, `browser.screenshotDir` set:

```text
Opened tab "live" on headless browser (hidden)
URL: http://localhost:59481/
Title: Example Domain

Reused tab "live" on headless browser (hidden)
URL: http://localhost:59481/there
Title: Example Domain

Screenshot captured
Saved: image/png (20.09 KB) to ~/shots/screenshot-2026-11-10T19-12-44-256.png
Model: image/webp (1.39 KB, 1024x640)
[Image: original 2880x1800 at capture scale 2, displayed at 1024x640. Multiply image coordinates by 1.41 to get viewport CSS pixels for tab.clickAt.]
```

This PR, same three calls (the second open was redirected):

```text
Opened tab "live" on headless browser (hidden), titled "Example Domain"

Reused tab "live" on headless browser (hidden), at http://localhost:59464/there, titled "Example Domain"

Screenshot 1024x640, full size saved to ~/shots/screenshot-2026-11-10T19-12-42-232.png. Multiply image coordinates by 1.41 to get viewport CSS pixels for tab.clickAt.
```

## Why

These lines are re-read on every later request of the session. The model never uses byte sizes or formats, the original size and capture scale are already in the factor, and `URL:` usually repeats the URL the call just passed.

What stays: the full-size path (models read it back), the factor sentence word for word, the padded and unknown-scale notes, the URL whenever the tab is not on the requested one (a redirect, or no `url`), and every notice after the first line. `describeBrowser` is unchanged.

This is a default change: anything parsing `Dimensions:` or `URL:` from the text would need the unchanged structured `details`.

## Testing

- `test/tools/browser-open-options.test.ts` opens a page, then reopens through a redirect: one line each, the URL only on the redirected one. With the source reverted, it, the `formatScreenshot` cases and `browser-screenshot-plus` fail (10 tests). The six browser and image test files: 90 pass with Chrome for Testing.
- Agent check, Haiku 5.5 through `omp -p`, headless Chrome for Testing, 6 runs per task and arm. The few extra calls were choices made before any changed text appeared (a `silent` screenshot then read from disk, a tab closed after the model's own `tab.run` error).

| Task | `main` | this PR |
|---|---|---|
| click a canvas-only button with `tab.clickAt` from a scale-2 screenshot | 6/6 hit first click, 3.2 calls | 6/6, 3.5 calls |
| report where a redirecting open landed | 6/6, 2.0 calls | 6/6, 2.2 calls |

- Token counts: the 307 screenshot and 727 open blocks in that user's recorded browser results, counted with o200k before and after rewriting them in this PR's format.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
