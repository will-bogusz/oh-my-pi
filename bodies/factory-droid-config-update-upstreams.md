## What

I turned off `configuration_update` for Factory Droid's Bedrock and Snowflake routes because changing thinking level mid-session there made the next GPT-6 turn fail with a 400.

Live, on a two-turn session with thinking raised from low to high between turns: turn 2 went from **400 → 200** on Snowflake (GPT-6 Astra), and the same 400 shows on Bedrock (GPT-6 Luna). OpenAI and Azure routes are unchanged and keep the item.

`factory-droid.kdl` adds `supports-configuration-update #false` to the existing `on-upstream "bedrock_openai" "snowflake"` block under `models "gpt-*" "grok-*"`; `rules.json` is regenerated. On those two upstreams a GPT-6 effort change now goes out as the request-level `reasoning.effort`, like any model without the item.

## Why

`classes/openai.kdl` enables `configuration_update` for every GPT-6 revision, and Factory Droid inherits it on every upstream. Factory picks the upstream per model: GPT-6 Astra's live routing lists Snowflake first, and GPT-6 Sol, Luna and 6.1 Sol have Bedrock in their rotation. On those routes the item is rejected:

```
400 The 'configuration_update' item type is not supported with this model.
(type=invalid_request_error param=input[2].type code=unsupported_value)
```

So a user who changes thinking level partway through a session on one of those routes gets an error on every following turn, since the item is replayed in history.

- **Scope:** only the two upstreams that reject it. Turning the item off for all of Factory Droid would also drop it on OpenAI and Azure, which accept it and where it keeps the cached prompt prefix stable across effort changes.
- **Where:** the existing per-upstream block in the provider's KDL, no TypeScript; the rule sits next to `reasoning-disable-mode "none-effort"`, the other request difference these two upstreams already carry.
- **Maintenance:** if Bedrock or Snowflake start accepting the item, deleting the one line restores it; the test below names both upstreams.

## Testing

- `factory-droid-responses.test.ts` adds a two-turn case per upstream (low, then high) through `streamFactoryDroid` with a captured fetch: on `openai` turn 2 keeps `reasoning.effort: "low"` and carries `{type: "configuration_update", reasoning: {effort: "high"}}`; on `bedrock_openai` and `snowflake` it sends `reasoning.effort: "high"` and no item. Removing the KDL line (reverting `rules.json`) fails the Bedrock and Snowflake cases.
- `bun test` in `packages/ai` (`test/factory-droid-*.test.ts`, `test/openai-configuration-update.test.ts`): 308 pass. `packages/catalog`: 1357 pass. `bun run check:ts` passes.
- Live, through `streamFactoryDroid` pinned to one upstream, a Factory subscription, prompts "Say hi." then "Say bye.", thinking low → high:

| Model | Upstream | Turn 2 before | Turn 2 after |
|---|---|---|---|
| GPT-6 Luna | `azure_openai` | 200, item sent | (unchanged) |
| GPT-6 Luna | `bedrock_openai` | 400 `unsupported_value` at `input[2].type` | (rule identical to Snowflake) |
| GPT-6 Astra | `snowflake` | 400 `unsupported_value` at `input[2].type` | 200, `reasoning.effort: "high"`, no item |

Review first: the `on-upstream "bedrock_openai" "snowflake"` block in `factory-droid.kdl`.

---

- [ ] `bun check` passes (`bun run check:ts` passes; the Rust half was not run)
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
