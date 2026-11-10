## What

I moved the computer guide out of the Eval tool description and into the output of the first computer call, because every computer-enabled session was paying for it on every request whether or not it touched the desktop.

The computer part of the Eval description goes from about 6,600 tokens to about 180 per request, which in my own sessions over 12 days is 34.5M → 3.0M input-token equivalents; on Haiku desktop tasks the price is about 1.2x the steps.

| | main | this PR |
|---|---|---|
| Eval description, computer part | the whole guide (~18.7k chars, 4,515 o200k tokens) | one line showing the macOS first call, `const { window: win } = await computer.apps.open(…)` (124 o200k) |
| When the guide reaches the model | before the first request | after the output of the first computer call, once per conversation; again if a compaction or rewind drops it |
| `xd://eval/computer` | the guide | unchanged |

**Maintainer decision: this reverses #16918's choice to inline the guide.** Inline costs every computer-enabled session the guide on every request; first-call delivery costs sessions that do desktop work about a fifth more steps (below). I'd take this side, since 18 of 414 sessions used the desktop, but it is a trade, not a free win.

## Why

Counted from the transcripts of my sessions on builds v18.14.0 and later (2026-10-29 to 11-10): the recorded tool-schema size for the same tool set rose from a median 8,256 to 14,861 tokens at v18.14.0, and that guide rode on 76,102 Anthropic requests in 414 transcripts, 18 of which ever ran a `computer` cell. At the rates those requests paid (cache read 0.05x, prefix rewrite 2x) that is 34.5M input-token equivalents, 2.4% of their input cost. With this PR the same requests carry about 1.0M for the one line plus 2.1M for the guide in the sessions that used it.

Other routes: #18563's `computer.inlineDocs` opt-out keeps the inline default and leaves the saving to users who find the setting (roboomp asked there whether the guide should arrive once computer is called, which is this PR). The read-first link before #16918 cost a doc-read step per task; none of the 60 runs here read the guide.

A first call that throws gets no guide until the next one that prints output; in the bench no first computer cell failed with the start line in place, against 8 of 12 without it.

## Testing

Haiku 5.5 in fresh macOS VMs, 4 native tasks (Reminders, Contacts, Notes→Reminders, Activity Monitor), 3 runs per arm per leg; all 60 runs passed. Against main's 24 runs, this PR's 12 took 1.19x the steps (95% bootstrap 0.97–1.70), 1.25x the prompt tokens and 1.5x the cost per task, and leaned on pixel clicks and screenshots more (48 pixel clicks in 12 runs, against 3 and 10 in main's two legs). Adding an AX-routing sentence to the line brought AX actions back but not the steps, so it is not in the PR. GPT-6.1 Sol runs are pending.

`bun test test/eval-preludes.test.ts test/tools/eval-description.test.ts test/sdk-computer-prelude-toggle.test.ts test/tools/computer.test.ts` (173 pass) and `bun run check` pass. The description test runs two `computer.run` calls in a Python kernel and sees the guide printed once, after the first; it fails without `firstCallDocumentation` on the prelude.

<details>
<summary>Bench rows and how the cost was counted</summary>

| arm (runs) | first cell failed | guide reads | steps, median per task (Notes, Contacts, Reminders, Activity) | prompt tokens per run | cost per run |
|---|---:|---:|---|---:|---:|
| main, two legs (24) | 0 | 0 | 7.5, 15, 6.5, 9.5 | 288k | $0.0064 |
| guide after first call, summary line only (12) | 8 | 0 | 14, 17, 6, 11 | 360k | $0.0097 |
| this PR (12) | 0 | 0 | 8, 17, 8, 13 | 375k | $0.0097 |
| this PR + an AX-routing sentence in the line (12) | 0 | 0 | 15, 18, 7, 12 | 387k | $0.0100 |

First request: 21,232 → 14,318 Haiku tokens. main's own two legs differ by 1.10x in steps; each first-use leg ran beside a main leg (1.12x and 1.27x against it). Wall time on the shared host is indicative only and left out. The bench ran the head before the compaction re-delivery was added, which these short tasks never reach.

Cost: per request carrying the guide, 6,605 tokens x 0.05, and x 2 on the 738 requests that rewrote the prefix; the PR side uses 182 tokens for the line and, in the 17 transcripts that called computer, the guide (6,675 tokens) written once and read by each of the 3,375 later requests.

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
