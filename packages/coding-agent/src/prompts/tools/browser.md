Drive real Chromium tabs from JavaScript or Python Eval with the global `browser` object.

<instruction>
- Static content? Use `read`. Use `browser` for JavaScript execution, authenticated sessions, and interactive actions.
- Known existing Chrome title or URL: start with `await browser.getTab({title:"Exact page title"})` or `{url:"https://exact/url"}`. It acquires a unique match with initial state; no separate discovery is needed. Fields match exactly and combine; `browserId`/`windowId` narrow the scope. Ambiguity lists matching IDs for explicit selection. Missing matches create nothing. `getTab(id)` also accepts a discovery ID. Python uses the same selector dictionary.
- `await browser.instances()` lists paired browser profiles by their setup names and exact IDs, including disconnected profiles. With several connected profiles, pass an exact `browserId` to `create`; `discover({browserId})` narrows tab discovery. A discovered tab ID already identifies its browser for `claim`. No connected profile: run `omp browser-relay pair` and finish extension setup.
- Discovery returns structured data without printing it. Filter by the requested title, URL, browser or ownership and project only relevant fields before `display`, in the same Eval cell. Display the full inventory only when the user requests a broad inventory. For closure, discover/filter first and pass the matching exact IDs to `closeTab`; acquiring a page is unnecessary.
- Existing Chrome: `await browser.discover()` lists exact tab IDs without activating or attaching to pages. `await browser.claim(id, {label})` exclusively adopts that exact tab without navigating it. `await browser.create({url,label})` creates a new inactive task tab. Keep the returned immutable handle; labels and URLs are not ownership.
- Chrome acquisition displays initial controls, readable text and a background preview. Use `tab.initialObservation` for actionable refs and `tab.initialTree` for page text; no immediate extra observe call is needed. Optional `observation: {screenshot:false}` skips the preview. Check `inspectionError`, `treeError`, and `screenshotError` for partial state; missing information is unknown. Later observation/navigation supersedes initial refs.
- `tab.target` is immutable Chrome identity: `{id, browserId, tabId}`. Match discovery entries and children's `popupOf` against `tab.target.id` (Python: `tab.target["id"]`). `tab.id(n)` selects an observed element; it is not the tab's identity.
- `await tab.reveal()` explicitly focuses Chrome. Inspection and capture never authorize reveal. `await tab.retain()` keeps a created result after `await tab.release()`; release preserves adopted user tabs. Interrupted cleanup preserves task pages for recovery.
- To close a requested existing or retained Chrome tab, use `await browser.closeTab(id)` with its exact discovery ID. This does not attach to or activate the page. If already holding its managed handle, `await tab.close()` physically closes it, even if adopted or retained. Both refuse another actor's ownership. Rediscover afterward to verify the remaining inventory.
- JavaScript: `await browser.open(options)` returns a `BrowserTab`; `browser.tab(name)` returns an existing handle; `await browser.close(options)` releases tabs.
- Python: `await browser.open(name=…, url=…)`, synchronous `browser.tab(name)`, and `await browser.close(name=…)`. Python methods accept keyword arguments.
- `open` options: `name`, `url`, `app`, `viewport`, `wait_until`, `dialogs`, `timeout`, `persist`, `observation` (managed Chrome).
- `close` options: `name`, `all`, `kill`, `timeout`.
- Direct tab helpers:
  - Navigation: `url`, `title`, `goto`.
  - Inspection: `observe`, `ariaSnapshot`, `screenshot`, `extract`, `downloads`.
  - Interaction: `click`, `type`, `fill`, `press`, `scroll`, `drag`, `scrollIntoView`, `select`, `uploadFile`.
  - Waiting: `waitFor`, `waitForSelector`, `waitForUrl`.
  - Page execution: `evaluate`. `tab.evaluate(string)` evaluates the string as a page-global expression; top-level `return` is invalid. Pass a function or invoke an IIFE string to use `return`.
