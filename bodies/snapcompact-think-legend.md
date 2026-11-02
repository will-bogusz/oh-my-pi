## What

I'd like to explore the idea of snapcompact fallback when switching models, and generally exploring more cross model/provider switching behaviors. I have a feeling this is underexplored right now, and probably not optimized.

Follow-up to #17510: Claude received the reasoning in a snapcompact archive whose summary an extension wrote; on a real session copy, 13 of 13 reasoning sections sent → none.

> **Snapcompact context.** An archive keeps old turns, assistant reasoning included as `¶think:` sections, and replays them into every later request. Claude refuses requests that quote earlier reasoning (`reasoning_extraction`, #6093), so it reads a no-reasoning view of an archive rendered under another model.

| Reader of an archive whose summary has no `¶think:` legend | `main` | this PR |
|---|---|---|
| Claude, image input (`viewWithoutThinking`, swap and re-render gates) | archive sent as is, reasoning included | no-reasoning variant rendered and sent |
| Claude without image input (`viewWithoutFrames`) | archive text sent, reasoning included | archive text without `¶think:` sections |
| Models that may read reasoning (GPT, DeepSeek, GLM) | unchanged | unchanged |

## Why

Every "does this archive carry reasoning?" check asked the summary for the `¶think:` legend. The template writes it, but a summary written by anything else need not, while the archive's text still holds the sections. Codex raised it on #17510 ([thread](https://github.com/can1357/oh-my-pi/pull/17510#discussion_r4433499544)) after its round budget was spent.

`snapcompact.archiveIncludesThinking(summary, archive)` now answers it: the legend, or a real `¶think:` section in the archive's text (not a label inside tool output). Both views and both `SessionMaintenance` gates (`#summaryReplacements`, `#renderViewWithoutThinking`) use it; the summarizer in `compaction.ts` follows via `viewWithoutThinking`.

Decision: I check the text rather than always scrub, so an archive with no reasoning keeps its own summary and is not re-rendered. The session decides once per summary; one no archive backs is looked up again only after the branch changes.

An archive saved before #16282 has no whole source, so its tail may open inside a thought labelled in the imaged middle. A text-only reader without reasoning now skips those tail lines whatever the summary says, as `compact()` does. Non-goal: Claude with image input on such an archive keeps its frames: pixels cannot be checked, and failing closed would drop every Claude-rendered legacy archive's frames.

## Testing

A real GPT-6 session copy (13 `¶think:` sections in its archive, the summary's legend line removed to stand in for an extension's), resumed by this worktree's CLI in an isolated agent dir under a text-only `claude-haiku-5-5` custom model whose base URL is a local server recording the request:

| | `main` | this PR |
|---|---|---|
| Reasoning headings from the archive in the request | 13 of 13 | 0 of 13 |
| `¶think:` labels in the request | 13 | 0 |
| Archive middle text in the request | yes | yes |

The unmodified copy (legend kept) sends 0 of 13 on both.

- `snapcompact.test.ts`: `viewWithoutThinking` and `viewWithoutFrames` (framed and frameless) with a legendless summary, and a legacy archive's unscoped tail.
- `agent-session-snapcompact-reader.test.ts`: Claude with and without image input on an archive with an extension's summary, and repeated side requests that scan the archive and look up the branch once.

Each fails with its source change reverted.

```sh
bun test packages/snapcompact/test/snapcompact.test.ts packages/coding-agent/test/agent-session-snapcompact-reader.test.ts
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
