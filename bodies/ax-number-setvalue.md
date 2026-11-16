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
| Checkbox, text field `"12345"` (still a text write), date picker, range inputs on WKWebView, Chrome and Electron pages (still refused as web content or Chromium) | 30 of 30 each | unchanged, 30 of 30 each |
| Median call time | 514 ms (the failed write) | 539 ms landed; a clamped write waits 500 ms to settle |

- **Number controls**: when a settable value is a number, the text is written as a number and read back, with the same result form as the Linux path since #19047. It must be plain decimal of at most 32 characters (sign, digits, optional fraction), so nothing it names can overflow an `f32`; anything else, exponents included, is refused before anything is sent and never quoted. Whole text, including a fraction of zeros, goes to an integer control as an exact `i64`.
- **`setValue(75)`** is written as `"75"` on every platform. `NaN`, `Infinity`, booleans and objects are still refused, as are a whole number past 2^53 (which a Python int that large has already become) and one that prints with an exponent, with a hint to pass it as text in digits.
- **Not settable, but steps**: the refusal names the step actions the element lists, spelled as `perform` takes them. A text value is never quoted there.

## Why

A slider's value is a number, and AppKit rejects text written to it as an illegal argument, so the slider stayed put every time; dates already get the same treatment (#13660). Models also pass the number itself about half the time, which `main` refused (sample under Testing).

Limits: a control without a settable value or step actions keeps today's refusal, and a SwiftUI slider steps by its own step (10 on 0-100), so a value off that grid is not reachable by steps. `setValue` does not step for you: it would move the control before knowing it misses.

A number control inside a terminal or Chromium app, such as an iTerm settings slider, is still refused as text, as on `main`. Letting it through moved iTerm's slider but not iTerm's setting, 10 of 10. A value the app corrects on its next main-queue turn is caught, but a later one, as from a debounced model, is not.

## Testing

macOS 26.5 VM, `main` and this branch interleaved per try, app state as truth. Following the refusal's own `el.perform("AXIncrement")` moved the SwiftUI slider 0 to 10 in 10 of 10. `cargo test -p pi-natives --lib -- desktop::macos`: 366 pass; Linux `desktop::`: 308 pass; `computer.test.ts`: 152 pass; clippy and rustfmt via `rust-check` on macOS and Linux. The new unit tests do not compile on `main`, and the worker test's number cases fail there.

| This head, unfocused, a person typing (0 keys lost), 10 tries each | result |
|---|---|
| integer slider, `"9007199254740993.0"` and `"9007199254740993"` | landed exactly, 10 of 10 each |
| slider whose setter answers after 600 ms, `"50"` | landed, 10 of 10 |
| `"1e3"` | refused before any write, 10 of 10 |
| `"73"` on a slider that snaps to multiples of 5 | reported `the control now reads 75`, 10 of 10 |
| median call time | 551 ms landed, 1032 ms clamped, within 14 ms of the earlier run |

<details><summary>Model sample</summary>

Model sample, the tool's documentation plus "set slider e7 to 75", 20 runs each: Haiku 5.5 (low) wrote `setValue(75)` in 16 and GPT-6.1 Sol (low) in 6, each refused on `main`; given the new step refusal as the previous result, 10 of 10 of each wrote a runnable `perform("AXIncrement")`.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)


