## What

Typing into a field on a Safari or WKWebView page whose window sat behind my own app fell back to a takeover that failed, or typed only by bringing Safari to the front, so OMP now types it in the background on the field's own focus claim and reads the field back to confirm the text landed.

`el.type` into a text field of a Safari or WKWebView page covered by the person's own window reached the field 15 of 130 times on `main`, each through a takeover that brought Safari forward, and 130 of 130 with this PR, all but one in the background, with none of a typing person's keys moved or lost.

| `el.type` into a page field, window covered by the person's app | `main` | this PR |
|---|---|---|
| Person typing in their own window, WKWebView and Safari (10 calls each) | falls back to a takeover: 22 of their keys in the agent's field per surface (5 calls), 5 refused | 20 of 20 typed in the background, 1.07-1.09 s; 0 of their keys moved |
| Field already holding text (5 each) | `InputFailed` | 10 of 10 typed at its selection |
| Password field (5 each) | `InputFailed` | 10 of 10 typed, confirmed by the field's masked length, never quoted; Safari's first through a takeover, its field not yet reporting focus |
| Field that reformats as you type (5 each) | `InputFailed` 9, 1 typed through a takeover | 10 of 10 typed, reported as sent but not confirmed, with what the field reads |
| Text ending in Return (5 each) | `InputFailed` | 10 of 10 typed, reported as sent but not confirmed |
| Page focus on another field, in or out of an iframe, or a native field holding the window's focus, when the call starts (10 each, 7 cells) | 14 of 70 typed, all on Safari through a takeover; the rest `InputFailed` | 70 of 70 in the field the call named, 0 in the other field |
| Call time with nobody typing (medians) | 1.43-1.48 s to refuse | 0.87-0.94 s |

## Why

`el.type` sends keys only once the application names the element as focused. A WebKit view in an app that is not active names none at all, even after `AXFocused` moved the page's focus to the field, so the background route always refused and the takeover failed the same check (Safari typed only once brought forward). Keys sent to the window do reach the field: a click then `win.type` already worked.

- **When the field's own claim counts.** Only when the application names no element through the whole 250 ms focus wait, and only for web content reporting `AXFocused` itself. An app naming another element (Chrome its web area) or not answering still refuses.
- **Read-back is the proof.** The text is read back for up to 1 s with AX insertion's verdict (`text_readback`); when the field does not show it, cannot be read, or the text holds Return or Tab, the call succeeds with "type sent the text but could not confirm it arrived: …" (`control::report_text_unconfirmed`, as on Windows). A secure field's value is never quoted.
- **Chords unchanged:** `el.press` has no read-back, so it still needs the app to name the element.

It needs the rule counting keys moved back to the person's app as theirs: with the macOS takeover pause also in and without that rule, 4 of 10 Safari calls with a person typing stopped with `UserIntervened` (0 of 10 with it).

Limits: the claim is taken at the call's start, so text a page moves on as you type (split code inputs) is reported unconfirmed; after typing into a page's password field, WebKit keeps macOS secure input on while that field holds the page's focus, so OMP's Escape stop and typing detection see no keys until focus leaves it.

Review first: `macos/ax.rs` (`focus_proof`, `web_self_focused`, `TypedReadback`), then `macos/input.rs` (`keys_after_focus`, `window_type`).

## Testing

On a macOS 26.5 VM, the kit's WKWebView app and the same page in Safari, `main` (`fe194ec2f12`) against this change. A simulated person types into their own front window through the VM's VNC keyboard, scored from their window and the page's key log; field cells run with nobody typing, scored from the page's state.

| Unchanged, 10 calls per cell | `main` | this PR |
|---|---|---|
| Person typing: background `el.type`, click then `win.type`, `setValue` on AppKit, SwiftUI, Chrome | same outcomes | same, medians within 45 ms |
| Person typing: `el.type` on Electron | 10 of 10, 831 ms | 10 of 10, 833 ms (a first run: 2.2 s, one `InputFailed` as focus left the window; not seen again) |
| App merely not front: `type`, click then `type`, `cmd+k` on AppKit, Chrome, Safari, WKWebView | 10 of 10 each; Safari's `type` 5 times through a takeover | 10 of 10 each, all in the background |

Seven mutations of the rule each fail at least one new test in `desktop::macos::ax::tests` and `desktop::macos::input::tests`. Full `pi-natives` lib tests pass on macOS (1001) and the desktop tests on Linux (308).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
