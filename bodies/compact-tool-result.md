## What

I kept running `/compact` while a long `wait` was still going, and afterwards the session file had the call with no result, so the model got "No result provided" instead of what the tool returned.

`/compact`, `/new` and a session switch now keep the interrupted tool's result in the session they rewrite or leave, as Esc already does.

| Running tool interrupted by | `main` | this PR |
|---|---|---|
| Esc | result saved | result saved (unchanged) |
| `/compact` | call saved without its result; the next request and every resume get a synthetic "No result provided" | result saved before the compaction reads the session |
| `/new`, session switch | the old session's file ends at the bare call | the old session's file keeps the result |

Non-goals: a reply still streaming when `/compact` lands stays unsaved, as on `main`; `dispose()` (shutdown) does not abort first and is not touched.

## Why

Each of these transitions calls `#disconnectFromAgent()` before `await abort()` on purpose: the comment in `#drainStrandedQueuedMessages` explains that a connected abort would auto-resume a stale turn into the old context. But the result the abort gives a running tool is emitted during that same `abort()`, so its `message_end` reaches no persisting handler. The result stays in `agent.state.messages` only, the session file never gets it, and `transform-messages.ts` papers over the gap with a synthetic result.

Fix: `#disconnectFromAgent()` records the agent's message count, and `abort()` persists the tool results past that count through the existing `#persistSessionMessageIfMissing` right after `waitForIdle()`, once per disconnect. The disconnect order is unchanged, and a connected abort does exactly what it did, since the count is only set while disconnected.

Decisions:
- One hook in `abort()` rather than a call in each transition: all three share the disconnect-then-abort order and the same loss.
- Only messages that ended after the disconnect, not every unpersisted message at the tail, so rewind-skipped results and other deliberately unsaved messages stay out.
- Tool results only. An aborted assistant message would also need the abort-flag stamping and reply bookkeeping `#processAgentEvent` does on `message_end`; that is a separate change. The call itself was saved when its assistant turn ended, before the tool started, which the test asserts.

## Testing

Live, over RPC with `anthropic/claude-haiku-5-5`: prompt "run `sleep 120`", send `compact` 1.5 s after `tool_execution_start`, then read the session file.

| | toolResult entries for the call | compaction entries |
|---|---|---|
| `main` (fix reverted) | none | 1 |
| this PR | 1 (`Command aborted`) | 1 |

`test/agent-session-compact-running-tool.test.ts` runs a real `AgentSession` on a file-backed session with the mock provider; the model calls a tool that settles only when its signal aborts. On tool start the test runs `compact()`, `newSession()` or `switchSession()`, reopens the old session file from disk, and expects the call's assistant entry followed by its toolResult. With the fix: 3 pass. Fix reverted: 3 fail, each with only the assistant entry.

Neighbouring suites pass: compaction cancellation, auto-compaction queue, `/new` queued steer, prompt-abort race, silent abort, compaction, compaction lifecycle, switch previous context. `bun run check:ts` passes; no Rust changed, so `check:rs` was not run.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
