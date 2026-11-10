## What

Models kept spending a whole cell just looking at the page to find out whether a click or fill had done anything, so I made each browser action print one line saying what it did.

With an earlier build of this change, GPT-6.1 Sol went from 35 look-only cells to 24 on four browser tasks and took 0.91x `main`'s steps; on Claude Haiku this head took 1.07x and 1.17x the steps in two blind legs, so the saving does not carry over to Haiku. In Chromium, `goto`, `click`, `fill`, `type`, `press` and `select` (tab, frame and element forms) now print into the cell output. Recorded on a bench signup wizard:

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
| `page changed` | nodes, text, attributes or a form value changed | 42 of 44 |
| `no change yet` | nothing changed while the DOM stayed quiet for 80 ms (300 ms at most) | 16 of 20 |

A fill or type whose value the page rewrote adds `(field now shows "…")`, never for a password field, and a dialog left open prints `dialog pending: confirm "…"`. Return values are unchanged; when the page cannot be probed, nothing is printed.

**Cost:** +81 ms median per action (p90 85 ms), about 1 ms for a navigation, 5 to 10 tokens per line. A page that never goes quiet pays the 300 ms cap and prints `page changed`.

## Why

Agents act mid-cell and end the cell with a look, so a returned value is dropped: an earlier build that only returned the line reached GPT-6 Luna 0 times in 6 runs; printed, Haiku saw 80 lines in 16.

`no change yet` claims only what was seen, since a wrong "no change" invites a repeated click. Its 4 misses were one case: a wizard still in its timed "Preparing…" stage from the previous navigation rendered after the line, and the click itself did nothing. Waiting 1.5 to 4 s for that on every no-op action costs more than `waitForText` does when such content matters. The 2 wrong `page changed` lines were DOM replacements with identical text.

Not in this PR: cmux and Tern tabs print nothing, and a click that opens a confirm synchronously still times out as on `main`. There is no setting to turn the line off; the default is the maintainer's call.

<details><summary>What the probe counts and what leaves the page</summary>

The probe runs in the frame's isolated world, so page scripts can neither see nor change it. It watches the document and every open shadow root. Style and class changes count, except on the focused element or the innermost hovered one (focus rings, hover and pressed states), so a modal or menu shown by a class reads as a change. Form values are hashed in the page; only the value of the field the action wrote leaves it, for the read-back, and quoted values and dialog messages stop at 80 characters. After the action the worker polls the page until the DOM has been quiet for 80 ms, so a hidden tab's throttled timers do not stretch it, and each probe call gives up after 400 ms.

</details>

## Testing

`packages/coding-agent/test/tools/browser-action-outcome.test.ts` covers every action form, renders on a page timer, style, class and shadow-root changes, read-back on fields that truncate, uppercase, move focus or hold a password, frames, a dialog, and that the page cannot see the probe: 6 of 6 pass, and with `main`'s `src` 6 of 6 fail. The rest of `test/tools/browser-*.test.ts` passes except `browser-screenshot-background`, which fails the same way on `main` on this host.

The 102 actions are navigations, in-place changes and deliberate no-ops on six bench task pages, each line compared with an independent look 1 s later, `main` and this head interleaved.

Model runs on headless Chrome for Testing; ratios are geometric means of per-task ratios with 95% bootstrap intervals, and the samples are small. The earlier-build runs were not blind: the model could read the arm's name in its working directory (`outcome-print`). The two Haiku legs on this head ran in a neutral directory from a neutrally named copy of each tree; a scan of everything the model was sent found no arm name.

| model, tasks x runs per arm | build | steps | tokens | look-only cells | pass `main` / PR |
|---|---|---|---|---|---|
| GPT-6.1 Sol medium, 4 x 3 | earlier | **0.91** [0.86, 0.97] | **0.89** [0.81, 0.98] | 35 -> 24 | 12/12 / 12/12 |
| Claude Haiku 5.5 medium, 4 x 4 | earlier | 0.86 [0.75, 1.01] | 0.85 [0.73, 1.01] | 75 -> 67 | 15/16 / 16/16 |
| Claude Haiku 5.5 medium, 4 x 4, blind | this head | 1.17 [0.99, 1.37] | **1.19** [1.02, 1.39] | 62 -> 73 | 15/16 / 16/16 |
| Claude Haiku 5.5 medium, 4 x 4, blind | this head | 1.07 [0.91, 1.25] | 1.04 [0.88, 1.22] | 66 -> 67 | 16/16 / 14/16 |

<details><summary>The earlier build, and Haiku on this head</summary>

The earlier build printed the same lines without `yet`, ignored every style and class change and read back the focused field. On this head the product configurator cost Haiku most (1.26x and 1.21x the median steps). Part of that is a correct line: Haiku often clicks a colour's caption, which does nothing, then reads `no change yet` and spends cells finding the swatch, but some long runs never saw that line. The PR's two FAILs in the second leg fetched Chrome's `/json/list` themselves, which the bench grader counts as a browser bypass. In the same leg the code with no prompt line took 1.00x [0.88, 1.15] the steps and the earlier prompt wording 1.11x [0.96, 1.30], so no wording made a measurable difference. Wall time: Sol 1.03x [0.90, 1.17]; Haiku 1.11x [0.92, 1.32] and 1.13x [0.98, 1.31], on a shared host.

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
