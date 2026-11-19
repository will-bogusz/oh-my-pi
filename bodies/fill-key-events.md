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

19.0.0 changed text-field `fill` from per-key typing to one `Input.insertText`, so a newline no longer presses Enter, controlled inputs see one value and long text takes one round trip. `Input.insertText` fires `beforeinput` and `input` only, and many as-you-type searches wait for `keyup`. In every 19.0.0 run of CyberChef's task on our release benchmark, the model filled the search box, saw no results, then pressed a key; the agent runs under Testing measure what that cost.

Decisions:
- Native CDP key events with no text are rejected: they go wherever focus is (a Space after an input handler focused a dialog's button clicked it), a held Control turns them into Ctrl+X, and the key-down renews the page's user activation.
- Puppeteer's `evaluate` is not used to dispatch: it requests a user gesture, which renews activation too.
- Typing the last character for real, or per-key typing for ASCII again, is rejected: keydown listeners read the value one character short and controlled inputs see several values.

Page-created events are untrusted (`isTrusted: false`, `keyCode` and `which` 0), so a page that ignores those still sees none, as on 19.0.0. A page's own keydown and keyup handlers do run, and may do whatever they do on a key (submit, click), as on 18.22.2 where every typed key ran them. This applies to Chromium-backed tabs, relay and CDP-attached included; WebKit, Tern and cmux tabs and rich-text editors keep their earlier paths, unchanged since 18.22.2.

## Testing

- New test in `browser-interactions.test.ts`, through `tab.fill`: a keyup-only search page gets one `beforeinput`, one `input`, then `keydown`/`keyup` reading the final value, no `keypress`, no doubled text and no renewed activation after its `input` handler spent it; a field whose `input` focuses a button sends that button no key or click; a field whose keydown moves focus gets no keyup; a focusable `<div>` passed to `fill` gets no key. It fails on 19.0.0 and on each rejected or weaker variant.
- Headless Chromium on macOS, 18.22.2 / 19.0.0 / this branch: the table above (medians of 4 interleaved runs), a hidden background tab and a held Control. Live CyberChef: 3 / 0 / 3 results.
- Agent runs on CyberChef's task, GPT-6.1 Sol, 19.0.0 and 19.0.0 plus this change interleaved, 3 runs each, same natives; 18.22.2 shown for reference, not interleaved. Measured at 04604c5684c, before the review round limited the events to text controls and added the focus check before each event; those paths are covered by the new test, not by a rerun. In every run with this change the results appeared straight after `fill`.

  | CyberChef task, median of 3 | 18.22.2 | 19.0.0 | this PR |
  |---|---|---|---|
  | steps | 7 | 13 | 8 |
  | tokens | 131.8k | 286.5k | 147.7k |
  | wall time | 31.3 s | 66.1 s | 34.6 s |

- Six web tasks, 3 runs each on both arms: 36 of 36 runs passed, and none of the 18 runs with this change typed text twice.
- Linux, this branch merged with the other open PRs that change `packages/coding-agent`: the whole coding-agent test suite fails the same 4 tests as `main` (none of them browser tests), and `bun run check:ts` passes.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

