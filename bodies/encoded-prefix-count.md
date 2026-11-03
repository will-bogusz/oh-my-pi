## What

I dont want to necessarily accept this solution we have right now as the best approach, though its a decent start

On a fresh session the context gauge and `/context` now count the system prompt and tools as the provider request carries them. On Claude, with the catalog's `token-count` framing, the pre-send estimate moves from 4.3% under the billed prompt to within 0.1%.

| Claude Opus 5.5, fresh session, 17 tools | estimate | vs truth |
|---|---|---|
| before the `token-count` framing (ef3293b) | 40,194 | −4.3% |
| `token-count` framing alone | 40,642 | −3.3% |
| `token-count` framing + this PR | 42,057 | +0.1% |
| truth: `count_tokens` 42,052 − 44 | 42,008 | |

| Other providers, this PR on ef3293b | before | this PR | truth |
|---|---|---|---|
| GLM-5.3 (Factory) | 25,257 (−4.4%) | 25,854 (−2.1%) | billed 26,420 |
| Kimi K3 (Factory) | 24,456 (−3.4%) | 25,278 (−0.2%) | billed 25,326 |
| GPT-6.1 Sol (Codex) | 25,433 (+0.2%) | 26,623 (+4.9%) | billed 25,384 |

`encodeRequestPrefix` (`packages/ai/src/request-prefix.ts`) asks the model's adapter for its system texts and one serialized definition per tool, through the builders `buildParams` uses. `Agent.requestToolsFor` returns the tools the loop sends that model (intent field, description pruning, an owned dialect's in-band prompt) and replaces `prunesToolDescriptions`. The tui context-usage helpers count that prefix, cached per prompt, roster, model, credential kind and tokenizer.

## Why

Before any turn there is no provider usage to anchor on, so omp estimates the prefix locally, and `main` counted each tool's name, description and schema as loose strings. On Claude that read the tools 19% under `count_tokens`: the injected intent field, JSON structure, per-tool flags and the OAuth `_` prefix were missing.

Decisions:
- The adapters encode, rather than a second copy of their shaping in the estimator; private builders are exported or split so both paths share them.
- Codex gets worse: +0.2% on `main`, +4.9% here. OpenAI re-renders the tool JSON it receives more compactly before counting it, so counting the JSON we send over-counts; `main` landed near zero only because its loose fields under-counted. Over-counting errs toward compacting early, and the correction belongs in the catalog `token-count` block.
- An anchor recorded by an older build would charge the estimator change as growth after upgrading (about +1,000 tokens on Claude). Snapshots carry a version; an older anchor rebases on its first reading and is charged only later changes.

## Testing

- `request-prefix.test.ts`: for each adapter family, including Anthropic with a model flag that conflicts with the request's OAuth option, the encoder equals the body the adapter hands `onPayload` (aborted, never sent).
- Fail on revert: the tui wire-definition count; an older-build anchor that later gains a tool or switches to a deferring model; the status-line memo across an OAuth or model change; a Cursor bridge keeping `requestToolsFor` memoized.
- Tables: omp over RPC with a real config, a captured warm-up so plugin tools settle, settled estimate plus prompt against `count_tokens` or a billed request with the same prefix bytes. Over 121 captured first-requests after a model switch the median error moves from −3.2% to −2.8%.
- `bun run check:ts`; ai, agent, tui and coding-agent context, session-stats, status-line and advisor suites.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
