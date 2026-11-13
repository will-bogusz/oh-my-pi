## What

The Gain tab showed zero for me even though every one of my sessions compacts with snapcompact, because it only counted imaged tool results, so this adds snapcompact compactions as a second source.

Over the last 7 days of my sessions the tab goes from **"No savings recorded" → 58M tokens of context freed by 204 snapcompact compactions (61.2% of the context they started from)**.

<img width="3200" alt="The Gain tab on main shows no savings recorded for the last 7 days; with this PR it shows 58M tokens across 204 snapcompact compactions, a 61.2% reduction" src="https://github.com/user-attachments/assets/8653b8d5-67a0-4b64-98f3-03ebeacf3bdc" />

| Gain tab | `main` | This PR |
|---|---|---|
| Sources | Imaged tool results only (`snapcompact.toolResults`, experimental, default off) | Imaged tool results **and** snapcompact compactions |
| Compaction | never counted | context each one freed: `tokensBefore − tokensAfter` |
| Reduction | always `–` | known for compactions: freed ÷ `tokensBefore` |
| History | n/a | transcripts written since 2026-08-20 are re-parsed once |

Reading order: `parser.ts` `extractSnapcompactCompaction` → `db.ts` (`snapcompact_compactions`, the compaction block in `applySessionParseResults`, `reparseModifiedSince`, the renamed `backfillSpotlight`) → `gain-aggregator.ts` → `GainRoute.tsx`.

## Why

The tab's only input is `snapcompact-savings.jsonl`, written only while tool-result imaging is on. Compaction is where most sessions meet snapcompact, and every compaction entry already persists `method`, `tokensBefore` and `tokensAfter`: the before → after the transcript divider shows.

Decisions:
- **Read the compaction entries the sync already parses**, not a new journal line: a journal would count only compactions made by new builds, while the entries carry history back to 2026-08-20.
- **One row per compaction, saved = max(0, before − after).** Each delta is measured against the context just before it, so repeated compactions are not double counted. Forks use the fork guard every ingest table uses; a parent that drops an entry hands it to the fork that still holds it.
- **Only `method: "snapcompact"`.** Other methods are not snapcompact savings.
- **The figure is context freed, not pure compression.** It includes history snapcompact trims when the frame budget is full, as the divider's figure does.
- **Each "By source" row names its subsystem**, so the table stays a list of savings per subsystem.

Non-goals: a dollar figure, imaged system prompts (not journaled today), and local-day buckets and raw project folder names, which affect every tab.

Known limits, both shared with the Spotlight tables: an older omp build that syncs between this build's first init and first sync re-reads those transcripts without the new rows, and `omp gc` does not remove an archived session's rows.

## Testing

- Real sessions: synced the 1,284 transcripts I modified in the last 7 days into a scratch `stats.db` and opened this branch's dashboard on it (image above; `main` shows the empty state for the same window).
- `gain-aggregator.test.ts`: a parent and a fork both carry one snapcompact and one `soft` compaction. It asserts 600 saved once, the soft one ignored, a 0.6 reduction and project scoping; 500 after the parent's `tokensAfter` is rewritten in place; 600 again, from the fork, after the parent drops the entry. Removing the stale-row delete fails it.
- `bun run check` in `packages/stats` passes. `bun test` there: one failure in `db-cost.test.ts` that fails the same way on `main`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
