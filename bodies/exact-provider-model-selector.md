## What

I made a `provider/model` selector name a model that provider really has. Before, a near miss was fuzzy-matched to a sibling and that sibling ran with no warning. Now it fails with the existing `Model "…" not found` error, which names up to three close ids from that provider. Bare selectors such as `opus` or `gpt-5.2` still fuzzy-match.

| Selector (bundled catalog) | Before | After |
|---|---|---|
| `anthropic/claude-haiku-9-9` | not found | not found |
| `openai-codex/gpt-5.5` (retired) | runs `openai-codex/gpt-5.6-luna` | not found, suggests `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` |
| `--provider openai --model 4o` | runs `openai/gpt-4o` | not found, suggests `openai/gpt-4o` |
| `google-vertex/claude-opus-4-8` | runs `claude-opus-4-8@default` | not found |
| `openai/gpt-4o`, `anthropic/claude-sonnet-4-5` (exact) | resolves | resolves |
| `opus`, `spark` (bare) | fuzzy | fuzzy |

The change is in `matchModel`. When the prefix names a provider in the candidate set, matching stops after the exact phases (reference, id, variant and native aliases) instead of scoring that provider's ids by subsequence. A prefix that is not a known provider is still read as part of a raw id, so OpenRouter ids like `openai/gpt-4o:extended` and `@upstream` routing work as before.

Places that used to switch silently now say what happened:

- **`--provider p --model id`** now waits for extensions and discovery before failing, like `--model p/id`.
- **A configured `default` that no longer resolves** still falls back, but startup warns `Default model <selector> not found. Using <provider/id>`.
- **Role chains** mark the candidate replacing an unresolved configured `provider/…` selector; dictation warns with it (the case in the issue's last comment). Other role consumers still skip silently.
- **Built-in role defaults:** `smol`'s `cerebras/zai-glm` and `slow`'s retired `openai-codex/gpt-5.5` name no bundled model and are removed; `cerebras/zai-glm-4.6` and `openai-codex/gpt-5.6-sol` already precede them. A catalog test catches any qualified default that only near-matches.

## Why

Refs #12884. The maintainer scoped the remaining half of that issue as "known-provider `provider/model` selectors resolve exactly or fail; bare selectors retain fuzzy matching". A qualified selector is usually written on purpose, often into config, and swapping in a neighbour bills the wrong model with nothing in TUI or JSON mode saying so.

**Upgrade cost.** `provider/…` values that relied on the fuzzy step stop matching: retired or renamed ids (`openai-codex/gpt-5.5`), dated ids without their date, `-latest` shorthands (`openai/gpt-5-latest`), and Vertex ids without `@default`. Use the id `omp models <provider>` lists, or the bare id to keep fuzzy matching; the suggestions and warning name the replacement.

## Testing

- New tests fail on the previous head. They cover: qualified and `--provider` near misses fail; the error suggests the sibling; `--provider` defers; a stale default warns; a role chain marks its replacement; no qualified role default is a near miss.
- Changed fixture: a startup-fallback test's `runtime-provider/runtime-m*` only resolved through the fuzzy step; it is now the bare `runtime-m`.
- `check:ts` and the catalog suite pass. The `coding-agent` suite's remaining failures also fail on `main` locally (ambient Bedrock, message-pipeline, npm, JS package env) or are Chrome-timing flakes.
- `omp -p --model anthropic/claude-haiku-9-9 hi` and the `--provider` form exit 1 without a request.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
