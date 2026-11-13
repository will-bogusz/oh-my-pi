## What

I want the stats dashboard to pick up what my running sessions write within a second, since on my Mac it sat up to five minutes behind while the Live chip said "just now".

On macOS, a request from a running session reached `omp stats` up to 5 min later (the next full resync) → about 0.4 s later.

| Held-open writer, 10 entries 1 s apart | `main` | This PR |
|---|---|---|
| Rows in `stats.db` within 15 s | 1 / 10 (the file creation's event) | 10 / 10 |
| Lag per row | until the 5-min resync | 337–383 ms |
| 40 real transcripts being written, ~1 min in | every one 51–85 s behind | 0 s (only appends from the last second pending) |

**Cost:** about 2 µs of CPU per tracked transcript per poll. Idle server CPU over 120 s: 0.47% of a core with 2,000 transcripts all touched today, 0.09% with 150 (about a day of my sessions), against 0.07% on `main`, which does no per-file work while idle.

## Why

The coding agent opens each session file once and appends through that descriptor. On macOS, Bun's recursive `fs.watch` reports no event for those writes (10 writes, 0 events; one when the file closes). Live ingest only re-synced files the watcher named, so running sessions waited for the 5-minute full sync, while the Live chip read "just now" because syncing any new file moved `lastSyncedAt`.

Live ingest now polls for appends:

- Once a second it stats the transcripts modified in the last 24 h and syncs those whose size or mtime moved.
- Each full sync adds the recent transcripts it stored to that set, with the stored size and mtime as the baseline.
- The watcher only adds new and rewritten files to the set; the 800 ms debounce is gone.
- Every targeted sync now comes from a poll, so `lastSyncedAt` moves only when a full sync or the ingest of changed transcripts finishes.

Decisions:

- Polling every transcript: rejected, listing and statting 11,500 files costs 0.75–1.1 s of CPU per pass; the 24 h set was 142 files here.
- A session resumed after a day idle is picked up by the next full sync (up to 5 min), then polled.

Non-goal: Spotlight rebuilds on every data-version bump, so an open Spotlight tab now rebuilds as often as it already did on Linux. That rebuild cost is a separate fix.

Related: #16729 (headless live ingestion runs on this same loop).

## Testing

- `bun test packages/stats/test/live-external-writes.test.ts`: the new case starts with no sessions directory (so no watcher), ingests two transcripts, makes one unreadable, appends to the other and advances fake timers one poll. It times out with the `src` changes reverted, and the poll throws `EACCES` without its per-file catch.
- `bun test packages/stats`: 240 pass, 1 fail (`db-cost.test.ts`, failing on `main` too); `bun run check` passes.
- Live on an isolated config, server from `main` and from this branch with the event stream open: a writer appending through one held-open descriptor (table above); 40 of my active transcripts hard-linked in, lag = file mtime minus stored cursor mtime; idle CPU from `ps` over 120 s.
- Not run: Linux and Windows. Linux's inotify reports every `write(2)` as `IN_MODIFY`, so the watcher already saw these appends there; the poll is the same code on every platform.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
