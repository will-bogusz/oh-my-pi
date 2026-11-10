## What

Models kept spending a whole cell just looking at the page to find out whether a click or fill had done anything, so I made each browser action print one line saying what it did.

With an earlier build of this change, GPT-6.1 Sol went from 35 look-only cells to 24 on the same four browser tasks and took 0.91x `main`'s steps, every run passing on both sides; on Claude Haiku the saving does not show beyond noise. In Chromium, `goto`, `click`, `fill`, `type`, `press` and `select` (tab, frame and element forms) now print into the cell output. These two lines were recorded on a bench signup wizard:

```js
await tab.fill('#email', 'outcome@example.test');
await tab.click('#next');
```

| | cell output |
|---|---|
| `main` | `(no output)` |
| this PR | `page changed`<br>`navigated to http://127.0.0.1:8962/signup/2` |

| line | printed when | right, of 102 scripted actions |
|---|---|---|
| `navigated to <url>` | the frame's URL or document changed | 38 of 38 |
| `page changed` | nodes, text, attributes or a form value changed, open shadow roots included | 42 of 44 |
| `no change yet` | nothing changed while the DOM stayed quiet for 80 ms (300 ms at most) | 16 of 20 |

A click on a disabled card now prints `no change yet` instead of nothing. A fill or type whose value the page rewrote adds `(field now shows "…")`, never for a password field, and a dialog left open after the action prints `dialog pending: confirm "…"`. Nothing is printed when the page cannot be probed, and return values are unchanged.

**Cost:** +81 ms median per action (p90 85 ms) and under 1 ms for a navigation, about 5 to 10 tokens per line. A page that never goes quiet pays the 300 ms cap.

## Why

Agents act mid-cell and end the cell with a look, so a value an action returns is dropped: in an earlier build that only returned the line, GPT-6 Luna saw none of it in 6 runs and Haiku 10 lines in 16. Printed, Haiku saw 80 lines in 16 runs.

`no change yet` claims only what was seen, since a wrong "no change" invites a repeated click. Its 4 misses were all one case: a signup wizard still in its timed "Preparing…" stage from the previous navigation rendered after the line, and the click itself did nothing. Catching that would take a 1.5 to 4 s window on every action that changes nothing; `waitForText` is the tool for such content. The 2 wrong `page changed` lines were DOM replacements with identical text. Style and class changes count, except on the focused element or the innermost hovered one (focus rings, hover and pressed states), so a modal or menu shown by a class still reads as a change; a page that keeps changing itself (a ticking clock) prints `page changed`.

The probe runs in the frame's isolated world, so page scripts can neither see nor change it, and form values are hashed in the page: only the value of the field the action wrote leaves it. Quoted values and dialog messages stop at 80 characters.

Not in this PR: cmux and Tern tabs print nothing, and a click that opens a confirm synchronously still times out as on `main`. There is no setting to turn the line off; the default is the maintainer's call.

## Testing

`packages/coding-agent/test/tools/browser-action-outcome.test.ts` drives a headless tab through every action form: navigation, a no-op click, a render on a page timer, modal and panel shown by style and class, a change inside a shadow root, a click that only restyles itself, `maxlength` read-back on tab and handle fills, a password field, a field that moves focus on input, an 80-character cap, `select`, `press`, an iframe click, a confirm opened from a timer, and a check that the page cannot see the probe. 6 of 6 pass; with `main`'s `src`, 6 of 6 fail. `bun test test/tools/browser-*.test.ts`: 826 pass, 1 fail (`browser-screenshot-background`, which fails the same way on `main` on this host).

Zero-model check: 102 scripted actions (navigations, in-place changes and deliberate no-ops) on six bench task pages, each line compared with an independent look 1 s later, `main` and this head interleaved.

Model runs on headless Chrome for Testing. Ratios are geometric means of per-task ratios with 95% bootstrap intervals:

| model, tasks x runs per arm | build | steps | tokens | look-only cells | pass `main` / PR |
|---|---|---|---|---|---|
| GPT-6.1 Sol medium, 4 x 3 | earlier | **0.91** [0.86, 0.97] | **0.89** [0.81, 0.98] | 35 -> 24 | 12/12 / 12/12 |
| Claude Haiku 5.5 medium, 4 x 4 | earlier | 0.86 [0.75, 1.01] | 0.85 [0.73, 1.01] | 75 -> 67 | 15/16 / 16/16 |
| Claude Haiku 5.5 medium, 4 x 4 | this head | 1.02 [0.84, 1.25] | 1.04 [0.86, 1.27] | 77 -> 85 | 14/16 / 16/16 |

The earlier build had the same lines without `yet`, ignored all style and class changes and read back the focused field. On this head, three Haiku tasks took 0.86x to 1.06x the steps and a product configurator 1.63x: in three of its four runs Haiku clicked a colour's caption, which does nothing, was told `no change yet`, and spent cells finding the swatch; two `main` runs made the same click and got no output. Wall time showed no change on either model. Samples are small: only Sol's step and token intervals exclude 1.0.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
