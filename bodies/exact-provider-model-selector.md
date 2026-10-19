## What

I made a `provider/model` selector name a model that provider really has. Before, a near miss was fuzzy-matched to a sibling and that sibling ran with no warning. Now it fails with the existing `Model "…" not found` error, which names up to three close ids from that provider. Bare selectors such as `opus` or `gpt-5.2` still fuzzy-match.

| Selector (bundled catalog) | Before | After |
|---|---|---|
| `anthropic/claude-haiku-9-9` | not found | not found |
| `openai-codex/gpt-5.5` (retired) | runs `openai-codex/gpt-5.6-luna` | not found, suggests `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` |
| `--provider openai --model 4o` | runs `openai/gpt-4o` | not found, suggests `openai/gpt-4o` |
| `google-vertex/claude-opus-4-8` | runs `claude-opus-4-8@default` | runs `claude-opus-4-8@default` (sole revision) |
| `openai/gpt-4o`, `anthropic/claude-sonnet-4-5` (exact) | resolves | resolves |
| `opus`, `spark` (bare) | fuzzy | fuzzy |

The change is in `matchModel`. When the prefix names a provider in the candidate set, matching stops after the exact phases (reference, id, variant and native aliases) instead of scoring that provider's ids by subsequence. A prefix that is not a known provider is still read as part of a raw id, so OpenRouter ids like `openai/gpt-4o:extended` and `@upstream` routing work as before.

Places that used to switch silently now say what happened:

- **`--provider p --model id`** now waits for extensions and discovery before failing, like `--model p/id`.
- **A configured `default` that no longer resolves** still falls back, but startup warns `Default model <selector> not found` (or `is unavailable (no credentials, or not in enabledModels)` when the catalog has it), then names the model used.
- **Role chains** mark the candidate replacing an unresolved configured `provider/…` selector; dictation warns with it, also when only the built-in local model is left (the case in the issue's last comment). Other role consumers still skip silently.
- **Built-in role defaults:** `smol`'s `cerebras/zai-glm` and `slow`'s retired `openai-codex/gpt-5.5` name no bundled model and are removed; `cerebras/zai-glm-4.6` and `openai-codex/gpt-5.6-sol` already precede them. A catalog test catches any qualified default that only near-matches.

## Why

Refs #12884. The triage there scoped the remaining half as "known-provider `provider/model` selectors resolve exactly or fail; bare selectors retain fuzzy matching", pending the maintainer's call on the breakage below. A qualified selector is usually written on purpose, often into config, and swapping in a neighbour bills the wrong model with nothing in TUI or JSON mode saying so.

**Upgrade cost.** `provider/…` values that relied on the fuzzy step stop matching: retired or renamed ids (`openai-codex/gpt-5.5`), dated ids without their date, and `-latest` shorthands (`openai/gpt-5-latest`). Use the id `omp models <provider>` lists or the bare id; the suggestions and warning name the replacement. An id without its `@revision` (Vertex `claude-opus-4-8`) still resolves while it has only one revision.

## Testing

- New tests fail without the change: qualified and `--provider` near misses, the shared suggestion (also after deferral), stale/unavailable default warnings, role-chain and empty-chain dictation warnings, the Vertex revision alias, and no qualified role default being a near miss.
- Changed fixture: `runtime-provider/runtime-m*` only resolved fuzzily; it is now the bare `runtime-m`.
- `check:ts` and the catalog suite pass; other `coding-agent` failures also fail on `main`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
