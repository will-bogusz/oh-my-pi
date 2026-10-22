## What

I fixed the advisor's quota comments and docs because the status comment says a quota-paused advisor retries on its own after a cooldown, and nothing but a reset ever clears that pause.

Three places now say the same thing: a `quota_exhausted` advisor stays paused, its batch kept, until its runtime is reset or rebuilt, and no timer resumes it.

| Where | Said | Now |
|---|---|---|
| `AdvisorRuntimeStatus` doc (`advisor/config.ts`) | "the runtime auto-retries after a cooldown so it can resume without user action" | stays paused until reset or rebuilt (history rewrite, session switch, `/advisor` rebuild, config reload, restart); no timer resumes it |
| `#quotaExhausted` doc (`advisor/runtime.ts`) | cleared by "`/new`, config rebuild, or session restart" | cleared by a history rewrite, session switch, rebuild, or restart |
| `docs/advisor-watchdog.md` | resumes when `/advisor` rebuilds it, config reloads, a new session starts, or the process restarts | adds compaction and other history rewrites and session switches, and says no timer resumes it |

Comments and docs only; no behaviour changes.

## Why

Only `AdvisorRuntime.reset()` clears the quota latch. Besides `/new`, an `/advisor` rebuild, a config reload and a restart, these call it:

- every in-conversation history rewrite (`#resetAllAdvisorRuntimes`): compaction, compaction rescue, drop-images and shake;
- a session switch or resume (`resetSessionState`).

Short cooldown waits do happen, but before the latch: host recovery may wait out a bounded usage-limit window and retry. Once recovery gives up and the latch sets, nothing on a timer clears it, which the `#quotaExhausted` doc already argues for (quota windows of 5 h or 7 d outlast any sensible timer). A reader of the status comment would expect a stalled advisor to come back by itself.

## Testing

- Each reset path above was traced to `runtime.reset()` at `origin/main`; the latch is set only in the `AIError.isUsageLimit` branch after the host recovery hook declines.
- `bun run check` in `packages/coding-agent` passes.
- No test added: nothing executes differently.

---

- [x] `bun check` passes
- [ ] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
