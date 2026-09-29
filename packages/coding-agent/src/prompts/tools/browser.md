`browser` drives real Chromium tabs from Eval; `read` suits static pages. Work headless (`browser.open({ url? })`{{#if relay}} with `app: { relay: false }`; a bare `open` makes a user-Chrome tab{{/if}}) unless the user names their Chrome or the task needs their session; sites attribute those actions to the user.

<instruction>
Entry points
- `browser.getTab({ title?, url? })` claims ONE open tab by substring (ambiguity lists exact ids); `discover({ title?, url? })` lists tabs without attaching and `claim(id)` adopts one; `create({ url? })` opens an inactive task tab; `open` starts or attaches a headless/CDP browser.
- Each returns a `tab` whose first tree prints and stays as `initialObservation` (`observation:` takes `observe()`'s options). `tab.ref("e26")` is an element handle; `tab.run(fn)` runs a multi-step function with `{ tab, page, browser, wait, assert }` (no closures; not a sandbox).
- Headless/CDP tabs from `open` persist across cells: `browser.tab(name)` (default `"main"`) returns one. `getTab`/`claim` address only user-Chrome tabs.
{{#if tern}}
- Inside a Tern pane, tabs open by default as browser picture-in-pictures over this pane (native WKWebView, visible to the user, not Chromium); the open result names the backend. Explicit `app` options, the relay, and a configured CDP URL win; `headed: false` or `app.tern: false` opens Chromium instead; `app.tern: true` requires Tern. When no Tern window can host the page, the open falls back to Chromium and says so.
- Tern tabs: input is trusted native mouse/keyboard events at element centres; `tab.evaluate` runs in the page world. Console, `requests`, `route`, and HAR cover the page's `fetch`/XHR plus navigation responses only (no images/scripts/styles; `route` accepts only `resourceType` `fetch`/`xhr`); request bodies exist only for the current document. Frames inside CSS-scaled/rotated elements cannot be driven. `emulate` supports viewport/device, userAgent, colorScheme, credentials, geolocation, locale, offline (JS-visible); timezone, headers, any reducedMotion, CPU and network throttling throw. Clipboard helpers use the system clipboard. `pdf` supports only `path`. `a11y`, `webmcp*` cover the main frame; `loadState` restores storage for the current origin only. `traceStart`/`traceStop`/`profileStart`/`profileStop` are unsupported; raw `page`/`browser` in `tab.run` are a Puppeteer-like subset (`goto`, `evaluate`, `content`, `$`, `$$`, `locator`, waits, `screenshot`, `keyboard`, `mouse`, `cookies`).
{{/if}}
- `page`/`frame` are raw Puppeteer (`$$eval`, `$eval`, `evaluate`; `locator()` only acts); Playwright's API (`hasText`, `allTextContents`, `evaluateAll`) is absent. `browser.help()` prints the typed API. Arguments are positional; Python has the same names, its `run` takes JavaScript.

Model
- A tab is claimed, never selected: only `reveal()` focuses Chrome or switches tabs. Chrome web content: `browser` only, never `computer`.
- An observation is the accessibility tree: header `url | title | scroll | focused`, one node per line, indent = depth, text and iframes inline. `eN` refs mark controls, stateful nodes and clickable table rows or cells (`includeAll: true`: every node). After acting, `await tab.observe()` in the same cell waits for the page to settle and prints only changes (`+` added, `~` changed, `removed:`); `diff: false` prints all, `display: false` nothing.
- Refs survive observations and re-renders; a ref whose node was replaced fails.{{#if compactRefs}} When that failure carries the page as read after it, act on that page's refs (a replacement has a new one); otherwise observe again and use the refs it returns. `observation.elements` carries the same refs for `find(el => …)`.{{else}} It says to observe again. `elements[i].ref` is `<snapshot>:<n>` — use that token, not `eN`, and re-observe after a re-render.{{/if}}
- Set checkboxes, radios and switches with `check()`/`uncheck()`; `click()` throws when one stays unchanged. `uploadFile(...paths)` on a ref, or `tab.uploadFile(selector, ...paths)`, feeds a file input, chooser button or drop zone.
- Read the tree first; `.tree` (and `String(obs)`) keeps it whole when the print is cut. `extract()` is Readability: one article, no tables or nav, so prose only. Read tables from the tree, `tab.ariaSnapshot("<selector>")` or `page.$$eval`.

Ownership
- A task names a site with an open tab: claim it and stay on the user's account; `create` only when none matches or you will navigate elsewhere. Never switch company or account inside the user's tab.
- User-Chrome tabs are handed back open at turn end; next turn, claim their exact id again. Close tabs you opened, never others unless asked; `tab.release()` hands back early. Never `reveal()` to observe or recover.
- Several profiles (`browser.instances()`) → pass `browserId`.

Interruptions
- "Chrome revoked OMP's control …" follows OMP's retry: have the user dismiss the extension frame it names; never close that tab.
- "The user stopped OMP's control … from Chrome's infobar": they ended browser control on purpose. Do not re-claim or work around it; stop and report what is done and what is left.
- A pending JavaScript dialog is reported on the action (a claim returns `initialDialog`); `tab.dialog()` reads it, `tab.handleDialog({ accept, id, text? })` answers it.
- Child tabs your page opens are auto-leased: `tab.popups()` (or `discover()`'s `popupOf`) lists them; claim the child id to drive it.
- `tab.downloads()` lists this tab's downloads with `state` and, once completed, the saved `path`; `tab.waitForDownload()` awaits the next completion.
</instruction>

<examples>
```javascript
const tab = await browser.getTab({ title: "401(k) contributions" }); // prints the tree
const field = tab.initialObservation.elements.find(el => el.name === "Amount in percent");
await tab.ref(field.ref).fill("15");
await tab.observe(); // prints the diff
```
</examples>
