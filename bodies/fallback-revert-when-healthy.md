## What

I want usage-aware fallback to hand the session back once the primary has quota again, instead of paying for the bottom of the chain for the rest of the session.

With `retry.usageAwareFallback` on, a session whose primary reads depleted or in reserve moves down its fallback chain and stays there until `/model`. `retry.fallbackRevertPolicy: when-healthy` (opt-in) returns it at the next user prompt, once the request is assembled, when all hold:

| Rule | `when-healthy` |
|---|---|
| Cooldown | The primary's selector cooldown is over (same clock as `cooldown-expiry`, including the reported-reset suppression from #14757). |
| Usage | `health.model` reads the primary `healthy` with a 10-point band added to every account's reserve (new `reserveMarginFraction` health option in `ai`): the model returns once some account in its pool clears reserve + 10. Which account serves stays with pins, restrictions, priority, the ordinary reserve and the usage-aware preflight, as on every turn. |
| Context | The assembled request fits the primary's window under the primary's compaction policy, judged in pre-prompt maintenance (where context promotion already switches models) and counted in the primary's tokenizer too when it differs; it never compacts to go back. |
| Refusal | Classifier-refusal fallbacks never return on their own (#10206 unchanged). |
| Unknown usage | Error fallbacks return as under `cooldown-expiry`; usage fallbacks stay. A fallback ends only on the kind of evidence that started it. |

Replay (Factory Droid -> Devin -> OpenRouter, Factory exhausted 4 h, turns at 0-245 min): `main` serves all seven turns from OpenRouter; `when-healthy` serves the 245-minute turn from Factory. Defaults and advisors are unchanged.

## Why

The usage pin came with usage-aware fallback (`0bfb0bd1e3`, `db97103c32`): restoration returns early on any pin, so users keep usage-aware fallback off.

**Decision for maintainers:** allow usage-driven fallbacks to return to the primary, via an opt-in revert-policy value, with the default left as is.

- A band, not a timer: quota only falls between resets, so leaving at the reserve and returning above reserve + 10 allows one move each way per reset.
- Rejected: `cooldown-expiry` returning from usage pins (reverses `0bfb0bd1e3` for everyone); a margin setting; climbing the chain.
- Cost: a cold prompt cache on return; one cached usage read per prompt past cooldown; across tokenizers, one extra count in the primary's domain only once usage allows a return (tokenizer cached).
- Pin state keeps #14744's shape (`pinned` for usage, plus `refusalPinned`), so the two compose.
- Related: #5018, #8633.

Non-goal: cache warmth (#13106).

Reading order: `turn-recovery.ts`, `session-maintenance.ts`, `ai/src/auth/health.ts`.

## Testing

- Scenario tests drive usage and error fallbacks against a primary reading healthy, in the band, depleted, unknown or failing, with and without room for the context or prompt, and a refusal pin.
- `env -i HOME=$HOME PATH=$PATH bun test` in coding-agent on `agent-session-retry-fallback`, `agent-session-retry-cap`, `turn-recovery-replay-unsafe`, `sdk-model-selection`, `advisor-headless-fallback-drain`, `settings-layout`, `compaction-speculation`, `retry-fallback-tokenizer-domain`, `prefix-binding-tool-roster`, `agent-session-tool-rebuild-skip` (incl. a production-tokenizer subprocess): 450 pass. ai `auth-storage-model-usage-health`: 29 pass. `bun run check:ts` passes.
- Negative controls, one mutation per rule, each failing its test: refusal, usage pin, band, stored context, prompt, agent-start addition, primary's compaction policy, model switched mid-check, primary-domain recount, usage preflight off, unknown fallback window, unknown usage both ways, startup `pinned: true` under `cooldown-expiry`, advisors, `health.ts` margin.
- Not run: a live quota reset.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
