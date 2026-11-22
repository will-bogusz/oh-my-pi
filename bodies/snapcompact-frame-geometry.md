## What

I made a snapcompact archive's summary state every grid its frames use. When a long archive's middle uses a denser companion layout than its edge frames, the summary gave every frame the edge frames' row count, so a reader was told 71 rows on pages that have 98.

> **Snapcompact context.** Compaction draws old history into PNG frames and tells the reading model how to read them: the grid each frame is printed on, in characters wide and rows tall. When an archive's middle overflows, most layouts draw it on a denser companion to keep more history; doc and Silver layouts keep one grid.

| Reader (edge layout, frame edge) | Frames | Summary on `main` | With this PR |
|---|---|---|---|
| OpenAI (`8on22-bw`, 1568px) | 196×71 edges, 196×98 middle | "196 characters wide, up to 71 rows tall" | "196 characters wide, up to 71 rows tall, or 196 characters wide, up to 98 rows tall" |
| Gemini (`8on22-bw`, 2048px) | 256×93, 256×128 | "256 characters wide, up to 93 rows tall" | both grids |
| Claude Opus 4.7+ (`11on16-bw`, 1932px) | 175×120, 241×120 | "175 or 241 characters wide, up to 120 rows tall" (right: only the width changes) | both grids |

`compact()` collects the distinct grids of the rendered frames, and `snapcompact-summary.md` lists them. The old summary already listed every distinct width, so it was right whenever only widths differ (Claude). It gave one row count, the edge layout's, which is wrong for every `8on22-bw` reader, since its dense companion `8on16-bw` keeps the width and adds rows.

## Why

This line is the reader's only description of a page, and on a long archive's middle pages it was 27 rows (1568px) or 35 rows (2048px) short. A read-back study of Devin's Gemini readers found the mismatch; it did not measure how much the wrong description costs.

## Testing

- `bun test packages/snapcompact/test/snapcompact.test.ts -t "states"`: a 2048px reader's overflowing archive states both its grids, and an archive whose only frame is the dense middle states that grid alone, each checked against the frames' own `cols`×`rows`. On `main` both fail (`256x128` missing; `8x2` stated for an `8x4` frame). The three-HQ-edge test checks Claude's two widths, which `main` already stated right.
- `bun test packages/snapcompact`: 124 pass. The snapcompact suites in `coding-agent` pass except the two `agent-session-snapcompact-no-reduction` cases that fail on `main` too.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
