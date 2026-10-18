## What

I changed omp to cap tool names longer than 64 characters on Factory Droid's chat-completions wire, as droid does: such a name becomes its sanitized first 55 characters, `_` and an 8-character hash. Names of 64 characters or fewer go out exactly as before, dots included. Returned calls are mapped back to the caller's tool name. This wire serves the Droid Core models: Kimi, GLM, DeepSeek, Qwen, Inkling, Mistral, Nemotron and MiniMax M3.

- **Declarations** of long names carry the capped name; shorter names are unchanged.
- **Replayed calls and results** carry it too, so they stay inside the route's 64-character limit (`tool-call-names.kdl`). A forced `toolChoice` names the encoded tool.
- **Returned calls** go back to the tool that was declared, using the same wire→caller map as the Gemini path. If two long tools cap to the same name, the request is refused before anything is sent.

The sanitizer and the map move out of `factory-droid/gemini.ts` into `factory-droid/tool-names.ts`. Gemini keeps its full sanitizer; chat completions applies it only above 64 characters.

| Tool name (73 chars) | Declared before | Declared after |
|---|---|---|
| `mcp__long_server__…__tttttttttttttttt` | verbatim (73) | `mcp__long_server__…long_server_7c6fd6f9` (64) |

## Why

Before this change, omp declared long names unchanged. The route limit is 64, so `transformMessages` dropped every replayed call to such a tool, along with its result. The model never saw the output of the call it had just made. Droid caps chat-completions names at 64 on declaration and replay; mapping returned calls back to the caller's name is omp's addition, so calls dispatch to the declared tool.

## Testing

- `factory-droid-completions-reasoning.test.ts` on Kimi K3: a 73-character tool declared and replayed under its pinned 64-character name with its result kept; forced `toolChoice` in both shapes; parallel long and short calls, with `toolcall_start`/`toolcall_end` naming the caller's tool; two long names that cap alike refused with nothing sent. Each fails without the change. A dotted short name (`mcp.server.tool`) still goes out verbatim, as on `main`.
- Live, `factory-droid/kimi-k3` with an extension tool named `mcp__some_long_server_name__some_long_tool_name_that_exceeds_limits`: the model called it and answered with its result. The follow-up request carried the 64-character call and its tool result.
- Ran the full `packages/ai` suite and `bun run check:ts`, which includes oxlint and oxfmt. `check:rs` was not run; no Rust changed.

---

- [ ] `bun check` passes (see Testing for what ran)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
