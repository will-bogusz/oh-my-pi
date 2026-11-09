## What

When my uplink stalled mid-upload, Codex and xAI just said ECONNRESET with no hint the request never finished uploading, so now every provider says whether its request body was still uploading or already written when the connection drops, the way Anthropic does.

A connection that drops before any response on any request sent through Bun's `fetch` now names when it dropped, whether the request body was still uploading, and its size, instead of the runtime's socket error:

| Provider path | `main` | This PR (32 MB body, local server) |
|---|---|---|
| OpenAI Responses and Completions, Codex (HTTP and its websocket's SSE fallback), xAI, Gemini, Gemini CLI, Antigravity, Factory Droid | ``ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()`` | `Connection error: connection lost after 2ms while uploading the 32.0MB request body; no response received (ECONNRESET).` |
| Anthropic-compatible endpoints (Z.ai, gateways), and Anthropic through a proxy or an `http://` base URL | `Connection error.` | same as above |
| Any of these, server reads the whole body first | as above | `Connection error: connection lost after 21ms, after the 32.0MB request body was written to the socket, before any response (ECONNRESET).` |

Retries are unchanged: same attempts and classification as `main`.

Non-goals: bodies under 1 MB, timeouts and aborts, and websocket errors.

## Why

Only Anthropic's own transport named the upload state; everything else goes through Bun's `fetch`, which has no event for the body finishing.

How: `transportFetch` and the cowork transport's `fetch` fallback send a body of 1 MB or more as a `ReadableStream` with an explicit `Content-Length`. Bun keeps that framing and pulls the stream only as the socket drains, so bytes pulled tell uploading from written. A socket closed before the response becomes `ConnectionLostBeforeResponseError` (original error as `cause`).

Decisions:
- **1 MB threshold:** a smaller body fits in the socket buffers and would always read "written", so it keeps Bun's own handling.
- **Only socket-close errors are wrapped:** Bun pulls a chunk even for a refused connect, so connect failures, aborts and timeouts keep their errors. The new text matches every transient pattern the old did; remote compaction matched only the old wording, so it accepts the new error too.
- **Redirects:** Bun cannot replay a streamed body, so redirects are followed here as `fetch` does (307/308 resend the body, 303 becomes a GET, credentials dropped across origins).
- Proxies (forward and CONNECT) checked; `Request` inputs and a caller's own `fetch` untouched; size is after compression.
- **Websockets:** a failed Codex websocket send falls back to SSE, whose error is the one surfaced.

Maintenance: if Bun buffers the stream eagerly, the mid-upload test fails.

## Testing

- `packages/ai/test/transport-fetch-upload-error.test.ts`: a server that never responds drops after 256 KiB of a 32 MB body, or after all of it; the messages differ by upload state and stay retriable, through `transportFetch` and `AnthropicMessagesClient`. A 64 KB body keeps Bun's error; a 307 uploads once to the new location and names the drop there; a cross-origin 303 becomes a GET without credentials. Each fails with its source change reverted.
- `packages/agent/test/remote-compaction.test.ts`: the new error is retried; fails without the compaction change.
- `stream()` per provider in the table against a local TLS server, retries included: the messages above, with `main`'s `errorId` and attempt counts (OpenAI Responses 6, Completions 12, Codex 6, Codex websocket then SSE 7, xAI 6, Gemini 1, Gemini CLI 4, Antigravity 4, Factory Droid 6, Anthropic-compatible 11, Anthropic over `http://` 11).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
