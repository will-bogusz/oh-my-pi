## What

I made browser calls wait for the page a click is loading, so clicking Continue and then reading or answering the next step works in one call instead of hitting the old page or throwing.

A read right after a click that navigates went from the page being left, or a CDP error, on most tries to the next page on every try (80 of 80, headless and relay).

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/905281bf-18cf-4142-813c-4a1d9ada165d">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/72f0ce4d-0058-4f2a-8830-5b57871678cd">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/faca0804-5200-403d-805a-d86a9f953009">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/7e4e4004-1bc0-4fe7-831e-7f1a2eb4cea8">
  <img width="780" alt="Timeline, main against this PR. In both, the click asks Chromium to navigate and then returns before the next page arrives. On main the read runs at once: it returns the old page, or fails with Execution context was destroyed when the next page lands mid-read. With this PR the read waits until the next page commits and finishes parsing, then reads it." src="https://github.com/user-attachments/assets/72f0ce4d-0058-4f2a-8830-5b57871678cd" />
</picture>

| Right after `tab.click()` | main, headless (40 tries) | main, relay (20 tries) | this PR (40 headless, 40 relay) |
|---|---|---|---|
| `text` | 32 old page, 2 errors | 11 old page, 1 error | next page every time |
| `evaluate` | 32 old page, 1 error | 12 old page | next page every time |
| `ariaSnapshot` | 31 old page, 1 error | 11 old page, 2 errors | next page every time |
| `observe` | 32 errors, 3 old page | 11 errors | next page every time |
| `waitForText` | 17 errors | 8 errors | next page every time |

The tab worker marks the tab from Chromium's `Page.frameRequestedNavigation` (sent before the click returns) until the main frame commits, stays in the document, stops loading, or a `beforeunload` prompt is dismissed. Page reads, screenshots included, and selector or coordinate actions wait for that before they run. A read that still loses its context to a navigation runs once more; `waitForText` keeps polling.

**Non-goals:** `tab.frame()` calls, low-level `keyDown`/`mouseDown`, and the cmux and Tern backends.

## Why

On main the next call raced the navigation: reads got the old page or failed with `Execution context was destroyed` (direct CDP) or `Cannot find context with specified id` (relay), and a `fill` meant for the next step could land on the old form. An agent that hits that error once stops putting a click and a read in one call: on a GOV.UK multi-page calculator, GPT-6.1 Sol hit the relay error at its first click-and-read in all four runs, then spent two calls per page, 32 steps where Codex took 17.5.

Decisions:
- The wait runs before the next call, not inside the click, so a click that doesn't navigate costs nothing.
- `evaluate` reruns only when Chromium refused it before it ran, since user code can have side effects.
- Chromium holds evaluations on the old document until a started navigation commits, so the wait follows it; a request that never starts loading holds a call at most 5 s (half the op's deadline if shorter).

## Testing

- `bun test test/tools/browser-read-after-navigation.test.ts` covers reads and a screenshot after a navigating click, a fill and click on the step it loads (three in a row), a read after a dismissed `beforeunload` (under 1 s), and which reads rerun. With the fix reverted three of the four fail (3 of 3 runs); without the `beforeunload` handling the fourth takes 5 s.
- The table: a local form, next page after 0 or 150 ms, 20 tries per cell, headless Chrome and an isolated relay. After clicks that navigate nowhere (new tab, download, 204, hash, `pushState`) the next read took 12 ms at most.
- Neighbouring browser suites pass; `tsgo` clean.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
