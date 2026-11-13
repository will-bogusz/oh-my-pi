## What

I added Factory Droid's Gemini 4 Hydrogen, which droid 1.10.0 serves, and caught Muse Spark 1.2 up with its image support, so an account entitled to them can use them in omp.

| In omp on a Factory login | `main` | This PR |
|---|---|---|
| Gemini 4 Hydrogen | missing | listed behind `gemini_4_hydrogen`; Google upstream, EU inference included; Low/Medium/High (default High); 1M context, 65K output; 0.6× input credits, Google's $1.50/$7.50 list price beside them |
| Muse Spark 1.2 image input | image dropped (or described by another model) | image sent |

> **Factory context.** Factory has no model-listing endpoint: omp ships the CLI's roster in `factory-droid.kdl` and narrows it per account with feature flags, org policy and inference region.

Reading order: the Hydrogen seed row and `models "gemini-4-hydrogen"` in `factory-droid.kdl` → the `google-thinking "level-medium"` line that gained it → `quota-tiers` and the `google-generate` route in `runtime/behavior.kdl`.

## Why

Fixes #19173: Hydrogen is the third of the three Factory models it asks for, after Claude Fable 5.2 and Gemini 4 Carbon.

droid 1.10.0 adds Hydrogen behind a new feature flag; droid 1.9.0 lets Muse Spark 1.2 take images on Fireworks.

Decisions:
- Hydrogen takes Gemini 3.8 Flash's request rules, not Argon's and Carbon's, as the CLI sends it: temperature, topP and topK go out, `maxOutputTokens` does not, and its turns replay as ordinary history. Unlike Carbon it is served on EU inference too.
- No credit promotion: droid ships none for Hydrogen.
- Muse Spark 1.2 gains image input only: Fireworks still rejects PDF parts, and omp's model `input` has no PDF modality to set.

## Testing

- Live from this branch on a Factory login, `omp -p` two-read turn (read two files, reply with their sum): 42 on `gemini-4-hydrogen`.
- One-image turn on `muse-spark-1.2` (a red/blue split PNG, `images.describeForTextModels` off): this branch sends the image and the model answers RED/BLUE; the base branch drops it and the model answers NO IMAGE.
- Native parity: the corpus's new `gemini-4-hydrogen@google` case matches omp's requests (`factory-droid-native-parity.test.ts` 65 pass). With Hydrogen added to Argon's and Carbon's dialect line, its parity case fails.
- The discovery gate test now checks that `gemini_4_hydrogen` gates Hydrogen; it fails with the flag line removed.
- `bun test` (`env -i`): `packages/ai` `test/factory-droid*.test.ts` 296 pass; `packages/catalog` Factory and compat tests 211 pass. `check:types` clean for both packages.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
