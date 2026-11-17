## What

When my shared weekly Claude limit ran out, a Fable 429 left that account blocked for Fable for two more days even after `/usage` showed the weekly window had room again, so Fable requests on my other account had nowhere to fail over to; this lets the same usage report that lifts the account-wide block lift the Fable one too.

A Fable or Mythos 429 can come from the shared weekly window rather than the Fable meter; omp then stores a `tier:fable` block ending at that window's reset. When `/usage` returns only the weekly window (no 5-hour row, no marker saying none runs), `main` lifts the account-wide block if the window has room and its reset matches the stored deadline (#19090), but never offered the tier scope, so the Fable block held until its clock ran out.

| On a report carrying only the shared weekly window, with room | `main` | This PR |
|---|---|---|
| Account-wide block whose deadline is that window's reset | lifted | lifted |
| `tier:fable` / `tier:mythos` block with the same deadline, Fable row has room | kept until the deadline (days) | lifted |
| Same tier block, Fable row exhausted | kept | kept |
| Tier block whose deadline doesn't match that window's reset (the 5-hour wall may hold it) | kept | kept |

## Why

In a pool of two Claude accounts, one hit its shared weekly limit with Fable at 80%. Its account-wide and Fable blocks got the same deadline, the weekly reset two days out. Hours later the weekly window recovered; a single-window report lifted the account-wide block and the Fable block stayed, so the other account's next Fable 429 found no free sibling.

The tier scope keeps the account-wide scope's guards: only a shared window's reset is matched against the deadline (60 s tolerance), a report from rate-limit headers never heals, and the tier's own weekly row must have room. A block from the missing 5-hour window has that window's deadline and won't match; where the Fable meter resets with the weekly window, its own row decides.

Decision: writing the account-wide block instead when the report at 429 time shows the shared window spent would change which scope a 429 writes and need the report inside `blockScope`; matching the deadline is the smaller change. Only `claudeRankingStrategy.healableBlockScopes` changes.

Non-goals: reports with no shared window or with both behave as on `main`; complete reports already heal tier blocks.

Related: #10978, #13348.

## Testing

- Regression test in `packages/ai/test/claude-block-healing.test.ts`: a `tier:fable` block whose deadline is the weekly reset, and a report with only that window (40%) and Fable at 80%. A Fable request now selects that account and the block is cleared. On `main` the test fails (`access-2` is selected and the block stays).
- Boundary: the same tier block stays when that report shows the Fable row exhausted, or comes from rate-limit headers (fails if the tier scope drops the headers guard). The existing "keeps the block when the report omits a shared gate" test (deadline not matching) still passes.
- `bun test test/claude-block-healing.test.ts` (35 pass, 1 fail with the `claude.ts` change reverted) plus the Claude reset, fable-fallback, model-usage-health, ratelimit-headers, usage-endpoint and block-persistence tests (141 pass in all), `bun run check:types` in `packages/ai`, oxlint and oxfmt on the changed files.
- Not run: a live 429 against a real account; it needs a spent shared weekly window.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
