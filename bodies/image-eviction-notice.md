## What

I made omp leave a short note where it drops images to fit a provider's image limit, so the model knows they're missing instead of reading the message as whole.

| What the model receives after a drop | `main` | This PR |
|---|---|---|
| A message with text and images, some dropped | the text and the surviving images, no sign anything is missing | `[N images omitted: provider image limit]` in the place of each run of dropped images |
| A snapcompact archive losing its oldest frames | head text, the remaining frames, `imaged middle above` | head text, `[3 images omitted: provider image limit]`, the remaining frames, tail |
| An image-only message | `[image omitted: provider image limit]` | unchanged |
| A computer result evicted on the Responses route | its text only | the notice, then its text |

Both clamps leave the notice, the count cap (`clampProviderContextImages`) and the byte budget (`clampProviderContextImageBytes`), for every provider. Consecutive drops share one notice, also when the count cap drops some and the byte budget the next ones.

## Why

A long session moved to a provider with a 5-image cap. Its snapcompact archive summary lost 12 of its frames with no marker, while the archive text still described an unbroken imaged middle. Only a message left with nothing already got the omission text; the shared path now covers that case, so its special case is removed.

Decisions:
- **One notice per run, in place**, rather than one note per message, so the model sees which part is missing.
- **Frames `capFrameDataBytes` already replaced keep snapcompact's own notice**; they are gone before this clamp runs, so nothing is marked twice.
- **The notice counts against the request body limit**, in the same re-check the byte clamp already runs for an evicted computer result's text, so it can't push a request over a limit like Factory's 4.5 MB.
- **On the Responses computer path the notice leads the text**, since that route truncates the text to 16,000 characters from the end.

Non-goals: which images get dropped and when (oldest first, as on `main`).

Related: #15238 (batched eviction in the same file).

## Testing

Live, `devin/claude-haiku-5-5` (no catalog image budgets, so omp's 5-image default), seven digit images, asking the model to quote any bracketed text and list the digits:
- `main`: digits 3-7, no omission text; it guesses images 6 and 7 are the missing ones.
- This PR: quotes `[2 images omitted: provider image limit]`, digits 3-7.

`bun test packages/coding-agent/test/session/provider-image-budget.test.ts`: 73 pass. New: a summary archive over the count cap shows one `[3 images omitted …]` between its head text and the remaining frames; a Factory request whose fresh image fits by fewer bytes than the notice drops it too; a long computer result's serialized note keeps the notice. Each fails with its part of the change reverted. Neighbouring suites: 310 pass; `bun run check:ts` is clean.

Review first: `markEviction` in `provider-image-budget.ts`, then the byte loop's `addedTextBytes`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
