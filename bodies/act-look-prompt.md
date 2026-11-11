## What

I changed the browser prompt to teach act-then-look in one cell and to stop agents padding cells with fixed sleeps, now that the look and the reads after an action wait for the page on Chromium.

With this wording on top of the look and read settle, blind runs show the gain sits on GPT-6.1 Sol: 0.82x its base's steps [0.78, 0.86], all of it in the one long GOV.UK task. Claude Opus 5.5's steps are unchanged (0.98x [0.88, 1.08]) but it sleeps about 3.6x less (84 to 23), and Claude Haiku 5.5 stops sleeping (93 to 2) at 1.12x steps [0.97, 1.30].

- "Re-observe, then act in the same cell" becomes "Act and look in one cell: end a cell that acts with `await tab.observe()`", and both examples end their click with a look.
- One `<critical>` line: on Chromium tabs the next look or read after an action waits for the page, so fixed sleeps are not needed for that; on Tern and cmux, and for content the page renders later on its own timer, wait with `waitForText`/`waitForSelector`.

## Why

The Waiting line already says to wait for text, a URL or a selector instead of sleeping, yet agents slept in 30% of browser cells on Haiku 5.5 and 61% on Opus 5.5 on main, and spent a second cell on the look after most actions. An earlier no-sleep sentence tried on main alone removed the sleeps but made Opus slower (1.37x steps): without the read settle, it read "Loading" and re-checked. So this line needs the read settle under it.

## Testing

Runs on bench-mac, headless Chrome for Testing through `browser.cdpUrl`, graded by each bench task's own grader; ratios are the geometric mean over tasks of arm/main task means with 95% bootstrap intervals. Tasks: an SPA wizard with staged renders, a records table with confirm dialogs, and the live GOV.UK maternity pay calculator.

| this stack (with observe-stable-ids on top) vs its base, Claude Haiku 5.5, blind, 3 tasks x 4 | steps | sleeps | wall | pass |
|---|---|---|---|---|
| SPA wizard | 0.98x | 8 -> 0.5 (median) | 1.16x | 4/4, 4/4 |
| records table | 1.18x | 8.5 -> 0 | 1.13x | 4/4, 4/4 |
| GOV.UK maternity pay | 1.09x | 5.5 -> 0 | 0.81x | 3/4, 2/4 |
| all three [95% CI] | 1.12 [0.97, 1.30] | 93 -> 2 in total | 0.85 [0.69, 1.08] | 11/12 vs 10/12 |

On Haiku the stack removes the sleeps and almost all reads of an unsettled page (48 of 120 to 9 of 140); its steps lean up (tokens 1.14 [0.98, 1.36]) without separating from 1.0, and it re-checks more (39 cells against 30). Each arm lost one run to a harness artefact; one head GOV.UK run closed the result tab the prompt asks to keep open. These Haiku runs were taken on a quiet host.

| same stack vs its base, GPT-6.1 Sol, blind, 3 tasks x 4 | steps | tokens | pass |
|---|---|---|---|
| SPA wizard | 1.06x | 1.12x | 4/4, 4/4 |
| records table | 0.96x | 1.03x | 4/4, 4/4 |
| GOV.UK maternity pay | 0.53x | 0.55x | 4/4, 4/4 |
| all three [95% CI] | 0.82 [0.78, 0.86] | 0.84 [0.78, 0.91] | 12/12 both |

Sol slept in no cell in either arm. The gain is the long GOV.UK flow, where it acts and reads in one cell; reads taken before the page settled fell from 19 of 34 to 4 of 124.

| same stack vs its base, Claude Opus 5.5, blind, 3 tasks x 4 | steps | cells with a sleep | tokens | pass |
|---|---|---|---|---|
| SPA wizard | 1.00x | 10.5 -> 5 | 1.01x | 4/4, 4/4 |
| records table | 0.88x | 6 -> 0 | 0.91x | 4/4, 4/4 |
| GOV.UK maternity pay | 1.00x | 1 -> 0 | 1.02x | 4/4, 4/4 |
| all three [95% CI] | 0.98 [0.88, 1.08] | 68 -> 19 in total | 1.01 [0.90, 1.13] | 12/12 both |

Opus's steps held while its sleeps fell by three quarters (84 to 23); reads taken before the page settled fell from 38 of 63 to 17 of 59. Wall time in the Sol and Opus legs ran under heavy host load and awaits a quiet rerun.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
