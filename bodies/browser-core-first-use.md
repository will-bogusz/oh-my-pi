## What

Every browser task on main opened by reading the whole browser guide, so I made the first browser call bring a short core of it instead and left the full guide where it was.

On four browser tasks, runs that read the guide first went from 16 of 16 to none on both GPT-6.1 Sol and Claude Haiku 5.5, and tokens per task from 1.00 to 0.86 of `main` on Sol and 0.61 on Haiku.

| 4 browser tasks × 4 runs (Sol / Haiku) | `main` | this PR |
|---|---|---|
| first call reads `xd://eval/browser` | 16 / 16 of 16 | 0 / 0 of 16 |
| tokens per task | 1.00 / 1.00 | 0.86 / 0.61 |
| tool calls per task | 1.00 / 1.00 | 0.97 (no change) / 0.70 |
| tasks passed | 16 / 15 of 16 | 16 / 16 of 16 |

**Cost:** +52 tokens on the first request of every browser-enabled session (Haiku 13,432 → 13,484), plus about 1k once in a conversation that browses.

A prelude can now carry `firstCallDocumentation`: `invokeEvalPrelude` appends it to the printed output of that prelude's first call in a conversation, again only if compaction or a rewind dropped it (`Agent.messagesRevision`), and the Eval description and mid-session notice list such a prelude apart from the read-first docs. The browser core (`prompts/tools/browser-core.md`) carries helpers with signatures, units, selector forms, the re-observe rule and the critical lines. Non-goals: the computer prelude, and the full guide beyond the signatures the core shows.

## Why

On `main` every browser run here spends its first call reading the 14 kB guide, which then rides in every later request.

- **Core in the Eval description** saves more per browsing task on the same runs (Sol tool calls 0.88, tokens 0.78; Haiku 0.61 and 0.57) but costs +1,530 tokens in every session. Over one heavy user's real mix (269,212 Anthropic requests; 198 of 3,694 sessions ever ran a browser cell) that is about 17.9M input-token equivalents, against 6.5M for today's read and 3.1M for this PR.
- **Full guide in the description,** as the computer prelude does since PR 16918 (18.9 kB in every computer-enabled session): +5.5k tokens per session for the browser.

**Maintainer decision: the guide arrives unasked in the first browser call's output.** I recommend it for the always-on cost. The trade: Sol's first cell becomes a bare `browser.open`, so it saves the read and tokens but not tool calls; the core in the description saves both, at about 6× the cost over that mix.

Maintenance: `browser-prelude-documentation.test.ts` fails when the core names a helper, option or parameter the full guide lacks.

## Testing

- Four bench web tasks (arXiv form, CyberChef upload, pointer-only controls, a cross-turn handoff) on headless Chrome for Testing: `main` (e1d8f29d549), the core in the description and this head, 4 runs per task and arm in rotated order, each in a neutral directory, graded by the task's grader; GPT-6.1 Sol and Haiku 5.5, medium.
- Cost: a one-line arithmetic prompt with the browser enabled, Haiku's first request, identical over 2 runs each.
- `bun test test/eval-preludes.test.ts test/tools/eval-description.test.ts test/tools/browser-prelude-documentation.test.ts test/sdk-computer-prelude-toggle.test.ts`: 30 pass; the guide test fails with the delivery reverted, and its re-send case without the revision check.

<details><summary>Ratios and intervals</summary>

Geometric mean over the 4 tasks of the arm/`main` ratio of task means, 95% bootstrap interval from resampling runs within each task; 16 runs per arm. Wall time ran on a shared host and is indicative only.

| vs `main` | tool calls | requests | tokens | wall time | failed tool calls | passed |
|---|---|---|---|---|---|---|
| Sol, this PR | 0.97 [0.90, 1.04] | 0.97 [0.91, 1.03] | 0.86 [0.79, 0.94] | 1.00 [0.92, 1.09] | 17 → 14 | 16 → 16 |
| Sol, core in description | 0.88 [0.81, 0.95] | 0.90 [0.85, 0.96] | 0.78 [0.71, 0.85] | 0.97 [0.90, 1.06] | 17 → 16 | 16 → 16 |
| Haiku, this PR | 0.70 [0.59, 0.84] | 0.73 [0.62, 0.85] | 0.61 [0.51, 0.73] | 0.73 [0.62, 0.86] | 31 → 27 | 15 → 16 |
| Haiku, core in description | 0.61 [0.52, 0.73] | 0.65 [0.57, 0.75] | 0.57 [0.49, 0.67] | 0.70 [0.57, 0.86] | 31 → 13 | 15 → 16 |

On Sol, this PR's first cell opened or listed tabs in all 16 runs and the guide arrived with its output; the next cell then observed the page or listed targets. Runs used ff7a0b87c82 (this commit before its rebase onto 18.18.7) and, for the core in the description, 4c0e663877.

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
