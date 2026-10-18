## What

I made Gemini get parallel tool results back in the order it made the calls, not the order they finished.

Both Gemini converters (`google-shared.ts` for the Gemini API, Vertex, Cloud Code Assist and Antigravity, and the Factory Droid Gemini wire) sort each turn's `functionResponse` parts into call order. The responses stay in the slots they already hold, and parts without a matching call stay where they are. This matches what Factory's `droid` CLI does as of 0.241 (still in 0.244).

## Why

Results are stored in the order they finish, so when a model calls `read(a)` and `read(b)` in parallel the history can hold b's result before a's. Requests without `functionResponse.id` leave Gemini to pair responses with calls by position. When the two calls share a name, a's call gets b's output and nothing reports an error:

| Route | `id` on responses | Before | After |
|---|---|---|---|
| Gemini API, Gemini < 3 | no | crossed | call order |
| Vertex | no (rejected) | crossed | call order |
| Gemini CLI / Antigravity (Gemini) | no | crossed | call order |
| Factory Droid Gemini | no | crossed | call order |
| Gemini API, Gemini 3+ | yes | paired by id | paired by id, now also in call order (one-time prompt-cache miss for histories already stored crossed) |

## Testing

- New tests send a same-name call pair whose results are stored in reverse order through each route listed above (Gemini CLI and Antigravity on their own `google-gemini-cli` transport). They fail on `main` and pass here.
- `bun test packages/ai` and `bun run check:ts` pass; full `bun check` was not run.
- Live A/B on Factory Droid `gemini-3-flash-preview`: a saved session where the model calls `read` on `x1.txt` and `x2.txt` in parallel, with the results stored crossed (x2's `BETA-TOKEN` first, then x1's `ALPHA-TOKEN`). It is resumed with "Without calling any tool, answer from the conversation: which token did x1.txt contain?". On `main`, both valid runs answered `BETA-TOKEN`, and two more runs failed with `MALFORMED_RESPONSE`. On this branch, all 5 runs answered `ALPHA-TOKEN`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
