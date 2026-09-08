# Browser Eval prelude

The Eval `browser` facade controls browser pages from JavaScript or Python. For existing Chrome, discover an exact tab and claim it, or create a new inactive task tab. Use [`read`](./read.md) for static URLs and [`computer`](./computer.md) for native application windows.

```text
Paired Chrome profiles
         │ instances() → exact browserId
         ├── discover() → exact tab id → claim(id) ──┐
         └── create({ url, label, browserId }) ──────┤
                                                   ▼
                                         Actor-owned tab handle
                                                   │
                                   observe → act → verify
                                                   │
                           ┌───────────────────────┼────────────────────┐
                           ▼                       ▼                    ▼
                        reveal()                retain()             release()
                     explicit focus         keep on release       end ownership
```

The prelude is available while Eval and `browser.enabled` are enabled. It is not a standalone AgentTool. Browser and computer handles are separate APIs.

## Existing Chrome setup and discovery

For a known existing page, start with `await browser.getTab({ title: "Exact page title" })` or an exact `url`. Python uses `await browser.getTab({"title": "Exact page title"})`. A unique match is acquired with initial state in one call. Every supplied field must match exactly; optional `browserId` and `windowId` disambiguate profiles/windows. Multiple matches return a choice of exact IDs; no match creates nothing. `getTab(id)` accepts an already discovered ID. Lookup rechecks the selected page metadata during acquisition and releases a changed match without navigation or input.

Install the extension with `omp browser-relay install`, load the generated directory through Chrome's **Load unpacked** flow, and run `omp browser-relay pair`. Click the extension's toolbar button to open Options, choose a setup name such as Work Chrome, and enter the one-use pairing code. Repeat for each profile. See the [extension guide](../../packages/browser-relay/README.md) for custom ports, independent installations, and connection recovery.

When keeping an older extension loaded, install the new custom-port copy into a separate directory with a distinct display name: `omp browser-relay install --dir /absolute/new/extension --port 9333 --name "OMP Browser Relay 9333"`. Load that directory, run `omp browser-relay pair --port 9333`, and set `browser.relayUrl` to `http://127.0.0.1:9333` in the intended settings scope. Fresh installations use the installed port default; existing profile-local saved connection settings and pairing take precedence. The optional name is trimmed, must be nonempty, and changes the manifest name and toolbar settings title, not browser-instance identity or the pairing label. The default remains **OMP Browser Relay**.

Chromium compares debugger infobar message text: identical extension manifest names can automatically cancel the newer debugger even when the copies have different extension IDs. Distinct names preserve the visible warning; never suppress that warning with silent-debugger/infobar flags. A different name does not resolve another debugger owning the same tab.

`browser.instances()` returns paired profiles, including disconnected ones, as `{ id, label, connected, generation? }`. Labels are chosen during setup; they are not inferred account or profile identities. Use the exact `id` as `browserId`. With multiple connected profiles, `create` requires an explicit selection.

`browser.discover({ browserId? })` returns fresh tab inventory without attaching to pages, navigating, or activating Chrome. Each entry includes:

- `id`: exact discovery identity accepted by `claim` and `closeTab`; distinct from a returned handle and the numeric Chrome `tabId`.
- `browserId`, `browserLabel`, `tabId`, `windowId`, `title`, `url`, `pinned`, and `groupId`.
- `active`: whether this tab is selected in its window; it does not mean Chrome is the foreground application.
- `ownership`: `"available"`, `"this_actor"`, or `"other_actor"`.
- `popupOf`, when present: the discovery identity of the task-owned parent tab.

Chrome-internal, DevTools, Web Store, and other-extension pages are not attachable and are omitted. A tab with another debugger attached may also refuse a claim.

Instance and tab discovery return structured data without automatically printing the inventory. Use `display` only for fields needed by the task; filtering the returned value does not implicitly expose other tab titles or URLs.

```js
const matches = (await browser.discover())
  .filter(tab => tab.title === "Workshop reservation")
  .map(({ id, browserLabel, windowId, title, url }) => ({ id, browserLabel, windowId, title, url }));
display(matches);
```

Filter and select fields before display in the same Eval cell. Show a full inventory only when the request calls for it. For requested closure, pass the matching exact IDs directly to `closeTab`; page acquisition is unnecessary.

