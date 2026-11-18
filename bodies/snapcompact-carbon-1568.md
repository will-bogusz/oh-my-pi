## What

I switched Gemini 4 Carbon on Devin and Factory Droid to 1568px snapcompact frames, because at 2048px it copied under a third of an archive's lines exactly.

Exact copies of dense archive lines: 30% → 84% (20 matched seeds over both hosts), with no loss of recall on real transcripts.

Snapcompact draws archived history into image frames. Gemini bills every frame about the same (~1,089 tokens) at any size, so a larger frame packs more text into the same bill, but Carbon reads a frame exactly only up to ~15k characters: a 2048px `8on22-bw` frame holds 23.8k, a 1568px one 13.9k.

| Gemini 4 Carbon on | Before | Now |
|---|---|---|
| Devin (`gemini-4-carbon` and its raw effort uids `-low`, `-medium`, `-high`), Factory Droid (`gemini-4-carbon`) | `8on22-bw` at 2048px | `8on22-bw` at 1568px |
| Google, Vertex, OpenRouter and every other host | `8on22-bw` at 2048px | unchanged |

It is one rule in `classes/gemini.kdl`, inside the class-wide 2048px block.

Non-goals: other Gemini lines and hosts (not measured enough), and the stretched 13x21 layout that measured slightly better still (it needs a renderer change first).

## Why

Measured 2026-11-17 on Devin's agent wire and Factory's Google wire, medium effort. The copy task: the reader transcribes 12 tagged lines (URLs, hashes, UUIDs, paths) of a synthetic session log drawn into the frames; "exact" is the share copied verbatim.

| | 2048px (before) | 1568px (now) |
|---|---|---|
| characters per frame | 23,808 | 13,916 |
| exact lines, Devin / Factory (10 seeds each) | .225 / .367 | .850 / .825 |
| pooled Δ exact vs 2048, bootstrap 95% CI | ref | +.542 [.454, .629] |
| real-transcript QA F1, Devin / Factory (300 paired questions each) | .949 / .932 | .932 / .960 |
| strict-agentic recall, Devin / Factory | .933 / .927 | .960 / 1.000 |

On QA, Factory improved at 1568 (F1 +.028 [.001, .062], strict +.073 [.027, .133], chunk bootstrap) and Devin's differences sit inside noise. The class rule chose 2048 on QA alone; the exact-copy loss decides it.

**Cost:** a 1568px frame holds 42% fewer characters for the same bill, so an archive bound by its frame count covers less history. Factory caps an archive at 5 frames: 70k characters of frames instead of 119k. Characters read exactly per frame still rise, from ~7.1k to ~11.7k.

Budgets: frames shrink (60 full frames measured ~4.6 MB of base64 against ~7.9 MB), so every byte cap still holds. Related: #19619 gives Devin's own host a 60-image budget and a 12 MB frame share; Carbon archives there stay bound by the image count at either size (the byte cap allows 107 frames at 1568px, 70 at 2048px), well under Devin's 32 MB request limit. On a custom Devin base URL (40 images, the default 3 MB frame share) they stay byte-bound: 26 frames at 1568px, 17 at 2048px. The per-frame token price #19619 records (1,089) does not depend on frame size.

Maintenance: a change in how Gemini bills or resamples images calls for re-running the copy task; the fix stays this one rule.

## Testing

- `bun test packages/snapcompact/test/snapcompact.test.ts -t "Gemini 4 Carbon"`: renders one Carbon frame per host and decodes its PNG. Devin frames (logical id and the `-high` effort uid) and Factory frames are 1568px wide in the 8x22 cell, Google's 2048px. With the rule removed, or the effort uid dropped from it, it fails (`Expected: 1568, Received: 2048`).
- `resolveShape()` on this branch: Carbon on Devin and Factory 1568px; Carbon on Google, Gemini 3.7 Flash on Devin and Factory, and Gemini 4 Argon on Factory 2048px.
- `bun test packages/snapcompact/test/snapcompact.test.ts`: 122 pass.

---

- [x] `bun check` passes (snapcompact typecheck, oxlint, oxfmt)
- [x] Tested locally
- [x] CHANGELOG updated
