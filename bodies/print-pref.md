## What

I turned printing off in the Chrome profiles omp seeds, because a page calling `window.print()` hung the next browser call and got the tab killed, and made held calls in attached browsers fail with an error naming the preview.

In omp's headed Chrome, printing on a click stalled `tab.click` for 9 s, then recovery killed the tab; with this PR the page keeps working. In attached browsers the held call fails in 1.3 s without killing its tab.

**Linux, headed, 5 runs per cell:**

| Page prints… | `main` | This PR, seeded profile |
|---|---|---|
| on a click | click 9 s, recovery kills tab | no stall |
| on load | clicks refused | no stall |
| same-origin iframe on load | `open` 19.5 s timeout | no stall |
| cross-site iframe on load | clicks refused | no stall |
| `open(url)` popup | screenshot 19 s, clicks refused | no stall |
| `open('')` popup | click 9 s, `pages()` 21 s, tab killed | no stall |
| back/forward-cache restore | `goBack` 41 s, tab killed | no stall |
| between calls | next click 9 s, run 41 s, tab killed | no stall |

**macOS 26.5.2 VM, headed CfT 150 / Chrome 154:** 5 runs per cell; fixed columns include a valid PDF in every run.

| Context | `main`, CfT / Chrome | Fixed CfT | Fixed Chrome |
|---|---|---|---|
| click | 9 s click, 19 s observe, 41 s run, tab killed; 5/5 each | no print stall 5/5 | no print stall 5/5 |
| load | not run | no print stall 5/5 | no print stall 5/5 |
| same-origin iframe | not run | no print stall 5/5 | no print stall 5/5 |
| cross-site iframe | clicks refused 5/5; PDF timeout 19 s, 4/5 each | no print stall 5/5 | no print stall 5/5 |
| URL popup | not run | no print stall 5/5 | no print stall 5/5 |
| written popup | not run | no print stall 5/5 | no print stall 5/5 |
| back/forward-cache restore | 41 s, tab killed; 5/5 each | no print stall 5/5 | no print stall 5/5 |
| between calls | CfT: 9 s input, 41 s run, tab killed 5/5; Chrome not run | no print stall 5/5 | no print stall 5/5 |

## Why

Chrome's preview holds the page's script until somebody closes it. The profile pref covers documents that in-page hooks miss and applies to an existing profile on its next launch. Attached browsers keep their printing settings; pending calls check for a held page once a second. Supersedes #15508.

**Decisions for the maintainer:**
- **Printing is off, without a notice, in omp's own Chrome.** The agent no longer hears that a page asked to print. In-page reporting could restore the notice; a document it missed would lose only the notice, not hang the tab.
- **Report, not close, in attached browsers.** Cancelling through Chrome's internal preview markup worked in the earlier Linux probe, but that markup is private and the relay cannot reach `chrome://` pages. A run on a held page also fails even if it only waits: a 2.5 s wait failed in 1.304 s, 5/5. That is deliberate here, not a claim that only blocked operations fail.

**Limits:** prints on load in attached browsers still behave as on `main`; `browser.pages()` with a popup preview still times out and kills the tab. An older shared Chrome needs a restart. Edge, Brave, Electron and Windows were not run; Tern/cmux are unchanged.

## Testing

Real browser-tool runs on Linux/Xvfb and macOS: PDFKit parsed all 107 macOS PDFs; no print jobs or user-saved files appeared. Main-seeded profiles picked up the pref next launch, 5/5 each browser (print returned in 2–8 ms, no preview). Headless Linux `main` did not stall.

**Relay cancellation, Chrome for Testing 157, Linux:** held calls failed in 1.304–1.309 s. After switching to the actual printing tab and cancelling:

| Context | Page responds after Cancel | Valid `tab.pdf()` |
|---|---|---|
| click | 5/5 | 5/5 |
| written popup | 5/5 | 5/5 |
| back/forward-cache restore | 5/5 | 5/5 |
| between calls | 5/5 | 5/5 |

`bun test test/tools/browser-relay-detach.test.ts test/tools/browser-relay-bridge.test.ts test/tools/browser-profile-cleanup.test.ts`: 139 pass; the new tests fail with their fixes reverted.

<details><summary>Detection, cost and coverage</summary>

Chrome lists an open preview as `chrome://print/`; the relay extension reads it through `chrome.debugger.getTargets()`. The check treats a frame as held when a plain evaluation answers but a promise does not; busy scripts answer neither, slow pages answer both. Checks are bounded and include child frames.

On macOS's cross-site load, ordinary evaluations still answered while the print script waited; `tab.pdf()` timed out in 4/5 on each main browser, never on the fix. CfT's iframe-fixture body clicks were refused even though code after `print()` ran; those are not successful clicks. The click fixture was rerun with 5/5 delivered prints.

One first cold launch took 5.7 s; the table counts print stalls, not browser startup.

Measured through the real tool on Linux: one target lookup per second while a call is pending, including idle waits. A 2.5 s unheld wait made two lookups and succeeded, 5/5. Lookups took 0.269–0.460 ms with 8–14 targets and returned 2.2–3.9 KB; this is a small-browser measurement, not a bound for many tabs.

Five held idle waits each made one lookup and failed in 1.304 s. Restricting checks to tracked operations would miss raw `page.*` calls, so this PR keeps the broader run-level rule.

The error asks the user to switch to the tab and press Cancel, or navigate away (losing page state), and warns that queued input may land after cancellation. Navigation after the error worked 5/5 with and without emulation.

Tests cover relay and CDP attachment, a dropped check, a slow call beside a held page, held-input release, old-extension capability handling, and no probing in seeded browsers before/after recycle. Review `print-preview.ts` and `WorkerCore#run` first.

To replay the basic hold, serve `<button id="p" onclick="print()">Print</button>` locally, then use omp's browser tool:

```js
const tab = await browser.open({ url: fixtureUrl, headed: true });
await tab.click("#p");
await tab.pdf();
```

For an attached browser use `app: { cdp_url: endpoint }` on an unseeded profile. After the named error, `await new Promise(r => setTimeout(r, 2500)); return 1` in another run demonstrates the held-idle tradeoff; cancelling the visible preview then frees the page.
</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
