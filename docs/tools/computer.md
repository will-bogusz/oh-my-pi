# computer Eval prelude

Control real host windows from JavaScript or Python Eval through `computer`. This is separate from `browser`: there is no DOM, browser/CDP, raw driver, permissions/config mutation, or replay passthrough. See [Scriptable computer use](../computer-use.md) for setup, safety, examples, and migration; this page is the authoritative description of the backend and of what each host supports.

The model-facing prompt (`packages/coding-agent/src/prompts/tools/computer.md`) is deliberately short: it states the flow, the identity rule, the observe → act → verify loop, delivery, interruptions, durability and lifecycle. Everything below is the long-form contract behind those rules.

## Source and runtime

- Host service: `packages/coding-agent/src/tools/computer.ts`
- Public contract: `packages/coding-agent/src/tools/computer/declarations.d.ts`
- Facades and approval allowlist: `packages/coding-agent/src/tools/computer/{prelude.js,prelude.py,call.ts}`
- Session and runtime: `packages/coding-agent/src/tools/computer/{supervisor,runtime,backend,types}.ts`
- Driver child and vendored executable: `packages/coding-agent/src/tools/computer/{driver,vendored,cua-session}.ts`, `vendor/cua-driver/<platform>/`
- Interruption gate: `packages/coding-agent/src/tools/computer/interruption.ts`
- Prompt and safety: `packages/coding-agent/src/prompts/{tools/computer,system/computer-safety}.md`

