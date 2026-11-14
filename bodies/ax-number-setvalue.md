## What

I made `setValue` work on macOS sliders and other number controls: it writes the number the control holds instead of text, reads it back, and says where it landed when the app clamps it.

On an AppKit slider, `setValue("75")` went from 0 of 30 to 30 of 30 landing (front, covered and unfocused windows, a person typing in another app throughout, 0 of their keys lost).

| macOS, 10 calls per window state, 3 states | `main` | this PR |
|---|---|---|
| AppKit slider `"75"` / `"42.5"` | 0 of 30 each, `AXError(-25201)` | 30 of 30 each |
| AppKit slider `"150"` (range 0-100) | 0 of 30, `AXError(-25201)` | at 100, 30 of 30 `AxFailed: wrote 150; the control now reads 100 (its maximum is 100)…` |
| AppKit slider `"seventy"` | `AXError(-25201)` | refused before any write, naming what it reads, 30 of 30 |
| Editable level indicator `"6"` | 0 of 30, `AXError(-25201)` | 30 of 30 |
| `setValue(75)`, a JavaScript number | refused, `requires a string` | 30 of 30 |
| SwiftUI `Slider`, stepper (value not settable) | `AXValue is not settable…` | same refusal, naming `el.perform("AXIncrement")` and the value it reads; nothing sent |

**Unchanged** (same result on both, 30 of 30 each): checkbox refusal, a text field given `"12345"` (still a text write), a date picker, and range inputs on WKWebView, Chrome and Electron pages (still refused as web content or Chromium). **Cost:** a landed write takes 25 ms more than `main`'s failed one (539 against 514 ms median); a clamped write waits 500 ms for the value to settle before reporting.

- **Number controls**: when a settable value is a number, the text is parsed and written as a number, then read back, with the same result form as the Linux path since #19047. Text that is not a number is refused before anything is sent.
- **`setValue(75)`** is written as `"75"` on every platform; `NaN`, `Infinity`, booleans and objects are still refused.
- **Not settable, but steps**: the refusal names the step actions the element lists, spelled as `perform` takes them. A text value is never quoted there.

## Why

A slider's value is a number, and AppKit rejects text written to it as an illegal argument, so the slider stayed put every time; dates already get the same treatment (#13660). Models pass a number about half the time: with the tool's documentation and "set slider e7 to 75", Haiku 5.5 (low) wrote `setValue(75)` in 16 of 20 runs and GPT-6.1 Sol (low) in 6 of 20. Given the new refusal as their previous result, 10 of 10 of each next wrote a runnable `perform("AXIncrement")`.

Limits: a control without a settable value or step actions keeps today's refusal, and a SwiftUI slider steps by its own step (10 on 0-100), so a value off that grid is not reachable by steps. `setValue` does not step for you: it would move the control before knowing it misses.

## Testing

macOS 26.5 VM, `main` and this branch interleaved per try, app state as truth. Following the refusal's own `el.perform("AXIncrement")` moved the SwiftUI slider 0 to 10 in 10 of 10. `cargo test -p pi-natives --lib -- desktop::macos`: 360 pass (372 merged with #19195); `computer.test.ts`: 152 pass; clippy and rustfmt via `rust-check` on macOS and Linux. The new unit tests do not compile on `main`, and the worker test's number cases fail there.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
