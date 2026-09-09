Control real host application windows from JavaScript or Python Eval with `computer` (not `browser`; no DOM). Safety rules: system prompt.

<instruction>
- Flow: `await computer.window(selector, { screenshot?, silent?, maxDepth?, maxElements?, query? })` acquires ONE exact window and displays its background inspection (tree and image); `win.initialObservation` holds that snapshot (`inspectionError` when AX failed). Loop: act on a ref → observe → verify. Acquisition never focuses anything.
- Identity: `selector` is an exact id or `{ app?, title?, id?, pid? }` and must resolve exactly one window; ambiguity returns candidates — pick an exact `id`/`pid`, never a name guess. `computer.windows(filter)` lists without inspecting; `computer.launch(nameOrPath | { bundleId?, name?, urls?, newInstance? })` launches in the background, then acquire its window.
- Observe: `win.observe(options)` → `{ snapshotId, window, tree, elements, complete, backgroundInput, relatedWindows?, documentPath?, documentEdited?, screenshot?, screenshotError? }`. `screenshot:false` is AX-only. `complete:false` = partial tree: returned refs are valid, omitted controls unknown — widen `maxElements` or `win.find({ role?, label?, value?, limit? })`.
- Elements from `observe`/`find` carry snapshot data (`ref`, `role`, `label`, `value?`, `enabled?`, `actions?`, `bounds?`) and methods `click`, `doubleClick`, `setValue`, `type`, `press`, `scroll`, `perform(action)`. `win.ref(token)` is a handle for those methods (`await win.ref(r).click()`); `await win.ref(r)` returns the snapshot. Activate with `click()`.
- Window actions: `click(token | [x,y], { button?, count?, modifiers?, delivery? })`, `doubleClick`, `drag(from, to)`, `scroll(direction, { target?, amount?, by? })`, `type(text, { target? })`, `press(chord, { target? })`, `setValue(token, text)`, `setFrame(bounds)`, `menu(path, { delivery: "foreground" })`, `reveal()`, `verify(expectations, { timeoutMs?, stableSamples? })`.
- Refs are current-generation only, bound to exact window id/pid; `observe`, `find` and `verify` refresh them. On `StaleRef` re-observe; never guess tokens. Pixels belong to the latest image of the SAME window; AX `bounds` are global desktop coordinates — never mix.
- Actions return `{ text, effect, evidence, data?, route?, delivery }`. Dispatch is not proof: read the postcondition back via fresh observation or `verify`. A failed reply may still have acted — inspect before retrying. `setValue` never reaches disk and does not mark the document edited, so `documentEdited: false` after a `setValue` is not proof of a save: in document apps save through the app (menu or `type`+shortcut), then confirm on disk or via `documentEdited`.
- Delivery defaults to background; the runtime never escalates on its own. Pass `delivery: "foreground"` yourself when the action needs it (drag, desktop-root input `computer.click/doubleClick/move/drag/scroll/type/press`, `menu`, a window that refuses background input) — it briefly makes the target key and restores focus after, so use it when the user asked for the result and background cannot deliver it. Do not send synthetic keys or clicks at a window that is not key unless `backgroundInput` confirms a route; in Electron click the editor first. `reveal()` only when the user should see the window — never for screenshots or recovery. Never fall back to shell `open` or AppleScript.
- Interruptions: while an `auth`, `permission` or `lock` window (password/TCC prompt, crash alert, lock screen) is on screen, every mutation is refused with `Interrupted:` and `interruptedBy { app, pid, windowId, title, kind }`; observations carry the same field. STOP: never type, click or send keys at it. Observe that window, tell the user what is asking, and wait. One exception: a crash alert for an app YOU launched that exited — do not relaunch; observe the alert, press its "Ignore" button, then tell the user.
- Lifecycle: a supervised `cua-driver` child (Apple Silicon macOS) runs native control. Cancelling stops the in-flight action and reports what landed as `partial`; refs survive unless the child was replaced. `await computer.release()` when done (automatic at turn settle); later calls start a fresh child — reacquire windows. `computer.close()` ends computer use for this session.
- `computer.run(fnOrCode, { args?, read_only?, timeout? })` receives `{ desktop, wait, assert }`; closures are not captured; full host access, not a sandbox. Python: same names with keyword options; `run` takes JavaScript strings.
</instruction>

<examples>
```javascript
const win = await computer.window({ app: "Code" });
const search = win.initialObservation?.elements.find(el => el.label === "Search");
if (!search) throw new Error("Search control not exposed");
display(await win.click(search.ref));
await win.observe({ screenshot: false });
```
</examples>
