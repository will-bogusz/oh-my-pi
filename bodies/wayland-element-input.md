## What

On GNOME, `el.type` into a gedit field behind Firefox failed as it should, but it still raised a "gedit is ready" notification, so I made Wayland refuse element typing before it touches the app.

On Wayland `el.type` and `el.press(keys)` can never succeed: they end in `BackgroundUnavailable`. Before failing, they focused the element inside its app. With this PR they fail the same way before anything reaches the app.

| GNOME 50, Firefox focused, `el.type("zz")` on gedit's text area | `main` | this PR |
|---|---|---|
| Result | `BackgroundUnavailable` | `BackgroundUnavailable` |
| gedit text changed | no | no |
| `“*notes.txt (~) - gedit” is ready` notification | yes | no |

- `wayland/mod.rs`: `WaylandBackend` overrides `element_input` and refuses at once. The message says nothing was sent and points to `setValue`, or a desktop click where a screenshot shows the field, then desktop typing.
- `el.press()` without keys goes through `axPerform` and is unchanged.

## Why

The default `Backend::element_input` resolves the element's window, calls `ax.focus(element)`, then types through `Target::Window`. On Wayland `run_input` refuses every window target (`window_input_error`, "wayland-compositor-focus-only"), so the focus step was the only part that ever ran: a refused call with a side effect. It ran even under `computer.backgroundFallback: "refuse"`, which refuses `el.focus()` off macOS for exactly this reason.

Non-goals: making element typing work on Wayland. AT-SPI `setValue` already covers editable text.

## Testing

- Live in a Fedora 44 KVM guest (GNOME Shell 50.6) through the real path (`AgentSession` → eval → `computer` prelude → pi-natives built with `wayland-pipewire`). The cell calls `computer.window({app: "gedit"}).find({role: "textarea"})`, then `type("zz")`, then reads `focusedWindow()` and the field's value. A host framebuffer shot after each run gave the table.
- Unit test `element_input_is_refused_before_anything_reaches_the_app` runs text and chord input on a backend with no AT-SPI connection and expects `BackgroundUnavailable` with "nothing was sent". With the override removed it fails: the default's first AT-SPI step returns `AxUnsupported`.
- `cargo test -p pi-natives --lib -- desktop::`: 208/208 on Linux. `scripts/rust-check` linux: clean.
- Not run: the full `bun check`, KDE.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
