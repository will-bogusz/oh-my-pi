## What

I kept seeing subagent reports over 5k characters cut to a preview, so the parent either spent a turn reading `agent://` or carried on without the end of the report; this inlines them whole up to 11.5k.

In a live check where the parent must list every finding in an 8.5k-character subagent report, Haiku 5.5 parents got all 12 in 5 of 8 runs on `main` and 8 of 8 with this PR, in 3.6 → 3.0 parent turns.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/50e35061-d181-4d26-8d8c-908bffdf4383">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/d42bd6e3-d893-420e-a525-9a0324028bf4">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/32892240-e5c0-46a2-a9d3-41d953099075">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/cd75d35a-ea69-4da8-8847-415c3250123e">
  <img width="780" alt="Every run as a mark. A subagent hands its parent an 8.5k-character report of 12 findings, 4 past character 5,000. Haiku 5.5 parents listed all 12 in 5 of 8 runs on main and 8 of 8 with this PR, in 3.62 → 3.00 parent turns and 81.9k → 66.7k prompt tokens; Sonnet 5.5 parents listed all 12 in every run either way, in 4.00 → 3.00 turns and 90.0k → 66.6k tokens." src="https://github.com/user-attachments/assets/d42bd6e3-d893-420e-a525-9a0324028bf4" />
</picture>

<details><summary>Exact numbers (Haiku 5.5 n=8 per arm, Sonnet 5.5 n=2 per arm)</summary>

| Parent model, 8.5k-char report | Parents that listed all 12 findings | Parent turns (mean) | Parent prompt tokens (mean) |
|---|---|---|---|
| Haiku 5.5, n=8 per arm | main 5/8 → this PR 8/8 | 3.62 → 3.00 | 81.9k → 66.7k |
| Sonnet 5.5, n=2 per arm | main 2/2 → this PR 2/2 | 4.00 → 3.00 | 90.0k → 66.6k |

Prompt tokens are input + cache read + cache write summed over the parent's requests. Every run's subagent was Haiku 5.5; parents ran with thinking low.

`main` runs: origin/main 10b9b493f4. This PR's runs: the PR head, 74cda9fd25.

</details>

On `main` 3 Haiku runs answered from the preview (7 of 12 findings); every other `main` run went back to `agent://<id>`.

- `task/result-summary.ts`: `FULL_OUTPUT_THRESHOLD` was both the inline limit and the preview size. It splits into `INLINE_OUTPUT_CHARS` (11,500) and `PREVIEW_CHARS` (5,000, unchanged).
- Output up to 5,000 characters, and over 11,500, renders exactly as before.

## Why

Other tool results spill at `tools.artifactSpillThreshold` (50 KB by default); a subagent's report was cut at 5,000 characters. In a week of my sessions, 352 of 634 subagent results (55%) were longer. Parents then re-read the report, paying a full-context turn and holding the preview twice, or acted on the head; the cut tails I sampled held review findings and verdicts. Re-reads rise with report size:

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/74a764d1-d5b3-4e73-b827-cba2bc233cf4">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/c89b0c59-a13d-47b5-9473-ec834ef63612">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/43ed450c-1b2c-4e9c-9c6a-42c8abe01610">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/93c4bb26-b930-459d-ac6a-9f6a06876549">
  <img width="780" alt="On main, the longer a cut subagent report, the more often its parent re-read the whole report through agent://&lt;id>: 24% at 5–8k characters, 73% at 8–12k, 90% at 12–20k and 90% over 20k (352 reports, one week). main cuts reports saved for agent://&lt;id> past 5,000 characters; this PR past 11,500, so reports of 5,000–11,500 characters now arrive whole." src="https://github.com/user-attachments/assets/c89b0c59-a13d-47b5-9473-ec834ef63612" />
</picture>

<details><summary>Exact numbers (352 reports cut to a preview on main, 2026-10-14..20)</summary>

| Report size | Results | Parent read `agent://<id>` afterwards |
|---|---|---|
| 5–8k chars | 229 | 56 (24%) |
| 8–12k chars | 82 | 60 (73%) |
| 12–20k chars | 31 | 28 (90%) |
| over 20k chars | 10 | 9 (90%) |

</details>

Replaying those 634 results against each cap:

| Inline cap | Results the parent saw whole | `agent://` re-reads | Prompt cost, a week (API prices) |
|---|---|---|---|
| 5,000 chars (`main`) | 69% | 153 | $59.5 |
| 11,500 chars (this PR) | 99.4% | 42 | $47.8 |

Decisions:
- **11.5k, sized to async delivery.** A background task's result arrives as an async follow-up, which cuts anything over `ASYNC_INLINE_RESULT_MAX_CHARS` (12,000) to 4,000 characters; the cap is that bound less 500 for the envelope. 16k or 50 KB would save 25 or 42 more re-reads a week but need that shared bound raised.
- **Not a head+tail preview in the same 5k.** Built and run: parents still read `agent://` for the middle in 8 of 8 runs (4.0 turns).
- **Not a cap scaled by the context window.** It threads the window into every caller for no gain on this data.

Risk: a parent holds up to 6.5k more characters per long report it would not have read; the replay prices that in.

## Testing

- `inlines a report past the preview size whole, tail included` and `delivers a background task's whole inline report without cutting it again` (async delivery of an exactly 11,500-character report) fail on `main`; the second also fails with the cap at 16,000. `bun test test/task/result-summary.test.ts test/agent-session-async-delivery.test.ts test/slash-commands/seance.test.ts test/task/task-spawn.test.ts`: 59 pass; `bun run check` clean.
- Live check: headless `omp -p`, Haiku 5.5 (thinking low) parent, Haiku 5.5 on the `task` role; the child returns an 8.5k-character report of 12 findings (4 past character 5,000) verbatim and the parent lists the ids. Sonnet 5.5 parent as a spot check.

<details><summary>Replay method</summary>

Results are `<task-result>` envelopes delivered to parents (task results, `wait` results, async-result injections), 2026-10-14..20, deduplicated per parent and agent id; size from the envelope's `<meta size>` when cut, else the inline output. A re-read is a `read agent://<id>` by the same parent after delivery; a whole inline result is assumed not re-read (3 of 282 were). Cost per result = characters/4 tokens × (cache write once + cache read × the parent's remaining requests in that session), plus the observed cost of each re-read turn (mean $0.10). Opus 5.5 rates fitted from the same sessions' usage: $4 input, $20 output, $0.20 cache read, $8 cache write per million tokens. 16,000-char cap: 99.7% whole, 17 re-reads, $44.7; 50 KB: 100%, 0, $43.2. 50 KB would also inline up to about 12.8k tokens, 13% of a 100k-token Haiku window.
</details>
