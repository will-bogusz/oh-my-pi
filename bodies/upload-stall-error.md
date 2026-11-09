## What

<!-- OWN-WORDS: Will's sentence goes here, first. -->

An Anthropic turn whose connection drops before any response now says how far the request got, instead of a bare `Connection error.`:

| Where the connection dropped | `main` | This PR |
|---|---|---|
| While the request body is still uploading | `Connection error.` | `Connection error: connection lost after 15.3s while uploading the 6.2MB request body; no response received (ECONNRESET).` |
| After the whole body was sent, before a response | `Connection error.` | `Connection error: connection lost after 20.1s, after the 6.2MB request body was sent and before any response (ECONNRESET).` |
| Before the connection is up (DNS, refused, TLS) | named by `networkFailureMessage` | unchanged |

The error is still an `AnthropicConnectionError`, so retries treat it exactly as before.

## Why

A long session sent a 6.2 MB (gzip) request over a link that resets connections about 15 s into a saturated upload. Every attempt died mid-upload, omp retried for about 37 minutes, and the session ended with `Retry budget exhausted after 10 retries: Connection error.` Nothing said the body never finished uploading; finding that took `netstat` (Send-Q stuck at 3-4 MB) and a request dump. With the size and upload state in the message, the first failure points at the request size and the uplink.

How it works: `coworkFetch`, the `node:https` transport first-party Anthropic requests use, notes when TLS is up and when the request emits `finish` (the whole body handed to the socket). A request error after connect and before response headers becomes a `ConnectionLostBeforeResponseError` with the original error as `cause`, so code- and text-based classification still see it, and `AnthropicConnectionError` uses its sentence. Errors before the connection is up, and aborts and timeouts, keep their own errors.

Decisions:
- "Sent" means handed to the OS socket, not acknowledged by the server; `finish` is the signal both Bun and Node give. A body smaller than the kernel send buffer can read "sent" while still in flight; the size still points at the cause.
- No uploaded-byte count: under Bun, `socket.bytesWritten` already reports the whole body while most of it is still queued in the process, so it would mislead.
- Scope is the cowork transport. The Bun `fetch` fallback (proxied requests, non-https base URLs, `Request` inputs) cannot carry this: `fetch` has no event for the request body finishing, and streaming the body to watch it would switch the request to chunked encoding. Those requests keep `Connection error.`

Non-goals: `Request timed out.` and other providers.

## Testing

- `packages/ai/test/cowork-fetch-upload-error.test.ts`: a local TLS server that never responds reads part of a 32 MB body and destroys the socket, or reads all of it and then destroys it. Through `AnthropicMessagesClient` on `coworkFetch`, the two messages differ by upload state, both name `32.0MB`, and `AIError.retriable` holds. With the `cowork-fetch.ts` change reverted, both fail on `Connection error.`
- Real provider path: `stream()` with an `anthropic` / `anthropic-messages` model pointed at the same kind of server (its CA through `NODE_EXTRA_CA_CERTS`), the provider's 5 client retries included:

  | Server | `main` | This PR |
  |---|---|---|
  | drops after 256 KiB of a 32 MB body | `Connection error.` | `Connection error: connection lost after 43ms while uploading the 32.0MB request body; no response received (ECONNRESET).` |
  | drops after the whole body | (not run) | `Connection error: connection lost after 58ms, after the 32.0MB request body was sent and before any response (ECONNRESET).` |

  Both ended `stopReason: "error"` after 11 connections (retries unchanged on both).

- `bun check` in `packages/ai`.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
