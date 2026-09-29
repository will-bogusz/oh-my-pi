Control real host application windows from JavaScript or Python Eval with `computer` (no DOM — that is `browser`). Safety rules: system prompt.

<instruction>
Entry: `await computer.window(selector)` acquires ONE window and prints its tree and a screenshot of it, which is also the frame pixel actions use; capture it again only after acting or waiting, or when a pixel action answers `StaleFrame`. `selector` is an id or `{ app?, title?, id?, pid? }`; `app` is a display name or a bundle id (`com.vendor.App`), and an app that is not running is launched. `computer.windows(filter)` lists windows without acquiring; `computer.help()` prints the typed API. The handle's verbs print with your first acquisition.

Observation
- Rows read `n5 button "Add" = "value" (description) [disabled, selected] actions=open`, indented by depth; `text "…"` rows are text the window shows with no action on it. Any row takes `click()`; `actions=` names only what a row offers beyond press, show_menu, confirm, cancel and pick, which `el.perform(name)` reaches too.
- Refs belong to the observation that printed them: your next `observe()` of that window retires them all and prints fresh ones. Never guess a ref.
- `observe()` prints the whole window; `observe({ query })` keeps the rows matching a case-insensitive substring (an array matches any of several) with their ancestors; `{ screenshot: true }` adds a frame; `{ menubar: true }` adds the menu bar.
- The header names the window, and says `keys: foreground only` when background keystrokes cannot reach it. Sheets, and windows the app opens while you work, print under their opener and take its refs. An app with traps its tree cannot show prints an app note with its first window; follow it.

Acting
- Batch what one observation justifies in one cell, then read back in the same cell: `await win.ref("n5").click(); await win.ref("n7").setValue("x"); await win.observe();`
- `click` presses a control and selects a list row (a row's default action is `perform("press")`); `setValue` replaces a field's value; `type(text, { caret: { after: "…" } })` or `{ caret: "end" }` adds to what a field holds; `press("cmd+s")` sends a chord; `win.menu(["File", "Save…"], { delivery: "foreground" })` drives the menu bar.
- Coordinates are window points of that window's latest screenshot; pixel targets, modified or counted clicks and drag ends need a current frame.
- Delivery is background by default. Pass `{ delivery: "foreground" }` where the header or a reply names it, and for pixels, menus and drags; it briefly makes the window key.
- `scroll(direction, { target, amount, by })`: `by: "line"` (default) or `"page"` counts notches (1–50), `by: "points"` takes an `amount` in window points (1–5000); no target means the window centre. Its reply leads with what the view did: `✓ Scrolled down 231 pt at (163, 400)`; `✓ At end` — stop repeating; `? Moved the other way` — observe first; `✗ No motion` — take the route it names (`{ delivery: "foreground" }` moves the real pointer there for views that scroll only under it); `? Changed in place` — observe first; `Stopped early: … the user has it` — the user took over: do not retry. After a move, capture again before any coordinate action.

Evidence
- A cell's reply leads with one mark per call — `✓` proven or read, `?` delivered but unproven, `✗` nothing landed — and each outcome has its own answer:
  - `✗` refused or not dispatched: nothing happened; take the route it names, or another allowed one.
  - `?` dispatched, effect unproven: observe before anything else and never send it again — a second send lands too. Act again only if what you read shows it took no effect.
  - `✓` a read-back proves only what it read: a field showing your text is not the app acting on it.
- `setValue` never reaches disk: save through the app, then check the file itself with `read`.

Boundaries
- Never act on a dialog you did not open — password, unlock, permission, crash alert: observe it, tell the user what it asks, wait.{{#if linux}} Nothing is refused for you here and `interruptedBy` is never set.{{else}} An `auth`, `permission` or `lock` window (password/TCC prompt, lock screen, crash alert) refuses every mutation with `Interrupted:`. One exception: a crash alert for an app you launched that exited — press "Ignore", do not relaunch, tell the user.{{/if}}
- Never mix coordinate spaces.
- In Chrome, `computer` is for Chrome and extension UI only; never type web-page field text through it.

{{#if linux}}
Linux
- The tree is the app's AT-SPI tree: GTK and Qt publish it, Chromium and Electron need `--force-renderer-accessibility`, an app publishing none yields one frame element — work from the screenshot.
- Background is the AT-SPI route and reaches GTK, Qt and Chromium without touching focus; synthetic keys and pixels need foreground, which raises the target and wants a running window manager (`foreground_unavailable` otherwise). A `background_unavailable` refusal sent nothing — retry with `{ delivery: "foreground" }`.
- `?` is the ordinary shape of success here, never a reason to repeat. `computer.displays()` and desktop-root input are unsupported. The driver child owns the selection it wrote: paste before releasing.
- Chords: `"ctrl+shift+p"` with `shift|ctrl|alt|super|meta`; an unknown modifier name is not a key and may type its base key alone.
{{else}}
macOS
- A control that acts on a real pointer event ignores a background press and reports `suspected_noop`: observe first; if nothing changed, screenshot and click its pixel centre with `{ delivery: "foreground" }`. On such a surface click the editor before typing: it takes keys only once a pointer has put the caret in it.
- Chords: `"cmd+shift+p"` with `cmd|shift|option|ctrl|fn`; an unknown modifier name is not a key and may type its base key alone.
{{/if}}
</instruction>
