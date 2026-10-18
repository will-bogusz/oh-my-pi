## What

I appended Factory Droid's three image models to the end of the `image` role's default chain, in Factory CLI's own order (GPT Image 2.5, Flare, Gemini 3 Pro Image). Today someone whose only login is Factory Droid gets "Image generation exhausted the resolved image chain" from `generate_image` until they set the `image` role by hand.

| setup | `main` | this PR |
|---|---|---|
| Factory login only, no image settings | no default image model; the tool fails | GPT Image 2.5, then Flare, then Gemini 3 Pro Image |
| Factory plus another default image provider | that provider | that provider first; Factory runs only after earlier candidates are unavailable or fail with an HTTP error |
| `image` role set, no `retry.fallbackChains.image` array | the role, then the other defaults | the same, with Factory appended at the end |
| `retry.fallbackChains.image` array configured | as configured | unchanged |

**The maintainer question:** should Factory be in the default image chain at all?
- **Factory last (this PR):** a Factory-only user can generate with no setup; nobody whose earlier candidates work sees a different provider or bill. The cost is that a role set without a fallback array gains a Factory tail, which runs only when everything before it fails or lacks credentials.
- **Not in the defaults:** Factory image models stay selectable, but a Factory-only user must set the `image` role first. Dropping this PR is that option.

## Why

Factory's image models can be chosen for the `image` role, but a default change needs its own call, so they were left out of the defaults. Factory comes last so earlier providers keep their turn, and a Factory org that disables image generation never lists these models, so its chain is unchanged.

## Testing

`packages/coding-agent/test/tools/image-gen.test.ts` (+5):
- Factory only, no settings: the tool calls Factory's `/images/generations` with `gpt-image-2.5-sunburst`.
- With an xAI image login: the call goes to xAI only.
- xAI returns HTTP 500: the call reaches Factory's `/images/generations` next.
- `image` role set to xAI, no fallback array, xAI 500: the call reaches Factory.
- `image` role set to xAI with `retry.fallbackChains.image: []`, xAI 500: the tool stops after xAI; Factory is never called.

With the KDL change reverted, the three Factory-reaching cases fail; the two unchanged-behavior cases pass on both.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
