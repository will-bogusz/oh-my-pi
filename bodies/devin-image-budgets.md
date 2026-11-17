## What

I switched a long session from Claude to Devin's Gemini 4 Carbon and it lost most of its snapcompact archive, because omp only lets Devin requests carry 5 images; this gives Devin the limits its server actually enforces.

A Devin model now sees 12 of 12 attached images instead of the newest 5, and snapcompact plans a Carbon archive frame at 1,089 tokens instead of 5,024.

| Devin request | `main` | This PR |
|---|---|---|
| Images kept, Devin's host | 5 | 60 (Claude models 20) |
| Image bytes, Devin's host | 3 MB | 24 MB, request held under 32 MB |
| Images kept, custom Devin base URL | 5 | 40, no byte clamp |
| Tokens planned per Gemini 4 Carbon / 3.7 Flash image | 1,120 unverified (5,024 per archive frame) | 1,089, verified |

All of it is `devin.kdl` rules on mechanisms that already exist (`image-count-budget`, `official-image-count-budget`, `inline-image-byte-budget`, `request-body-byte-limit`, `endpoint-hosts` with `catalog-endpoint-budgets`, `image-tokenization`), plus the regenerated `rules.json`. No TypeScript changes.

**Non-goals:** sizing snapcompact frames differently for Gemini readers, and verifying the other Devin Gemini models (3.5/3.8 Flash, 4 Hydrogen/Argon), which keep the lineage's 1,120 until measured across sizes.

## Why

The Devin catalog had no image budgets, so every Devin request fell to omp's generic 5 images / 3 MB. A session moved onto a Devin model from Claude kept only its newest 5 screenshots or archive frames.

> **Devin context.** Devin's server relays each model's own upstream image rules and adds one of its own: it refuses a request whose decompressed body passes 32 MiB.

Decisions:
- **60 on Devin's host, 40 elsewhere.** On Devin's host the 24 MB byte budget bounds the images, so 60 is safe. A custom base URL gets no byte clamp (its limit is unknown), so the count alone must fit: 40 images at omp's 500 KiB resize target are 27.3 MB base64, under 32 MiB. 60 there could reach 41 MB.
- **Claude 20 everywhere.** Past 20 images Claude rejects any edge over 3,000 px, and Devin passes images through unresized.
- **`verified` only on Carbon and 3.7 Flash.** Those two billed a fixed 1,089 tokens at 8 sizes from 512 to 4,096 px. The others billed 1,089-1,091 at only two sizes.

Maintenance: if Devin lowers a limit, the turn fails with a typed `invalid_argument` or `resource_exhausted` error naming no image, and the fix is one number in `devin.kdl`.

## Testing

Live, `omp -p --model devin/gemini-4-carbon` with 12 attached images, each showing a two-digit number, asking for every number in order:
- `main`: `66, 73, 80, 87, 94`, count 5 (the newest five).
- This PR: all 12 numbers, in order, count 12.

Limits measured against Devin's server through omp's own Devin transport, one request per probe:

| Probe | Result |
|---|---|
| Images per request | Claude 600 OK, 601 refused; GPT 1,500 OK, 1,501 refused; Gemini 650 OK (context-bound) |
| Decompressed request body | 33,554,431 B OK ×3; 33,554,437 B and above `resource_exhausted` |
| Claude edge past 20 images | 3,000 px OK, 3,001 px refused |
| Gemini image tokens, 512-4,096 px | Carbon 1,090-1,092, 3.7 Flash 1,087-1,089 at all 8 sizes |

Rerun: our probe kit's `run.sh count|body|dims|res` (needs `omp token devin`).

Tests in `provider-image-budget.test.ts` go through `clampProviderContextImages` / `clampProviderContextImageBytes`: Devin's host keeps 60 (Claude 20), a custom base URL 40 with no byte clamp, and 60 resized screenshots on Devin's host are cut to fit under 32 MiB, oldest first. `image-tokenization.test.ts` covers the two verified models and 3.8 Flash staying unverified. Negative control: with `devin.kdl` reverted and `rules.json` regenerated, all 6 new cases fail; restored, 76 + 24 pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
