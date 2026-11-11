## What

I changed the browser prompt to teach act-then-look in one cell and to stop agents padding cells with fixed sleeps, now that the look and the reads after an action wait for the page on Chromium.

For later timer-driven content, the line now says to wait for text or an element the page has already shown, or read first and then choose a wait target. This replaces the open-ended "wait for it", which led agents to guess text that was not on that page.

The examples end their action with `await tab.observe()`. Chromium's automatic settle and the explicit condition waits for Tern, cmux and later timer-driven content remain distinct.

## Why

The earlier wording produced guessed-text wait timeouts in 3 of 8 Sol wizard runs. One target was on the next page; another was only a select-option label. Reading before choosing a target avoids teaching agents to replace fixed sleeps with speculative waits.

The sentence still needs the read settle beneath it: on main alone an earlier no-sleep instruction removed sleeps but made Opus take 1.37x as many steps, reading "Loading" and re-checking. This is not a claim that all timer-driven content is ready when the DOM first goes quiet.

## Testing

Blind wording comparison, headless Chrome for Testing: current wording at `3778d45907` against that head plus the one-line change at `a26eec9288`. Those measurements predate the separate pre-existing-request fix; they are not attributed to the newly restacked head. Every run remained under the host-load ceiling and arm-name leak checks were clean. Ratios below are new/current; intervals are 95% bootstrap intervals.

| Wording comparison | Wait calls, current → new | Runs with wait timeout | Sleeps | Pass, current / new | Steps ratio | Wall ratio |
|---|---|---|---|---|---|---|
| GPT-6.1 Sol medium, wizard, 10 per arm | 26 → 0 | 1/10 → 0/10 | 0 → 0 | 10/10 / 10/10 | 1.05 [1.00, 1.12] | 1.03 [0.92, 1.14] |
| Claude Opus 5.5 medium, wizard and records, 4 per task per arm | 24 → 34 | 0/8 → 0/8 | 34 → 19 | 8/8 / 8/8 | 1.00 [0.88, 1.12] | not used |

The new wording eliminated Sol's wait calls in this sample and did not bring Opus's sleeps back. It does not establish a wall-time improvement; Opus's step interval also spans no change.

<details>
<summary>Earlier blind complete-series comparison against main</summary>

Three tasks, four runs per task per arm: staged SPA wizard, records table, live GOV.UK maternity calculator. Ratios compare the full series at `172f0187d0` with `e1d8f29d549`, not the wording change alone. Wall figures are from the quiet-host rerun.

| Model | Steps, first / quiet leg | Sleeps, base → series | Quiet wall ratio | Pass, base / series |
|---|---|---|---|---|
| GPT-6.1 Sol | 0.82 [0.78, 0.86]; 0.92 [0.83, 1.00] | 0 → 0 | 1.06 [0.95, 1.17] | 12/12 / 12/12 both legs |
| Claude Opus 5.5 | 0.98 [0.88, 1.08]; 0.97 [0.90, 1.03] | 84 → 23; 80 → 15 | 0.93 [0.77, 1.11] | 12/12 / 12/12; 11/12 / 12/12 |
| Claude Haiku 5.5 | 1.12 [0.97, 1.30] | 93 → 2 | 0.85 [0.69, 1.08] | 11/12 / 10/12 |

Sol's step gain was concentrated in GOV.UK. Haiku re-checked more; one series run closed its result tab. No quiet-host wall speedup was established.

</details>

The blind comparison above is the evidence for the wording change; a rendering or prompt-string assertion does not establish model behavior.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated (queued, attribution added on opening)
