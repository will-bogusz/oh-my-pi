## What

Since 19.0.0 `fill` inserts text without any key events, so search boxes that only update on keyup (CyberChef's, for one) showed nothing until the model pressed a key itself; I made fill finish with a keydown and keyup on the field, created in the page so they bring no browser default action, no held modifier and no new user activation.

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

`fillViaHandle`'s text-field branch (`packages/coding-agent/src/tools/browser/interactions.ts`): after the insert, `FIELD_KEY_EVENTS` runs on the field through `Runtime.callFunctionOn` on the handle's own session, with the value's last non-control code point. It acts only on a `<textarea>` or a text-entry `<input>`, and checks before each of the two events that the field still has focus, never retargeting.
</details>

## Why

19.0.0 changed text-field `fill` from per-key typing to one `Input.insertText`, so a newline no longer presses Enter, controlled inputs see one value and long text takes one round trip. `Input.insertText` fires `beforeinput` and `input` only, and many as-you-type searches wait for `keyup`. On our release benchmark (3 runs each), CyberChef's task took 20 steps on 19.0.0 against 7 on 18.22.2: in every 19.0.0 run the model filled the search box, saw no results, then pressed a key.

Decisions:
- Native CDP key events with no text are rejected: they go wherever focus is (a Space after an input handler focused a dialog's button clicked it), a held Control turns them into Ctrl+X, and the key-down renews the page's user activation.
- Puppeteer's `evaluate` is not used to dispatch: it requests a user gesture, which renews activation too.
- Typing the last character for real, or per-key typing for ASCII again, is rejected: keydown listeners read the value one character short and controlled inputs see several values.

Page-created events are untrusted (`isTrusted: false`, `keyCode` and `which` 0), so a page that ignores those still sees none, as on 19.0.0. A page's own keydown and keyup handlers do run, and may do whatever they do on a key (submit, click), as on 18.22.2 where every typed key ran them. This applies to Chromium-backed tabs, relay and CDP-attached included; WebKit, Tern and cmux tabs and rich-text editors keep their earlier paths, unchanged since 18.22.2.

## Testing

- New test in `browser-interactions.test.ts`, through `tab.fill`: a keyup-only search page gets one `beforeinput`, one `input`, then `keydown`/`keyup` reading the final value, no `keypress`, no doubled text and no renewed activation after its `input` handler spent it; a field whose `input` focuses a button sends that button no key or click; a field whose keydown moves focus gets no keyup; a focusable `<div>` passed to `fill` gets no key. It fails on 19.0.0 and on each rejected or weaker variant.
- Headless Chromium on macOS, 18.22.2 / 19.0.0 / this branch: the table above (medians of 4 interleaved runs), a hidden background tab and a held Control. Live CyberChef: 3 / 0 / 3 results.
- Linux, `test/tools/browser*.test.ts` at the previous head: 1052 pass, 0 fail (1051 on `main`); the full suite's failures match `main`'s or pass 3 of 3 alone. `bun run check:ts` passes.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
