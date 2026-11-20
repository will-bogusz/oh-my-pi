## What

I raised the image count for Gemini models on Devin's own host from 60 to 80 per request, so a snapcompact archive keeps up to 80 frames. With Gemini 4 Carbon on 1568px frames there, 60 frames cut the history an archive keeps by 26–42%; 80 gives back nearly all of it at 1.54M characters of history and about half at 3.98M.

> **Snapcompact context.** Compaction draws old history into PNG frames, capped by the host's image count. Devin bills Carbon a flat ~1,089 tokens per frame.

| History kept by Gemini 4 Carbon on Devin, 300K trigger (synthetic compaction) | 2048px, 60 images (before 1568) | 1568px, 60 images | 1568px, 80 images (this PR) |
|---|---|---|---|
| 1.54M chars of history | all (48 frames) | 1.14M (60 frames) | 1.52M (80 frames) |
| 3.98M chars of history | 1.94M (60 frames) | 1.13M (60 frames) | 1.52M (80 frames) |

Neon and Hydrogen get the same numbers once Devin's price for them is verified (a scratch merge with #19883 and the Hydrogen measurement). Until then omp plans their frames at a 5,024-token estimate and they stop at 26 frames either way.

It is one rule in `providers/devin.kdl`: `official-image-count-budget 80` for the `gemini` class. Claude on Devin keeps its 20, other Devin models 60, a configured custom base URL 40. Like the existing 60, the official budget follows the configured URL, so it also applies when Devin's sign-in reroutes chat to another server; the byte budget and request limit apply there unchanged.

Non-goals: going past 80, where snapcompact's own `MAX_FRAMES_DEFAULT` (80) binds as well.

## Why

Devin relays Gemini's image rules, and Gemini counts images only against context (the probe behind #19619). On 2026-11-20 Devin took 80 snapcompact frames of Gemini 4 Hydrogen and Neon in one request: 5.4 MB, about 104k input tokens.

At 1568px the image count and `MAX_FRAMES_DEFAULT` both bind at 80. The token share of the trigger does not, nor does the archive's 12 MB byte allowance, which plans 107 frames at 1568px (70 at 2048px).

**Cost:** a full archive is 80 × 1,089 = 87k tokens of frames per request instead of 65k. Accuracy at 80 frames was checked on only 16 recent questions in one archive. Screenshots and imaged tool results share the 80, and the 24 MB byte budget still clamps them.

Related: #19619 (Devin's image limits), #19880 (frame shapes in KDL).

## Testing

- `bun test packages/coding-agent/test/agent-session-snapcompact-budget.test.ts -t "80 Gemini"`: a real compaction on Devin's own host archives 80 Carbon frames; with the rule reverted, 60.
- `provider-image-budget.test.ts`: Gemini on Devin keeps the newest 80 images, through a gateway 40, Claude 20; the Devin row fails with the rule reverted.
- `bun test packages/catalog/test` (1,421 pass) and `packages/snapcompact/test` (124 pass).

---

- [ ] `bun check` passes: `main` fails its own `oxfmt --check` on 20 untouched files; coding-agent typecheck, oxlint and oxfmt on the changed files pass
- [x] Tested locally
- [x] CHANGELOG updated