- `tab.ref(observed.elements[i].ref)` returns a snapshot-bound `BrowserElement`; a new observation or navigation invalidates it. `tab.id(n)` captures the current observation in the direct facade. Handles support `click`, `type`, `fill`, `press`, `hover`, `focus`, `select`, `uploadFile`, `scrollIntoView`, `boundingBox`, `isVisible`, `isHidden`, and `evaluate`.
- JavaScript `await tab.run(fnOrCode, { args?, timeout? })` runs a function or code string. Functions receive `{ tab, page, browser, wait, assert }`; cell closures are not captured. Plain data, functions, and `RegExp` values are supported in `args`.
- Python `await tab.run(code, timeout=…)` accepts a JavaScript code string only. Direct Python helpers use the same method names; keyword arguments become a trailing JavaScript options object.
- `tab.run` executes in an isolated JavaScript tab runtime with raw Puppeteer `page`/`browser`, ordinary Eval helpers, and full Bun/Node + tool-bridge access. It is not sandboxed.
- Direct helpers and `tab.run` return real structured values. Nonempty inner `display` text prints in the outer Eval cell; screenshots surface as Eval images.
- Selectors accept CSS plus Puppeteer `aria/…`, `text/…`, `xpath/…`, and `pierce/…` query handlers.
- Navigation and re-renders invalidate observed ids and refs. Re-observe, then act in the same cell.
- Managed Chrome `ariaSnapshot` is a read-only structural view. Use `observe` references for actions; raw ARIA slot references and numeric IDs inside `tab.run` are rejected because they lack snapshot identity.
- Use `tab.select(selector, 'option-value')` or `tab.ref(ref).select('option-value')` for `<select>` elements. Values must be strings, not label objects; read the visible option labels and values when they differ.
- `uploadFile` sets a file input from local paths, relative to the task directory when not absolute. Verify upload submission separately. Existing Chrome downloads use its profile settings; changing download behavior or directory through CDP is unsupported. A click does not prove download completion or its saved path. Chrome-internal Downloads pages cannot be acquired.
- Acquisition may return `initialDialog` instead of page inspection when reclaiming an observed pending dialog. Resolve it first; the next normal page operation initializes the same owned tab.
- Managed Chrome JavaScript dialogs: if an action reports a pending dialog, inspect with `await tab.dialog()`. For `status:"open"`, read `dialog.message`, `type`, and `defaultPrompt`; decide from the user’s request, then use `await tab.dialog({action:"accept",id:dialog.id,promptText:"..."})` or `{action:"dismiss",id:dialog.id}`. Responses require that exact current ID; promptText is only for accepting prompts. This works outside `tab.run` while the renderer is blocked. A response may open another dialog; inspect the returned state and re-read if needed. `unobserved` is unknown, not proof of absence. After resolving, inspect the page before repeating the triggering action. Native file/permission panels are separate targets.
- After triggering a download, `await tab.downloads()` returns `{since, omitted, entries}` for starts observed on this exact page since acquisition. Entries identify downloads by `id` with source `url`, `suggestedFilename`, `state` (`started`, `inProgress`, `completed`, `canceled`) and reported byte counts. Re-read a pending ID to verify completion; missing entries are unknown. The record retains the latest 256 starts. `suggestedFilename` is not the saved path, especially with duplicate filenames; verify that file separately before claiming its location.
- To find a saved location, use `await tab.downloads({paths:true})`. `files.available:false` explains missing extension permission or version support; completion entries remain available. Otherwise `files.matches` maps each observed download ID to candidate actual paths, matched by URL and a short time window. These are candidates, not proven tab ownership: multiple candidates or `truncated:true` are unresolved, and empty results are unknown. Verify the intended file and contents before reporting a destination; Chrome's cached `exists` flag is not a filesystem check. This lookup never requests permissions or changes download settings automatically.
- Managed Chrome `fill` replaces text through browser text insertion, including empty replacement. Use `type` for individual key events and `press` for shortcuts. The full operation temporarily emulates page focus without selecting the tab or focusing Chrome; page scripts may observe focus/visibility events. Verify the result from a fresh observation; a successful input command does not prove the application accepted it.
- During a managed Chrome operation, supported new-window links and `window.open` create inactive task-owned child tabs. Discover children by `popupOf` (parent discovery ID) and `ownership: "this_actor"`, then claim the exact child ID. Each claimed child needs its own retain/release decision. Unclaimed children survive parent release with ownership released for recovery.
- Background popups support HTTP(S)/`about:blank` destinations and return no `WindowProxy`. Named windows and new-window form submissions fail visibly; use an explicit destination tab when the site requires those semantics. The policy ends with the operation, preserving ordinary user popup behavior between operations. It is not a sandbox against scripts that bypass the installed page hooks.
- If a process dies, the broker releases stale tab ownership after its last scoped connection has been absent for 30 seconds. Pages and task groups remain for exact rediscovery and claim. A reconnect within that grace keeps ownership.
- Raw `page` event handlers and request interception last only for the current `tab.run`, including after failures. Register a dialog handler before the action that opens it and handle the dialog in that same call; verify the resulting page state. `page.off` and `page.removeAllListeners` remove only handlers created by that call, preserving controller observers.

Application modes:
- `app.path`: spawn the specified browser or Electron executable.
- `app.cdp_url`: attach to an existing CDP endpoint.
- `app.relay: true`: `open` creates a new inactive Chrome task tab. Substring selection is rejected; use discovery and exact claim to use an existing page.
- Chrome sessions are the user's real logged-in browser. Sites attribute actions to the user. Each actor must own its own exact tab; sharing an Eval kernel does not share ownership.
- A managed Chrome Puppeteer connection exposes only its owned tab. Raw create/activate/close operations are rejected; use the explicit lifecycle methods. Raw JavaScript still has Eval's ordinary host capabilities and is not a security sandbox.
- Managed Chrome `tab.close()` closes the page; use `tab.release()` for end-of-task cleanup that preserves adopted/retained pages. Other CDP-attached handles only disconnect when closed. Spawned browsers remain open unless `kill: true`.
- Idle tabs auto-freeze at turn settle (animated pages stop burning CPU/GPU) and unfreeze on next use; tabs idle past the idle-close timeout are closed. Pass `persist: true` on `open` to keep a tab live across turns (e.g. multi-step login); `browser.close` still releases explicitly.
</instruction>

<examples>
```javascript
const tab = await browser.open({ name: "docs", url: "https://example.com" });
const observed = await tab.observe();
await tab.id(observed.elements[0].id).click();
const title = await tab.run(async ({ tab }, suffix) => (await tab.title()) + suffix, { args: ["!"] });
await tab.close();
```

```python
tab = await browser.open(name="docs", url="https://example.com")
observed = await tab.observe()
await tab.id(observed["elements"][0]["id"]).click()
title = await tab.run("return await tab.title();", timeout=30)
await tab.close()
```
</examples>

<critical>
- Acquire a page handle with `getTab`, `claim`, `create`, or `open` before page interaction; `browser.tab(name)` only looks up an existing handle.
- Use acquisition's initial state first, then `tab.observe()` after changes; use screenshots for visual confirmation.
- `tab.run` has full Bun/Node and tool-bridge access; it is not sandboxed.
- Relay and CDP actions operate on real user sessions.
</critical>
