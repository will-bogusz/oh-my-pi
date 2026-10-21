## What

I want each line in `~/.omp/logs` to say which session wrote it, because one omp process runs a session and all its subagents and the pid can't tell them apart.

On 6 recorded runs of a session that spawned two subagents, log lines naming the session that wrote them went from 10.9% → 81.0% (every line after startup), and `/debug` report bundles now carry that session's lines as `session-logs.txt`.

| Surface | `main` | This PR |
|---|---|---|
| Record written by a session's turn, prompt setup, queued-message hooks, `/compact`, `/handoff`, or an IRC or background-job delivery to it | `pid` only | `pid` + that session's `sessionId` |
| Record from an in-process subagent | same `pid` as its parent | its own `sessionId` |
| Record from a service every session shares (LSP client, DAP idle sweep, eval kernels) | `pid` only | `pid` only |
| `title-generator:`, DAP and eval kernel records | `sessionId` = a title request's provider id, a `debug-N` id or a kernel key | that value as `titleSessionId`, `debugSessionId`, `kernelSessionId` |
| `/debug` report bundle | `logs.txt`: last 1,000 lines of each same-day process log | also `session-logs.txt`: every same-day record of this session and its subagents |

## Why

Finding which session hit a provider error meant matching pid and timestamps against transcripts. On my last 5 days of logs, 95 of 145 provider-error lines came from processes that also ran subagents; of the 61 one transcript error confirms, "the pid's top-level session" was right 15 times (25%), and 84 match no transcript entry at all. `/debug` misses them too: on my busiest day 58,562 of 74,437 lines sat before the 1,000-line tails `logs.txt` keeps.

**Decisions.**
- An `AsyncLocalStorage` context in the logger (`logger.withContext`), not a `sessionId` at each call site, so providers, tools and compaction get it too. A nested context replaces the outer one.
- `sessionId` is a getter on the session manager, read per record, so it follows re-keys, including a session moved to a new file mid-turn.
- `Agent.logContext` covers `prompt()` and all of `continue()`; `AgentSession` enters it for prompt setup, `compact`, `shake`, `handoff`, and IRC and background-job delivery, where the sender's context is otherwise active. `agent.sessionId` can be a fresh provider id, so it is not used.
- A shared service started in one session's turn would keep that id forever; the LSP reader and idle timer, the DAP idle sweep, and eval kernel starts run under `logger.withoutContext`.
- A field passed to the log call wins, so existing callers that pass a real `sessionId` are unchanged; the ones that passed another kind of id now name it `titleSessionId`, `debugSessionId` or `kernelSessionId`.
- Log sinks (OTLP export) get the context's fields too, under the call's own.
- **Not in this PR:** records written before any session exists.

**Cost.** 0 ns per record outside a context, ≤31 ns inside (Mac, median of 9 × 1M records); +51 bytes per record that gains the field (+14% log bytes). A bundle reads today's logs whole: 0.5 s with 995 same-day files.

## Testing

Seven new tests (listed below) fail with `src/` reverted to `main` and pass here. Live: 6 `omp -p` runs per build, a Haiku session spawning two parallel subagents; with this PR all 136 records after startup carry the right id (88 main, 48 subagent). A real bundle for one: `logs.txt` 17,881 records, `session-logs.txt` exactly the session's 22. `bun run check:ts`; `bun test` in `utils`, `agent`, and `coding-agent` `test/{debug,lsp,task}`, `agent-session*`, `title-generator` (one failure, identical on `main`).

<details><summary>New tests</summary>

- `utils/test/logger-contract.test.ts` "stamps each record with its own async context, read live…": interleaved contexts across a timer, a getter re-keyed mid-run, a nested context, an explicit `sessionId`, `withoutContext`, a record outside any context.
- `agent/test/agent-log-context.test.ts`: `continue()` called from another session's context runs its dequeue hook and model request under the agent's context.
- `coding-agent/test/agent-session-log-context.test.ts`: a child session prompted inside its parent's model request; an IRC delivery whose recipient listener throws; a session moved off a replaced journal.
- `coding-agent/test/lsp/shared-client-log-context.test.ts`: a framing warning from an LSP client started by one session and used by another names neither.
- `coding-agent/test/debug/report-bundle-logs.test.ts`: records before the tail, a subagent header with JSON whitespace, another session's record and a nested-only `sessionId` left out.
- The failing pre-existing test: `agent-session-async-delivery` "links a background bash follow-up to the sink's raw capture…".

</details>

