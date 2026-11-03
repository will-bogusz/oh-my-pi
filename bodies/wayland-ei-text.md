## What

I wanted the computer tool to type things like `äöü`, `日本` or an emoji on KDE Wayland, where it currently refuses them, so this sends that text through libei's text interface when the compositor offers one and keeps the existing refusal everywhere else.

On KDE Plasma 6.8, `computer.type("Hello äöü ß € ñ 日本 😀")` used to throw `InputFailed: libei cannot type character 'ä' in active XKB group 0`; now the line lands in Kate exactly as typed.

> **libei context.** libei is how OMP injects input on Wayland: OMP presses evdev keys that the active keyboard layout turns into characters, so a character with no key cannot be typed. libei 1.6 added `ei_text`, a device that commits a UTF-8 string directly, like an input method. KWin 6.8 offers it; Mutter does not.

| Text passed to `type()` | `main` | This PR |
|---|---|---|
| Every character has a key in the active layout | keystrokes | keystrokes, unchanged |
| Some character has no key, compositor offers `ei_text` (KDE Plasma 6.8) | `InputFailed`, nothing typed | the whole string is committed as text |
| Some character has no key, no `ei_text` (GNOME, older KWin) | `InputFailed`, nothing typed | same `InputFailed`, which now says no text device was offered |
| Such text containing `\n` or `\t` | `InputFailed` | `InputFailed` before anything is sent, asking to press Enter or Tab between calls |

Reading order: `plan_typing`, `text_runs` and `Libei::type_text` in `wayland/libei.rs`, then the reis bump in `Cargo.toml`, `Cargo.lock` and `MODULE.bazel.lock`.

## Why

`ei_text` needs reis 0.7 (from 0.5.0, now `=0.7.1`), which changes two signatures used here (`Seat::bind_capabilities` takes bit flags, the disconnect explanation is optional) and negotiates `ei_device` version 3. Version 3 holds every device until the client sends `ei_device.ready`, and reis does not send it, so the `DeviceAdded` handler does. KWin and Mutter negotiate version 2 today, so nothing changes for them.

Decisions:
- A string that needs text goes out whole as text, never as keys mixed with text commits. Mixing them scrambled the output every time on KWin: four lines typed that way read `äöüßñ日本😀M1   €    x1`, because the keys pass through KWin's input method and arrive after the commits. One call is one route, and ordering between separate calls held in every try.
- Line breaks and tabs are refused inside committed text rather than sent: a committed newline never submits a form, a tab never moves focus, and Kate dropped a commit that began with a newline.

Maintenance cost: if Mutter adds `ei_text`, GNOME picks it up with no change here. A compositor that offers a text device but ignores it would swallow the text without an error; OMP cannot detect that over libei.

## Testing

Live on a Fedora 44 KDE Plasma 6.8.2 guest (libei 1.6.0), through the RemoteDesktop portal, typing into Kate and reading the result back from the clipboard:

| Call | `main` | This PR |
|---|---|---|
| `type("Hello äöü ß € ñ 日本 😀")` | `InputFailed … 'ä' in active XKB group 0` | `Hello äöü ß € ñ 日本 😀` |
| `press("enter")`, then `type("zwei ä")` | `InputFailed` | `zwei ä` on a new line |
| `type("x\ny ä")` | `InputFailed` | `InputFailed`, nothing typed |

Version 3 handshake: libei's own `eis-demo-server` turns version 3 on. Through `LIBEI_SOCKET`, `type("ab")` failed with `RemoteDesktop portal granted no libei keyboard or pointer devices` before the `ready` call and logged `text utf8 'ab'` with it.

Not run: GNOME. Mutter offers no text device, so it takes the refusal branch the unit test below covers.

`cargo test -p pi-natives --features wayland-pipewire --lib desktop::linux::wayland` (Linux): 33 passed; with the text route removed from `plan_typing`, `text_the_active_group_cannot_type_goes_out_whole_as_ei_text` and `ei_text_runs_stay_within_the_utf8_request_limit` fail. `bun scripts/gen-bazel-lock.ts --check` passes.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