After inspecting the inventory, pass the selected entry's exact `id` to `browser.claim(id, { label? })`. A discovered ID already identifies its browser. Claim is exclusive to the calling actor and never navigates or changes the tab's group. Labels, titles, URLs, and numeric tab IDs cannot substitute for that identity.

Chrome `claim` and `create` return the exact handle with initial inspection already displayed: `initialObservation` holds actionable controls and their snapshot refs, `initialTree` holds readable page text, and `initialScreenshot` holds the local preview path. Use these before requesting another observation. Passing `observation: { screenshot: false }` skips capture; `includeAll` and `viewportOnly` configure the control observation. JavaScript and Python expose the same fields; Python passes `observation={"screenshot": False}`.

The immutable `tab.target` contains `{id, browserId, tabId}`. Use `tab.target.id` to match fresh discovery entries or a child's `popupOf`; in Python use `tab.target["id"]`. This identity survives tab movement and navigation; current URL, title, window, selection and ownership come from fresh discovery. `tab.id(n)` is an element helper and cannot identify a browser tab.

Inspection channels fail independently: `inspectionError`, `treeError`, or `screenshotError` identifies missing state while preserving a usable acquired handle. A whole-run cancellation or cleanup failure does not report successful acquisition. OMP attempts to preserve the exact tab and release ownership for rediscovery; cleanup failures remain explicit. Initial observations describe acquisition time, and later observations/navigation invalidate their old refs.

For an explicit request to close a tab, use `await browser.closeTab(id, { browserId?, timeout? })` directly from discovery. It does not attach a debugger or page worker, regroup the tab, or activate Chrome. Another actor's ownership is rejected; your own controlled tab can be closed this way. Discover again after closure to verify the remaining inventory. Stale IDs cannot close a replacement tab after removal or browser reconnection.

## Create, retain, release, and reveal

```js
const profiles = (await browser.instances()).filter(profile => profile.connected);
if (profiles.length !== 1) {
	throw new Error("Choose an exact browserId from browser.instances() first");
}

const tab = await browser.create({
	browserId: profiles[0].id,
	label: "Documentation review",
	url: "https://example.com",
});

display(await tab.observe());
display(await tab.extract("text"));
await tab.screenshot();

await tab.retain();
await tab.release();
```

`browser.create({ browserId?, url?, label?, timeout? })` always creates a new inactive Chrome tab; the URL defaults to `about:blank`. Task-created tabs share a group per task and window unless grouping is disabled. The first task label remains stable when later scratch tabs use different labels. Adopted tabs keep their existing grouping.

Keep the immutable handle returned by `create` or `claim`. Its `name` is a display label and its `handle` identifies this acquisition. `browser.tab(name)` cannot reconstruct a managed Chrome handle. Sharing an Eval kernel does not share ownership between actors.

| Operation                      | Effect on a managed Chrome tab                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `tab.reveal()`                 | Selects the tab and focuses its Chrome window explicitly.                                |
| `tab.retain()`                 | Marks a task-created tab to survive release; keeps ownership until release.              |
| `tab.release()`                | Releases ownership and invalidates the handle. Closes only unretained task-created tabs. |
| `tab.close()`                  | Physically closes this exact Chrome tab, including adopted or retained pages.             |
| `browser.closeTab(id)`         | Physically closes an exact discovered Chrome tab without acquiring page control.          |
| `browser.close({ all: true })` | Releases this actor's tabs across browser modes; does not release another actor's tabs.  |

Adopted user tabs and retained result tabs survive release. Another actor can discover and claim a released result by its current exact discovery ID. `retain`, `release`, and `reveal` require a managed Chrome handle returned by `create`, `claim`, or relay-mode `open`; use `close` for other modes.

Migration: managed Chrome handles previously treated `tab.close()` as release. Change end-of-task cleanup to `tab.release()` when adopted or retained pages should survive. Keep `tab.close()` for an intended physical closure. The older root `browser.close({ all: true })` remains an actor-wide cleanup operation; it is not a request to physically close every discovered tab.

Inspection, screenshots, and managed input do not implicitly reveal the tab or focus Chrome. Keep reveal separate from ordinary work and use it only when a foreground handoff is intended.

## Direct tab and element helpers

Direct helpers cross the host bridge and return structured values:

