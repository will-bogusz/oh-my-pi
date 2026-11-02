## What

I bumped omp's Factory Droid identity to droid 1.1.0 and dropped the SDK and Claude Code headers droid itself no longer sends, so a Factory request from omp looks like one from the current CLI again.

| On Factory requests | `main` (droid 0.237 shape) | This PR (droid 1.1.0 shape) |
|---|---|---|
| `User-Agent` / `X-Client-Version` | `factory-cli/0.237.0` / `0.237.0` | `factory-cli/1.1.0` / `1.1.0` |
| `X-Stainless-*` (lang, runtime, OS, arch, package version, retry count, timeout) | Messages, Responses, Chat Completions | none |
| `x-api-key: placeholder` | Messages | none |
| `x-app: cli`, `anthropic-dangerous-direct-browser-access: true` | Messages | none |
| `X-Factory-Whoami-Extended: true` | none | whoami only |
| Claude via Azure Foundry, with tools | no eager tool input, no tool-streaming beta | per-tool `eager_input_streaming` and `fine-grained-tool-streaming-2025-05-14`, like the Anthropic and Vertex routes |

> **Factory context.** omp's `factory-droid` provider presents itself to Factory's LLM proxy as the `droid` CLI, so the version pin and header set are its client identity. `X-Stainless-*` is telemetry the Anthropic and OpenAI SDKs add on their own.

Reading order: `FACTORY_DROID_CLIENT_VERSION` → `buildIdentityHeaders` and the `stream*Wire` functions in `providers/factory-droid.ts` → `omitStainlessTimeoutHeader` (`openai-responses.ts`, `openai-completions.ts`) and `omitClaudeCodeAppHeaders` (`anthropic.ts` → `buildAnthropicHeaders`) → `readWhoami` → `azure_anthropic` in `factory-droid.kdl`.

## Why

Since 0.248, droid removes every `X-Stainless-*` header and `x-api-key` from its Anthropic and OpenAI clients: the proxy reads none of them, and each counts against the host's 100-line request-header cap. Its Anthropic client never sent `x-app` or the browser-access header; on `main` they reached Factory because the shared Anthropic header builder adds them to every API-key request.

Decisions:
- The shared transports keep their defaults; the Factory wrapper opts out through two request options, so no other provider's headers change. A KDL axis would add a `models.yml` knob for headers only this wrapper owns.
- The pinned Node runtime version existed only for the Stainless fingerprint and goes with it.

Maintenance: each droid release needs this version bump and a corpus recapture. The parity projection now covers `x-api-key`, every `X-Stainless-*`, `x-app` and the browser-access header, so any of them coming back fails `factory-droid-native-parity.test.ts`.

Non-goals: droid 1.1.0's new models (separate PR), its stream-deadline header, the Responses WebSocket.

## Testing

- droid 1.1.0's own requests, checked without spending Factory credits on Messages, Responses and Chat Completions, carry none of the removed headers; its whoami carries `X-Factory-Whoami-Extended: true`.
- Live turns from this branch (read two files, reply with their sum): `kimi-k3` on Chat Completions and `minimax-m2.7` on Messages both answered `SUM=4817`. Not run: a live Responses turn; those models bill from the Standard pool, which answered 402 (5-hour window used up).
- New tests check that no Factory wire sends the removed headers even with a first-event budget set, that only whoami asks for the extended response, and that Azure Foundry gets eager tool streaming. With the source reverted, 6 fail.
- **Native parity corpus recaptured with droid 1.1.0 (`bun packages/ai/scripts/capture-factory-droid-native.ts --droid <droid 1.1.0>`): ⟪TO FILL IN: parity cases passing / total⟫**
- `bun test` in `packages/ai` and `packages/catalog` and `bun run check` in both pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
