## What

I raised the image count for Gemini models on Devin's own host from 60 to 80 per request, so a snapcompact archive keeps up to 80 frames. With Gemini 4 Carbon on 1568px frames there, 60 frames cut the history an archive keeps by 26–42%; 80 gives back nearly all of it at 1.54M characters of history and about half at 3.98M.

> **Snapcompact context.** Compaction draws old history into PNG frames, capped by the host's image count. Devin bills Carbon a flat ~1,089 tokens per frame.

| History kept by Gemini 4 Carbon on Devin, 300K trigger (synthetic compaction) | 2048px, 60 images (before 1568) | 1568px, 60 images | 1568px, 80 images (this PR) |
|---|---|---|---|
| 1.54M chars of history | all (48 frames) | 1.14M (60 frames) | 1.52M (80 frames) |
| 3.98M chars of history | 1.94M (60 frames) | 1.13M (60 frames) | 1.52M (80 frames) |

Neon and Hydrogen get the same numbers: Devin's price for both is verified (#19883, #20038), so omp plans their frames at 1,089 tokens like Carbon's.

It is one rule in `providers/devin.kdl`: `official-image-count-budget 80` for the `gemini` class. Claude on Devin keeps its 20, other Devin models 60, a configured custom base URL 40.

Limits: an account whose sign-in reroutes chat to another server gets this host's budgets, here 80 Gemini images, on a server that wasn't measured, as it already gets 60 today.

Non-goals: going past 80, where snapcompact's own `MAX_FRAMES_DEFAULT` (80) binds as well.

## Why

Capacity has to come from the page count: no ~18k-character page read as well as the 1568px page on Hydrogen (.883–.902 against .978), so a denser page is not the way back to the lost history.

Devin relays Gemini's image rules, and Gemini counts images only against context (the probe behind #19619). Devin took 80 snapcompact frames of Hydrogen and Neon in one request (5.4 MB, about 104k input tokens) and 72 of Carbon (~6.2 MB). On one 1.37M-character history laid out by omp's own compaction, Carbon at 1568px with 80 images (72 frames, 6 regular + 66 dense) answered .929 of 77 exact questions right against stock 2048px with 60 images (56 frames) at .812, +.117 [+.045, +.195]; neither layout dropped history at that size.

At 1568px the image count and `MAX_FRAMES_DEFAULT` both bind at 80. The token share of the trigger does not, nor does the archive's 12 MB byte allowance, which plans 107 frames at 1568px (70 at 2048px).

**Cost:** a full archive is 80 frames of a flat ~1,089 tokens each instead of 60. Accuracy at 80 frames against 5 was checked on only 16 recent questions in one archive. Screenshots and imaged tool results share the 80, and the 24 MB byte budget still clamps them.

Related: #19619 (Devin's image limits), #19880 (frame shapes in KDL).

## Testing

- `bun test packages/coding-agent/test/agent-session-snapcompact-budget.test.ts -t "80 Gemini"`: a real compaction on Devin's own host archives 80 Carbon frames; with the rule reverted, 60.
- `provider-image-budget.test.ts`: Gemini on Devin keeps the newest 80 images, through a gateway 40, Claude 20; the Devin row fails with the rule reverted.
- `bun test packages/catalog/test` (1,421 pass) and `packages/snapcompact/test` (124 pass).

---

- [ ] `bun check` passes: `main` fails its own `oxfmt --check` on 20 untouched files; coding-agent typecheck, oxlint and oxfmt on the changed files pass
- [x] Tested locally
- [x] CHANGELOG updated