- Navigation: `url()`, `title()`, `goto(url, { waitUntil? })`.
- Inspection: `observe({ includeAll?, viewportOnly? })`, `ariaSnapshot(selector?, { depth?, boxes? })`, `screenshot({ selector?, fullPage?, silent? })`, `extract("markdown" | "text")`, `downloads()`.
- Interaction: `click(selector)`, `type(selector, text)`, `fill(selector, value)`, `press(key, { selector? })`, `scroll(dx, dy)`, `drag(from, to)`, `scrollIntoView(selector)`, `select(selector, ...values)`, `uploadFile(selector, ...paths)`.
- Waiting: `waitFor(selector, { timeout? })`, `waitForSelector(selector, { timeout?, visible?, hidden? })`, `waitForUrl(stringOrRegExp, { timeout? })`.
- Page execution: `evaluate(fnOrSource, ...args)`.

Direct `waitFor` and `waitForSelector` return booleans. Their timeouts are in milliseconds. Whole-operation timeouts on acquisition, close, and `tab.run` are in seconds, default to 30, and are clamped to 1–300, subject to `tools.maxTimeout`.

### Observation references

Managed Chrome `observe()` returns a `snapshot` and element entries containing both a numeric `id` and a snapshot-bound `ref`. Resolve an element from the observation, then act with its exact reference:

```js
const observation = await tab.observe();
const search = observation.elements.find(element => element.role === "textbox" && element.name === "Search");
if (!search?.ref) throw new Error("Search field is not exposed in this observation");
await tab.ref(search.ref).fill("background browser control");
display(await tab.observe());
```

`tab.ref(ref)` and `tab.id(number)` return synchronous `BrowserElement` proxies. On the direct facade, `tab.id` binds the number to the most recent observation. Handles support `click`, `type`, `fill`, `press`, `hover`, `focus`, `select`, `uploadFile`, `scrollIntoView`, `boundingBox`, `isVisible`, `isHidden`, and `evaluate`. A string passed to element `evaluate` is a function expression invoked with the element as its first argument.

A new observation or navigation invalidates managed Chrome references. Re-renders can also make an element unavailable. Re-observe and resolve again; do not reuse an old reference based on matching numbers. Prefer observing and acting in the same Eval cell.

Managed Chrome `ariaSnapshot()` is a read-only structural view. Its `[ref=eN]` slots are not action references; use `observe()` references for actions. Numeric IDs inside `tab.run` are also rejected on managed Chrome because they lack snapshot identity. Other Puppeteer modes retain their legacy numeric observation IDs and ARIA references.

### Selectors and input

Selectors accept CSS and Puppeteer `aria/…`, `text/…`, `xpath/…`, and `pierce/…` query handlers. Playwright-only pseudos such as `:has-text()` and `:visible` are rejected.

Use `tab.select(selector, "option-value")` or `tab.ref(ref).select("option-value")` for `<select>` elements. Values must be strings, not `{ label: ... }` objects; read the options when displayed labels differ from their values. `fill` does not support selects.

Managed Chrome `fill` replaces editable text through browser text insertion, including Unicode and empty replacement. `type` sends individual key events; `press` sends keys and shortcuts. Each managed run temporarily emulates page focus before selector lookup and observation, keeping it through input and restoring it during cleanup. This lets accessibility queries progress in an inactive tab without selecting it or focusing Chrome. Page scripts can observe this emulation, including focus and visibility events. Restoration failure ends reuse of the handle; release and rediscover before continuing. Check the result with a fresh observation; successful dispatch does not prove the application accepted the input.

### Files

`uploadFile(selector, ...paths)` sets an observed file input to local files; relative paths resolve against the task's working directory. Submit through the page and verify the application's response separately.

Downloads in existing Chrome use that profile's ordinary download settings. `Browser.setDownloadBehavior` and the legacy `Page.setDownloadBehavior` are rejected, including through raw page sessions: OMP does not apply a requested download directory or silently acknowledge that it did. A download-link click alone does not establish completion or the saved path. Chrome-internal Downloads pages cannot be acquired through this interface.

`await tab.downloads()` reads page-scoped download events observed since acquisition. It returns `{since, omitted, entries}`; each entry has an exact download `id`, source `url` and `frameId`, `suggestedFilename`, `startedAt`, `state`, and reported byte counts. States are `started`, `inProgress`, `completed`, and `canceled`. Re-read pending entries by their IDs to confirm a terminal state. Observation does not initiate, cancel, move, or retry a download.

