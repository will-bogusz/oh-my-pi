Control real host application windows from JavaScript or Python Eval with `computer` (no DOM — that is `browser`). Safety rules: system prompt.

<instruction>
Entry points: `await computer.window(selector)` acquires ONE window — `selector` is an id or `{ app?, title?, id?, pid? }` — and prints its tree; `computer.windows(filter)` lists without acquiring; `computer.run(fnOrCode)` runs a multi-step function with `{ desktop, wait, assert }` (no closures; full host access, not a sandbox). Everything else lives on the handle you get back and is listed with it; `computer.help()` prints the full typed API when a signature matters. Python: same names, keyword options.

Model
- A window is acquired, never focused. An `{ app }` that is not running is launched and acquired in the same call; several matches yield its front document window and name the rest.
- An observation is the accessibility tree at one instant. Its refs (`n7`) belong to that observation and that window; the next `observe` or `find` retires them. `StaleRef` means re-observe, never guess.
- A screenshot is one window's frame. Pixels mean something only in the latest frame of that same window; AX `bounds` are desktop-global. Coordinates, modified or counted clicks and drag ends are pixel actions and need a current frame — `observe()` is tree-only unless you ask for one.
- Delivery is background by default: accessibility routes that touch nothing on screen. Foreground briefly makes the window key and exists for what only real input can do — drag, menus, pixel targets, keys at a window that is not key. The runtime never escalates for you.

Evidence
- A result states what it can prove: `confirmed` (state read back), `unverifiable` (delivered, unproven), `suspected_noop` (positive reason to think nothing happened), or a typed refusal (nothing dispatched; it names its route). Dispatch is not proof — read the postcondition back, and inspect a failed reply, which may still have acted.
- The reply already carries its verdict and evidence: act on them. A read-back you still need goes in the same cell as the action — chain the verifying `observe()`/`find()` after it; a separate verification cell is a wasted step.
- Unverified is not failed. Re-observe freely — a read changes nothing on the screen — but never re-fire a mutation that reported delivery: the second one lands too. A refusal that names a route is the opposite case — take that route, composed from the state the reply carries, not a blind retry of the rung that refused.
- `setValue` changes the accessibility value, never disk. Save through the app, then confirm.
- Results carry their own next step — a partial tree, passed-over windows, a window an action opened, a nested sheet, a hidden menu bar, a refusal's route. Read them before choosing what to do.

{{#if achieve}}
Achieve (experimental)
- `win.achieve(goal, { maxSteps = 8, confidence = 0.6 })` runs one bounded, verifiable sub-goal on a window you already hold — fill a field, pick a row, reach a pane — through a chooser: each step the host observes, builds a candidate table from the tree, a typed judge picks one row (or re-reads, or abstains), the pick runs exactly as `win.ref(r).<action>()` would, and a postcondition judgment over the fresh tree decides. Quote every value it should write (`"Ada"`); unquoted text is never typed, and it never deletes, removes or discards anything — those are yours. It returns `{ done, steps, reason, abstained }` with each step's driver reply verbatim; `reason` is `done`, `abstain`, `max_steps`, `interrupted` or `refused`, and anything but `done` hands the window back to you — read the trace, then act.

{{/if}}
Boundaries
- Never act on a dialog you did not open — password, unlock, permission, crash alert: observe it, tell the user what it asks, wait.{{#if linux}} Nothing is refused for you here and `interruptedBy` is never set.{{else}} An `auth`, `permission` or `lock` window (password/TCC prompt, lock screen, crash alert) refuses every mutation with `Interrupted:` and `interruptedBy`. One exception: a crash alert for an app you launched that exited — press "Ignore", do not relaunch, tell the user.{{/if}}
- Never mix coordinate spaces, never guess a ref, never reach for foreground or `reveal()` to observe, and never re-run a refused rung unchanged. When a reply names the app's own window drawn in front of yours, that window is the route: acquire it with `computer.window(id)` or dismiss it.
- `computer.release()` (automatic at turn settle) ends the driver child: later calls reacquire; a cancelled call reports what landed as `partial`. `computer.close()` ends computer use for the session.

{{#if linux}}
Linux
- The tree is the app's AT-SPI tree: GTK and Qt publish it, Chromium and Electron need `--force-renderer-accessibility`, an app publishing none yields one frame element — work from the screenshot.
- Background is the AT-SPI route and reaches GTK, Qt and Chromium without touching focus; synthetic keys and pixels need foreground, which raises the target and wants a running window manager (`foreground_unavailable` otherwise). Foreground is first-class here, not a last resort: a `background_unavailable` refusal means nothing was dispatched — retry with `{ delivery: "foreground" }`.
- `effect: "unverifiable"` is the ordinary shape of success, never a reason to repeat. `computer.displays()` and desktop-root input are unsupported. The driver child owns the selection it wrote: paste before releasing.
- Chords: `"ctrl+shift+p"` with `shift|ctrl|alt|super|meta`; an unknown modifier name is not a key and may type its base key alone.
{{else}}
macOS
- A `pointerdown`-driven control (common in Chromium and Electron) ignores a background press and reports `suspected_noop`: screenshot, then click its pixel centre with `delivery: "foreground"`. Check `backgroundInput` before sending keys; in Electron, click the editor first.
- A write that is not proven names what to do about it; a proven one says nothing. Do what the sentence says — it is composed from what the driver read back, and it is named again by the next observation or capture of that window.
- Chords: `"cmd+shift+p"` with `cmd|shift|option|ctrl|fn`; an unknown modifier name is not a key and may type its base key alone.
- A chord at a window that is not key, when it is the key equivalent of a menu item the app keeps disabled until then, is delivered as that menu command instead: the reply leads with `Delivered as menu command <path> (app fronted: yes/no)` — the window was made key for it and the prior frontmost restored. A change that did not survive that restore is named with the control to address instead; the foreground rung has nothing more to offer there.
{{/if}}
</instruction>
