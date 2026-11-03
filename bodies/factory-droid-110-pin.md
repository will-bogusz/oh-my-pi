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

Reading order: `FACTORY_DROID_CLIENT_VERSION` → `buildIdentityHeaders` and the `stream*Wire` functions in `providers/factory-droid.ts` → `omitStainlessTimeoutHeader` and `omitClaudeCodeAppHeaders` → `readWhoami` → `azure_anthropic` in `factory-droid.kdl`.

## Why

Since 0.248, droid removes every `X-Stainless-*` header and `x-api-key` from its Anthropic and OpenAI clients: the proxy reads none of them, and each counts against the host's 100-line request-header cap. Its Anthropic client never sent `x-app` or the browser-access header; on `main` they reached Factory because the shared Anthropic header builder adds them to every API-key request.

Decisions:
- The shared transports keep their defaults; the Factory wrapper opts out through two request options, so no other provider's headers change.
- The pinned Node runtime version existed only for the Stainless fingerprint and goes with it.

Maintenance: each droid release needs this version bump and a corpus recapture. The parity check now covers every removed header, so any of them coming back fails `factory-droid-native-parity.test.ts`.

Non-goals: droid 1.1.0's stream-deadline header and Responses WebSocket.

## Testing

- droid 1.1.0's own requests (captured against a local stub, no credits) carry none of the removed headers; its whoami carries `X-Factory-Whoami-Extended: true`.
- Live turns from this branch (read two files, reply with their sum), each answering `SUM=4817`: `kimi-k3` on Chat Completions, `minimax-m2.7` and `claude-haiku-4-5-20251001` on Messages, `gpt-6-luna` on Responses.
- New tests check that no Factory wire sends the removed headers even with a first-event budget set, that only whoami asks for the extended response, and that Azure Foundry gets eager tool streaming. With the source reverted, 6 fail.
- Native parity corpus recaptured with droid 1.1.0: 56 cases, adding Nemotron 3.5 Super, Muse Spark 1.2, Beam 1.0, GPT-6 Sol/Luna Fast and Opus 5.5 on Anthropic; `factory-droid-native-parity.test.ts` 57 pass. The capture account cannot run Muse Spark Open, GPT-6.1 Terra or Ultra Fast, so they have no case.
- The capture now deletes droid's cached feature flags before each case: droid 1.1.0 serves them while refetching, so two cases first recorded the previous case's upstream and failed parity until recaptured.
- `bun test`: `packages/ai` 6551 pass, `packages/catalog` 1315 pass. `bun run check:ts` flags formatting only in `tui.ts` and `interactive-click-focus.test.ts`, which this PR does not touch.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

