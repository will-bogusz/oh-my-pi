## What

I added the models Factory now serves to Droid users that omp's Factory Droid provider still didn't know about, so they show up in `/models` once the account may use them.

Nine models join the roster; a live Factory login now lists five of them and each finished a two-read tool turn.

| Model | Wire · pool | Shown when |
|---|---|---|
| GPT-6.1 Terra | Responses · Standard | `gpt_6_1_terra` flag |
| GPT-6 Sol / Luna Fast Mode | Responses, `service_tier: priority` · Standard | always (fast tiers follow the org's fast-model policy) |
| GPT-6 Astra Ultra Fast | Responses, `service_tier: ultrafast` · Standard | `gpt_6_astra_ultrafast` flag + the org's high-cost opt-in |
| GPT-6.1 Sol Ultra Fast | Responses, `service_tier: ultrafast` · Standard | the org's high-cost opt-in |
| Nemotron 3.5 Super | Completions on Baseten · Core | `nemotron_3_5_super` flag |
| Muse Spark Open | Completions on Baseten · Standard | `muse_spark_open` flag |
| Muse Spark 1.2 | Completions on Fireworks · Standard | always |
| Beam 1.0 | Completions on Baseten, `allow_missing_thinking` · Core | `beam_1_0` flag |

**Also:** Opus 5.5 Fast, GPT-6.1 Sol and MiniMax M3 no longer wait on feature flags Factory has retired (the server still answers them `true` today, so nothing disappears now, but would once it drops them), and GPT-5.5 stops rotating to Snowflake, which Factory no longer routes it to.

Reading order: `factory-droid.kdl` (seed rows, then one policy block per model, then the completions selector, the `beam-1.0` block and `gpt-*-ultrafast`), `runtime/behavior.kdl` (api route and pool per id), then `axes.ts` and `buildCompletionsReasoningBody` for the one new request field.

## Why

These are the models the current Droid release (1.1.0) offers, with its ids, limits, effort ladders, credit rates, upstreams and gates. Everything is KDL except two request shapes the catalog could not express yet:

- `ultrafast` is a second value of the existing `responses-service-tier` axis (OpenAI's tier already exists in omp's wire types).
- `completions-allow-missing-thinking` is a new request axis: Beam is told to accept tool-call turns that arrive without reasoning. Only `beam-1.0` sets it.

Non-goals: MiniMax M3.1 Flash (#17709 adds it), Gemini 4 Argon and Muse Spark 1.3 (each needs its own request dialect), credit promotions (#16309), and the client version bump.

Maintenance: a model Factory adds or retires is a KDL edit; `factory-droid-provider.test.ts`'s registry-consistency tests fail if an id is missing its route, pool or registry block.

## Testing

- `bun test test/factory-droid-provider.test.ts` (catalog): 45 pass. New: the retired-flag models stay listed with those flags off; the new models stay hidden without their flags, Ultra Fast stays hidden until the opt-in is granted; GPT-5.5's rotation has no Snowflake.
- `bun test test/factory-droid-*.test.ts` (ai): 262 pass. New: Sol/Luna Fast send `priority`, both Ultra Fast models send `ultrafast` on the `openai` upstream, Beam sends `reasoning_effort` with `allow_missing_thinking: true`.
- Negative control: with the KDL, axis and encoder changes reverted, the 3 new catalog tests and the 5 new ai cases fail.
- `bun run check:ts`: passes.
- Live, on a Factory login: `omp models factory-droid` from this branch lists beam-1.0, gpt-6-luna-fast, gpt-6-sol-fast, muse-spark-1.2 and nemotron-3.5-super (Terra, Muse Spark Open and both Ultra Fast stay hidden: flags off, no opt-in). A "read a.txt and b.txt, reply with the sum" turn on each of the five ran both `read` calls and returned the right sum.
- Not run: Terra, Muse Spark Open and the Ultra Fast pair live (not enabled for this account).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
