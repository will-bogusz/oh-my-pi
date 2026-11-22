## What

I switched Gemini 4 Carbon, Neon and Hydrogen on Devin, and Carbon on Factory Droid, to 1568px snapcompact frames. On Devin, all three answered 80–90% of exact questions about an archive right at 2048px and 97–99% at 1568px.

Snapcompact draws archived history into image frames. Devin bills these models a flat ~1,090 tokens per frame whatever its size, so 2048px packs the most text per bill: an `8on22-bw` frame holds 23,808 characters at 2048px and 13,916 at 1568px. These models misread the denser one, identifiers and commands worst.

| On | Before | Now |
|---|---|---|
| Devin: `gemini-4-carbon`, `gemini-4-neon`, `gemini-4-hydrogen` and their raw effort uids | `8on22-bw` at 2048px | `8on22-bw` at 1568px |
| Factory Droid: `gemini-4-carbon` | `8on22-bw` at 2048px | `8on22-bw` at 1568px |
| Other Gemini defaults (Google, Vertex, OpenRouter; Neon and Hydrogen off Devin) | `8on22-bw` at 2048px | unchanged |

It is one rule in `classes/gemini.kdl`, inside the class-wide 2048px block. The same shape draws their opt-in `snapcompact.systemPrompt` and `snapcompact.toolResults` images, which can use more, smaller images.

Non-goals: other Gemini lines and hosts (not measured), and denser stretched-glyph layouts Carbon and Neon could read (they need a renderer change).

## Why

Measured 2026-11-20 to 22 on Devin, medium effort: 158 exact-answer questions on three real archives, each answer a string from the imaged middle, graded by script. Every layout re-renders the same stored text; plain text scored 1.000.

| Answered exactly right | 2048px (today) | 1568px | 1568px dense middle page | Identifiers, 2048 → 1568 | 1568 − 2048, paired, 95% CI |
|---|---|---|---|---|---|
| Hydrogen | .804 | .968–.978 | .883 | .60 → .94 | +.165 [+.111, +.218] |
| Neon | .902 | .981 | .965 | .71 → .96 | +.079 [+.044, +.117] |
| Carbon | .892 | .987 | .959 | .72 → .97 | +.095 [+.051, +.142] |

Each 1568 cell has 2 reps (316 answers), Carbon's 2048 cell 1 rep. An archive too long for its regular pages draws its middle on the dense companion (`8on16-bw`, 19,208 characters at 1568px), which costs Hydrogen about .10 and still scores above today's page for all three. The comparison changes pixels, density and glyph size together; Hydrogen needs about 14k characters per frame or fewer.

At real size, one 1.37M-character history laid out by omp's own compaction: Carbon at 1568px with the 80-image budget of the stacked follow-up (72 frames, 6 regular + 66 dense) scored .929 against stock 2048px with 60 (56 frames) at .812, +.117 [+.045, +.195]; neither dropped history, and Devin accepted both (~6.2 MB). For Factory the evidence is an earlier synthetic copy task on Carbon: dense identifier lines copied exactly .367 → .825.

**Cost:** uniform `8on22-bw` frames hold 1.7× more at 2048px, each still a flat ~1,090 tokens. In a synthetic compaction at a 300K trigger, Carbon at Devin's 60-frame budget kept 1.13M characters instead of 1.94M of 3.9M, and 1.14M of 1.54M it kept whole before. Neon and Hydrogen, both priced at 1,089 since #19883 and #20038, do the same.

## Testing

- `bun test packages/snapcompact/test/snapcompact.test.ts -t "Hydrogen's frames"`: renders one frame per model and host and decodes its PNG. Carbon, Neon and Hydrogen on Devin (logical ids and effort uids) and Carbon on Factory are 1568px wide; Carbon and Neon on Google and Neon on Factory 2048px. With the Neon or the Hydrogen ids removed from the rule, it fails (`Expected: 1568, Received: 2048`).
- `bun test packages/snapcompact/test/snapcompact.test.ts`: 124 pass; a configured `snapcompactShape` still wins over this rule. `bun test packages/catalog/test`: 1,421 pass.

---

- [ ] `bun check` passes: `main` itself fails its `oxfmt --check` (20 untouched files); catalog and snapcompact typecheck, oxlint and oxfmt on the changed files pass
- [x] Tested locally
- [x] CHANGELOG updated
