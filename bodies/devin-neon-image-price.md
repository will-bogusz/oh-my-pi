## What

Devin started serving Gemini 4 Neon this week and I noticed its snapcompact archives were capped much lower than Gemini 4 Carbon's on the same login, because omp was still guessing Neon's image price; I measured it and it bills the same flat 1,089 tokens as Carbon, so this marks it verified.

A compaction of 1.54M characters at a 300K-token trigger on `devin/gemini-4-neon` keeps 26 frames and drops 721K characters on `main`; with this PR it keeps 48 frames and drops nothing, the same as Carbon.

> **Snapcompact context.** Compaction draws old history into PNG frames and caps how many it keeps by what they will cost in tokens. A reader whose image price is `verified` in the catalog is charged that price per frame; any other reader is charged a 5,024-token planning estimate.

The change is one rule in `devin.kdl`: Neon's logical id and its four raw effort uids join Carbon's verified fixed-price list.

## Why

Devin bills Gemini images a fixed amount whatever their size. The catalog already says so for Gemini 3.7 Flash and 4 Carbon, each measured across sizes; Neon arrived after that measurement and fell back to the estimate.

Measured on Devin's own host, `gemini-4-neon` at low effort, billed input minus a no-image baseline:

| Check | Result |
|---|---|
| One image at 512, 1024, 1568, 1932×1920, 2048, 2576, 3072 and 4096 px | 1,092–1,095 tokens each |
| 0, 1, 2, 4, 8 snapcompact frames at 2048 px, 2 runs each | 1,091.0 ± 0.2 tokens per frame |
| Carbon, same two checks (earlier run) | 1,090–1,092 each; 1,091 per frame |

Decisions:
- **1,089, not 1,091.** It is the value the existing Devin Gemini rule carries and the one Carbon measured the same against; the two-token gap is under 0.2% of a frame.
- **Neon only.** 3.5/3.8 Flash and 4 Hydrogen/Argon stay on the unverified rule until each is measured across sizes, as the rule's comment already says.
- **An id list, not a class rule.** Neon shares its class rank with Argon and Hydrogen and has no family, the same reason Carbon is listed by id.

Maintenance cost: if Devin changes how it bills Gemini images, frame budgets drift from the bill. The size check above re-measures it in 19 requests, and the fix is this rule's `tokens`.

## Testing

- **Live billing**, the table above: 9 single-image requests and 10 frame requests through omp's Devin transport on `gemini-4-neon`.
- **Frames kept.** A real `session.compact()` over 280 turns (1.54M characters), 1M-token window, 300K trigger: `main`'s rules give Neon `plannedFrameTokens` 5,024, 26 frames, 720,896 characters dropped; this branch 1,089, 48 frames, 0 dropped. `gemini-4-neon-xhigh` (a raw effort uid) matches. Carbon is 48 frames and Hydrogen 26 on both.
- `bun test packages/catalog/test/image-tokenization.test.ts`: 24 pass. With `devin.kdl` reverted and `gen:compat` rerun, the Devin row fails (`tokens: 1120`, unverified) on `gemini-4-neon`.
- `check:types` for `packages/catalog` passes. `bun check` fails on `main` itself (`oxfmt --check` on 20 browser-relay and collab-web files), so its box stays unticked.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
