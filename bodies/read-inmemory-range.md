## What

Reading a line range of a remote file over `ssh://` kept handing me the line *above* the range plus a "continue" hint that re-read the same page, so in-memory range reads now start at the requested line whenever that context line would fill the budget.

Replaying 338 recorded `ssh://` range reads against the same files: 2 looping pages on `main`, 0 with this PR; the only other change is the limit figure in 5 byte-limit notices.

`ssh://`, URL line selectors and other in-memory reads (agent://, history://, notebooks, archive members) render through `buildInMemoryTextResult`, which adds one leading context line to a range and then cuts the page at 50KB; the cut can land on that line:

```text
read ssh://bench-mac/…/mcp.jsonl:71-73        (line 70 is 49.9KB)

main:     70:{"epoch": 1791343795.669357, …49.9KB…}
          [Showing lines 70-70 of 73 (49.9KB limit). Use :71 to continue]   ← :71 widens to 70 again
this PR:  71:{"epoch": 1791343795.7558022, …}
          72:{"epoch": 1791343803.443153, …}
          73:{"epoch": 1791343803.494538, …}

read ssh://bench-mac/…/stdout.txt:4-6         (line 4 alone is 87.7KB)

main:     3:8c3b12ac…  Phase5InputSources
          [Showing lines 3-3 of 6 (137B limit). Use :4 to continue]         ← same loop
this PR:  [Line 4 is 87.7KB, exceeds 50.0KB limit. …]
```

The same notice also printed the bytes shown as its "(N limit)" figure (137B, 49.9KB); it now prints the 50KB budget.

## Why

The leading context line catches an anchor one line above the range; it should never cost the range. When the budget stops at or inside it, or it alone exceeds the budget, the read now re-slices from the requested start. Pages whose requested start already fits are unchanged, and `:raw` reads never add context.

Decision: the local streaming path answers this case with a notice pointing at `:raw:N-N` and "widen the requested range to increase the budget". In-memory reads have a fixed 50KB budget, so widening does not help, and the whole text is already in memory, so dropping the context line returns the asked-for lines in the same call.

Non-goals: the oversized-first-line branch (open #16024 rewrites its "0B" stat) and a column cap for in-memory reads (URL and agent:// pages carry long prose lines a 768-char cap would cut).

## Testing

- `test/tools/read-in-memory-range.test.ts` drives `ReadTool` through a remote-backed handler: a context line that fills the budget, one that alone exceeds it, one that still fits (context kept), and the limit figure of a byte-truncated page. With the `read-format.ts` change reverted, three fail; the "still fits" case passes on both.
- Replays, each file fetched once and read by `main` and this PR:

| Replay | Reads | Requested start silently missing | Looping `Use :N` | Wrong limit figure | Pages changed beyond the limit figure |
|---|---|---|---|---|---|
| Recorded `ssh://` range reads (12 sessions) | 338 | 2 → 0 | 2 → 0 | 7 → 0 | 2 |
| Synthetic: code / JSONL with 5% wide lines / 30% wide blobs | 900 | 65 → 0 | 42 → 0 | 386 → 0 | 65 |

Every changed page shows the requested start, or names it (`[Line N is …]`) when that line alone exceeds 50KB; pages whose requested start fit on `main` are identical apart from the limit figure.

- `packages/coding-agent` read suites (507 tests) pass; its `bun run check` is clean.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
