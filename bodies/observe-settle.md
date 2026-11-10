## What

I made the first look after an action wait for what that action started, so a cell can click and then call `observe()` and see the result instead of the page before it.

On Chromium tabs, the first `observe()` or `ariaSnapshot()` after an action now waits for the fetch, XHR and main-frame document requests begun since the action, then for 150 ms without DOM changes. The wait is bounded at 3 s, or half the call's own budget when that is shorter, and then the page is read as it is.

| | main | this PR |
|---|---|---|
| click starts a fetch answered 400 ms later, `observe()` in the same cell | lists the page before the response | lists the result |
| `observe()` with no action before it | no wait | no wait |
| request the action started never answers | | read as it is at the bound |
| request the page had open before the action (long poll, beacon) | | not waited for |

The heart is `WorkerCore.#settleAfterAction` in `tab-worker.ts`. Actions mark the tab: `input()` for raw input, navigations, `handleDialog` and frame actions, `act()` for selector actions, and the element-handle actions. The next look pays the mark. It reads the tab's existing request log through `BrowserNetworkManager.hasPendingRequests(since)`, so it adds no listener, then runs the page-side `waitForQuietDom`, which ignores `style`/`class` churn such as spinners. Looks issued together share one settle. Waits and reads that shared main's navigation barrier with actions (`waitFor*`, `evaluate`, `cookies`, `storage`, `frames`, `highlight`) keep that barrier through `documentOp()` and do not mark. cmux and Tern tabs are unchanged.

## Why

#16907 made a call after a navigating click wait for the new document, but nothing waits for the requests and DOM updates an action starts inside a page. So `click(); observe()` in one cell lists a form before its save lands, and agents spend a second cell on every look or pad cells with fixed sleeps. This is the first of four PRs (look settle, read settle, prompt line, stable ids); it is useful alone.

## Open questions

- **The 3 s bound.** A request the action started that never answers (a hung API, a long poll opened by the click) costs the look the full bound. The first look after `browser.open` or `goto` also counts the requests the page load started. A shorter bound returns sooner on such pages and reads slow fetches as "Loading" more often.
- **Whether to skip long-lived requests.** Browser Use treats a request in flight for over 1.5 s as background and caps its wait at 0.8 s. That would return "Loading" for a 2 s fetch, so this PR waits for every request the action started, up to the bound, and skips only requests that predate the action.

## Testing

`bun test packages/coding-agent/test/tools/browser-observe.test.ts`, `browser observe after an action`: a click whose fetch Chromium delays by 400 ms (`page.emulateNetworkConditions`, so no server sleeps), a never-answering request inside a 3 s cell, and a request opened before the click. The first fails on main (the fetched "Saved" is missing).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
