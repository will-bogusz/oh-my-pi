## What

I made the first look after an action wait for what that action started, so a cell can click and then call `observe()` and see the result instead of the page before it.

On Chromium tabs, the first `observe()` or `ariaSnapshot()` after an action waits for its main-frame document, fetch and XHR requests, then 150 ms without DOM changes. The wait is capped at 3 s, or half the call's budget when shorter. Concurrent looks share it; cmux and Tern are unchanged.

**Cost:** the first read after navigation now waits for the page's ongoing data loading and quiet DOM, up to the bound: about 0.6 s on MDN and 2.7 s on BBC News in this census. Main adds no settle wait and can read a half-loaded page; its scripted delayed-fetch reads returned in about 1 ms and were stale.

A load-time long poll made the first read take 3.01 s in 20/20 scripted loads. After one initial read, a DOM-only click with that poll still pending took 159 ms, not another 3 s.

## Why

#16907 waits for a navigation's new document, but not the in-page fetch and DOM updates an action starts. `click(); observe()` can therefore list a form before its save lands. The next look pays one bounded wait rather than requiring a fixed sleep.

Skipping chunked responses is unsafe: a finite response with immediate headers and a delayed body was read stale in 20/20 trials.

A measured alternative, available if the maintainer prefers it, stops waiting for navigation-started requests after `load` and quiet DOM while still waiting for click-started requests. It kept both click probes fresh and shortened MDN and BBC reads, but trades away waiting for deferred navigation content. The fixed policy had 0/60 public-page cap hits, so this alternative is not adopted here.

## Testing

`bun test packages/coding-agent/test/tools/browser-observe.test.ts packages/coding-agent/test/tools/browser-tern-tab.test.ts packages/coding-agent/test/tools/browser-network.test.ts`: 31 pass, 0 fail on current main bcd5b0b996e (Linux; main-built native addon 18.18.8, checkout 18.19.0). A request started in the action's clock tick is still awaited; selecting requests by timestamp makes that regression fail. Delayed-header and delayed-body click probes: main 20/20 stale each, this policy 0/20 each. Root `bun run check:ts` reaches typechecking and reports only main's two TS2322 errors in `bench-auth-fallback.test.ts`.

<details>
<summary>First-navigation cost: model-free headless Chromium, five loads per page</summary>

The complete settle series was measured with `browser.open(wait_until: "domcontentloaded")`, immediately followed by its first `text()` read. Numbers are median settle milliseconds, excluding open; every fixed-policy sample ended at quiet DOM, not the cap. Across 60 public samples, 28 waited for requests and then quiet DOM, 32 needed only quiet DOM. No baseline sample hit the cap.

| Page | Fixed policy ms | Skip streams ms | Stop load requests after load ms | Both ms |
|---|---:|---:|---:|---:|
| GitHub repo | 266 | 246 | 221 | 262 |
| GitHub PR | 323 | 284 | 305 | 309 |
| GOV.UK | 159 | 157 | 154 | 160 |
| Wikipedia | 180 | 244 | 238 | 188 |
| MDN | 580 | 572 | 154 | 155 |
| Google results | 971 | 1017 | 1103 | 795 |
| Hacker News | 152 | 152 | 154 | 153 |
| BBC News | 2658 | 3010 | 967 | 890 |
| React docs | 265 | 284 | 317 | 325 |
| npm | blocked | blocked | blocked | blocked |
| Stack Overflow | blocked | blocked | blocked | blocked |
| YouTube | shell only | 3045* | shell only | shell only |
| Signup fixture, normal setup | 158 | 162 | 155 | 160 |
| Records fixture, normal setup | 157 | 160 | 157 | 159 |

npm and Stack Overflow were security-blocked in all 40 attempts; YouTube returned only its playback timer in 19/20. *One readable YouTube result, after a cap, is not a five-load median. Fixtures retain their normal two-second setup interval. The immediate signup first read instead returns its loading redirect screen; none of the candidates waits for that future timer.

Cap hits over 60 public loads: fixed 0, streams 4, navigation 0, both 0. Three streams-arm BBC caps held advertising fetches with response headers; one YouTube cap held media fetches without headers. Stream/both candidates each caused 20/20 stale finite chunked-body reads and were rejected. Navigation kept 0/20 on both click-fetch probes and reduced the scripted load-poll first read from 3034 to 160 ms, but has no demonstrated real-page cap reduction here.

All runs used a native addon reporting 18.18.6 with 18.18.8 source; no native API changed in this patch, but the version mismatch is a comparison caveat. These are five-load observations, not a guarantee of freshness or stable speedups on public pages.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated (queued, attribution added on opening)
