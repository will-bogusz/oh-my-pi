Drive real Chromium tabs from JavaScript or Python Eval with the global `browser`; use `read` for static content. Default to headless (`browser.open`); use the user's Chrome only when they name it or the task needs their session — sites attribute those actions to the user.

<instruction>
Entry points: `browser.getTab({ title?, url? })` claims ONE open tab by substring (ambiguity lists exact ids); `browser.discover()` lists tabs without attaching and `browser.claim(id)` adopts one unchanged; `browser.create({ url? })` opens an inactive task tab; `browser.open({ url?, app? })` starts or attaches a headless/CDP browser. Each returns a `tab` whose first tree prints as `initialObservation`; `tab.ref("e26")` is an element handle; `tab.run(fnOrCode)` runs a multi-step function with `{ tab, page, browser, wait, assert }` (raw Puppeteer `page`/`frame`; no closures; not a sandbox). Everything else lives on those handles and is listed with them; `browser.help()` prints the full typed API when a signature matters. Prelude methods take positional arguments; Python: same names, JavaScript strings for `run`.

Model
- A tab is claimed, never selected: input never focuses Chrome or switches tabs, and `reveal()` is the only thing that does.
- An observation is the page's accessibility tree: header `url | title | scroll | focused`, one node per line, indent = depth, `eN` refs only on controls, text inline, iframes inline. After an action, `await tab.observe()` in the same cell waits for the page to settle and prints only what changed (`+` added, `~` changed, `removed:`); `{ diff: false }` prints everything.
- Refs are stable: an element keeps its number across observations and re-renders; new elements get new numbers; a ref whose node was replaced fails and says to observe again.{{#if compactRefs}} `observation.elements` carries the same refs for `find(el => …)`.{{else}} `elements[i].ref` is `<snapshot>:<n>` — use that token, not `eN`, and re-observe after a re-render.{{/if}}
- Read from the tree first; `extract("text" | "markdown")` for article pages; `evaluate` only for data the tree does not carry.

Ownership
- If the task names a site and a tab for it is open, claim that tab and stay on the user's account there; `create` only when no matching tab exists or you will navigate elsewhere. Never switch company or account inside the user's tab.
- Tabs are handed back open at turn end; next turn, claim the exact id again. Close a tab you opened when done, never one you did not open unless asked; `tab.release()` hands back early. Never `reveal()` to observe or recover.
- Several profiles (`browser.instances()`) → pass `browserId`.

Interruptions
- "OMP lost control … Chrome revoked": another extension (typically a password manager) took over the page. Never close that tab; tell the user what step to finish, then claim it again.
- A pending JavaScript dialog is reported on the action (a claim returns `initialDialog`); `tab.dialog()` inspects it, `tab.dialog({ action: "accept" | "dismiss", promptText? })` answers it.
- Child tabs your page opens are auto-leased: `tab.popups()` (or `discover()`'s `popupOf`) lists them; claim the child id to drive it. Chrome decides whether it selects the child; OMP never re-selects the tab it displaced.
- `tab.downloads()` lists this page's downloads; `suggestedFilename` is not a saved path.
</instruction>

<examples>
```javascript
const tab = await browser.getTab({ title: "401(k) contributions" }); // prints the tree
const field = tab.initialObservation.elements.find(el => el.name === "Amount in percent");
await tab.ref(field.ref).fill("15");
await tab.observe(); // prints the diff
```
</examples>
