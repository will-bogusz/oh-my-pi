Drive real Chromium tabs from JavaScript or Python Eval with the global `browser`; use `read` for static content. Default to headless (`browser.open`); use the user's Chrome only when they name it or the task needs their session — sites attribute those actions to the user.

<instruction>
- Prelude methods take positional arguments (`tab.extract("text")`, `tab.ref("e26")`); the one-trailing-object rule is for `tool.*()`.
- Acquire: `browser.discover({ browserId?, full? })` lists `{ id, title, url, active, ownership, popupOf? }` without attaching; `browser.claim(id, { label? })` adopts that exact tab unchanged; `browser.getTab({ title?, url? })` claims ONE tab by substring (ambiguity lists exact ids); `browser.create({ url?, label? })` opens an inactive task tab. Several profiles (`browser.instances()`) → pass `browserId`. If the task names a site and a tab for it is open, claim that tab and stay on the user's account there; `create` only when no matching tab exists or you will navigate elsewhere — never switch company or account inside the user's tab.
- Loop: act, then `await tab.observe()` in the **same** cell — it waits for the page to settle and prints only what changed (`+` added, `~` changed, `removed:` refs); `{ diff: false }` prints the full tree. Acquisition prints the first tree as `initialObservation` (`observation: { screenshot: false }` skips its screenshot).
- Read page text from the tree: header `url | title | scroll | focused`, then one node per line, indent = depth, `eN` refs only on controls, text inline, `[iframe host]` subtrees inline (cross-origin included). `extract("text" | "markdown")` for article pages; `evaluate` only for data not in the tree.
- `tab.ref("e26")` returns an element handle (`click`, `fill`, `type`, `press`, `select`, `uploadFile`, `evaluate`, …). Refs are stable: an element keeps its number across observations and re-renders, new elements get new numbers; a ref whose node was replaced fails and says to observe again.
{{#if compactRefs}}
- `observation.elements` (controls only) carries the same refs for `find(e => e.name === …)`.
{{else}}
- `elements[i].ref` is `<snapshot>:<n>`; use that token, not `eN`; re-observe after a re-render.
{{/if}}
- Also on a tab: `url`, `title`, `goto`, `ariaSnapshot` (read-only), `screenshot`, `click`, `type`, `fill`, `press("Enter" | "Control+a")`, `scroll("down", { by: "page" })`, `select` (option label or value; an unmatched one fails and lists what the `<select>` offers), `uploadFile`, `waitForSelector`, `waitForUrl`, `evaluate` (a string is a page-global expression — no top-level `return`). Input never selects the tab or focuses Chrome.
- `tab.run(fnOrCode, { args?, timeout? })` receives `{ tab, page, browser, wait, assert }`; `page`/`frame` are **Puppeteer** (no `locator`; use `page.$`, `frame.evaluate`); no closures; not a sandbox. Python: JavaScript strings only.
- Tabs are handed back open at turn end; next turn, claim the exact id again. `await tab.close()` a tab you opened when done, never one you did not open unless asked; `tab.release()` hands back early. `await tab.reveal()` focuses Chrome — never to observe or recover.
- "OMP lost control … Chrome revoked": another extension (typically a password manager) took over the page. Never close that tab; tell the user what step to finish, then claim it again.
- Dialogs: actions report a pending JavaScript dialog (a claim returns `initialDialog`); `await tab.dialog()` inspects it, `tab.dialog({ action: "accept" | "dismiss", id, promptText? })` answers it.
- Child tabs your page opens are auto-leased: `await tab.popups()` lists them (also `discover()`'s `popupOf`); claim the child id to drive it. Chrome decides whether it selects the child; OMP never re-selects the tab it displaced.
- `await tab.downloads()` lists this page's downloads; `suggestedFilename` is not a saved path.
- `browser.open({ name?, url?, app?, viewport?, dialogs?, persist? })`: `app.path` spawns, `app.cdp_url` attaches, `app.relay: true` makes a Chrome task tab; `browser.close({ name?, all?, kill? })` releases.
</instruction>

<examples>
```javascript
const tab = await browser.getTab({ title: "401(k) contributions" }); // prints the tree
const field = tab.initialObservation.elements.find(el => el.name === "Amount in percent");
await tab.ref(field.ref).fill("15");
await tab.observe(); // prints the diff
```
</examples>
