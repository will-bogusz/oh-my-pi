## What

I borrowed toks's piece cache for our offline tokenizer: the first time a word misses the vocabulary we still run the merges, but every repeat after that is one lookup, so counting a session's history for GPT and the other BPE models gets about a fifth faster.

Replaying the strings omp's `Tokenizer` counted for 184 of my own sessions, the median session's counting time under o200k (GPT models) goes from 4.6 ms to 3.7 ms and the total from 947 ms to 746 ms (21% less); the other BPE families save 11–17%. Claude models count through a separate engine and are unchanged.

| 184 real sessions, one Ryzen core | `main` | this PR | less time |
|---|---|---|---|
| o200k (GPT), median session | 4.6 ms | 3.7 ms | 20% |
| o200k (GPT), largest session | 44 ms | 33 ms | 25% |
| Six other BPE families, all sessions | 0.90–1.30 s | 0.80–1.08 s | 11–17% |

On fixed texts, 4,096-character messages count 11–24% faster on English, code and Markdown and 3–5% faster on Chinese; token counts match `main` everywhere.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/82957faa-ce7f-43f4-ae59-dde03250d3f3">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/0a5671ab-8f47-401b-bc90-a355cad04398">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/51f5eb21-0c9d-4bb0-a9b4-abdfb6168ab9">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/245a5d37-1c99-4724-a2d2-dabd74d48db8">
  <img width="780" alt="Token counting speed on one pinned Ryzen 9 5900X core, main against this PR, for seven tokenizer families on 4,096-character messages, median of three rounds: English 72–98 → 80–116 MB/s (11–23% faster), code 49–86 → 58–102 MB/s (17–24% faster), Markdown 52–73 → 61–86 MB/s (15–20% faster), Chinese 22–33 → 23–34 MB/s (3–5% faster). In every row each of this PR's rounds beat every round of main's, and token counts are identical to main." src="https://github.com/user-attachments/assets/0a5671ab-8f47-401b-bc90-a355cad04398" />
</picture>

<details><summary>Exact numbers (MB/s, Ryzen 9 5900X, range over the seven tokenizer families, median of three rounds)</summary>

| Text, 4,096-character messages | `main` | this PR | faster |
|---|---|---|---|
| English prose | 72–98 MB/s | 80–116 MB/s | 11–23% |
| Code (omp's TypeScript) | 49–86 MB/s | 58–102 MB/s | 17–24% |
| Markdown (omp's docs) | 52–73 MB/s | 61–86 MB/s | 15–20% |
| Chinese prose | 22–33 MB/s | 23–34 MB/s | 3–5% |

</details>

> **Tokenizer context.** `utok` splits text into word-sized pieces. A piece that is one vocabulary token costs one hash lookup; any other piece runs the BPE merge loop, about half of all counting time.

## Why

Pieces the vocabulary misses are 6–22% of the pieces in English, code and Markdown, and 64–84% of them repeat within a document; each repeat reran the merge loop. The memo keeps the merge count of every such piece of 2–15 bytes per thread, keyed by the piece bytes and the rank table's id, so entries stay exact across calls and Jev's base table can share it.

- **Per thread, not shared:** array counts run on the rayon pool, and a lock per piece would cost more than the probe saves.
- **Direct-mapped, 16 Ki slots (384 KiB per counting thread):** 4 Ki slots gave most of the gain; 64 Ki added about 1%.
- **Short pieces only:** 70–82% of Chinese misses are first sightings, and toks measured a long-piece cache as a loss on Chinese.

Non-goals: `encode` and the Claude families are untouched; Chinese needs toks's "premerge" (common characters start as one symbol), not a cache.

## Testing

- Real sessions: 184 transcripts from the last 30 days (80 Claude, 80 GPT, 24 other) loaded into omp's `Tokenizer` for their own model, recording every string it passed to `countTokens` after its caches. Each session replayed on a fresh thread through every family, `main` and this PR alternating, two rounds, one pinned Ryzen 9 5900X core. ClaudeV5 took 2.05 s on both arms, the control.
- Fixed texts: Pride and Prejudice and Dream of the Red Chamber (toks's bench corpora), 4.3 MB of omp's TypeScript and 4.4 MB of its Markdown; three alternating rounds on the Ryzen and on an M4 Max (19–30% faster there).
- `cargo test --release -p pi-natives --lib utok::`: 46 passed, including the tiktoken-rs differential and HF fixture suites, which now count through the memo.
- `memo_tests::other_tables_entry_in_the_probed_slot_is_recounted` plants another table's entry in the probed slot; with the table check removed it returns 999 instead of 4. `piece_memo_keeps_tables_apart` fails (2 instead of 4) when the memo is keyed by bytes alone.

<details><summary>Per-family numbers (MB/s, 4,096-character messages, median of three rounds)</summary>

Ryzen 9 5900X, one pinned core:

| Family | English | Code | Markdown | Chinese |
|---|---|---|---|---|
| o200k | 89 → 108 | 86 → 102 | 71 → 85 | 22 → 23 |
| cl100k | 94 → 112 | 63 → 74 | 69 → 80 | 30 → 31 |
| Qwen3 | 89 → 105 | 60 → 75 | 68 → 78 | 26 → 26 |
| DeepSeek V3 | 72 → 80 | 49 → 58 | 52 → 61 | 27 → 28 |
| Kimi K2 | 88 → 108 | 86 → 102 | 72 → 86 | 26 → 28 |
| GLM-5 | 98 → 116 | 66 → 78 | 73 → 83 | 25 → 26 |
| Jev | 90 → 104 | 65 → 78 | 68 → 80 | 33 → 34 |

M4 Max:

| Family | English | Code | Markdown | Chinese |
|---|---|---|---|---|
| o200k | 110 → 137 | 100 → 125 | 83 → 105 | 26 → 27 |
| cl100k | 114 → 148 | 72 → 91 | 81 → 100 | 36 → 38 |
| Qwen3 | 111 → 143 | 69 → 89 | 80 → 100 | 29 → 30 |
| DeepSeek V3 | 86 → 102 | 57 → 71 | 61 → 75 | 30 → 31 |
| Kimi K2 | 108 → 137 | 101 → 124 | 89 → 108 | 29 → 30 |
| GLM-5 | 118 → 154 | 76 → 95 | 84 → 105 | 29 → 30 |
| Jev | 111 → 138 | 76 → 94 | 81 → 99 | 42 → 43 |

The same text counted again on the same thread gains more (Ryzen: English 24–45%, code 22–27%). Two other toks ideas did not pay and were left out: a stack-allocated merge loop (flat), and the heap merge from 32 or 64 bytes instead of 128 (0–3% slower).
</details>
