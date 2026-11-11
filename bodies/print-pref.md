## What

I turned printing off in the Chrome profiles omp seeds, because a page calling `window.print()` hung the next browser call and got the tab killed, and in browsers omp only attaches to I made that call fail fast and say a print preview is open.

In omp's own headed Chrome, a page that printed on a click stalled `tab.click` 9 s, `observe()` 19 s and the next run 41 s, then the tab was killed; with this PR nothing stalls. In a browser omp attaches to, the held call now fails in 1.3 s with an error naming the preview and how to clear it, and the tab keeps its page.

**omp's own Chrome** (headed), 5 runs per cell:

| Page prints… | `main` | This PR |
|---|---|---|
| on a click | click 9 s, `observe` 19 s, run 41 s, tab killed | no stall |
| on load | clicks refused | no stall |
| in a same-origin iframe, on load | `open` times out (19.5 s) | no stall |
| in a cross-site iframe, on load | clicks refused | no stall |
| in an `open(url)` popup | screenshot 19 s, clicks refused | no stall |
| in an `open('')` popup it writes | click 9 s, `observe` 19 s, `pages()` 21 s, tab killed | no stall |
| on a back/forward-cache restore | `goBack` 41 s, tab killed | no stall |
| 2 s after load, between calls | next click 9 s, run 41 s, tab killed | no stall |

**A browser omp attaches to** (relay, `app.cdp_url`): where `main` stalls above, the held call fails in 1.3 s (all 186 held calls, 1.30-1.31 s), and once the user cancels the preview, calls and `tab.pdf()` work. Prints on load, in iframes or in an `open(url)` popup behave as on `main`.

This replaces holding `window.print` inside each page, one kind of document at a time. Supersedes #15508.

## Why

Chrome's print preview holds the page's script until someone closes it, so the next call waits out its timeout, the recovery stalls on the same page, and the tab is killed. The pref sits beside the password-leak pref omp already seeds, and a profile an older omp seeded picks it up at next launch. In attached browsers only navigating away closes the preview from outside, so each run checks once a second whether a preview holds its page.

**Decisions for the maintainer.**
- **The agent no longer hears that a page asked to print** in omp's own Chrome, and nobody can print from it. A few lines of in-page reporting could restore the notice; a document they miss would lose only the notice, as the pref keeps the tab working.
- **Report, not close, in attached browsers.** Pressing Cancel inside Chrome's preview page freed the call in 0.6-0.7 s (Chromium 156, seven contexts, one run each), but relies on that page's internal markup, and the relay cannot reach `chrome://` pages.

**Not covered.** Prints on load in attached browsers; `browser.pages()` while a popup's preview is open still times out and the tab is killed, as on `main`. A shared Chrome an older omp started prints until it restarts. Edge, Brave and Electron were not measured. Tern and cmux tabs are unchanged. Windows was not run.

## Testing

Through omp's browser tool on Linux (Ubuntu 24.04, Chrome 157, Chrome for Testing 157 for the relay, Xvfb); macOS not run: `tab.pdf()` made a valid PDF in every run, code after `print()` ran, and no other PDF or print job appeared. Headless `main` stalled in no context.

`bun test test/tools/browser-relay-detach.test.ts test/tools/browser-relay-bridge.test.ts test/tools/browser-profile-cleanup.test.ts`: 139 pass; each new test fails with its piece reverted.

Review first: `print-preview.ts` (when a page counts as held), then the abort in `WorkerCore#run`.

<details><summary>How "held" is decided, the error text, and what the tests cover</summary>

Chrome lists an open preview as a `chrome://print/` page; through the relay the extension reports it from `chrome.debugger.getTargets()`. A held page still answers a plain evaluation but never settles a promise; a busy script answers neither and a slow page answers both. Each frame session is asked, so a cross-site iframe counts. Each check gives up after 1 s and asks again.

> The page called window.print() and Chrome's print preview is holding it, so this call stalled: clicks, typing and most evaluations wait until the preview closes. Ask the user to switch to this tab in Chrome and press Cancel in its print preview, or navigate this tab to another URL, which closes the preview and loses the page's state. Input this call sent may land once the preview closes.

Tests: a seeded profile has printing off; through the relay and over `app.cdp_url`, a call a real Chromium page holds (a page parked in the debugger stands in for the preview) fails with this error while a slow call beside it runs to its end, held keys are released, and a dropped first check is retried; a browser omp launched is never asked, before or after a recycle; the bridge answers for an extension that cannot report previews without asking it. Reverted, they fail with `tab.click` timing out at 8 s, the run timing out at 60 s, or a different payload.

After the error, navigating away worked 5 of 5, with and without `tab.emulate` set. A print that lands after a run: the next `browser.open({ name })` without a URL returns at once as on `main`, and the next call fails with this error in 1.3 s.
</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