This is a current-page event record, not the profile's download history: earlier downloads and other tabs are excluded, and a new acquisition starts a new record. The latest 256 starts are retained; `omitted` reports older entries dropped from this bounded record. Missing records are unknown, and a disconnected observation channel produces an explicit error. These Page-domain events are available in the qualified Chromium runtime but deprecated upstream; other providers may not expose them. `suggestedFilename` is not a saved path: browser settings, duplicate names and native dialogs can change the destination. Verify the actual file separately before claiming a location.

For saved destinations, `await tab.downloads({paths:true})` adds a `files` lookup. Enable **download file lookup** in this profile's OMP extension settings when wanted; the optional Chrome permission is requested only by that button. Missing permission, old service/extension versions, or provider failures return `files: {available:false, reason}` while retaining completion observations. Both the service and extension must support this feature.

With permission, `files` contains `{available:true, correlation:"url-and-time-candidates", matches}`. Each match identifies an observed download `id`, a `truncated` flag, and candidate files with Chrome's numeric download ID, actual `path`, URLs/referrer, start time, state, byte counts and cached existence flag. The relay accepts only GUIDs observed on the owned tab and supplies its own timestamp; the extension searches within five seconds either side and filters exact original/final URLs. Results are capped at 100 per observed start. Chrome's file records contain no source tab ID, so this correlation does not prove ownership. Multiple candidates, empty results and truncated searches remain unresolved; inspect the actual intended file before reporting its path. Delayed starts outside this time window remain unknown. Lookup never initiates, moves, cancels or retries transfers, changes profile settings, or asks for permission from agent code.

## JavaScript dialogs in managed Chrome

`await tab.dialog()` inspects the dialog journal on the existing exact debugger attachment without running page JavaScript. `status: "open"` includes a dialog with `id`, `type`, `message`, `url` and `defaultPrompt`. Answer with `await tab.dialog({action:"accept", id: dialog.id, promptText:"..."})` or `{action:"dismiss", id: dialog.id}`. Prompt text is valid only when accepting a prompt. Python accepts a dictionary or keyword arguments. This method belongs to the outer tab handle, outside `tab.run`.

Stale IDs, another actor's lease, invalid prompt text and overlapping responses are refused. New dialogs receive new IDs, even with identical text. `closed` means the last observed dialog resolved; a page can open another afterward. `unobserved` means unknown: events before attachment, disconnects and uncertain response delivery cannot establish absence. An uncertain reply must not trigger a blind retry.

A blocking unexpected dialog ends the current managed run with a decision-required error. It does not repeat the trigger or answer the dialog. Page-side code already triggered can continue after the decision, so inspect the resulting state. Input and renderer cleanup may remain pending until dialogs resolve; the next normal run drains that cleanup before admitting work. The debugger remains attached while an observed dialog is open, even if clients disconnect, to preserve its original resolution channel. This retained attachment is a deliberate pending resource, not completed cleanup.

When reclaiming a tab with an already observed pending dialog, acquisition returns `initialDialog` instead of initial page inspection. The exact tab stays owned while the decision is pending. Resolve it through `tab.dialog()`; the first subsequent page operation initializes control on that same tab. Releasing or disposing the task preserves the page and its unresolved dialog for later recovery.

This supports page-owned JavaScript alerts, prompts, confirms and beforeunload events observed on the root debugger session. Native file pickers, browser permission panels and dialogs that predate observation are not equivalent. Dialogs opened before any debugger observation, child-session events, cancellation during resolution and extension reconnect recovery still require qualification. Generic worker recycling no longer dismisses dialogs or stops navigation implicitly.

## `tab.run(fnOrCode, options?)`

Raw `page` event handlers and request interception are scoped to one call and cleaned up on success or failure. Register a JavaScript dialog handler before the triggering action and resolve it during that same call. Listener removal affects only the call’s own handlers, preserving OMP and Puppeteer observers. Dialog acceptance is not proof of the application result; inspect the resulting state. Unexpected dialogs and native permission/file panels still require explicit handling.

A JavaScript run accepts a serialized function or a JavaScript function-body string, plus `{ args?, timeout? }`:

```js
const hrefs = await tab.run(async ({ page }) => {
	return await page.$$eval("a", links => links.map(link => link.href));
});

const title = await tab.run(async ({ tab }, suffix) => (await tab.title()) + suffix, { args: ["!"], timeout: 10 });
```

