## What

I switched Gemini 4 Carbon, Neon and Hydrogen on Devin, and Carbon on Factory Droid, to 1568px snapcompact frames. On Devin, all three answered 80–90% of exact questions about an archive right at 2048px and 97–99% at 1568px.

Snapcompact draws archived history into image frames. Devin bills these models a flat ~1,090 tokens per frame whatever its size, so 2048px packs the most text per bill: an `8on22-bw` frame holds 23,808 characters at 2048px and 13,916 at 1568px. These models misread the denser one, identifiers and commands worst.

| On | Before | Now |
|---|---|---|
| Devin: `gemini-4-carbon`, `gemini-4-neon`, `gemini-4-hydrogen` and their raw effort uids | `8on22-bw` at 2048px | `8on22-bw` at 1568px |
| Factory Droid: `gemini-4-carbon` | `8on22-bw` at 2048px | `8on22-bw` at 1568px |
| Other Gemini defaults (Google, Vertex, OpenRouter; Neon and Hydrogen off Devin) | `8on22-bw` at 2048px | unchanged |

It is one rule in `classes/gemini.kdl`, inside the class-wide 2048px block. The same shape draws these readers' opt-in `snapcompact.systemPrompt` and `snapcompact.toolResults` images, so those can use more, smaller images.

Non-goals: other Gemini lines and hosts (not measured), and denser stretched-glyph layouts Carbon and Neon could read (they need a renderer change).

## Why

Measured 2026-11-20 on Devin, medium effort: 158 exact-answer questions on three real archives, each answer a string from the imaged middle, graded by script. Every layout re-renders the same stored text; plain text scored 1.00 on every question asked.

| Answered exactly right | 2048px | 1568px | Identifiers | 1568 − 2048, paired, 95% CI |
|---|---|---|---|---|
| Hydrogen (3 archives, 2 reps, 316 answers) | .804 | .968 | .60 → .94 | +.165 [+.111, +.218] |
| Neon (3 archives, 2 reps, 316 answers) | .902 | .981 | .71 → .96 | +.079 [+.044, +.117] |
| Carbon (1 rep, partial) | .891 (110 answers) | .991 (107 answers) | .79 → .96 | +.119 [+.051, +.203] (59 questions) |

Devin's weekly quota cut Carbon's run short: each layout covers two of the three archives, sharing one, where the paired difference is taken. The comparison changes pixels, density and glyph size together; Hydrogen needs about 14k characters per frame or fewer. For Factory, the evidence is an earlier synthetic copy task on Carbon: dense identifier lines copied exactly .367 → .825 (Devin .225 → .850).

**Cost:** uniform `8on22-bw` frames hold 1.7× more at 2048px. In a synthetic compaction at a 300K trigger, Carbon at Devin's 60-frame budget kept 1.13M characters instead of 1.94M of 3.9M, and 1.54M of history, kept whole before, kept 1.14M. Neon and Hydrogen are planned at omp's 5,024-token estimate here, not their price (Related: #19883), so they stopped at 26 frames either way, keeping 487k instead of 822k. Devin accepted 80 frames (5.4 MB) in one request; the 5-vs-80 comparison used only 16 fixed recent questions. Per call: Hydrogen $0.157 → $0.128; Neon $0.244 → $0.300, thinking more (11.3k → 14.3k output tokens); Carbon on its shared archive 39% cheaper in 41.5% of the time.

## Testing

- `bun test packages/snapcompact/test/snapcompact.test.ts -t "Hydrogen's frames"`: renders one frame per model and host and decodes its PNG. Carbon, Neon and Hydrogen on Devin (logical ids and effort uids) and Carbon on Factory are 1568px wide; Carbon and Neon on Google and Neon on Factory 2048px. With the Neon or the Hydrogen ids removed from the rule, it fails (`Expected: 1568, Received: 2048`).
- `bun test packages/snapcompact/test/snapcompact.test.ts`: 124 pass; a configured `snapcompactShape` still wins over this rule. `bun test packages/catalog/test`: 1,421 pass.

---

- [ ] `bun check` passes: `main` itself fails its `oxfmt --check` (20 untouched files); catalog and snapcompact typecheck, oxlint and oxfmt on the changed files pass
- [x] Tested locally
- [x] CHANGELOG updated
