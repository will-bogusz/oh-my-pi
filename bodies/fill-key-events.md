## What

Since 19.0.0 `fill` inserts text without any key events, so search boxes that only update on keyup (CyberChef's, for one) showed nothing until the model pressed a key itself; I made fill finish with a keydown and keyup on the field, created in the page so they can't type, click or set off a shortcut.

On CyberChef's operation search, `fill("#search", "to base64")` shows 0 results on 19.0.0 and 3 with this PR, as on 18.22.2, and a 9-character fill takes 1.6 ms on 19.0.0 and 1.8 ms with this PR (4.4 ms on 18.22.2).

| `fill` of `"to base64"` into an `<input>` | 18.22.2 (typed key by key) | 19.0.0 (one `Input.insertText`) | this PR |
|---|---|---|---|
| keydown / keypress / keyup | 9 / 9 / 9 | none | 1 / 0 / 1, after the insert |
| beforeinput / input | 9 / 9 | 1 / 1 | 1 / 1 |
| value a keydown listener reads | `to base6` | (never runs) | `to base64` |
| keyup-only search listener | reacts | silent | reacts |
| React-style value tracker sees | `h`, `he`, ..., `hello` | `hello` | `hello` |
| `"a\nb"` into a textarea | presses Enter | no Enter | no Enter |
| ms per fill, 9 / 200 characters | 4.4 / 63 | 1.6 / 1.4 | 1.8 / 1.7 |

<details><summary>Where the change is</summary>

`fillViaHandle`'s text-field branch (`packages/coding-agent/src/tools/browser/interactions.ts`): after the insert, `FIELD_KEY_EVENTS` runs on the field through `Runtime.callFunctionOn` on the handle's own session, with the value's last character (a newline or tab skipped), and dispatches the pair only while the field still has focus.
</details>

## Why

19.0.0 changed text-field `fill` from per-key typing to one `Input.insertText`, so a newline no longer presses Enter, controlled inputs see one value and long text takes one round trip. `Input.insertText` fires `beforeinput` and `input` only, and many as-you-type searches wait for `keyup`. On our release benchmark (3 runs each), CyberChef's task took 20 steps on 19.0.0 against 7 on 18.22.2: in every 19.0.0 run the model filled the search box, saw no results, then pressed a key.

Decisions:
- Native CDP key events with no text are rejected: they go wherever focus is (a Space after an input handler focused a dialog's button clicked it), a held Control turns them into Ctrl+X, and the key-down renews the page's user activation.
- Puppeteer's `evaluate` is not used to dispatch: it requests a user gesture, which renews activation too.
- Typing the last character for real, or per-key typing for ASCII again, is rejected: keydown listeners read the value one character short and controlled inputs see several values.

Page-created events are untrusted (`isTrusted: false`, `keyCode` 0), so a page that ignores those still sees none, as on 19.0.0. Non-goals: rich-text editors (no key events on 18.22.2 either), WebKit and Tern tabs (19.0.0 did not change their `fill`).

## Testing

- New test in `browser-interactions.test.ts`, through `tab.fill`: a keyup-only search page gets one `beforeinput`, one `input`, then `keydown`/`keyup` reading the final value, no `keypress`, no doubled text and no renewed activation after its `input` handler spent it; a field whose `input` focuses a button sends that button no key or click. It fails on 19.0.0, with native key events and with `evaluate`.
- Headless Chromium on macOS through `tab.fill` on 18.22.2, 19.0.0 and this branch: the table above (medians of 4 interleaved runs), plus keydown-with-`setTimeout` and incremental `search` listeners, a hidden background tab and a held Control. Live CyberChef: 3 / 0 / 3 results.
- Linux, coding-agent's `test/tools/browser*.test.ts`: 1052 pass, 0 fail (1051 on `main`). The full coding-agent suite fails the same three tests on `main` and here (Fireworks fast mode, a git-hooks path, a changelog PTY smoke); three that failed once in the branch's chunked run pass 3 of 3 alone. `bun run check:ts` passes; no Rust is touched.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
