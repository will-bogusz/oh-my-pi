## What

I made omp leave a short note where it drops images to fit a provider's image limit, so the model knows they're missing instead of reading the message as whole.

| What the model receives after a drop | `main` | This PR |
|---|---|---|
| A message with text and images, some dropped | the text and the surviving images, no sign anything is missing | `[N images omitted: provider image limit]` in the place of each run of dropped images |
| A snapcompact archive losing its oldest frames | head text, the remaining frames, `imaged middle above` | head text, `[3 images omitted: provider image limit]`, the remaining frames, tail |
| An image-only message | `[image omitted: provider image limit]` | unchanged |
| A computer result evicted on the Responses route | its text only | its text and the notice |

Both clamps leave the notice, the count cap (`clampProviderContextImages`) and the byte budget (`clampProviderContextImageBytes`), for every provider. Consecutive drops share one notice, also when the count cap drops some and the byte budget drops the next ones.

## Why

A long session moved to a provider with a 5-image cap. Its snapcompact archive summary lost 12 of its frames with no marker, while the archive text still told the model about an unbroken imaged middle and to read the history in full. The model had no way to know the middle was gone. Only a message with nothing left already got the omission text; the shared mechanism now covers that case, so its special case is removed.

Decisions:
- **One notice per run, in place**, rather than one summary note per message: the model sees which part of the sequence is missing. A run beside an existing notice extends it rather than adding a second.
- **Archive frames that `capFrameDataBytes` already replaced keep snapcompact's own notice**: those frames are gone before this clamp runs, so nothing is marked twice.
- **The notice text counts against the request body limit.** The byte clamp already re-checks the room for the text an evicted computer screenshot sends; the notice bytes join that same check, so a notice can't push a request over a limit like Factory's 4.5 MB.

Non-goals: which images get dropped and when (oldest first, as on `main`); image budgets per provider.

Related: #15238 (batched eviction in the same file).

## Testing

Live, `devin/claude-haiku-5-5` (no image budgets in the catalog, so omp's 5-image default applies), one prompt with seven digit images asking the model to quote any bracketed text and list the digits it sees:
- `main`: lists digits 3-7, quotes no omission text, and guesses that images 6 and 7 are missing.
- This PR: quotes `[2 images omitted: provider image limit]` and lists digits 3-7.

`bun test packages/coding-agent/test/session/provider-image-budget.test.ts`: 73 pass. New cases: a summary archive over the count cap shows one `[3 images omitted …]` between its head text and the remaining frames; a Factory request whose fresh image fits by fewer bytes than the notice drops that image too. With the source change reverted, both fail, as does the first case of the file, now asserting a notice after each dropped image. Existing cases that asserted the silent drop now assert the notice in its place. A neighbouring set (`snapcompact-inline`, `agent-session-message-pipeline`, `blob-provider-fallback`, `advisor-provider-options-parity`, `secrets-obfuscator`): 310 pass. `bun run check:types` in `coding-agent` is clean.

Review first: `markEviction` in `provider-image-budget.ts`, then the byte loop's `addedTextBytes`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
