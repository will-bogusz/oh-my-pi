## What

I kept getting this on snapcompact for a session that already had an archive, shown twice, even though the new archive would have shrunk the context, so this counts the old archive in the comparison and makes the failure one message that says what to run instead.

In an offline replay of the session that hit it (a 35-frame archive, ~280K local tokens), `/compact snapcompact` went from refusing to committing a 27-frame archive (~149K).

| | `main` | this PR |
|---|---|---|
| Snapcompact on a session that already holds an archive (`/compact snapcompact`, idle, pre-prompt) | refused as "would not reduce context" whenever the new archive costs more than the turns since the last compaction | committed when it is smaller than the old archive plus those turns |
| A refused `/compact snapcompact` | `⚠ compaction: snapcompact would not reduce context.` then `✕ Compaction failed: snapcompact would not reduce context locally.` | `✕ Compaction failed: snapcompact would not reduce context. Run /compact to fall back to remote compaction.` (the next method plain `/compact` would run, from `compaction.methodOrder`) |
| Plain `/compact` falling past snapcompact | `snapcompact compaction failed; trying the next preferred method` plus the reason as a second notice | one notice: `snapcompact compaction failed (snapcompact would not reduce context); trying the next preferred method` |

Reading order: `SessionMaintenance#projectPreSnapcompactContextTokens` (the baseline), `#contextBuildOptions` and `SessionManager.resolveFrameData` (blob frames), then the manual blockers in `compact()`.

## Why

A new snapcompact archive re-renders the previous one, so it replaces that archive plus the turns after it. The no-reduction baseline was built from the compaction preparation's messages, which never include the previous compaction's summary message, so the old frames were missing from the baseline but present in the projection. The baseline now counts the live context's standing summary, keeping both sides local and encrypted-reasoning-excluded (#10023, #10716). Idle passes no trigger figure and pre-prompt nets the stored estimate out, so both fell back on the same baseline.

Idle also runs a second check against a rebuild of the whole branch. A resumed session keeps archive frames as blob references that only the session manager resolves, and that rebuild passed no resolver, so the old archive priced as missing frames there too. The three maintenance rebuilds now resolve frames as the live context does.

Decision: `runIdleCompaction` still passes no `triggerContextTokens`; with the baseline counting the archive, the fallback is right on its own, and the second fix was needed either way.

Each manual blocker emitted a warning and then threw, and the thrown error is shown again as `Compaction failed: …`. Blockers now only throw; RPC's `manual_compaction_end.errorMessage` and ACP's `/compact` output carry the same message. Non-goal: the automatic path's notices, which already show once.

## Testing

- Replayed a copy of the affected session offline (mock auth, no model calls): on `main`, `/compact snapcompact` and idle compaction both refuse with the two messages above; on this branch both commit, 35 → 27 frames.
- `bun test test/agent-session-snapcompact-no-reduction.test.ts` (coding-agent): a resumed session with a 10-frame blob-backed archive commits a 6-frame archive through `/compact snapcompact` (also with context notes ahead of the archive), idle and pre-prompt compaction, and still rejects a 12-frame one. Against `main`'s source the commit cases fail; with only the resolver removed, idle and pre-prompt fail; the fallback-notice case fails without the second commit.
- Focused coding-agent compaction suites pass, except two tests in that file that also fail on `main` (`claude-haiku-5-5`'s window is now 1M, not 100K). `bun check` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
