Drive real Chromium tabs from JavaScript or Python Eval with the global `browser`; use `read` for static content. Default to headless (`browser.open`); use the user's Chrome only when they name it or the task needs their session — sites attribute those actions to the user.

<instruction>
Entry points: `browser.getTab({ title?, url? })` claims ONE open tab by substring (ambiguity lists exact ids); `browser.discover({ title?, url? })` lists tabs without attaching and `browser.claim(id)` adopts one unchanged; `browser.create({ url? })` opens an inactive task tab; `browser.open({ url?, app? })` starts or attaches a headless/CDP browser. Each returns a `tab` whose first tree prints as `initialObservation` (`observation:` takes `observe()`'s options); `tab.ref("e26")` is an element handle; `tab.run(fnOrCode)` runs a multi-step function with `{ tab, page, browser, wait, assert }` (no closures; not a sandbox). `page` is a raw Puppeteer `Page` (and `frame` a Puppeteer `Frame`): read data with `page.$$eval(sel, nodes => …)`, `page.$eval`, `page.evaluate`; Puppeteer's `page.locator()` is an action handle (`.click`, `.fill`, `.filter(fn)`, `.map`, `.wait`) and Playwright's reading API is not there at all — no `{ hasText }` option, no `.allTextContents()`, no `.evaluateAll()`. Everything else lives on those handles and is listed with them; `browser.help()` prints the full typed API when a signature matters. Prelude methods take positional arguments; Python: same names, JavaScript strings for `run`.

Model
- A tab is claimed, never selected: input never focuses Chrome or switches tabs; only `reveal()` does.
- An observation is the page's accessibility tree: header `url | title | scroll | focused`, one node per line, indent = depth, `eN` refs only on controls, text inline, iframes inline. After an action, `await tab.observe()` in the same cell settles the page and prints only what changed (`+` added, `~` changed, `removed:`); `{ diff: false }` prints everything, `{ display: false }` nothing.
- Refs are stable: an element keeps its number across observations and re-renders; new elements get new numbers; a ref whose node was replaced fails and says to observe again.{{#if compactRefs}} `observation.elements` carries the same refs for `find(el => …)`.{{else}} `elements[i].ref` is `<snapshot>:<n>` — use that token, not `eN`, and re-observe after a re-render.{{/if}}
- Read the tree first: every observation keeps its whole tree as `.tree` (and `String(obs)`); search that in code when the printed copy loses its middle. `extract("text" | "markdown")` is Readability: it keeps the highest-scoring article and drops tables, nav and sidebars, so it silently loses structured data. For a table or any structured block read the tree, `tab.ariaSnapshot("<selector>")`, or `page.$$eval`; `evaluate` for data no tree carries.

Ownership
- If the task names a site and a tab for it is open, claim it and stay on the user's account there; `create` only when no matching tab exists or you will navigate elsewhere. Never switch company or account inside the user's tab.
- Tabs are handed back open at turn end; next turn, claim the exact id again. Close a tab you opened, never one you did not open unless asked; `tab.release()` hands back early. Never `reveal()` to observe or recover.
- Several profiles (`browser.instances()`) → pass `browserId`.

Interruptions
- "Chrome revoked OMP's control …": another extension (typically a password manager) took the page. Never close that tab; tell the user what to finish, then claim it again.
- "The user stopped OMP's control … from Chrome's infobar": they ended browser control on purpose. Do not re-claim or work around it; stop and report what is done and what is left.
- A pending JavaScript dialog is reported on the action (a claim returns `initialDialog`); `tab.dialog()` reads it, `tab.handleDialog({ accept, id, text? })` answers it.
- Child tabs your page opens are auto-leased: `tab.popups()` (or `discover()`'s `popupOf`) lists them; claim the child id to drive it.
- `tab.downloads()` and `waitForDownload()` report finished downloads; the user's Chrome gives no `path`.
</instruction>

<examples>
```javascript
const tab = await browser.getTab({ title: "401(k) contributions" }); // prints the tree
const field = tab.initialObservation.elements.find(el => el.name === "Amount in percent");
await tab.ref(field.ref).fill("15");
await tab.observe(); // prints the diff
```
</examples>
