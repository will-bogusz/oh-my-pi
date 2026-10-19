## What

With only a Factory Droid login, `generate_image` had nothing to run: Factory serves image models, but OMP listed none and had no Factory image transport. I added both, in the tool and through the auth gateway's image routes.

| | `main` | this PR |
|---|---|---|
| `image` role choices with a Factory login | none | GPT Image 2.5, GPT Image 2.5 Flare, Gemini 3 Pro Image |
| Edit with reference images | — | up to 16 PNG/JPEG/WebP references on GPT Image (any MIME casing); every Factory reference up to 5 MiB |
| Org turns image generation off, allow-lists some image models, or its settings can't be read | — | those models leave the picker; nothing else changes |

Live, one image each through `generateImage` with a stored Factory login:

| model | call | tokens in / out | time |
|---|---|---|---|
| GPT Image 2.5 Flare | generate | 18 / 229 | 9.3 s |
| GPT Image 2.5 Flare | edit, one 256 px reference | 277 / 229 | 9.5 s |
| Gemini 3 Pro Image | generate | 43 / 1,120 | 16.0 s |

## Why

Factory's own CLI generates images on the same login, so a Factory subscriber pays for a capability OMP left unused.

Decisions:
- The rows ride the existing `factory-droid-agent` API: wire, upstream, region and org policy already live there. Image calls send chat's identity headers and route policy (`OpenAI-Platform`, Gemini's session lock) merged over the model's own configured headers, and each auth attempt is scoped to the account that issued its bearer, so a sibling rotation to another region hits that region's host.
- Gating follows Factory's org settings (`imageGenerationEnabled`, `imageGenerationAllowedModelIds`) plus the existing model policy; Factory retired the image feature flags. An absent switch means enabled, as Factory's schema defines it; an unreachable or unparsable settings response hides the image models.
- Gemini gets Factory's generate or edit instruction after the Droid identity line (one Handlebars prompt asset), with the prompt ahead of the references as the instruction says.
- GPT Image 2, which Factory's CLI no longer offers, is not listed. Factory's Images routes take no size, so aspect ratio and size reach only Gemini.
- Which failures move the chain: an HTTP rejection (403, 429, 5xx) is a provider HTTP error, so the tool tries its next image model. A 200 without an image stops the chain with the reason: a Gemini prompt block is a `content-blocked` error, an empty data array or a Gemini stream without a terminal `STOP` a response error. Reference-limit violations stop before sending.

Non-goals: adding Factory to the `image` role's default chain (its own PR); the org's preferred `imageGenerationModel` (needs a new role-resolution input); `n` > 1.

Maintenance: a new Factory image model is three KDL lines; a renamed setting leaves the models hidden.

## Testing

- ai `factory-droid-images.test.ts` (19): URLs, bodies and headers for generate and edit, including route policy and configured headers; both Gemini instructions and part order; the reference limits and MIME normalization; regional retry after a rotated sibling; block, empty, unfinished and non-`STOP` responses fail; a 403 becomes a provider HTTP error.
- ai `auth-gateway-images.test.ts` (+1): a gateway generation reaches Factory's Images route.
- catalog discovery (+6): disabled, allow-listed, empty-list, policy-blocked, unreachable and unparsable settings hide exactly the image models.
- coding-agent `image-gen.test.ts` (+1): the tool runs a Factory image model chosen for the `image` role.
- Each fix's test fails with its source reverted.
- Live: the three calls above, and discovery listing all three models.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
