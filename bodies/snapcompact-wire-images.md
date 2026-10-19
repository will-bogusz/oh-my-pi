## What

I switched snapcompact's and the session's image checks to the same "does the wire actually send images" test the image fallbacks already use, because five DeepSeek Flash lanes say they take images but their provider strips every one, so an archive reached them as blank placeholders.

On these models snapcompact (the default first method) and inline tool-result imaging produced frames that never arrived: each became `[image omitted: model does not support vision]`, losing everything between the archive's text head and tail. History images were also normalized and, with image URLs on, published before the wire dropped them. These models now take the text-only path.

| Model with `compat.stripImageInput` | `main` | This PR |
|---|---|---|
| auto compaction | snapcompact, frames sent as placeholders | next method (`soft`, LLM summary) |
| `/compact` | snapcompact attempted first | falls back like a text-only model |
| `/compact snapcompact` (explicit) | writes the archive | refused: "…'s provider strips image input" |
| inline tool-result imaging | images tool results | leaves them as text |
| speculative compaction | skipped (snapcompact counts as instant) | speculates the next method |
| history images in the request | normalized, published, then stripped by the wire | replaced with the text-only placeholder up front |

Affected bundled models: `deepseek/deepseek-v4-flash`, `kilo/~deepseek/deepseek-flash-latest`, `nanogpt/deepseek/deepseek-v4-flash-latest`, `venice/deepseek-v4-1-flash`, `yolo-auto/deepseek-flash-v4`, plus any `models.yml` entry declaring images with `stripImageInput: true`. Models that keep images on the wire (DeepSeek V4.1 Flash on OpenRouter or Fireworks, DeepSeek's own `deepseek-flash`) are unchanged.

## Why

`sendsImageInputOnWire()` (pi-ai `vision-guard`) is the wire truth: declared input, minus the Chat Completions guard's `stripImageInput`. The image-question and vision-fallback gates moved to it in #11708; snapcompact's gates and the session's text-only image replacement (#5400) still read `model.input`. Now every gate on the snapcompact path uses it (method choice and speculation, the explicit-snapcompact refusal, the frame-overflow re-render, inline imaging), and so does the session's replacement, which runs before the provider transforms, so the blob broker and image budgets never see these images.

The broker's and image budget's own declared-input checks stay: no image reaches them on these routes now.

Maintenance: none; toggling `stripImageInput` in KDL moves a model between paths.

## Testing

Reproduced the loss: two snapcompact frames converted for `venice/deepseek-v4-1-flash` come out as one `[image omitted: model does not support vision]` part; for `fireworks/deepseek-v4.1-flash` they stay two `image_url` parts.

Each new case runs on the bundled Venice model and fails with the source changes reverted (7 of 89 in the files below fail; all pass with them): inline imaging and its savings estimate; auto compaction takes `soft`; `/compact` never calls `snapcompact.compact`; explicit `/compact snapcompact` is refused; the frame-overflow rescue skips the re-render; `resolveSpeculationMethod` returns `soft` (Sonnet 4.5: `undefined`); a `createAgentSession` request with a history image sends the session's placeholder, not the image or the wire's.

```
cd packages/coding-agent && bun test test/snapcompact-inline.test.ts test/agent-session-manual-snapcompact-fallback.test.ts test/agent-session-snapcompact-auto-fallback.test.ts test/compaction-speculation.test.ts test/agent-session-snapcompact-frame-dead-end.test.ts test/sdk-wire-stripped-images.test.ts
```

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
