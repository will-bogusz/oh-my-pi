## What

I gave Opus 5.5 on Factory the same refusal fallback to Opus 5 that Fable already has, and stopped offering any fallback model the account can't actually use.

On Factory Droid, an Opus 5.5 turn served by Anthropic now carries Opus 5 as its fallback, as the droid CLI does, and a Claude turn never offers a fallback model your organization's model policy removed from your Factory model list.

> **Factory context.** A refusal fallback is a model id in the request's `fallbacks` field: when the model refuses, Anthropic answers with the fallback model in the same turn. Factory sends it only on its first-party Anthropic upstream.

| Factory model, Anthropic upstream | `main` | this PR |
|---|---|---|
| Opus 5.5 | no fallback | `fallbacks: [claude-opus-5]` |
| Opus 5.5 Fast Mode | no fallback | no fallback (unchanged) |
| Fable 5 / 5.1, Opus 5 on the account's list | `[claude-opus-5]` | `[claude-opus-5]` (unchanged) |
| Fable 5 / 5.1, org policy blocks Opus 5 | `[claude-opus-5]` | no fallback |

<details><summary>Reading order</summary>

- `rules/providers/factory-droid.kdl`: Opus 5.5 joins the Fable block whose `on-upstream "anthropic"` sets `server-side-fallback-models`.
- `discovery/factory-droid.ts` `withAvailableRefusalFallbacks`: after the offline seed and live discovery build the account's models, each records the fallbacks its upstreams name that are themselves on that list (`Model.factoryDroidRefusalFallbacks`).
- `providers/factory-droid.ts` `streamMessagesWire`: filters the route's fallback list by that field.

</details>

## Why

droid 1.1.0 gives Opus 5.5 the Opus 5 refusal fallback on Anthropic (Fast Mode gets none) and drops any fallback missing from the account's available models. On `main`, an Opus 5.5 refusal ends the turn instead of being answered by Opus 5, and a Fable turn offers Opus 5 even to an organization whose policy blocks it. Opus 5 has no feature flag, so org policy is the only way an account loses it: narrow, but it hands a turn to a model the admin removed.

Decisions:
- Availability is decided at discovery, which knows the account's model list; the request path only filters.
- A model built without discovery (no `factoryDroidRefusalFallbacks`) keeps the route's full list, as on `main`, rather than losing fallbacks.
- The list belongs to the organization discovery ran for: a request served for another one (a pooled login, a credential rotation) sends no fallback rather than borrowing that permission.
- Per-call workers (`disableServerSideFallback`) still send none.

Maintenance: when droid changes a model's fallbacks, the KDL block is the one place to edit.

## Testing

- ai `factory-droid-anthropic.test.ts`: Opus 5.5 with Opus 5 available sends `fallbacks` plus the `server-side-fallback` and `fallback-credit` betas; with it unavailable, and for Opus 5.5 Fast Mode, neither. A model discovered for org A sends it for A and nothing after rotating to org B's credential, or on B's first attempt.
- catalog `factory-droid-provider.test.ts`: live discovery records the fallback with Opus 5 allowed and an empty list with it blocked; the offline seed records it.
- Both files pass (44 and 44 tests). With the source changes reverted the new tests fail; reverting only the organization check fails the rotation test.
- Live: an Opus 5.5 turn on Factory (`--thinking=low`) sent `fallbacks: [{"model":"claude-opus-5"}]` with `x-api-provider: anthropic` and both betas (captured at `fetch`); Factory answered 402.
- Not run: a completed live Opus 5.5 turn (the account's 5-hour Standard window was exhausted; resets ~06:14Z), and a live refusal, which cannot be triggered on demand.

```
cd packages/ai && bun test test/factory-droid-anthropic.test.ts
cd packages/catalog && bun test test/factory-droid-provider.test.ts
```

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
