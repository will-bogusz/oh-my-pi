## What

<!-- Will: confirm own-words -->
When omp moves my session to another Claude or Codex account, I want to see which rule did it, instead of asking an agent to dig through the session file.

| Surface | `main` | This PR |
|---|---|---|
| TUI | Nothing; the next turn just pays a full prompt-cache write on the other account | Status line `anthropic account: a@example.com -> b@example.com (reserve)` |
| Log | Nothing at any level | One info line `Session OAuth account switched` with provider, model, from, to, reason |
| RPC | Nothing | `account_switched` event (`provider`, `model`, `from?`, `to`, `reason?`) |
| `AuthStorage.sessions.sticky()` | The serving credential | Also `switchReason` |

Each fires once per change of account, never on a session's first account.

<details><summary>Reasons</summary>

`blocked` (rate-limited or out of usage), `cold` (idle past the cache window, so the pool re-ranked), `reserve`, `allowance-spent`, `reclaim` (`reclaimAbovePct`), `plan` (its plan or discovered models lack the requested model), `unavailable` (removed, token rejected or unrefreshable), `released` (usage-aware fallback), `pinned` (the user picked another account). A move none of these explains carries no reason rather than a guess.

</details>

## Why

Model fallbacks already say why (`retry_fallback_applied.reason`); an account switch leaves only a new `credential_pin` hash. A switch costs a full cache write, and explaining one today means reconstructing usage, blocks and policies after the fact.

Decisions:
- **Reason computed only on a change.** `resolveOAuth` compares the resolved credential id with the session's pin and only on a mismatch works out which rule fired, judging the eviction policies against the account that actually served (after a dead grant fails over, that is not the one ranking picked). Routing is unchanged.
- **Reported at turn end, where `credential_pin` is already written:** one event per account change, even when retries move the session twice in a turn.
- **Account labels, not credential ids,** in the event and the log: they are what `/session` and the status line already show. The log could carry ids only instead (one line to change).
- **A typed event, not a `notice`,** so RPC hosts can act on the reason, like `retry_fallback_applied`.

Not in this PR: subagents in worker threads report the switch without a reason (the remote auth seam does not expose `sessions.sticky`); `omp usage` history of switches.

Related: #19312 logs every multi-account resolve at debug level with its source (sticky, usage ranking, pool order); this records only changes, names the eviction rule, and surfaces it at info level and as an event. #13278 proposes a structured log for every selection.

## Testing

- `packages/ai`: `bun test test/auth-storage-account-reclaim.test.ts`, five new cases on a real `AuthStorage` with a SQLite store: reserve then reclaim on one warm session, a blocked pin, a pin gone cold after two idle hours, a user pin, a usage-aware release, a model discovered only on the other account, a transient refresh failure, and a dead grant on the reclaiming account that fails over to a third. 18 pass; with the `src` change reverted the new cases fail.
- `packages/coding-agent`: `bun test test/credential-pin.test.ts`: the first pin reports nothing, a pin to the other account reports `{from: a@…, to: b@…, reason: "pinned"}`. 10 pass; fails with the change reverted.
- Neighbouring suites: `packages/ai` auth suites (`auth-storage*`, `auth-retry*`, `claude-block-healing*`, `credential*`, `openai-codex*`) 856 pass; `packages/coding-agent` `test/rpc-wire`, `test/rpc`, `sdk-subagent-auth-inheritance` pass except one Fireworks fast-mode RPC test that fails on `main` too.
- `bun run check:types` in both packages; `bun run gen:rpc` regenerated the wire schema and SDKs.
- Not run: a live session switching accounts in the TUI, which needs two subscriptions and a real limit mid-session.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
