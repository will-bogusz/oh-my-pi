## What

I kept asking why my Opus archives couldn't go higher and why we were artificially limiting them, so I ran archive sizes up to the providers' real limits on my longest sessions, and what actually held them back was our own half-the-room sizing rule.

Snapcompact archives now fill the compacted context up to 75% of the compaction trigger. On five long real sessions at their per-model triggers, archives grew from 50 → 72 frames on Opus 5.5 and 54 → 79 on gpt-6.1-sol, and recall of the discarded history rose from 37% → 53% and 29% → 36%.

| How far back the fact was | Opus 5.5, main | Opus 5.5, this PR | gpt-6.1-sol, main | gpt-6.1-sol, this PR |
|---|---|---|---|---|
| up to 0.3M chars | 98% | 95% | 95% | 93% |
| 0.6–0.9M chars | 97% | 96% | 57% | 91% |
| 1.3–1.9M chars | 25% | 97% | 12% | 24% |
| 2.1–2.7M chars | 1% | 10% | 5% | 6% |
| 3.0–4.4M chars | 1% | 2% | 2% | 3% |
| **All probes** | **37%** | **53%** | **29%** | **36%** |
| Archive frames (tokens after compaction) | 50 (268K) | 72 (377K) | 54 (174K) | 79 (247K) |

**Cost:** after a compaction about a quarter of the trigger is left for new turns instead of about half, so sessions compact about 1.8 times as often. Each compaction is local (6 to 9 s here) and rewrites the prompt cache once.

> **Snapcompact context.** When compaction fires, snapcompact prints the discarded history onto images ("frames") that stay in context. How many frames it keeps decides how far back the model can still read; past that, the oldest history is dropped.

## Why

The archive got half the room under the trigger, never planned past 60% of it (PR 14345, where 0.5 won a 0.3/0.5/0.7 sweep on an earlier pricing design). On these sessions that share was the limit: no frame cap, byte budget or image count was reached. More frames cost nothing in reading quality: facts both archives held scored the same (+0.00 Opus, +0.01 gpt-6.1-sol), so the gain is history the smaller archive had already dropped.

- **Why 75%, not 80%.** A threshold pass must leave the context under the 80% recovery band or it hands off to the next method; sized contexts landed at 73 to 74% of the trigger, inside it.
- **The share is gone.** With the share equal to the target, the target term always binds, so one constant remains.
- **Non-goals:** when compaction fires, frame caps and shapes, the payload budget.
- Related: #10897 sizes first-pass archives against the recovery band.

Maintenance: one constant in `session-maintenance.ts`. A reader that started losing frames at this size would show up as recall falling on facts both sizes hold.

## Testing

- Live: five sessions with 6 to 20M chars of history each, cut before a real compaction with earlier compactions stripped, resumed in omp's RPC mode with only `snapcompact` in the method order and the session model's trigger (Opus 5.5 at 510K tokens, gpt-6.1-sol at 340K), two runs each. The first prompt is a quiz of about 60 questions at known distances back, graded by exact match or a judge from the other model family. Paired difference: Opus +0.16 [0.11, 0.20], gpt-6.1-sol +0.07 [0.03, 0.12] (95% bootstrap over sessions, then questions).
- `bun test test/agent-session-snapcompact-trigger-room.test.ts test/agent-session-snapcompact-budget.test.ts` (coding-agent): the sizing tests now assert the 75% bound, and with the constant back at 0.6 NEGCTL.

<details><summary>Rig and build</summary>

Build: `main` at `6a86df8539f` with this change and a per-host frame cap that lets gpt-6.1-sol archives pass 80 frames; on this PR alone 4 of the 10 gpt-6.1-sol runs keep 80 frames instead of 81. Questions come from 25K-char windows of the archived transcript at fixed distances, written by gpt-6.1-sol; facts that recur more than three times are rejected so a question's age means something. First-turn time to first token: Opus 16 → 21 s, gpt-6.1-sol 11 → 14 s; cached later turns 3.4 → 4.7 s and 4.9 → 6.3 s.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
