## What

I gave DeepSeek V4.1 Flash its snapcompact archive as plain text instead of image frames, because it can barely read the frames.

Recall on real archived transcripts: F1 .535 → .919 (300 paired questions).

Snapcompact archives older history as frames of 8px text. DeepSeek V4.1 Flash bills images by area (~1,690 px² per token) and cannot resolve 8px glyphs: it copied 7% of the characters on today's frames. omp already sends a model without image input the archive's kept text instead; a new catalog rule, `snapcompact-text-archive`, sends DeepSeek V4.1 Flash the same view.

| DeepSeek V4.1 Flash | Before | Now |
|---|---|---|
| Archive it reads | `8on22-bw` frames at 1568px | the archive's kept text |
| Its own snapcompact pass | frames priced as images (~996 tokens each) | each frame priced as the text it holds (~4k tokens), and the result judged by that text |
| Screenshots, `read` images, pasted images | images | unchanged |

Reading order: `axes.ts`, `classes/deepseek.kdl`, `readerTakesArchiveText`; in `session-maintenance.ts`, `archiveReader`, `snapcompactFrameCost`, `#projectSnapcompactContextTokens`, `#textView`.

Non-goals: other DeepSeek lines; snapcompact's opt-in imaging of tool results; a frame layout DeepSeek reads (the best costs text's tokens, below).

## Why

Measured 2026-11-17 on opencode-go, low effort (OpenRouter billed and ranked the same); input tokens per 40k-character transcript chunk.

| Archive as | input tokens | QA F1 | strict recall | exact copy |
|---|---|---|---|---|
| text | 10,284 | .919 | .940 | 1.000 |
| 16x26 cells at 1092px | 10,529 | .908 | .873 | .675 |
| 12x20 cells at 546px | 7,210 | .864 | .747 | .425 |
| `8on22-bw` at 1568px (today) | 3,658 | .535 | .247 | .000 |

Frames also tripled output tokens, and at high effort 21 of 36 frame reads ran out of output or looped in thinking (3 of 36 at low).

Decisions:
- A boolean rule, scoped to the classified V4.1 Flash revision on every host (68 bundled rows; `-1017` snapshots, DeepSeek's `deepseek-flash` and Devin's `deepseek-v4-1-flash` too): the limit is the model's vision encoder, not the host.
- The switch reuses the no-image-input path: model switches, side requests and the text budget (60% of the threshold) work as for text-only models.
- When DeepSeek compacts, snapcompact still stores frames for a later frame reader (rejected: a frameless archive, which would leave it none). Pricing each frame as its text sizes the kept source to the room under the trigger; the image-count and byte caps are unchanged.

Maintenance: later DeepSeek lines are measured on their own.

## Testing

- Live, opencode-go at low effort: 60 archived turns with a codename in the middle, snapcompact `/compact` at a 40k threshold, then a question about it: this branch sent no images and 60k characters of archive text, the base its 5 frames; both answered `ZEBRA-4417`.
- `agent-session-snapcompact-reader.test.ts`: after a switch from GPT, DeepSeek V4.1 Flash gets the archive's text and only the user's image; its own `/compact` with a ~40k-token kept turn lands under 60% of a 100k threshold in one render, 54.8k as read (sizing reverted: 64.5k); a render forced past that plan is cut back by text, not to one frame; its first `/compact` after a resume commits (judged as frames: no reduction).
- `agent-session-snapcompact-frame-dead-end.test.ts`: the dead-end rebuild prices frames as text (4 where image pricing allows 5). Each sizing line, reverted alone, fails one of these tests.
- Snapcompact suites in `coding-agent`, `snapcompact` and `catalog` pass except two `snapcompact-no-reduction` cases that fail on the base too.

---

- [x] `bun check` passes (catalog, snapcompact and coding-agent typecheck, oxlint, oxfmt)
- [x] Tested locally
- [x] CHANGELOG updated
