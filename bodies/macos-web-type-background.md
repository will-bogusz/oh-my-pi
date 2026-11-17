## What

Typing into a field on a Safari or WKWebView page whose window sat behind my own app fell back to a takeover that failed, or typed only by bringing Safari forward. OMP now types it in the background on the field's own focus claim and reads the field back: with the page under a person's window, `el.type` reached the field 130 of 130 times (all but one in the background) against 15 of 130 on `main`, none of their keys moved or lost.

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

`el.type` sends keys only once the application names the element as focused. A WebKit view in an app that is not active names none, even after `AXFocused` moved the page's focus to the field. Keys sent to the window do reach the field: a click then `win.type` already worked.

- **When the field's own claim counts.** Only when the app's last answer in the 250 ms focus wait is that it names no element (an earlier answer is superseded: the focus request moves focus during the wait), and only for web content reporting `AXFocused` itself. An app whose last answer names another element (Chrome its web area) or does not come still refuses.
- **Read-back is the proof.** The text is read back with AX insertion's verdict (`text_readback`), each read given what is left of 1 s. A field that does not show it by then or cannot be read, text holding Return or Tab, or a cancel first gives "type sent the text but could not confirm it arrived: …" (`control::report_text_unconfirmed`, as on Windows). A secure field's value is never quoted.
- **Chords unchanged:** `el.press` has no read-back, so it still needs the app to name the element.

It needs the rule counting keys moved back to the person's app as theirs: without it, 4 of 10 Safari calls with a person typing stopped with `UserIntervened` (0 of 10 with it).

| With the input lease held | Bounded by |
|---|---|
| Self-focus proof and its walk up to the web area (walked only when `AXFocused` is true) | the 250 ms focus wait: each request gets the time left, cancellation checked between requests; the app's own focus read keeps its timeout, and an AX call in flight is not cut short |
| Read-back after the last key | what is left of 1 s per request; a cancel ends it, reported unconfirmed |
| Two reads of the field before the first key | the element's 2 s timeout each |
| The keys | the text's length |

So the route as a whole has no fixed bound. Limits: the claim is taken at the call's start, so text a page moves on as you type (split code inputs) is reported unconfirmed; after typing into a page's password field, WebKit keeps macOS secure input on while that field holds the page's focus, so OMP's Escape stop and typing detection see no keys until focus leaves it.

Review first: `macos/ax.rs` (`holds_keyboard_focus`, `focus_proof`, `TypedReadback`), then `macos/input.rs` (`keys_after_focus`, `window_type`).

## Testing

On a macOS 26.5 VM, the kit's WKWebView app and the same page in Safari, `main` (`fe194ec2f12`) against this change at `521fdb3ad7b`; a simulated person types into their own front window through the VM's VNC keyboard.

| Unchanged, 10 calls per cell | `main` | this PR |
|---|---|---|
| Person typing: background `el.type`, click then `win.type`, `setValue` on AppKit, SwiftUI, Chrome | same outcomes | same, medians within 45 ms |
| Person typing: `el.type` on Electron | 10 of 10, 831 ms | 10 of 10, 833 ms (a first run: 2.2 s, one `InputFailed` as focus left the window; not seen again) |
| App merely not front: `type`, click then `type`, `cmd+k` on AppKit, Chrome, Safari, WKWebView | 10 of 10 each; Safari's `type` 5 times through a takeover | 10 of 10 each, all in the background |

The deadlines in the table above came after those runs; a field that answers in time gets the same reads and waits (from the code, not re-measured). Seven mutations of the rule each fail a new test in `ax::tests` or `input::tests`, which also pin the read-back's cut-off and cancel and that the walk waits for `AXFocused`. On top of the key-reroute fix, `cargo test -p pi-natives --lib -- desktop::macos desktop::control desktop::tests` passes on macOS (493).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
