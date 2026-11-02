## What

I added Gemini 4 Argon to the Factory Droid provider, along with the request rules it needs, since Factory serves it now and the existing Gemini request shape doesn't fit it.

Accounts with Factory's `gemini_4_argon` flag see `gemini-4-argon` in `/models`: 934K context, 66K output, low/medium/high effort (medium by default), Standard credits at 1.6× input, 5× output and 0.05× cache read. Factory serves it on Global inference only.

| Argon request | Other Factory Gemini models | Argon |
|---|---|---|
| `temperature` / `topP` / `topK` | sent (1 / 0.95 / 64) | not sent |
| `maxOutputTokens` | not sent | 65536 |
| Its own earlier turns | rebuilt from omp's message content | the raw Gemini content it streamed (thoughts, signatures, call ids), with call ids on tool results |

Reading order: three request axes (`compat/types.ts`, `axes.ts`, `factory-droid.kdl`) → `streamFactoryDroidGemini` records `GeminiNativeContentPayload` → `replayableNativeContent` / `toGeminiContents` → `session-persistence.ts`, `provider-image-budget.ts`.

## Why

droid sends Argon no sampling parameters, a pinned output cap, and its raw turns back. omp sent it the Gemini 3 shape.

Decisions:
- A raw turn replays only if it is this model's, its text, thinking and calls still digest to what Gemini sent, and credential redaction (when on) would leave the raw content alone. That last check also covers raw parts the rebuilt turn drops (unsigned thoughts). Every other turn is rebuilt.
- The policy is three KDL axes, not a TS id check.
- Session saves keep the raw content atomic, like Cursor history, so the 500K-character truncation never cuts a signed part. Raw turns feed the call-order tracker, and the image clamp charges whichever is larger, raw or rebuilt, the same as Responses history.

Non-goals: Argon's launch credit promotion (0.5× until 2026-12-01) waits for dated rates in the catalog. The recorded droid request corpus gets an Argon row when it is recaptured at the current pin.

Maintenance: if Factory drops the dialect, removing the three axes reverts Argon to the plain Gemini request.

## Testing

- Live, Global account: `omp models factory-droid` from this branch lists `gemini-4-argon` (934K / 66K / low, medium, high).
- New tests: the request shape; second turn sent verbatim with call ids; rewritten turn rebuilt; with redaction on, a credential in a call argument or an unsigned thought stays off the wire; parallel results in call order; a 600K raw turn survives save/reload; the clamp charges the raw size. Reverting the redaction check, the call-order line, the clamp flag or the persistence guard fails its test. With the whole change reverted, 4 of 7 replay tests and the clamp test fail.
- A droid-recorded Argon request pair matches omp's bodies on both turns (only the client-version header differs from the pin).
- ai, catalog and coding-agent session suites pass, and `bun run check:ts` is clean.
- Not run: a live Argon tool turn. The account's Standard credit window was exhausted (402).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
