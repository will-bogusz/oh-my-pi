## What

Factory Droid accounts with Argon access can now pick Gemini 4 Argon in omp, and omp sends it the request droid sends.

- **Catalog**: a `gemini-4-argon` row on the native Gemini wire. Pool: Standard. Credit rates: 1.6 / 5 / 0.05. Efforts low, medium (default) and high. It is gated on the `gemini_4_argon` flag. It is served on Global inference only, so US and EU accounts don't see it.
- **Wire**: three new request axes on Factory's Gemini route, all set for Argon only:

| Axis | Gemini 3.x on Factory | Gemini 4 Argon |
|---|---|---|
| `google-omit-sampling` | `temperature 1, topP 0.95, topK 64` | none sent |
| `google-pin-max-output-tokens` | no `maxOutputTokens` | `maxOutputTokens: 65536` (model max) |
| `google-native-replay` | earlier turns rebuilt from omp blocks | earlier turns sent back as the `content` Gemini streamed |

Native replay keeps every streamed part of the turn on the assistant message as a new `geminiNativeContent` provider payload. The next request sends those parts back unchanged: thought parts, signatures, Gemini's own `functionCall.id`, and any fields omp does not model. Each tool result then carries the matching `id`. A turn is sent from the payload only if it came from the same model, its text, thinking and tool calls still hash to the digest taken when it was recorded, and its call names line up. Otherwise the turn is rebuilt (for example after a history rewrite or edit), and every unsigned call in it gets the skip-validator signature, as droid does. Droid's 50% launch discount is not part of this PR.

## Why

droid 0.241 added Argon with a request policy that no other Factory Gemini model uses (`geminiRequest({ omitSamplingParameters, maxOutputTokens: 65536, preserveNativeContent })`). Before this change, omp had no row for it. With only a row added, omp would send the Gemini 3 sampling defaults and leave out the output cap that droid sends.

## Testing

- Parity: a recaptured `gemini-4-argon@google medium` case from droid 0.244.0 matches on both the opening request and the tool-result follow-up. Without the wire change it fails.
- `factory-droid-gemini.test.ts` has new cases for the policy body, verbatim replay with call ids, a rewritten turn rebuilding with the sentinel, and no payload recorded when the model lacks the policy. Without the wire change, three of them fail.
- Live turn on `factory-droid/gemini-4-argon` with the read tool: the model called `read` and answered with the file contents. The second request carried the native model turn, including Gemini's `functionCall.id`, and that id was on the `functionResponse`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
