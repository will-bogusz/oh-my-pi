## What

I made omp shorten, on Factory Droid's Gemini models, a tool name longer than 64 characters to exactly 64, hash included, so that calls to long-named tools (most MCP tools) stay in the conversation.

`sanitizeFactoryDroidToolName` used to keep the first 64 characters and then add `_` and an 8-character sha256, which comes to 73. The route's tool-name limit is 64 (`tool-call-names.kdl`, `factory-droid-agent`), so `transformMessages` treated every such replayed call as undeclarable and dropped it, and its tool result along with it. The name now keeps the first 55 characters, then `_` and the hash of the full sanitized name. That is what droid's `sanitizeToolNameForProvider` does, and the result is the same on every request.

This covers the Gemini wire only. Factory's chat-completions wire (Kimi, GLM, DeepSeek and the other Droid Core models) declares long names unchanged and drops the same calls; that fix is a separate change.

| Name | Before | After |
|---|---|---|
| `mcp__some_long_server_name__some_long_tool_name_that_exceeds_limits` | `…that_exceeds_lim_4a148750` (73) | `…that_ex_4a148750` (64) |

## Why

The model sent the call and omp ran it, but the next request left out both the call and its result. The model never saw the output, so it called the tool again. In a live run on `main` with one long-named custom tool, the turn took 6 requests and each follow-up was missing the call. With this change, the second request carries the call and its `functionResponse`, and the turn is done in two.

## Testing

- `factory-droid-gemini.test.ts`: the long-name case checks that the declared name is 64 characters, the same on the next request, and that the replayed `functionCall` and `functionResponse` both survive. It fails on `main`. It replaces the old case that asserted the 73-character shape.
- Live, `factory-droid/gemini-3-flash-preview` with an extension tool named as above: the model called it, got the result and answered with it. The second request carried the 64-character call and its response.

---

- [ ] `bun check` passes (ran `bun run check:ts`, which includes oxlint and oxfmt, and the full `packages/ai` suite; `check:rs` not run, no Rust changed)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