Functions receive `{ tab, page, browser, wait, assert }` as their first argument. Additional `args` follow it. Plain data, functions, and `RegExp` values are serialized; the function cannot capture Eval-cell closures. Code strings use the same names as globals and allow top-level `await`.

The inner `tab` includes handle-returning `waitFor`/`waitForSelector` and run-scoped `waitForNavigation`/`waitForResponse`. Start a navigation or response wait before the action that triggers it. Request interception lasts only for the current run.

For managed Chrome, the Puppeteer connection exposes only the owned target. Raw browser create, activate, and close operations are rejected; use the explicit facade lifecycle. Runs still have ordinary Eval helpers, full Bun/Node access, and the tool bridge. This target scope is not a security sandbox for arbitrary host code.

The return value stays structured. Nonempty inner `display(...)` text prints in the outer Eval cell; object and image displays remain Eval output. A run with no display text emits no placeholder.

## Python API

Python exposes the same direct method names and lifecycle. Acquisition options use keyword arguments. `tab.id` and `tab.ref` are synchronous proxies; keyword arguments on direct helpers become a trailing JavaScript options object.

```python
profiles = [profile for profile in await browser.instances() if profile["connected"]]
if len(profiles) != 1:
    raise RuntimeError("Choose an exact browserId from browser.instances() first")

tab = await browser.create(browserId=profiles[0]["id"], label="Documentation review", url="https://example.com")
observation = await tab.observe(viewportOnly=True)
display(observation)
title = await tab.run("return await tab.title();", timeout=30)
await tab.retain()
await tab.release()
```

Use `await browser.discover(browserId=...)` and `await browser.claim(tab_id, label=...)` for an existing tab. Use `await browser.closeTab(tab_id, browserId=...)` for physical closure without page control. Python `tab.run` accepts a JavaScript string only, not a Python callable. `browser.open(name=..., url=...)`, synchronous `browser.tab(name)`, and `browser.close(name=...)` remain available for the named-tab modes below.

## Compatibility `open` and other browser modes

`browser.open(options?)` supports `name`, `url`, `app`, `viewport`, `wait_until`, `dialogs`, and `timeout`. Explicit selection takes precedence in this order: `app.cdp_url`, `app.path`, then `app.relay`. Without explicit selection, OMP considers relay settings, configured CDP, cmux, then project-shared headless Chromium. `PI_BROWSER_RELAY` can override relay enablement.

| Mode                                                 | Acquisition and explicit close behavior                                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed Chrome (`app.relay: true`, or relay default) | Every `open` creates a new inactive task tab; `name` supplies its label. `app.target` substring selection is rejected. Handle `close` physically closes the tab; `release` applies retention. |
| Headless                                             | Opens or reuses a named OMP-owned page in project-shared Chromium with stealth patches. Close closes that page.                                                       |
| Spawned (`app.path`)                                 | Starts or reuses a CDP-enabled browser/Electron executable; `app.args` applies here. The process remains open unless `kill: true` releases its last managed tab.      |
| Connected (`app.cdp_url`)                            | Attaches through an HTTP CDP discovery endpoint; `app.target` can select a page by URL/title substring on this legacy path. Close disconnects and preserves the page. |
| Cmux                                                 | Controls an available cmux WKWebView surface. Close closes an OMP-owned surface.                                                                                      |

Use `create({ browserId, ... })` for explicit paired-profile selection and `claim(id)` for an existing Chrome tab. Relay-mode `open` never adopts the currently selected user tab and never reuses a task tab because its label matches.

Other modes use named tabs. `browser.tab(name = "main")` returns a proxy for an already-open named tab and does not open one. Reusing a name across browser kinds is rejected until the old tab is closed. `browser.close({ name?, all?, kill?, timeout? })` and `tab.close({ kill?, timeout? })` release these tabs. `kill` does not terminate an attached Chrome/CDP browser.

## Popups, interruptions, and recovery

During a managed Chrome operation, supported new-window links and `window.open` create inactive children reserved to the same actor, in the source window and task group. Discover a child by `popupOf` and `ownership: "this_actor"`, then claim its exact ID. Each claimed child needs its own retain/release decision. Unclaimed children survive parent release and become available for recovery.

Background popups support HTTP(S) and `about:blank` destinations and return no `WindowProxy`. Named windows and new-window form submissions fail visibly. The containment policy ends with the operation, preserving ordinary user popup behavior between operations. It is not a sandbox against page scripts that bypass the installed hooks.

