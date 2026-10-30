## What

Anthropic raised the Messages request cap from 32 MB to 128 MB today, and since our screenshot clamp and snapcompact both size themselves off that number, I moved our encoded budget up so long computer-use sessions stop dropping images at a quarter of what the API now takes.

On the Anthropic API, a session of 534 KB screenshots now keeps 224 of them instead of 44 before the oldest are dropped, and snapcompact archives for 1932px-frame models go from 70 to 80 frames.

| On the official Anthropic endpoint | `main` | This PR |
|---|---|---|
| Inline-image budget (`inline-image-byte-budget`) | 24 MB (32 MB − 8 MB reserve) | 120 MB (128 MB − 8 MB reserve) |
| Request body limit (`request-body-byte-limit`) | unset | 128 MB |
| Snapcompact frame bytes (half the budget) | 12 MB | 60 MB |
| Archive frames, Opus 4.7+, Fable, Mythos (1932px) | 70 (bytes bind) | 80 (`MAX_FRAMES_DEFAULT` binds) |
| Archive frames, Sonnet, Haiku, Opus ≤ 4.6 (1568px) | 80 | 80 |

**Beyond the new limit:** on a host with `request-body-byte-limit` (Anthropic now, Factory Droid already), the clamp keeps all retained images within what the request's other bytes leave of that limit; on `main` that room only decided which newest images were protected. It is the `imageRoom` bound in `clampProviderContextImageBytes`.

## Why

Anthropic's [request size table](https://platform.claude.com/docs/en/api/overview#request-size-limits) now lists 128 MB for Messages and Token Counting. The budget lives in the catalog rules, so until it moves the clamp keeps evicting at the old cap.

Decisions:
- **Kept the 8 MB reserve, plus the body limit.** Whitespace-heavy text is cheap in tokens and full price in bytes: 15 MB of text beside 228 screenshots counted 980,828 tokens on Claude's tokenizer and built a 134.7 MB body before the room bound.
- **The newest message or tool result may use the reserve** while its images fit 128 MB less the other bytes, as on Factory Droid.
- **Decimal 128,000,000**, like the old 32,000,000. The probe accepts 132 MB and refuses 136 MB, so the real cap looks like 128 MiB.

Scope: `api.anthropic.com` only (API key or OAuth); `ANTHROPIC_BASE_URL` and Foundry reroutes keep no byte budget, and Bedrock, Vertex and Foundry document their own 20 to 32 MB limits. If Anthropic moves the limit again, it is two numbers in `anthropic.kdl`.

## Testing

- Live, free: `count_tokens` with omp's Anthropic OAuth token and noise-PNG bodies: 4, 40, 100, 128.06 and 132.06 MB returned 200 (40 MB: 13,001 tokens); 136.06 MB returned 413 `request_too_large`.
- `provider-image-budget.test.ts`: 240 screenshots keep the newest 224; a newest message with 123.5 MB of images keeps them; 20 MB of text beside 114 MB of images drops one image and the captured Anthropic body stays under 128 MB (Factory: 2 MB of text drops one of three 1 MB images). `request-size.test.ts` resolves the rules; `snapcompact.test.ts` the frame budget.
- Negative controls: `main`'s `rules.json` fails the changed tests; dropping the body-limit line fails the newest-message case; reverting the clamp fails both text cases.
- `bun run check:ts`; `bun test` in coding-agent (20,149 pass; 6 failures in daemon, tmux, Bedrock-credential and Fireworks tests this diff does not reach) and snapcompact.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
