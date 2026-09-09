Drive real Chromium tabs from JavaScript or Python Eval with the global `browser`; use `read` for static content. Default to a private headless browser (`browser.open`); touch the user's own Chrome only when they name it or the task needs their logged-in session.

<instruction>
- Existing Chrome is the user's logged-in profile; sites attribute actions to the user. `await browser.getTab({ title?, url?, browserId?, windowId? })` acquires ONE tab by title/URL substring; ambiguity lists exact ids — choose one, never guess. `browser.discover({ browserId? })` lists exact ids and `ownership` without attaching; `browser.claim(id, { label? })` adopts that exact tab unchanged; `browser.create({ url?, label?, browserId? })` opens an inactive task tab. `browser.instances()` lists paired profiles; several → pass `browserId`; none → `omp browser-relay pair`.
- Identity is the immutable handle and `tab.target` `{ id, browserId, tabId }`; titles, URLs, labels and names are not ownership. `tab.id(n)` is an element helper, not the tab. Display only needed discovery fields.
- Acquisition displays initial controls, text and preview (`initialObservation`, `initialTree`, `initialScreenshot`; `inspectionError`/`treeError`/`screenshotError` mark partial state; `observation: { screenshot: false }` skips capture). Loop: observe → act by ref → observe again; a successful command is not proof the page accepted it.
- `tab.ref(observed.elements[i].ref)` / `tab.id(n)` return element handles (`click`, `fill`, `type`, `press`, `select`, `uploadFile`, `evaluate`, …). Navigation or a new observation invalidates them: observe and act in the same cell.
{{#if compactRefs}}
- Refs are `e1`…`eN`, renumbered by every observation. A ref survives a re-render that replaced its node; it fails only when the element is gone.
{{else}}
- A re-render between observation and action also invalidates refs.
{{/if}}
- Direct helpers: `url`, `title`, `goto`; `observe`, `ariaSnapshot` (read-only; `[ref=eN]` there are not action refs), `screenshot`, `extract`; `click`, `type`, `fill` (replaces text), `press`, `scroll(0, 600)` / `scroll("down", { by: "page" })`, `select(selector, "value")`, `uploadFile`; `waitFor`, `waitForSelector`, `waitForUrl`; `evaluate` (a string is a page-global expression — no top-level `return`). Input never selects the tab or focuses Chrome.
- `tab.run(fnOrCode, { args?, timeout? })` receives `{ tab, page, browser, wait, assert }`; closures are not captured; raw `page` exposes only the owned tab; handlers last that run only. Not a sandbox. Python: JavaScript strings only.
- Ownership ends with your turn, pages do not: every tab is handed back open (task group and "OMP is debugging this browser" bar go away), so the user can take over a half-finished page and ask you to continue on it. Nothing carries over — next turn, claim the exact id again. Nothing is closed for you: when you are done with a tab you opened, `await tab.close()` it (or `browser.closeTab(id)` later); leave open a page the user asked to see or may want next; never close a tab you did not open unless asked. `tab.release()` hands back early.
- Lost control: "OMP lost control of ... Chrome revoked" means Chrome ended the debugger because another extension (typically a password manager) put its UI in the page — common on sign-in forms. The tab is open; you cannot attach. Never close it; tell the user which tab and what step to finish (sign in, dismiss the prompt), then claim it again once they say it is ready.
- `await tab.reveal()` focuses Chrome; never reveal to observe or recover.
- Dialogs: actions report a pending JavaScript dialog (a claim returns it as `initialDialog`). `await tab.dialog()` → `{ status, dialog: { id, type, message, defaultPrompt } }`; answer with `tab.dialog({ action: "accept" | "dismiss", id, promptText? })` per the user's request, then inspect before repeating the trigger.
- Child tabs your page opens are auto-leased to you, inactive: `await tab.popups()` lists them (also in `discover()` with `popupOf`); claim the exact child id to drive it.
- `await tab.downloads()` lists this page's downloads (`id`, `suggestedFilename`, `state`); `suggestedFilename` is not a saved path — check the filesystem.
- Other modes: `browser.open({ name?, url?, app?, viewport?, wait_until?, dialogs?, timeout?, persist? })` — `app.path` spawns, `app.cdp_url` attaches, `app.relay: true` creates a Chrome task tab; default is headless Chromium. `browser.tab(name)` looks up an existing handle; `browser.close({ name?, all?, kill? })` releases. Idle headless tabs freeze at turn end and close after the idle timeout unless `persist: true`.
</instruction>

<examples>
```javascript
const tab = await browser.getTab({ title: "Workshop reservation" });
const field = tab.initialObservation?.elements.find(el => el.role === "textbox" && el.name === "Search");
await tab.ref(field.ref).fill("background browser control");
display(await tab.observe());
```
</examples>
