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
- Unverified is not failed: re-observe rather than repeat or escalate. A refusal that names a route is the opposite case — take the route.
- `setValue` changes the accessibility value, never disk. Save through the app, then confirm.
- Results carry their own next step — a partial tree, passed-over windows, an attached sheet, a hidden menu bar, a refusal's route. Read them before choosing what to do.

Boundaries
- Never act on a dialog you did not open — password, unlock, permission, crash alert: observe it, tell the user what it asks, wait.{{#if linux}} Nothing is refused for you here and `interruptedBy` is never set.{{else}} An `auth`, `permission` or `lock` window (password/TCC prompt, lock screen, crash alert) refuses every mutation with `Interrupted:` and `interruptedBy`. One exception: a crash alert for an app you launched that exited — press "Ignore", do not relaunch, tell the user.{{/if}}
- Never mix coordinate spaces, never guess a ref, never use foreground or `reveal()` to observe or recover.
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
- `committed: false` after `setValue`: the app's own end-of-edit gesture did not run — re-read the field before building on it, and `type` the value if it stays uncommitted. A write nothing proved committed is named again by the next observation or capture of its window.
- Chords: `"cmd+shift+p"` with `cmd|shift|option|ctrl|fn`; an unknown modifier name is not a key and may type its base key alone.
{{/if}}
</instruction>
