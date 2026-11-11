## What

I want large conversations to stop spending full model turns checking whether a worker is still running.

This proposal changes the first empty-wait window from 5 seconds to 60 seconds when the latest request carried more than 100,000 prompt tokens (input + cache read + cache write). Smaller conversations retain the current start; a continuing idle streak still climbs one rung per call and resets on news or a minute away.

Completed jobs and direct messages still wake `wait` immediately: `WaitTool.#blockUntilWake` races those events against the idle timer. The tradeoff is waiting longer to reconsider when **nothing happens**, not delaying a short job's result. The progress reminder still starts on the second consecutive empty wait.

## Why

In a blind delegation experiment with a 186k-token main conversation and eight local web fixtures, the main made about four `wait` calls per handoff while workers ran for 60–300 seconds. Each poll was another full-context request.

| Measured observation | Result |
| --- | --- |
| Opus 5.5 | 159 waits / 40 handoffs |
| Sol 6.1 | 3.6–4.3 waits / handoff |
| Haiku 5.5 | 88 waits / 24 handoffs |
| Last 30 days, Claude idle returns | 6,443, including 6,258 above 100k tokens |
| Cache reread by those idle returns | 1.99 billion tokens |
| Idle returns on 5s, 10s, 30s rungs | 74% |

**Maintainer decision:** is this context-dependent default worth the longer idle reconsideration window? This is a cost-per-empty-turn heuristic, not a model-family property. The alternative is to preserve the default or make policy configurable; this proposal deliberately adds no settings and does not change job-based reset semantics. Related: #12111, #18862, #17889.

<details>
<summary>Measurement detail</summary>

At the measured Opus prices ($0.20/M cache read, $20/M output), a 186k-token poll was about 9.3k cache-read-weighted units. Polls accounted for about 77k units, alongside 88k worker units per delegated run. In 12 guidance-only runs where the main ended its turn rather than calling `wait`, it made no wait calls; that is an alternative workflow, not a measured result of this patch.

The session scan selected Claude calls to `wait` whose result contained `No job finished within` over 30 days. Average prompt across waits was 298k tokens; idle returns by early rung were 2,316 at 5s, 1,395 at 10s and 1,032 at 30s. These are observed baseline costs, not a claimed post-patch saving.

</details>

## Testing

On bench-mac with a native addon rebuilt from this source: `bun test packages/coding-agent/test/tools/wait.test.ts` passed **45 tests, 0 failures, 136 assertions**; `bun run --cwd packages/coding-agent check:types` reported **no type errors in 4,901 files**.

The fake-timer test drives the real wait path at 100,000 and 100,001 tokens, checking the start, climb, resets and reminder; existing tests exercise event wakes. Replacing `wait.ts` with `origin/main` made the large-context test fail at its first timing assertion.

No model-behavior improvement is claimed: the measured experiment above is the motivation, not a main-versus-patch benchmark. Full `bun check` was not run; checks ran off the contributor's Mac.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (added after PR creation)
