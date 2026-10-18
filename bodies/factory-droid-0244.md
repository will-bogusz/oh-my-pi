## What

I brought the Factory Droid provider up to the current `droid` CLI (0.244.0): the new models Factory now serves appear in `/models` once the account's flags allow them, and the requests omp sends match the native CLI's again.

| Surface | Before | Now |
|---|---|---|
| `/models` (factory-droid) | no GPT-6 Fast/Ultra Fast, Nemotron 3.5 Super, Muse Spark, Beam | GPT-6 Sol/Luna Fast Mode, GPT-6 Astra and GPT-6.1 Sol Ultra Fast (only after the org's high-cost opt-in), Nemotron 3.5 Super, Muse Spark Open, Muse Spark 1.2, Beam 1.0, each behind its feature flag, on the right wire and billing pool |
| Opus 5.5 Fast, GPT-6.1 Sol, MiniMax M3 | hidden unless a retired feature flag is on | listed without a flag |
| GPT-5.5 | could route to Snowflake | OpenAI, Bedrock, Azure, Databricks only |
| Opus 5.5 on Anthropic | no refusal fallback | falls back to Opus 5 server-side, like Fable |
| Refusal fallbacks | offered even when the account cannot use the fallback model | offered only when the account's roster includes it |
| Request identity | droid 0.237.0, Anthropic SDK 0.70.1 / OpenAI SDK 6.25.0 headers | droid 0.244.0, 0.128.0 / 7.23.0; the identity check asks for the extended response |

## Why

The provider is checked against what the native CLI actually sends. That CLI has moved seven releases ahead of the pinned version, adding models and changing gates and routing. Without this sync, users can't see models their plan includes, and requests carry version headers from an old client.

Decisions:
- Ultra Fast is a new `service_tier` value (`ultrafast`) on the existing `responses-service-tier` axis, chosen by a `gpt-*-ultrafast` rule. The existing `gpt-*-fast` rule does not match it.
- Beam needs `allow_missing_thinking: true` beside its effort. This is a new boolean request axis, `completions-allow-missing-thinking`, set only for Beam. Hard-coding it in TypeScript would split policy from the KDL.
- Muse Spark 1.2's Factory effort ladder outranks the Meta class ladder (`priority=1`). Factory serves no `minimal` rung.
- The fallback filter runs in discovery. Each model gets `factoryDroidRefusalFallbacks`, which keeps only the fallbacks in the account's roster. A model built without discovery keeps the full KDL list.

The provider's comment on the Droid identity sentence now states that the proxy still requires it: on 2026-10-18, Responses requests without the sentence in `instructions` got 403 3/3, and 200 3/3 with it (gpt-5.4-mini, gpt-6.1-sol).

Non-goals (separate PRs): Gemini 4 Argon, credit promotions, latest-model alias wildcards.

Maintenance: on the next `droid` release, bump the pin and rerun `bun packages/ai/scripts/capture-factory-droid-native.ts --droid <binary>`; the parity test fails on drift.

Review first: `factory-droid.kdl`, `behavior.kdl`, then `discovery/` and `providers/factory-droid.ts`.

## Testing

- Recaptured the native parity corpus from droid 0.244.0. It has 57 cases, 8 of them new: Nemotron 3.5 Super high and off, Muse Spark Open, Muse Spark 1.2, Beam 1.0, GPT-6 Sol Fast, GPT-6 Luna Fast at none, and Opus 5.5 on Anthropic with its fallback. `factory-droid-native-parity.test.ts`: 58 pass.
- Negative control: with this PR's `src` changes reverted, all 57 parity cases fail, and so do the six new tests.
- The new tests cover: the retired-flag listing; the fallback filter, both in discovery and in the request; the Ultra Fast service tier (unit-tested: Ultra Fast is opt-in and was not reachable for capture); and the extended identity header.
- `packages/ai`: 6040 pass. `packages/catalog`: 1226 pass. `bun run check:ts` is clean.
- Live, `omp -p --model factory-droid/<id>` ran on Beam 1.0, Opus 5.5 and GPT-5.5. Each turn ran on the requested model and stopped normally. `omp models factory-droid` lists the new models the account is flagged for and hides Ultra Fast.

Not run: Ultra Fast against Factory; it needs an org that accepted the high-cost terms.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
