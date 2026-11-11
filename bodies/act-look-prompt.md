## What

I changed the browser prompt to teach act-then-look in one cell and to stop agents padding cells with fixed sleeps, now that the look and the reads after an action wait for the page on Chromium.

In blind runs GPT-6.1 Sol took 0.82x and 0.92x its base's steps in two legs, all of the gain in the one long GOV.UK task; Claude Opus 5.5's steps are unchanged (0.98x, 0.97x) but it sleeps 3.6x and 5.3x less; Claude Haiku 5.5 stops sleeping (93 to 2) at 1.12x steps [0.97, 1.30]. Wall time on a quiet host is within noise for all three.

- "Re-observe, then act in the same cell" becomes "Act and look in one cell: end a cell that acts with `await tab.observe()`", and both examples end their click with a look.
- One `<critical>` line: on Chromium tabs the next look or read after an action waits for the page, so fixed sleeps are not needed for that; on Tern and cmux, and for content the page renders later on its own timer, wait with `waitForText`/`waitForSelector`.

## Why

The Waiting line already says to wait for text, a URL or a selector instead of sleeping, yet agents slept in 30% of browser cells on Haiku 5.5 and 61% on Opus 5.5 on main, and spent a second cell on the look after most actions. An earlier no-sleep sentence tried on main alone removed the sleeps but made Opus slower (1.37x steps): without the read settle, it read "Loading" and re-checked. So this line needs the read settle under it.

## Testing

Runs on bench-mac, headless Chrome for Testing through `browser.cdpUrl`, graded by each bench task's own grader, blind (neutral directory and tree names), the stack with observe-stable-ids on top against its base, 3 tasks x 4 runs per arm. Ratios are the geometric mean over tasks of stack/base task means, 95% bootstrap intervals. Tasks: an SPA wizard with staged renders, a records table with confirm dialogs, and the live GOV.UK maternity pay calculator. Where a model has two legs, the second was taken on a quiet host (load under 32).

| model | steps | tokens | sleeps, base -> stack | wall, quiet host | pass, base / stack |
|---|---|---|---|---|---|
| GPT-6.1 Sol | **0.82** [0.78, 0.86]; 0.92 [0.83, 1.00] | 0.84 [0.78, 0.91]; 0.98 [0.88, 1.09] | 0 -> 0 | 1.06 [0.95, 1.17] | 12/12 / 12/12 both legs |
| Claude Opus 5.5 | 0.98 [0.88, 1.08]; 0.97 [0.90, 1.03] | 1.01 [0.90, 1.13]; 1.04 [0.98, 1.11] | 84 -> 23; 80 -> 15 | 0.93 [0.77, 1.11] | 12/12 / 12/12; 11/12 / 12/12 |
| Claude Haiku 5.5 | 1.12 [0.97, 1.30] | 1.14 [0.98, 1.36] | 93 -> 2 | 0.85 [0.69, 1.08] | 11/12 / 10/12 |

- Sol's step gain is the GOV.UK task (0.53x in the first leg); on the SPA wizard its quiet-host wall time was 1.28x, which we have not traced.
- Haiku re-checked the page more on the stack (39 cells against 30), and one stack run closed the GOV.UK result tab the prompt asks to keep open.
- The failed runs we could inspect (Opus base, one per arm on Haiku) were harness artefacts.
- Wall time comes only from runs taken on a quiet host; the first Sol and Opus legs ran under heavy load and are not used for it.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
