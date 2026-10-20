## What

I kept having to guess why a compaction fired from a debug log line with no session id, so each compaction entry now records what triggered it and the two token counts the decision compared, and the transcript divider shows it.

On 33 recorded compactions, working out the trigger from the transcript misread 5 as not threshold-driven and missed 2 of the 4 that omp's local estimate tripped while the provider's count was under the threshold; the entry now answers both exactly.

The divider before and after, on a recorded snapcompact run:

```
main:     ──── 📷 snap-compacted · 41K→40K · Ctrl+O ────
this PR:  ──── 📷 snap-compacted · threshold · 41K→40K · Ctrl+O ────
ctrl+o:   Trigger: threshold 45,000 · provider count 40,561 · local estimate 46,083
```

That compaction fired with the provider's count under its threshold: the local estimate crossed 45,000, not the 40,561 tokens the provider billed. Nothing in the session said so before.

| `compaction` entry field | Set on |
|---|---|
| `trigger` | every compaction: `threshold`, `overflow`, `idle`, `incomplete` (length stop), `manual` (`/compact`, `/handoff`, SDK `compact()`), `new_context` |
| `thresholdTokens` | threshold decisions (the resolved trigger point) and idle (`compaction.idleThresholdTokens`) |
| `providerContextTokens`, `estimatedContextTokens` | threshold decisions (post-turn, mid-run, pre-prompt): the provider-reported count and the local estimate whose larger value was compared |

## Why

The entry records the method and `tokensBefore`, not why it ran, and `tokensBefore` is not always the number compared: 5 of the 33 show it below the threshold. The decision only reaches a debug log line, so telling a threshold compaction from an overflow or a `/compact`, or the provider's count from the local estimate (snapcompact frames priced high on DeepSeek fired compactions at 167–204k provider tokens against a 300k setting), meant joining logs to transcripts by time.

Decisions:
- Flat fields, like `method` and `tokensAfter`; the anonymizer already keeps `trigger` and `thresholdTokens` and now keeps the two counts.
- The threshold is captured where the decision compared it, so a model or settings change before the commit cannot rewrite it.
- Overflow and length-stop recoveries record only the trigger: there was no threshold comparison.
- A snapcompact dead-end rescue carries the rebuilt entry's trigger over.
- The text sent to the model is unchanged. So is the RPC wire contract: the trigger rides on the open `CompactionSummaryMessage` record, as `warning` does, instead of regenerating the Go, Python and Rust SDKs.
- A session id on the log line instead would still leave the answer outside the session.

**Cost:** 107 bytes per compaction entry, nothing on other entries; no new work per turn (each decision site already had both counts).

Non-goals: when compaction fires, what `tokensBefore` means.

Related: #10841 asks for the trigger on compaction telemetry spans.

## Testing

Live from this branch on Linux, Claude Haiku 5.5 (low), `compaction.thresholdTokens: 45000`, five sessions (two with `methodOrder: [remote]`, three with `[snapcompact]`, the last on this head): chunked reads of a large file, a 60 KB pasted prompt, more reads. I compared what the transcript alone suggests (threshold known exactly, provider count from the last assistant turn) with the recorded fields:

| question | from the transcript | from the entry |
|---|---|---|
| threshold-driven? | 28/33 (3 pre-prompt, 2 estimate-tripped read as not) | 33/33 |
| provider count the decision read | 29/33 (pre-prompt adds the pending prompt) | exact |
| local estimate tripped it | 2 of 4 found, or 7 flagged for 4 on provider count alone | 4 |

Six new tests fail on `origin/main` and pass here; the model-switch test also fails if the threshold is re-resolved at commit time (records 4,000 for a decision that compared 2,000).

```
cd packages/coding-agent && bun test test/agent-session-auto-compaction-progress-guard.test.ts test/agent-session-goal-midrun-compaction.test.ts -t "trigger|decision compared"
cd packages/tui && bun test test/compaction-divider.test.ts
```

<details><summary>Tests and other runs</summary>

- `agent-session-auto-compaction-progress-guard.test.ts`: a threshold compaction records its trigger, resolved threshold and both counts; an overflow recovery records `overflow` without counts; `/compact` records `manual`; an idle compaction records the idle timer's threshold.
- `agent-session-goal-midrun-compaction.test.ts`: a model switch while the mid-run decision waits on the persistence barrier leaves the threshold it compared on the entry.
- `compaction-divider.test.ts`: the divider names the trigger; the expanded view shows the counts.
- A run at `thresholdTokens: 20000` (below the system prompt, so every turn compacted) added 15 compactions, all carrying the fields.

</details>

Not run live: the idle timer and overflow recovery (tests above), and `/compact`, which print mode sends to the model as text.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
