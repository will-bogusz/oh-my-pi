## What

I'd like to explore the idea of snapcompact fallback when switching models, and generally exploring more cross model/provider switching behaviors. I have a feeling this is underexplored right now, and probably not optimized.

Here a text-only fallback got skipped as too big: the fit check charged it for the image model's frames, which it is never sent.

On a real session (a 38-frame snapcompact archive; the last Codex request billed 187,664 input tokens) the retry fallback's fit check charged a 131K-window GLM-5.3 fallback 187,664 tokens and skipped it; it now charges 75,963, against 76,562 that GLM's tokenizer counts in the request that fallback would be sent.

> **Context.** When a turn fails, the retry fallback asks `contextFitsModel(candidate)` whether the candidate's window holds the retry, taking the larger of the last request's provider-reported size (moved into the candidate's terms, today only for replayed reasoning) and a local count of the candidate's own request. A model without image input reads a snapcompact archive as text, not frames; only the local count followed that.

| Candidate, after that Codex turn | Its request (GLM tokenizer) | Charged with #17510 | With this PR | Verdict |
|---|---|---|---|---|
| `vllm/glm-5.3`, 131K window (fit budget 111,412) | 76,562 | 187,664 | 75,963 | skipped → fits |
| `factory-droid/glm-5.3`, 908K window | 184,667 | 187,664 | 184,052 | fits → fits |

## Why

- `contextFitsModel` now adds an archive-form shift beside the reasoning shift: for each archive the candidate reads in another form, its form at the candidate's count minus the form the usage priced.
- That form comes from the usage's own source, now reported as `ContextUsageBreakdown.anchor`: the reply whose provider usage it rests on (also through an in-flight snapshot), read as that reply's model reads it; with no anchor, the local count of the stored context. After a switch with no reply since, the anchor is still the earlier model's reply, so the active model is the wrong reference; a reply that only survived a compaction anchors nothing.
- Rejected: dropping the provider number for a text-only candidate; it is the only arm that sees the exact system prompt and tool schemas.
- Cost: one role scan; sessions without an archive stop there.

Non-goal: the reasoning shift is unchanged.

## Testing

- Real session: compaction-eval case `claude-05` plus the Codex turn that billed 187,664. Each candidate's request was built by omp and captured locally, never sent, then counted with omp's GLM-5 tokenizer (median ratio 0.999 to GLM's billed input on 12 other requests). The charged number was read from `contextFitsModel` by bisecting the usage at the candidate's window, on #17510's head and this branch.
- `context-fits-model.test.ts`, over a real `SessionStatsTracker`: "moves provider usage off the frames a candidate without image input reads as text" fails on #17510's head; "after a switch without a reply since" fails with the active model as reference; the local-count and in-flight-snapshot cases fail when the last anchor-shaped reply is taken instead.

```sh
cd packages/coding-agent && bun test test/context-fits-model.test.ts test/agent-session-snapcompact-reader.test.ts
```

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
