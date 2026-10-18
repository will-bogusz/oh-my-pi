## What

With only a Factory Droid login, `generate_image` had nothing to run: Factory serves image models, but OMP listed none and had no Factory image transport. I added both.

| | `main` | this PR |
|---|---|---|
| `image` role choices with a Factory login | none | GPT Image 2.5, GPT Image 2.5 Flare, Gemini 3 Pro Image |
| Edit with reference images | — | up to 16 PNG/JPEG/WebP references on GPT Image, each up to 5 MiB; Gemini takes them inline |
| Org turns image generation off, or allow-lists some image models | — | those models leave the picker; nothing else changes |

Live, one image each through `generateImage` with a stored Factory login:

| model | call | tokens in / out | time |
|---|---|---|---|
| GPT Image 2.5 Flare | generate | 18 / 229 | 9.3 s |
| GPT Image 2.5 Flare | edit, one 256 px reference | 277 / 229 | 9.5 s |
| Gemini 3 Pro Image | generate | 43 / 1,120 | 16.0 s |

## Why

Factory's own CLI generates images on the same login, so a Factory subscriber pays for a capability OMP left unused.

Decisions:
- The rows ride the existing `factory-droid-agent` API rather than a new image API: wire, upstream, region and org policy already live there, and the image client reuses chat's identity headers and account scoping.
- Gating follows Factory's org settings (`imageGenerationEnabled`, `imageGenerationAllowedModelIds`) plus the existing model policy; Factory retired the image feature flags, so they are not read. Image models stay hidden until discovery has read those settings, as consent-gated models already do.
- Gemini gets Factory's own generate or edit instruction after the Droid identity line (static prompt assets); the Images routes take the identity alone, as Factory's client sends it.
- GPT Image 2, which Factory's CLI no longer offers, is not listed. Factory's Images routes take no size, so aspect ratio and size reach only Gemini.
- Which Factory failures move the chain: an HTTP rejection (403, 429, 5xx) is a provider HTTP error, so the tool tries its next image model like any provider. A 200 with no image (a Gemini prompt block, an empty data array) now throws with the reason and stops the chain, as other malformed responses do; it no longer reports success with zero images. Reference-limit violations stop before sending.

Maintenance: a new Factory image model is three KDL lines. If Factory renames a setting, the models stay hidden (the safe failure) and the discovery tests show what to update.

Non-goals: adding Factory to the `image` role's default chain (a default change, kept for its own PR); the org's preferred `imageGenerationModel` (the role chain orders models by selector, not discovery order, so honoring it means a new role-resolution input); `n` > 1.

Maintenance: a new Factory image model is three KDL lines; a renamed setting leaves the models hidden.

## Testing

- ai `factory-droid-images.test.ts` (12): request URLs, bodies and identity headers for generate and edit; both Gemini system instructions; the 16-reference, media-type and 5 MiB limits refuse before sending; a prompt block and an empty data array throw response errors; a 403 becomes a provider HTTP error carrying Factory's message.
- catalog discovery (+6): image-kind specs; disabled, allow-listed, empty-list, policy-blocked and unreadable-settings orgs hide exactly the right models.
- coding-agent `image-gen.test.ts` (+1): the tool runs a Factory image model chosen for the `image` role.
- With the source reverted, the ai tests and the catalog listing test fail.
- Live: the three calls above (Gemini on this head), and discovery on the live account listing all three models.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
