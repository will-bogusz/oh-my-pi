## What

I changed the browser prompt to teach act-then-look in one cell and to stop agents padding cells with fixed sleeps, now that the look and the reads after an action wait for the page on Chromium.

With this wording on top of the look and read settle, agents on Haiku 5.5 slept in half as many cells (31 against 57 over 12 runs each); steps did not fall (1.12x main [0.99, 1.29]), and on the experiment branch Opus 5.5 took 0.86x main's steps [0.80, 0.93].

- "Re-observe, then act in the same cell" becomes "Act and look in one cell: end a cell that acts with `await tab.observe()`", and both examples end their click with a look.
- One `<critical>` line: on Chromium tabs the next look or read after an action waits for the page, so fixed sleeps are not needed for that; on Tern and cmux, and for content the page renders later on its own timer, wait with `waitForText`/`waitForSelector`.

## Why

The Waiting line already says to wait for text, a URL or a selector instead of sleeping, yet agents slept in 30% of browser cells on Haiku 5.5 and 61% on Opus 5.5 on main, and spent a second cell on the look after most actions. An earlier no-sleep sentence tried on main alone removed the sleeps but made Opus slower (1.37x steps): without the read settle, it read "Loading" and re-checked. So this line needs the read settle under it.

## Testing

Runs on bench-mac, headless Chrome for Testing through `browser.cdpUrl`, graded by each bench task's own grader; ratios are the geometric mean over tasks of arm/main task means with 95% bootstrap intervals. Tasks: an SPA wizard with staged renders, a records table with confirm dialogs, and the live GOV.UK maternity pay calculator.

| this stack vs its base, Haiku 5.5, 3 tasks x 4 | ratio [95% CI] |
|---|---|
| steps | 1.12 [0.99, 1.29] |
| wall time | 1.13 [0.95, 1.34] |
| tokens | 1.15 [1.01, 1.33] |
| cells with a sleep | 57 -> 31 in total |
| pass | 10/12 both |

The steps rise is mostly the records-table task (1.38x). An earlier Haiku leg of the same wording on the experiment branch gave wall 0.70x [0.54, 0.95], so at this n the Haiku effect on steps and wall is within noise; the Opus 5.5 leg there (2 tasks x 2) gave steps 0.86x and wall 0.81x. GPT-6.1 Sol has not been run on this change.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
