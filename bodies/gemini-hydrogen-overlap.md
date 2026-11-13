## What

Gemini 4 Hydrogen ended up in two Gemini thinking rules that tie, so I dropped it from the shared Argon/Carbon one and kept its own four-level rule.

`main`'s KDL and its committed `rules.json` have drifted apart: the KDL lists `gemini-4-hydrogen` in both the Argon/Carbon block (low, medium, high) and its own block (low, medium, high, xhigh) in `classes/gemini.kdl`, and those two equal-rank exact-id rules tie. The committed JSON was compiled before the first listing was added. Once anyone runs `bun run gen:compat` on `main`, every `omp` start dies before any model is used:

```
AmbiguousOverlapError: ambiguous overlap for `google/gemini-4-hydrogen` on axis `upgradeNeutral`:
rules `classes/gemini.kdl:88` and `classes/gemini.kdl:93` tie; add an explicit priority
```

This PR removes Hydrogen from the shared list and regenerates `rules.json`.

| | `main`, committed JSON | `main`, fresh compile | this PR |
|---|---|---|---|
| `omp` startup | works | throws for every model | works |
| Hydrogen on Google / Vertex / Zen | low, medium, high, xhigh | n/a | low, medium, high, xhigh |
| Hydrogen on Antigravity price | $0 (discovery value) | n/a | $1.50 / $7.50 |

**Beyond the overlap fix:** the regeneration also compiles the Antigravity Hydrogen cost-patch already in `gemini.kdl` but not yet in `rules.json`, so Antigravity Hydrogen bills at $1.50/$7.50 per million tokens (cache read $0.075), as the `[Unreleased]` line already says. It is the only other difference between the committed and regenerated JSON.

## Why

Keeping the dedicated block keeps the ladder v18.20.0 released ("low, medium, high, and xhigh thinking levels on the native Google transports"). The Argon/Carbon listing and its `[Unreleased]` clause "on Google, Vertex AI and OpenCode Zen it offers low, medium and high" were written before the xhigh block existed, so I removed that clause and updated the Gemini 4 test that expected three levels for Hydrogen.

**Alternative not taken:** deleting the dedicated block instead would also stop the crash and pass every existing test, but would drop the released `xhigh` on Google and Vertex, which [Google documents](https://aistudio.google.com/docs/whats-new-gemini-4-hydrogen#understanding-thinking-levels) for Hydrogen.

## Testing

- Clean `origin/main` worktree: `omp models find hydrogen` lists low..xhigh on the committed JSON; after `bun run gen:compat`, `omp models find hydrogen` and `omp -p --model devin/swe-1-6-slow "Reply with just: ok"` both throw the error above. On this branch, after `gen:compat`, both run and Hydrogen lists low, medium, high, xhigh.
- `model-thinking.test.ts`, "drives Gemini 4 with its thinkingLevel ladder on the direct Google transports": Hydrogen resolves to low..xhigh on `google` and `google-vertex`, including the `reasoning: false` discovery case that the tied `thinking-upgrade-neutral` axis decides. With the KDL change reverted and `gen:compat` rerun, it fails with `AmbiguousOverlapError`.
- `bun test` in `packages/catalog` for model-thinking, compat-compile (committed JSON matches a fresh compile; it fails on `main` today), compat-collapse, compat-conformance, compat-cascade, opencode-provider, build, google-antigravity-prompt-cache and gemini-argon-pricing: 354 pass, 0 fail.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
