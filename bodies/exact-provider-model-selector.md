## What

I made a `provider/model` selector name a model that provider really has. Before, a near miss was fuzzy-matched to a sibling and that sibling ran with no warning. Now it fails with the existing `Model "…" not found` error, which names up to three close ids from that provider. Bare selectors such as `opus` or `gpt-5.2` still fuzzy-match.

| Selector (bundled catalog) | Before | After |
|---|---|---|
| `anthropic/claude-haiku-9-9` | not found | not found |
| `openai-codex/gpt-5.5` (retired) | runs `openai-codex/gpt-5.6-luna` | not found, suggests `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` |
| `--provider openai --model 4o` | runs `openai/gpt-4o` | not found, suggests `openai/gpt-4o` |
| `google-vertex/claude-opus-4-8` | runs `claude-opus-4-8@default` | runs `claude-opus-4-8@default` (declared revision) |
| `openai/gpt-4o`, `anthropic/claude-sonnet-4-5` (exact) | resolves | resolves |
| `opus`, `spark` (bare) | fuzzy | fuzzy |

In `matchModel`, a selector whose prefix is a known provider stops after the exact phases (reference, id, aliases). Known means in the candidate set or defined in the KDL catalog, including discovery-only providers such as `ollama` and providers without credentials, so the selector can't fall through to another provider's raw ids. Other prefixes are still read as part of a raw id (`openai/gpt-4o:extended`, `@upstream`).

What else changed:

- **Revision aliases:** a new `selector-revision-suffix` catalog setting (`@default` on Google Vertex) lets an id be written without its declared revision.
- **One hint:** the not-found hint is shared by the CLI resolver and the deferred startup failure. Print mode no longer adds a cross-provider list for qualified misses.
- **`--provider p --model id`** waits for extensions and discovery like `--model p/id`, using the registry's provider knowledge, so a discovery provider with no rows yet still resolves.
- **No silent swaps:** a configured `default` that misses warns `not found` (or `unavailable` when it lacks credentials) and names the model used. A saved-session restore failure is kept. Non-interactive runs print this on stderr. Role chains report the first qualified entry they skipped, through aliases and comma lists, and dictation warns with it. Other role consumers still skip silently.
- **Built-in role defaults:** `smol`'s `cerebras/zai-glm` and `slow`'s retired `openai-codex/gpt-5.5` named no bundled model and are removed. A catalog test catches any qualified default that only near-matches.

## Why

Refs #12884. The triage there scoped the remaining half as "known-provider `provider/model` selectors resolve exactly or fail; bare selectors retain fuzzy matching", pending the maintainer's call on the breakage below. A qualified selector is usually written on purpose, often into config, and swapping in a neighbour bills the wrong model without a word.

**Upgrade cost.** `provider/…` values that relied on the fuzzy step stop matching: retired or renamed ids (`openai-codex/gpt-5.5`), dated ids without their date, and `-latest` shorthands (`openai/gpt-5-latest`). Use the id `omp models <provider>` lists or the bare id; the hint and warnings name the replacement.

## Testing

- New tests fail without the change: qualified misses, hints, deferral, default and role-chain warnings, Vertex alias, known-provider rule.
- Changed fixture: `runtime-provider/runtime-m*` only resolved fuzzily; it is now the bare `runtime-m`.
- `check:ts` and the catalog suite pass; other `coding-agent` failures also fail on `main`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
