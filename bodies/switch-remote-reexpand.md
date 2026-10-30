## What

I had a feeling switching between models and providers was underexplored, and sure enough, switching away from a GPT model after an OpenAI remote compaction left the new model with nothing but a placeholder summary, so now it reads the real history behind that compaction.

On copies of long remote-compacted sessions, the next model answered questions about the compacted work at 0.00–0.05; with the history re-expanded it scored 0.92–1.00.

> **Remote compaction context.** OpenAI's remote compaction keeps the compacted history in an encrypted payload only the same provider's Responses API can replay; omp stores a placeholder summary beside it. Every other provider, including `openai` ↔ `openai-codex` and Codex → Grok, gets the placeholder, and the kept tail is hidden too.

| After an OpenAI remote compaction | main | this PR |
|---|---|---|
| Next request after `/model`, Alt+P, resume, retry fallback or context promotion to another provider | placeholder + turns since the compaction | the history behind it, from the newest compaction that model can read |
| New model's window can't hold that history | sends the small placeholder context | the pre-prompt threshold sees the rebuilt context; the new model compacts first |
| Retry fallback and context promotion candidates | sized against the placeholder context | sized against the history they would read |
| Alt+P / `/switch` / plan approve-and-compact compacting before the switch | may pick OpenAI remote compaction, unreadable for the target too | skips a native method the target can't replay |
| Switching back to the OpenAI model | | replays the native payload again |

<details><summary>Reading order</summary>

- `BuildSessionContextOptions.model`, `getReadableCompactionEntry` (`session-context.ts`): the context is built for the model that reads it.
- `readsOtherCompaction` (`session-provider-boundary.ts`) and `#setModelWithProviderSessionReset` (`agent-session.ts`): a switch rebuilds the messages when the two models stand on different compactions; resume and session switch build for the adopted model.
- `prepareCompaction` (agent `compaction.ts`): a trailing compaction the model can't read re-expands instead of reporting nothing to compact.
- `contextFitsModel`, `resolveContextPromotionTarget`, and `compact()`'s method order with `CompactOptions.readerModel` (`session-maintenance.ts`).
</details>

## Why

Compaction preparation already skips such a boundary (#6343), but only at the next compaction, and the threshold check ran on the tiny placeholder context, so that compaction waited until the context filled up again.

<details><summary>Scores (prototype of this change)</summary>

Real sessions compacted remotely on Codex, then switched; probes graded by a model from another family. Claude 0.01 → 0.98 (n=16), Grok 0.00 → 0.96 (n=20), Gemini 0.05 → 1.00 and GLM 0.00 → 0.92 (n=5 each); Kimi K3, whose 197K window needed a compaction first, 0.00 → 0.64 (n=5). The kept tail alone gained only +0.13–0.15.
</details>

- The context is rebuilt only when the two models stand on different compactions; other switches keep the live message list as on main.
- Retry fallback skips a candidate whose re-expanded history doesn't fit its window (the existing never-switch-onto-an-oversized-request rule) instead of switching onto a placeholder; a later chain entry that can read the payload still qualifies.
- Non-goals: snapcompact archives on text-only models, and Anthropic server compaction of an oversized re-expanded history (#14081, which falls back to soft).
- Maintenance: readability is `canReplayRemoteCompaction`; a new provider-bound payload type extends it, and the switch tests fail if it doesn't.

## Testing

- `agent-session-remote-compaction-switch.test.ts` drives a real `AgentSession`: after `setModel(claude)` the request carries all 6 compacted turns and no placeholder, and switching back sends the native payload; a 64K-window Claude target compacts before its first request; compacting for a reader commits a soft summary, with or without `compaction.remoteEndpoint`. With the source reverted, the first two fail (0 turns sent; no compaction).
- Plan approve-and-compact passes the model it restores; unit tests cover the reader-aware build, `contextFitsModel`, the trailing `prepareCompaction` case and `canReplayRemoteCompactionFrom`.
- Live: resumed a copy of a Codex session remote-compacted from 340K tokens over RPC in an isolated agent dir and ran `set_model anthropic/claude-opus-5-5`. main keeps 2 messages, one the placeholder; this PR has 253 and no placeholder, and Claude's answer (494K input tokens) named the session's first task and file. Opus because the history needs its 1M window.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated (if user-facing)
