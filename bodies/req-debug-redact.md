## What

I use `PI_REQ_DEBUG=1` dumps to debug providers, and every one of them had my bearer token written to disk in plain text, so this runs dump headers through the same redactor rejected-request dumps already use.

With `PI_REQ_DEBUG=1`, each request writes `rr-session-N.json` (request) and `rr-session-N.res.log` (response) to the working directory. On `main` both carry header values verbatim: `authorization`, `x-api-key`, `x-goog-api-key`, `cookie` on the request and `set-cookie` on the response. Those files are what users attach to bug reports.

| Dump | `main` | This PR |
|---|---|---|
| `rr-session-N.json` headers | `authorization: Bearer <token>` | `authorization: [redacted]` |
| `rr-session-N.res.log` headers | `set-cookie: <session cookie>` | `set-cookie: [redacted]` |
| Other headers, bodies, status line | as sent | unchanged |

`SENSITIVE_HEADER_PATTERN` in `utils/http-inspector.ts` (the name match 400 dumps use, `key|token|secret|auth|credential|cookie`) is now exported, and `redactedHeaderRecord` in `utils/request-debug.ts` applies it. That one function builds the header record for both files, so every caller is covered: `transportFetch`, Cursor's HTTP/2 path and the Codex WebSocket handshake.

## Why

Debug dumps are shared on purpose, and a credential in one is a leak the user did not choose. A second list of header names would drift from the 400-dump one, which was widened from a fixed list after it missed provider-specific spellings, so this reuses that pattern.

Related: #11488 proposed the same redaction alongside credential-store permissions and an auth-broker change; this PR carries only the dump redaction (its author credited as co-author), rebuilt on the current pattern-based redactor.

Non-goals: the request URL's query string stays in the dump (no provider here puts a credential in it; 400 dumps strip it because a custom `baseUrl` can), and request and response bodies are unchanged.

## Testing

- `bun test packages/ai/test/request-debug.test.ts`: 8 pass. Two new cases write a dump through `transportFetch` (a `Headers` object) and through `createRequestDebugSession` / `openResponseLog` with plain records (the socket transports' shape, including a multi-value `Set-Cookie`), and assert neither file contains the bearer token, `x-goog-api-key` or cookie values. The existing case that asserted the bearer token was written verbatim now expects `[redacted]`.
- Negative control: with the `src/` change reverted, 3 of 8 fail (the two new cases and the updated assertion), each showing the secret values in the written files.
- Live: `PI_REQ_DEBUG=1 omp -p --model anthropic/claude-haiku-5-5 --no-session "Reply with just: ok"` against Anthropic. On `main` the `/v1/messages` dump held the OAuth bearer token in plain text; on this branch it reads `authorization: [redacted]` and neither dump file contains the token. That response sent no `set-cookie`, so the cookie side is covered by the unit tests only.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
