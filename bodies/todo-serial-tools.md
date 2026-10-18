## What

Codex [flagged this on #15402 after it merged](https://github.com/can1357/oh-my-pi/pull/15402#pullrequestreview-5538618677): the todo guidance tells every model to send `todo` in the same response as another tool call, but ChatGPT-login models on Responses Lite can only make one call per response, so for them I scoped that rule to parallel tool calls and gave them a fallback they can actually follow.

`applyCodexResponsesLiteShape` forces `parallel_tool_calls = false` for every `openai-codex` model the catalog marks `useResponsesLite` (GPT-6.1 Sol, GPT-6 Sol/Luna/Astra, GPT-5.6 Sol/Luna/Terra). The todo tool prompt, the system prompt's Decompose line and the forced eager-todo reminder rendered the batching rule unconditionally, so those models were told to do something the transport refuses.

| | Parallel tool calls | One call per response |
|---|---|---|
| Before | send `todo` beside the next real call | same instruction, impossible to follow |
| Now | unchanged | skip `start` (`done` already starts the next pending task) and call only when task state changes |

## Why

Each `todo` call on a serial transport is a full model round trip. Of the updates the prompt asks for, `start` is the one the tool already does by itself: after a `done` with no task active, the earliest pending task starts.

Gating the rule on the transport instead was rejected: the todo description is rendered once when the tool is built, so a model switch mid-session would leave it stale, and the catalog has no provider-wide parallel-tool-call capability (`useResponsesLite` is Codex's, `supportsParallelToolCalls` Devin's). The gate would need a new capability field and re-rendering for a few words of prompt.

## Testing

Prompt-only change, so no new test. `test/system-prompt-inventory.test.ts` (37 pass) still finds the todo-only-turn rule exactly when `todo` is in the tool set; `test/agent-session-eager-todo.test.ts` and `test/tools/todo.test.ts` pass.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
