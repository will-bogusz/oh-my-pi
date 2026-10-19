## What

When the numbered view cuts a long line, agents reach for `path:N:raw` to see that one line whole, and got a full page from line N instead, so I made a bare `N` next to `:raw` mean just that line.

Replaying 61 recorded `:N:raw` reads on files still on disk: main returned 1,048,381 characters with line N alone in 1 of 61; this PR returns 108,294 characters, line N alone in 61 of 61.

| Selector | main | this PR |
|---|---|---|
| `path:17:raw`, `path:raw:17` | lines 17 to the end of the page (up to 300 lines / 50 KB) | line 17 |
| `path:17-:raw` | lines 17 onward | unchanged |
| `path:17` (numbered) | lines 17 onward | unchanged |
| `path:19,59:raw` | lines 19 and 59 | unchanged |

The read tool prompt, changed:

> combine :2-4:raw or :raw:2-4 for exactly those lines**; beside :raw a bare number is that one line (:17:raw), :17-:raw runs on**.

## Why

A lone `:50` means "from line 50", which is right for paging. Inside a comma list a bare number is already one line (PR 12970), and the prompt says "only :raw stays exact" and "individual lines (:19,59)". So `:N:raw` read as "line N" to agents and to the docs, while the parser read it as "from N". In recorded sessions since 10-01 there were 246 such reads; 210 named a single line in their intent ("Reading full line 151"), and together they returned 4.25M characters where line N was 0.79M. Agents also wrote 163 `:N-N:raw` reads to get the one line.

Who relied on "from N": 19 of 246 reads (7.7%) either followed a `Use :N to continue` hint (2), described several lines (6), or later edited text from past line N without another read (11). Each now needs `:N-:raw` or one more read; the page footer still says where the next line is. Of 126 raw reads that followed a continuation hint, 123 already wrote `:N-M:raw`.

Decisions:
- The rule is in `parseLineRanges` (a `BareLineMode` argument), so `read`, URL reads (`parseReadUrlTarget`) and `grep`'s range filter on internal and web URLs (`selectorLineRanges`) agree; `grep` on a plain file still rejects `:raw`. Making every lone `:N` one line was rejected: it breaks paging for the numbered view, which the continuation footers rely on.
- Cursor's exec bridge inserts `raw` in front of a range already in the path (`cursorRawReadPath`); it now writes a bare `N` there as `N-`, so that path reads what it read before.

Non-goals: continuation footers keep `Use :N to continue`.

## Testing

- New tests: a raw bare line through `ReadTool` (both orders, plus `:58-:raw` open-ended), `parseReadUrlTarget`, `selectorLineRanges`, and `cursorRawReadPath`. With the source changes reverted all four fail; with them, the read, grep, fetch and cursor suites pass apart from 6 failures that fail identically on `main` (bash auto-background and two others).
- `grep` on an artifact with matches on lines 17-20: `artifact://N:17:raw` matched lines 17-20 on `main` and line 17 here; `:17-:raw` and `:17` match 17-20 on both.
- Replay above: a scratch script runs each recorded path through `ReadTool` on a `main` checkout and on this branch and compares the text with line N of the file.
- `bun run check` in `packages/tui`, `packages/ai`, `packages/coding-agent`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