`computer.enabled` defaults to false; Eval must be enabled. `/computer` toggles the current session. `computer.maxWidth`/`maxHeight` default to 3840/2400, subject to model-transport capture caps. There is no backend selector: native control is the vendored `cua-driver` for the host, on Apple Silicon macOS or X11 Linux (see [Platforms](#platforms)). Hosts without a vendored driver report that native control is unavailable; a failure never selects another driver or input route.

### The driver child

After approval, OMP spawns the vendored `cua-driver mcp --direct` executable as one child per agent session and talks newline-delimited JSON-RPC over its stdio. The driver owns capture, accessibility and input; there is no mixed OMP-capture/driver-input path. Operations are serialized per session.

The executable is vendored per platform under `vendor/cua-driver/<platform>/` with a `manifest.json` (version, sha256, source commit on the fork). Standalone builds embed it (`packages/coding-agent/scripts/cua-driver-plugin.ts`). On first use OMP verifies the sha256 and copies it to `~/.omp/natives/cua-driver/cua-driver` (with `manifest.json` beside it); nothing is downloaded and no package manager runs. The install path is fixed so macOS TCC sees one client across updates.

On macOS the vendored executable is code-signed with a stable local identity (`codesign -f -s "OMP Computer Use" --identifier com.ohmypi.cua-driver`) before its sha256 is recorded — see [`vendor/cua-driver/README.md`](../../vendor/cua-driver/README.md). TCC keys a signed binary's grants to its designated requirement, and Cargo's ad-hoc signature changes on every build, so an unsigned driver update raises a fresh Accessibility / Screen Recording prompt. Answering the prompt is the user's alone: while a system permission dialog is on screen the interruption gate refuses every action, and an unanswered dialog keeps refusing until it is dismissed.

Cancellation is cooperative. Aborting a call sends `notifications/cancelled` (and the `cancel_operation` tool when the driver advertises it) for that request id; the driver stops before its next step and answers `{"code":"cancelled","partial":…}` describing what already landed (input stops between complete key pairs; an interrupted drag is released at its last delivered position). The session stays usable and refs and frames remain valid. A child that ignores the cancel for the grace period (10 s by default) is killed; a child that exits for any reason is respawned by the next call, with element refs and pixel frames invalidated. Cancellation never undoes completed application changes.

When the agent finishes its turn the driver child is ended, so the macOS screen-sharing indicator goes away; the next computer call starts a fresh child. `await computer.release()` does the same on demand and is read-tier. `/computer off` disables new calls, interrupts the current agent turn and awaits release before reporting disabled, so the model cannot treat disabled access as a recoverable connection error. `/computer on` allows later requests to start a fresh child. `computer.close()` permanently ends computer use for the OMP session; later calls fail even after `/computer on`.

Interrupting the turn with Escape cancels the in-flight driver action, waits for admitted work to drain, and then releases this actor's driver child and any idle rendering lease exactly as turn settle does. Computer use stays enabled; the next call starts a fresh child.

### Capture and permissions

`computer.display` defaults to `all`; on the current driver `all` and `primary` both mean the primary display. `displays()` returns only the primary display and does not establish the total display count. The setting never selects a window.

For an onscreen window (including a covered window), requesting a screenshot starts or reuses a rendering lease: a ScreenCaptureKit stream covering the target window's display at 16×16 pixels and 2 fps, with every frame discarded. The requested screenshot is captured separately. The lease keeps covered windows rendering and shows macOS's system sharing indicator. There is one target per session; changing the captured target replaces it and invalidates earlier window pixel frames, including when the new capture fails. Capture the earlier window again before returning to pixel input. Hidden/offscreen windows use exact-window snapshots without starting a stream; this supplies an image, not an assertion of application freshness. AX-only observation does not start a lease or release an existing one.

OS permissions belong to the host running the driver. macOS Screen Recording covers capture and the lease; Accessibility covers AX and input. `computer.capabilities()` reports `backend`, `driver { version, transport }`, permission state and delivery metadata. A grant is not proof of delivery; inspect capability and effect evidence.

## Discovery and immutable identity

`computer.window(selector, options?)` acquires and inspects one exact target in the background. It displays the initial accessibility tree and image and exposes the structured snapshot as `win.initialObservation`. Pass `{ screenshot: false }` for AX-only acquisition. Python accepts the same options as keywords. Use `computer.windows(filter)` for an inventory without inspection.

The identity rule: a selector must resolve exactly one window. `selector` is an exact id, or `{ id?, pid?, app?, title? }`. Ambiguous acquisition returns the matching window identities without inspecting or controlling a candidate; select from those candidates by exact `id`/`pid` (or by adding the document title) rather than repeating inventory. IDs accept strings or positive safe integers and are returned as strings. A window handle retains exact `id` and `pid` plus snapshot `app`, `title`, `bounds`, optional `onScreen`, `layer` and `kind`; bound identity is frozen and never silently follows a similarly named replacement window.

Initial AX failure is reported as `win.inspectionError`; acquisition preserves the exact handle and attempts an independent screenshot unless capture was disabled (`win.initialScreenshot`, or `win.screenshotError`). These fields describe acquisition, not live state. Later observation or verification can invalidate initial refs.

- `computer.apps()` returns running and installed regular macOS applications.
- `computer.windows({ id?, pid?, app?, title? })` lists matching windows.
- `computer.launch(nameOrAbsoluteAppPath | { name?, bundleId?, urls?, newInstance? })` requests a non-activating launch (exec tier). A plain request for an already-running instance reuses it without reopening, hiding or activating it. Bundle ID takes precedence if both selectors are supplied. Python also accepts keyword options. Background launch does not forcibly hide the app and does not promise that every application preserves window order; inspect the returned launch evidence and acquire the window after launch. After `launch_app` returns, OMP watches the window roster for two seconds. If the launched process has already exited and a CrashReporter alert is on screen, the result names that alert as `interruptedBy` and records it as this session's crash alert (see [Interruptions](#interruptions)); if a live app raised a permission prompt instead, the result says so and actions stay refused until the user answers it. Keep recovery within the computer interface rather than substituting a shell or foreground launch.
- `computer.focusedWindow()` is unsupported on the driver: window order does not establish keyboard focus.
- `computer.displays()` lists the primary display.

Elements retain `ref`, `pid`, `windowId`, `role`, `label`, and optional `value`, `placeholder`, `enabled`, `selected`, `actions`, `bounds`. These fields are immutable snapshot data, not live getters. Empty values remain empty; `placeholder` is a separate hint and is never substituted for field contents. Missing enabled/selected state remains unknown.

## Observe and resolve

```javascript
const win = await computer.window({ app: "Code" });
const observation = win.initialObservation;
if (!observation) throw new Error(win.inspectionError);
const target = observation.elements.find(el => el.label === "Search");
if (!target) throw new Error("Search control not exposed");
const element = await win.ref(target.ref);
display(await element.click());
display(await win.observe({ screenshot: false }));
```

- `win.observe({ screenshot?, silent?, maxDepth?, maxElements?, query? })` returns `{ snapshotId, window, tree, elements, complete, backgroundInput, relatedWindows?, documentPath?, documentEdited?, interruptedBy?, screenshot?, screenshotError? }`. `tree` is text; `elements` is a structured array. Default observation captures and emits an image; `screenshot: false` is AX-only, `silent: true` suppresses image emission. Capture failure preserves valid AX results with `screenshotError`. Direct `win.observe()` displays the tree, coverage warning and optional image even when its return value is assigned.
- `complete` is true only when the traversal neither truncated nor skipped nodes. A partial tree keeps its returned refs valid; omitted controls and values remain unknown. `maxElements` bounds visited AX nodes, including containers, so a small limit can omit a visible button. Traversal shares a bounded native budget; when it stops early the tree text says so.
- `win.screenshot({ silent? })` captures independently of AX and returns screenshot metadata, or throws the capture error. It refreshes the coordinate frame without invalidating element refs.
- `win.find({ role?, label?, value?, limit? })` refreshes AX-only observation and returns matching element handles.
- `win.ref(token)` and `computer.ref(token)` resolve a current reference. Prefer the window-scoped form.
- `win.verify(expectations, { timeoutMs?, stableSamples? })` evaluates ANDed native predicates and returns `status: "satisfied" | "unsatisfied" | "unknown"` plus per-predicate evidence. Window predicates use `{ window: { exists?, bounds?: { x, y, width, height, tolerance_px? } } }`; element predicates use `{ element: { selector: { role?, label_contains? }, exists?: true, value_equals?, enabled?, selected? } }`. Unknown/unsupported state is not success, and verification never infers absence from an incomplete traversal.

Element snapshots optionally include `actions`, an immutable list of observed names accepted by `element.perform(action)` (`press`, `show_menu`, `pick`, `confirm`, `cancel`, `open`, subject to the target exposing them). An advertised action does not prove its effect; observe the result before continuing.

An attached sheet appears in `relatedWindows` with its exact `id`, `pid`, title and `relation: "sheet"`. Acquire that identity with `computer.window({ id, pid })` before inspecting or acting on its controls; the parent observation does not publish them.

### Document state and durability

For document windows the driver reads two AX attributes once per observation and OMP surfaces them as `documentPath` (a `file://` URL) and `documentEdited` (the app's own unsaved-changes flag); the tree text gains a `Document: <path> — unsaved changes|saved` line. Either key is absent when the app reports nothing — absent means unknown, and `documentEdited: false` alone is never evidence of a save.

`setValue` writes through accessibility. It never reaches disk, and whether the app registers it as an edit at all is app-specific. For a durable edit: write, save through the app (menu, shortcut or the app's own control), then re-observe and confirm `documentEdited` is false.

### Reference lifetime

Observations advance the reference generation; only current refs are valid, bound to the exact window id and PID. `find` and `verify` also refresh the generation; verification invalidates both refs and the saved image frame for that window, and AX-only observation discards that window's previous image frame while leaving other windows' frames alone. Any AX traversal can also evict refs from the driver's session-wide registry, including another window's refs. On `StaleRef`, re-observe and reacquire; never guess a token. A driver restart or `release()` resets refs and frames; reacquire exact window handles afterwards. `el.value`/`el.bounds` remain historical data even when a later action rejects the ref as stale.

A window without accessible controls can still have a usable screenshot. An unavailable snapshot or empty element list does not justify inventing a token; use the image when available.

### Observation previews

Browser and computer observation images appear as compact snapshots in collapsed tool output. Use the existing tool expansion control (Ctrl+O by default) to show them at the configured inline-image size. Collapsed snapshots fit within 48 columns and 8 rows; tighter image settings and the shared image budget still apply. Expansion only changes the displayed snapshot; it does not take a new screenshot, activate an app, or reveal a window.

Python uses keyword options and lists for points; returned observation objects use dictionary keys, while window/element handle fields use attributes:

```python
win = await computer.window(app="Code")
observation = await win.observe()
target = next((el for el in observation["elements"] if el["label"] == "Search"), None)
if target is None:
    raise RuntimeError("Search control not exposed")
element = await win.ref(target["ref"])
display(await element.click())
display(await win.observe(screenshot=False))
```

## Window and element actions

`target` is a current token string or `[x, y]` in the latest image of this window. Window delivery defaults to background and never escalates automatically.

| Window method | Options / meaning |
| --- | --- |
| `click(target, options?)` | `button`, `count`, `modifiers`, `delivery`; token clicks require count 1 and no modifiers |
| `doubleClick(target, options?)` | `button`, `modifiers`, `delivery`; an element double-click is two left clicks at its live bounding-box centre |
| `drag(from, to, options?)` | Two points; `button`, `modifiers`, `durationMs`, `steps`, `delivery` — foreground only on the current driver |
| `scroll(direction, options?)` | `target`, `amount`, `by: "line" \| "page"`, `delivery` |
| `type(text, options?)` | Optional `target`, `delivery` |
| `press(chordOrChords, options?)` | Optional `target`, `delivery` |
| `setValue(token, text)` | Replace the accessible value (non-durable; see above) |
| `setFrame({ x, y, width, height })` | Change window geometry |
| `menu(path, { delivery: "foreground" })` | Menu-label path array; foreground required |
| `reveal()` | Explicit foreground activation; same name in Python |

Scroll directions: `up`, `down`, `left`, `right`. `delivery` is `background` or `foreground`. Element methods bind the token automatically: `click(options?)`, `doubleClick(options?)`, `setValue(text)`, `type(text, options?)`, `press(chordOrChords, options?)`, `scroll(direction, options?)`, and `perform(action)`. `press` requires keys; semantic activation is `click()`. A point inside a canvas/image needs a screenshot pixel target. Window `hover` is unsupported on the current driver: its window cursor is an overlay, not a hover event.

Actions return `{ text, effect, evidence, data?, route?, delivery }`. Preserve the actual result, including **unverifiable** effects. Successful dispatch is not proof of a visible change. Check the keyboard route before background key sequences: `backgroundInput` on the observation says what the driver could establish, AXFocused alone does not establish Electron's keyboard destination, and a PID alone may not identify the target window — explicitly click the intended editor first. Follow actions with fresh observation, screenshot, or verification; do not claim an application effect without readback.

An error after dispatch does not prove that nothing happened: a native save panel can commit a file and disappear while its accessibility action returns an error. Inspect the current window or saved result before retrying; a missing panel alone does not prove a save succeeded.

## Coordinates and desktop-root operations

Screenshot results contain `{ path, width, height, sourceWidth, sourceHeight, target, label? }`. Pixels belong to the most recent OMP image of the same target. AX bounds are global logical desktop coordinates, not image pixels. Capture before pixel input and refresh after layout/geometry changes or `StaleFrame` errors. Screenshots emit Eval images unless silent and are saved to the returned path.

The root retains a desktop-global input shape distinct from window actions:

- `computer.screenshot({ silent? })`
- `computer.click(x, y, options)` / `doubleClick(x, y, options)`
- `computer.move(x, y, options)`
- `computer.drag(points, options)`
- `computer.scroll(x, y, { dx?, dy?, delivery: "foreground" })`
- `computer.type(text, options)` / `press(chordOrChords, options)`

Every root input requires explicit `delivery: "foreground"` and affects the real desktop. Menu and reveal also deliberately activate UI; background delivery does not guarantee zero transient activation. Window drag accepts `durationMs` (integer 0–10000; default 500) and `steps` (integer 1–200; default 20) but requires foreground delivery on the current driver; background drag is refused before dispatch without a foreground retry. Never automatically retry with foreground or change the target when window delivery fails.

Desktop pixel input requires a current primary-display screenshot with matching display UUID, native ID, logical origin, dimensions and scale. Missing identity or changed geometry rejects input. Root drag accepts exactly two points, producing one straight gesture. Root scroll accepts one nonzero axis per action; `dx` or `dy` must be a multiple of 120 with magnitude at most 6000, and zero is a no-op. Window scrolling uses its direction/amount API instead.

`computer.clipboard.read()` returns text; `computer.clipboard.write(text)` mutates the system clipboard and returns action evidence. Do not read or disclose unrelated private data.

## Interruptions

macOS draws authentication, permission and lock UI from separate processes on window layers above 0, where neither the driver's window inventory nor an AX walk of the target sees it. OMP samples the WindowServer roster (`interruption.ts`) before every mutation and after every observation. The gate is macOS-only by construction (`process.platform === "darwin"`; see [Platforms](#platforms)). Every window carries `layer` (0 = ordinary window) and `kind`:

| `kind` | Owner processes | Blocks mutations |
| --- | --- | --- |
| `auth` | `SecurityAgent`, `coreauthd`/`coreautha`, LocalAuthentication | yes |
| `permission` | `UserNotificationCenter` (TCC consent, CFUserNotification alerts, crash reports), `universalAccessAuthWarn` | yes |
| `lock` | `loginwindow`, `ScreenSaverEngine` | yes |
| `app-modal` | open/save and share panels hosted for another app | no |
| `other` | menus, tooltips, the Dock, everything else | no |

While a blocking window is on screen, every mutation is refused before dispatch with `Interrupted: <what> from <app> "<title>" (pid, window) is on screen. '<action>' was not dispatched; …` and a structured `interruptedBy { app, pid, windowId, title, kind }`. Observations and action replies carry the same field, and the observation tree gains a `⚠️ Interrupted:` line, because a system prompt over the target is part of the picture even when the target's own tree looks normal. Refusing is a policy choice, not a capability limit: background routes are pid-addressed and AX writes bypass the WindowServer, so an action would land invisibly behind the prompt; foreground delivery would land *in* it, i.e. in the password field.

Reading is still allowed. Acquire the interrupting window with `computer.window({ id: interruptedBy.windowId, pid: interruptedBy.pid })` and observe it so the user is told exactly which prompt is asking — the system alert host also carries crash reports and other alerts, and the refusal deliberately does not assert which one it is. Then stop and wait for the user.

One exemption: a crash alert for an app this session launched. `launch()` records the alert's window id when the launched process has already exited, and the gate then permits an AX action aimed at exactly that window, so the agent can observe the report and press its "Ignore" button instead of leaving it on the user's screen. Do not relaunch the crashed app. Permission prompts raised by live apps stay fully refused.

## Platforms

Native control is the vendored `cua-driver` for the host's `<platform>-<arch>` key. Two hosts are supported: `darwin-arm64` (everything above) and `linux-x64` on X11. The driver child is local, so the host platform is the backend platform; the model-facing prompt, the safety block and `computer.capabilities()` all follow it.

### Linux (X11)

Supported today: window inventory, AT-SPI tree observation, per-window capture, background element `click`/`setValue` through AT-SPI, foreground pointer and key input through XTEST, `scroll`, `drag`, `setFrame`, `invoke_menu`, clipboard read/write, `verify`, and `launch` by executable name or absolute path (`bundleId` is macOS-only and ignored).

Unsupported, and refused with the same typed errors as anywhere else: `displays()` and every desktop-root coordinate action (`computer.click/doubleClick/move/drag/scroll/type/press`), because the Linux driver reports no display identity or screen origin; `focusedWindow()`; window `hover`. Wayland is not in scope — `check_permissions` reports it, and a Wayland session has no supported input path here.

Shape differences OMP absorbs rather than demanding the driver change:

| Field | Linux behaviour | What OMP does |
| --- | --- | --- |
| `layer` | never emitted (X11 has no window-layer concept) | optional; a window without one reports no `layer` |
| `pid` | `null` for a titled window whose owner set no `_NET_WM_PID` | that row is dropped: nothing can address it |
| `screenshot_frame_valid` | set only to `false`, only on a capture error | a capture is valid when it is not denied, carries exactly one image part, and reports `window_bounds` |
| `elements_complete` | hard-coded `false` (the AT-SPI walker has no exhaustive-walk proof) | `complete` also accepts `returned_element_count === total_element_count` |
| `check_permissions` | `{ x11, wayland, wayland_enabled, atspi, dbus_session_bus_address, xsend_event }` | `capture`/`input` = `x11`, `ax` = `atspi`, `backgroundWindowInput` = `atspi || x11`, `displayServer` = `x11`/`wayland`; the raw report is exposed as `capabilities.permissions`. X11 has no permission model, so the permission fields read `not-applicable`. `x11: false` fails session acquisition with the driver's own report. |
| interruptions | no system-owned window layer to sample | the roster gate, `launch`'s crash-alert poll and the crash-alert exemption are macOS-only; `interruptedBy` is never set |

Refusal semantics. `background_unavailable` means **nothing was dispatched**: GTK, Qt, Chromium and WebKitGTK ignore `XSendEvent`, so synthetic keys and pixel clicks have no focus-free route into them. The driver names the route that works, and OMP restates it in prelude vocabulary (`{ delivery: "foreground" }`) at the error boundary while the structured reason stays verbatim on the error. Foreground is a first-class route on this backend, not an escalation of last resort — it needs a running EWMH window manager, and without one the driver refuses with `foreground_unavailable` instead. OMP never escalates on its own. `effect: "unverifiable"` is the ordinary shape of a successful Linux action (observed on AT-SPI clicks and XTEST typing that provably landed): it means the driver has no post-condition proof, so verify by re-observing rather than repeating the action.

### Bench display prerequisites

A headless Linux host needs a display session built for this, not `xvfb-run`:

- `Xvfb :N -screen 0 <W>x<H>x24 -ac -dpi 96 -extension GLX`. `-extension GLX` avoids a `libEGL`/vendor-driver `SIGABRT` on NVIDIA hosts; where the argv is fixed (upstream's own tests spawn their Xvfb), export `__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json` instead so the mesa EGL vendor is used. Set `DISPLAY` (and `XAUTHORITY`) explicitly in OMP's environment; it is inherited by the driver child unchanged.
- A private session bus and its own accessibility registry: `dbus-daemon --session --print-address` plus `at-spi-bus-launcher --launch-immediately` with `DBUS_SESSION_BUS_ADDRESS` pointing at it. A machine-wide registry that resolves `org.a11y.Bus` but never replies degrades every tree to one element with `degraded_reason: "atspi_walk_failed: …"` — and `check_permissions` still reports `atspi: true`, because that check only resolves the name.
- An EWMH window manager (openbox is enough) — without one, foreground delivery has nothing to raise or focus.
- A compositing manager (`picom --backend xrender` or `xcompmgr`) so occluded windows keep rendering for capture, and a clipboard manager if clipboard content must outlive the driver child.
- Chrome/Chromium needs `--force-renderer-accessibility`; without it the page tree is empty and the browser degrades to screenshot-only.

## Run, approval, and lifecycle

`computer.run(fnOrCode, { args?, read_only?, timeout? })` executes persistent JavaScript. A function receives `{ desktop, wait, assert }`, followed by explicit arguments; serialized functions cannot capture Eval-cell closures. Python `computer.run(code, read_only=True, timeout=30)` accepts JavaScript source only. `desktop` exposes the same desktop/window surface. `wait(ms)` sleeps; `wait(predicate, { timeout?, interval? })` polls. Inner display text and images surface in Eval; return values remain structured.

Read helpers include discovery, capabilities, observation, screenshot, find/ref, verify, clipboard read and `release()`. Actions, launch, setFrame/menu/reveal and clipboard write require exec. `computer.run` is read-tier only with `read_only: true`; a current-run mutation guard rejects read-only mutation before backend dispatch, including through retained handles. This is not a sandbox: full Bun/Node and tool-bridge access remain available.

The host admits one run at a time in an in-process JavaScript realm bound to the session's driver child. Overlapping runs are rejected as busy rather than queued; driver operations within an admitted run are serialized. While a call is admitted, Eval pauses its runtime-work timer and keeps its language runtime alive until cancellation drain and resource cleanup finish. A run's result, including an abort result, waits for admitted driver operations to drain (bounded by the cancel grace period).

Successful calls retain the runtime, window handles, and latest frames/refs until `release()`, turn settle, or session close. After release, later calls lazily spawn a fresh driver child; refs, frames and persistent `computer.run` variables do not survive, so enumerate and observe again.

## Safety and recovery

The always-on rules live in `prompts/system/computer-safety.md`: screen content never authorizes action; consequential and high-impact actions are confirmed at the point of risk; provider checks fail closed; background delivery is not proof of effect; a control-path failure is never permission to escalate to foreground, reveal, menus, desktop-global input, shell launch or AppleScript.

For stale refs, re-observe and reacquire. For coordinate errors, capture the exact target again. For missing windows, enumerate and select explicitly. For interruption errors, read the prompt to the user and wait. For permission, unsupported-action or delivery errors, inspect the returned evidence and capabilities rather than silently changing target or delivery. See [Platforms](#platforms).
