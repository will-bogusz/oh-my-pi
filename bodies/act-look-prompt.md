## What

I changed the browser prompt to teach act-then-look in one cell and to stop agents padding cells with fixed sleeps, now that the look and the reads after an action wait for the page on Chromium.

With this wording on top of the look and read settle, Opus 5.5 took 0.86x main's steps [0.80, 0.93] and 0.81x its wall time [0.73, 0.89], and Haiku 5.5 0.70x main's wall time [0.54, 0.95].

- "Re-observe, then act in the same cell" becomes "Act and look in one cell: end a cell that acts with `await tab.observe()`", and both examples end their click with a look.
- One `<critical>` line: on Chromium tabs the next look or read after an action waits for the page, so fixed sleeps are not needed for that; on Tern and cmux, and for content the page renders later on its own timer, wait with `waitForText`/`waitForSelector`.

## Why

The Waiting line already says to wait for text, a URL or a selector instead of sleeping, yet agents slept in 30% of browser cells on Haiku 5.5 and 61% on Opus 5.5 on main, and spent a second cell on the look after most actions. An earlier no-sleep sentence tried on main alone removed the sleeps but made Opus slower (1.37x steps): without the read settle, it read "Loading" and re-checked. So this line needs the read settle under it.

## Testing

Runs on bench-mac, headless Chrome for Testing through `browser.cdpUrl`, graded by each bench task's own grader; ratios are the geometric mean over tasks of arm/main task means with 95% bootstrap intervals. Tasks: an SPA wizard with staged renders, a records table with confirm dialogs, and the live GOV.UK maternity pay calculator (Haiku 3 tasks x 4 reps, Opus 2 tasks x 2). They were measured on the experiment branch; since then the no-sleep line was scoped to Chromium tabs and the settle code changed after review. GPT-6.1 Sol has not been run on this change.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
