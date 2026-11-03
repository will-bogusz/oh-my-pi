## What

id like to do some deeper research online on github and the web generally to learn more about sota tokenizers, and whether there are more appropriate native solutions we can find at the source of various providers/services

Gemini sessions now count context in Gemma's vocabulary, the one Google's own SDK counts Gemini in, instead of o200k: on 20 billed Gemini 3.8 Flash requests the local count of the request text goes from −9.4% to +1.1% of billed input (median).

| Billed Gemini 3.8 Flash requests (n = 20) | median | p10 | p90 |
|---|---|---|---|
| `main` (o200k) | −9.4% | −18.0% | −2.0% |
| This PR (Gemma 4) | +1.1% | −2.0% | +8.0% |

- `pi-natives`: `Encoding.Gemma4`, the Gemma 4 vocabulary (Apache-2.0); counts equal Hugging Face `tokenizers`, 57 MB/s, +1.1 MB addon.
- Catalog: `token-count { tokenizer "gemma4" }` for Gemini 2.x+ and Gemma 3+, baked into the 448 bundled rows they cover; Gemini 1.x stays on o200k.
- `models.yml` accepts `tokenizer: gemma4`; `omp toks` reports it.

Non-goal: chat-template specials count as text, as in every utok encoding.

## Why

Gemini had no local tokenizer, so context bars and compaction thresholds counted it in o200k, about 9% under Google's bill. Google's `python-genai` counts Gemini locally in Gemma vocabularies ([loader](https://github.com/googleapis/python-genai/blob/2eaf2d84e6cc3714eb5b5669fc26a2a1f5edf6c9/google/genai/_local_tokenizer_loader.py#L30-L60): Gemini 2.0–3 → Gemma 3, 3.1+ → `google/gemma-4-E4B-it`, the file embedded here).

**Decisions**

- **Gemma 4, not Gemma 3.** Gemma 3 is under the Gemma Terms of Use, which omp's MIT distribution cannot carry; Gemma 4 is Apache-2.0 (quotes below). The two share 262,125 of 262,144 pieces and give the same median here. The license and modification notice ship in `data/LICENSE.gemma4` and the addon's `THIRD-PARTY-NOTICES.txt`.
- **No merges list.** The 514,906 merges are every two-piece split of every merged piece in a fixed order; the packer proves the rebuild equals `tokenizer.json`, and the engine rebuilds it at load (54 ms once).
- **No scale or base**: the tokenizer alone lands at +1.1%.

**Maintenance.** A new Gemma vocabulary is a new pin in `tools/pack-gemma.ts`; its asserts fail if the merge order or segment cuts stop holding.

<details><summary>License texts relied on</summary>

- [Gemma Terms of Use](https://ai.google.dev/gemma/terms) (last modified April 1, 2026), §3.1: "You must include the use restrictions referenced in Section 3.2 as an enforceable provision in any agreement (e.g., license agreement, terms of use, etc.) governing the use and/or distribution of Gemma or Model Derivatives…" and "All Distributions (other than through a Hosted Service) must be accompanied by a "Notice" text file that contains the following notice: "Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms"". The page opens: "For Gemma 4 terms, see the [Gemma 4 license](https://ai.google.dev/gemma/apache_2)", which is the Apache License 2.0.
- [google/gemma-4-E4B-it @ ee0ef60](https://huggingface.co/google/gemma-4-E4B-it/blob/ee0ef6023621cff504d758262d4e04895a5af4a2/README.md) model card: `license: apache-2.0`; the repo has no NOTICE file. `tokenizer.json` sha256 `cc8d3a0c…bfe0f`, pinned in the packer.

</details>

## Testing

- Exactness: 4,304 texts (the 89 captured request bodies, 1,500 repo files, multilingual, CJK, emoji, digit and whitespace runs) count identically to HF `tokenizers` with added tokens off. 58 differ from Gemma 3 SentencePiece, each at one of its user-defined pieces such as `<table>`. `fixtures/gemma4.json` pins 43 cases by id in UTF-8, UTF-16 and UTF-32.
- Speed, 89 bodies: Gemma4 57 MB/s, Claude v5 39 MB/s, o200k 132 MB/s.
- Full omp estimate on the 20 requests (captured, never sent): median −11.1% → −0.7%; bodies replaying earlier Claude turns still overcount by up to 17% on content the Factory wire drops, outside the vocabulary. 263 anchored Gemini turn pairs: p90 |error| 0.55% → 0.07% of the billed prompt.
- The new `agent` test of a bundled Gemini row fails on `main`'s catalog and passes here.
- `cargo test -p pi-natives --lib utok`, catalog, agent, `bun check`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
