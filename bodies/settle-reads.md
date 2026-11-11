## What

I made the reads after an action wait the same way the look does, so `click()` then `text()` reads the result instead of "Loading".

A click whose fetch answers after 300, 800 or 2000 ms, read at once with `tab.text()`: stale 20 of 20 times on main, 0 of 20 here, at the fetch's own latency plus about 180 ms.

| read right after the click (20 reps each, median) | main | this PR |
|---|---|---|
| fetch answers after 300 ms | 20/20 stale, 1 ms | 0/20 stale, 467 ms |
| 800 ms | 20/20 stale, 1 ms | 0/20 stale, 986 ms |
| 2000 ms | 20/20 stale, 1 ms | 0/20 stale, 2178 ms |
| request never answers | 20/20 "Loading", 1 ms | 20/20 "Loading" at the bound, 3007 ms |
| read with no action before it | no wait | no wait |

The first page read after an action waits before reading, rather than reading speculatively and reconciling the result. Tab, frame and element reads share that boundary; reads issued together share one wait. Reads needed to carry out an action do not consume it. `cookies()`, `storage()` and `waitFor*` keep main's behavior; Chromium `tab.url()` becomes asynchronous inside `tab.run` (below).

## Why

In our model runs more than half of the cells that acted and then read did so with `text()`, `html()` or `evaluate()`, not `observe()` (15 of 27 on Opus 5.5), so a settle paid only at `observe()` left them reading the loading state and re-checking. Quiet DOM alone does not cover a fetch slower than its 150 ms window: the page is silent while the response is outstanding. In an earlier run of this probe with the request wait turned off and only quiet DOM kept, every read was stale, so the request wait is the part that does the work.

## Breaking change

Inside `tab.run`, Chromium `tab.url()` now returns a promise, since it waits like the other reads: `tab.url().includes(…)` throws there and needs `await`. cmux and Tern keep a string. Direct `tab.url()` calls are unchanged for callers because they were already awaited. The CHANGELOG files it under Breaking Changes.

## Open questions

- **The 3 s bound** is now also what a read pays for a request the action started that never answers (the last table row). It drops to half the call's own budget when that is shorter, so a short cell still gets its read.
- **Whether to skip long-lived requests.** Browser Use counts a request in flight over 1.5 s as background and caps its wait at 0.8 s; under that rule the 2000 ms row above reads "Loading". This PR waits for every request the action started and skips only requests open before it.

## Testing

`bun test packages/coding-agent/test/tools/browser-observe.test.ts`, `browser reads after an action`: fetches Chromium delays by 300, 800 and 2000 ms (`page.emulateNetworkConditions`, no server sleeps or test clocks), a never-answering request (a response landing at 1.5 s shows the read waited past it), a read with no action while a request is in flight, a request opened before the action, two reads issued together, and an element id reused across calls after an action. The delayed fetches, the never-answering request and the reads issued together fail on main; the other three pin what must not change. The table is a zero-model probe through the browser prelude against headless Chrome for Testing, 20 reps per row.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
