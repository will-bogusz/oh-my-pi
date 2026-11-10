## What

I moved omp's Factory Droid identity up to droid 1.7.1 and picked up the two request changes that release makes, so Factory sees omp's requests the way it sees the current CLI's.

| On Factory requests | `main` (droid 1.1.0 shape) | This PR (droid 1.7.1 shape) |
|---|---|---|
| `User-Agent` / `X-Client-Version` | `factory-cli/1.1.0` / `1.1.0` | `factory-cli/1.7.1` / `1.7.1` |
| `X-Factory-Request-Surface` (inference, model discovery, `/usage`, image generation) | not sent | `cli_tui` |
| Prefix-bound Claude (Opus, Sonnet and Haiku 5.5, Opus 5.5 Fast, Fable 5.1) on Factory's direct Anthropic upstream | no `thinking.block_binding` | `block_binding: drop_block` plus the `thinking-binding-controls-2026-08-01` beta, as the Azure Foundry upstream already gets |

> **Factory context.** omp's `factory-droid` provider presents itself to Factory's proxy as the `droid` CLI, so the version pin and these headers are its client identity. `X-Factory-Request-Surface` is the usage-attribution field the CLI's interactive terminal UI sends on every call. `drop_block` tells Anthropic to discard a signed thinking block whose earlier context changed (a tool added mid-session, a re-rendered reminder) instead of rejecting the request.

Reading order: `factoryDroidClientHeaders` (`catalog/src/wire/factory-droid.ts`) → `on-upstream "anthropic" "azure_anthropic"` in `factory-droid.kdl` → the recaptured corpus.

## Why

droid 1.7.1 sends `drop_block` on the direct Anthropic upstream as well as Azure Foundry, for the same prefix-bound models; the KDL comment's premise (only Azure enforces the prefix check, other upstreams predate enforcement) no longer holds for the Claude API. Vertex and Bedrock are unchanged, as in the CLI.

Decisions:
- One `cli_tui` value for every omp request: omp is an interactive harness, and `exec`'s value comes with exec input/output format headers that describe the CLI's own flags, not anything omp has.
- The surface header goes in the shared identity helper, so discovery, usage, inference and image calls agree.

Maintenance: each droid release needs this version bump and a corpus recapture; `factory-droid-native-parity.test.ts` fails on drift.

Non-goals: the models droid 1.7.x adds, image `complexity`/GIF controls, the Responses WebSocket.

## Testing

- Live through the branch's provider on a Factory login, one plain turn each, all 200 with `factory-cli/1.7.1` and `X-Factory-Request-Surface: cli_tui` on the wire: `claude-haiku-5-5@anthropic` and `claude-opus-5-5@anthropic` (both carrying `drop_block` and the beta), `gpt-5.4-mini@openai` (Responses).
- `omp -p` two-read turn (read two files, reply with their sum) answered 42 on `claude-haiku-5-5` (Messages) and `gpt-5.4-mini` (Responses).
- A replay of a signed-thinking turn under a changed system prompt on `claude-haiku-5-5@anthropic` returned 200 with and without `drop_block`: the change follows the CLI's request shape; no rejection was reproduced on `main`.
- Native parity corpus recaptured with droid 1.7.1: 58 cases, adding Gemini 4 Argon and Haiku 5.5 on Anthropic (the account is now entitled to Haiku 5.5). The corpus shows droid sending `drop_block` on `claude-opus-5-5@anthropic` and `claude-opus-5-5-fast@anthropic`; `factory-droid-native-parity.test.ts` 59 pass. With the KDL rule reverted, those two parity cases and three binding rows in `factory-droid-anthropic.test.ts` fail.
- `bun test` (`env -i`): `packages/ai` `test/factory-droid*.test.ts` 289 pass; `packages/catalog` `test/factory-droid*.test.ts` 51 pass. `check:types` clean for both packages.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
