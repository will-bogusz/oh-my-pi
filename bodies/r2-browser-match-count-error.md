## What

My agents kept getting a bare "timed out after 8000ms" on `aria/` clicks against a Chrome they attached over `app.cdp_url`, with none of the match-count hint the same click gets elsewhere, so they couldn't tell a missing button from a stuck one.

When the match-count probe behind that hint fails, the timeout now says why instead of dropping the hint:

| probe | `main` | this PR |
|---|---|---|
| counts N | `…; selector currently matches N element(s) …` | same |
| throws | `tab.click("aria/Accept") timed out after 8000ms` | `… timed out after 8000ms; could not count matches: <its error>` |
| no answer in 1 s | `tab.click("aria/Accept") timed out after 8000ms` | `… timed out after 8000ms; could not count matches: no answer within 1000ms` |

Inside the "never became clickable" hint, the same note takes the place of `selector matches N element(s)`. Aria-ref selectors (`aria-ref=e5`) still carry no count, as on `main`.

Non-goal: this explains the 8 s wait, it does not shorten it. The zero-match watchdog treats a failing probe as inconclusive and never fails fast on it; why that endpoint's probe failed is still unknown (a headless Chromium attached the same way fails fast at 2.1 s), so the message is what tells us next time.

## Why

`#runOp` appends the hint from `#selectorMatchCount`, which returned `undefined` both for "not counted" and for a probe that threw or stalled, so the reason was lost. On omp 18.12.1, four `tab.click("aria/…")` calls against one `cdp_url` Chrome each ended at the 8 s action deadline with no hint, while `text/` timeouts on the same build carried one. `#selectorMatchCount` now returns the count or the failure, and the message says which; the 1 s probe bound is one constant used for the wait and the text.

## Testing

- New `browser-interactions.test.ts` case "says why it could not count a timed-out selector's matches", managed headless Chromium: inside `tab.run` it replaces the tab page's `$$` (what both the watchdog and the count probe call) with a thrower, then with a promise that never settles, and clicks `#missing`. Both runs reach the action deadline and end with the reason.
- Negative control: with `tab-worker.ts` from `main` the case fails with `Received: "tab.click(\"#missing\") timed out after 2000ms"`, the field message shape.
- `PI_BROWSER_RELAY=0 bun test test/tools/browser-interactions.test.ts`: 27 pass.
- Live, headless Chromium launched on a spare port and adopted with `app: { cdp_url, target }`: `aria/`, CSS and `text/` clicks on a missing element all fail fast at ~2.1 s with the zero-match hint, on `main` and here; the field endpoint's failing probe did not reproduce.
- Not run: the field endpoint itself (a user's Chrome).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
