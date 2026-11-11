## What

I made a browser call that a page's print preview holds, in a browser omp attaches to, fail within about a second with an error naming the preview, instead of stalling to its timeout and losing the tab.

In an attached Chrome (the relay, `app.cdp_url`, `app.path`), printing on a click stalled the next call to its timeout, then recovery stalled too: a tab omp created there was closed, and a tab borrowed from the user was released. With this change the held call fails in 1.3 s and the tab keeps its page.

## Why

Chrome's preview holds the page's script until somebody closes it, and nothing outside Chrome can close it without navigating the page away. omp's own Chrome turns printing off in its profile (#18838); attached browsers keep their printing settings, so pending calls check for a held page once a second.

**Decision for the maintainer:** report, not close. Cancelling through Chrome's internal preview markup worked in an earlier Linux probe, but that markup is private and the relay cannot reach `chrome://` pages. A run on a held page also fails even if it only waits: a 2.5 s wait failed in 1.304 s, 5/5.

**Limits:** prints on load in attached browsers still behave as on `main`; `browser.pages()` with a popup preview still times out, closing an omp-created tab or releasing a borrowed one. How often pages print in practice is not counted.

## Testing

**Relay cancellation, Chrome for Testing 157, Linux:** held calls failed in 1.304–1.309 s. After switching to the printing tab and cancelling:

| Context | Page responds after Cancel | Valid `tab.pdf()` |
|---|---|---|
| click | 5/5 | 5/5 |
| written popup | 5/5 | 5/5 |
| back/forward-cache restore | 5/5 | 5/5 |
| between calls | 5/5 | 5/5 |

<details><summary>Detection, cost and coverage</summary>

Chrome lists an open preview as `chrome://print/`; the relay extension reads it through `chrome.debugger.getTargets()`. The check treats a frame as held when a plain evaluation answers but a promise does not; busy scripts answer neither, slow pages answer both. Checks are bounded and include child frames.

Measured through the real tool on Linux: one target lookup per second while a call is pending, including idle waits. A 2.5 s unheld wait made two lookups and succeeded, 5/5. Lookups took 0.269–0.460 ms with 8–14 targets and returned 2.2–3.9 KB; this is a small-browser measurement, not a bound for many tabs.

Five held idle waits each made one lookup and failed in 1.304 s. Restricting checks to tracked operations would miss raw `page.*` calls, so this keeps the broader run-level rule.

The error asks the user to switch to the tab and press Cancel, or navigate away (losing page state), and warns that queued input may land after cancellation. Navigation after the error worked 5/5 with and without emulation.

Tests cover relay and CDP attachment, a dropped check, a slow call beside a held page, held-input release and old-extension capability handling. Review `print-preview.ts` and `WorkerCore#run` first.
</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