Each acquired tab permits one active run. A timeout or abort can recycle its worker and invalidate handles. Unplanned teardown preserves task pages, including partially created pages, for recovery. Failed acquisition and teardown use one preserving-release request; they never follow failed retention with a potentially destructive release. Local workers drain even when server recovery cannot be confirmed, and the error identifies the exact tab for rediscovery. Older services reject this recovery operation explicitly; their existing orphan recovery remains available after disconnection. If a process disappears, the broker releases orphaned ownership after its final scoped connection has been absent for 30 seconds and admitted work has drained. An idle connected task keeps ownership; a reconnect within the grace preserves it. Physical pages and groups survive this recovery.

Reconnecting a paired profile invalidates that profile's old handles without replacing other profiles' sessions. Discover the current exact ID and claim again. Never use a stale label, URL match, or new `open` call as proof that the old task was recovered.

| Failure                          | Next step                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| Stale or released managed handle | Rediscover and claim the exact surviving tab. Create only if a new page is intended.            |
| Stale element reference          | Observe again, then resolve the new reference.                                                  |
| Busy tab                         | Await the active helper/run before another operation.                                           |
| Input or selector timeout        | Inspect current page state before deciding whether to retry; the action may have had an effect. |
| No connected profile             | Inspect `instances()`, finish extension pairing, and verify the selected endpoint.              |
| Multiple connected profiles      | Pass the intended exact `browserId` to `create` or filter discovery.                            |
| Older service owns active work   | Use a separate endpoint or update after its work finishes; do not replace the healthy service.  |
| Missing legacy named tab         | Reopen it with the intended non-relay mode and target.                                          |

Chrome and attached sessions are the user's logged-in sessions, so sites attribute actions to the user. Exact ownership establishes the target, not permission for an unrelated consequential action. Verify application state after UI changes.

## Screenshots and output

`tab.screenshot()` saves a full-resolution image beneath `browser.screenshotDir`, or the OS temporary directory when unset, and returns its path. Unless `silent: true`, it emits an Eval image. It never accepts an output path. Capturing a managed Chrome tab does not select it or focus its window.

Observation images appear as compact snapshots in collapsed tool output; expanding the tool output changes their presentation, not browser state. See [observation previews](./computer.md#observation-previews). Host results preserve structured `value` separately from displayed content. Text beyond the shared inline-output limit is stored as a session artifact with capped inline text.

## Source

- Public contract and JavaScript/Python facades: `packages/coding-agent/src/tools/browser/{declarations.d.ts,prelude.js,prelude.py}`.
- Host dispatch and actor authorization: `packages/coding-agent/src/tools/browser.ts` and `packages/coding-agent/src/tools/browser/managed-chrome.ts`.
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/browser.md`.
- Tab lifecycle and helpers: `packages/coding-agent/src/tools/browser/{tab-supervisor,tab-worker}.ts`.
- Browser registry and other modes: `packages/coding-agent/src/tools/browser/{registry,launch,attach}.ts` and `packages/coding-agent/src/tools/browser/cmux/`.
- Paired instances, ownership, authentication, and CDP transport: `packages/coding-agent/src/tools/browser/relay/`.
- Chrome extension: `packages/browser-relay/extension/`.

### Updating an existing Chrome extension

Run the extension installer against the same directory used for the loaded unpacked extension. Updates preserve its custom display name unless `--name` is supplied. Reload that entry in Chrome’s extension manager to load the new files. Existing browser labels, pairing credentials and saved connection settings remain in Chrome; updating files does not require a new pairing code. An exported directory alone does not prove that Chrome has loaded or reloaded it.

After reconnecting, `omp browser-relay list` (with `--port` for a custom endpoint) and `browser.instances()` report `extension.status`. `matching` means the connected worker reported the build bundled with the running service; `different` means another build is executing, without assuming which is newer. `unknown` means disconnected or an older extension that cannot report its build. Older services omit these diagnostics entirely. Update the service after its active work finishes as well as reloading the extension when migrating versions.

`loadedBuildId` comes from code embedded in the executing worker, not a fresh read of files on disk. `expectedBuildId` identifies the service’s bundled extension; the export’s `build-info.json` carries the same identity. The reproducible digest covers the unstamped worker, options UI and base manifest. Custom display names and connection defaults do not change code identity. A matching build establishes version alignment, not permission grants or successful task execution.
