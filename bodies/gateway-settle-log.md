## What

The gateway's debug log told me it was retrying after every usage-limit error, but it only retries when it switches to another credential, so most of those lines described a retry that never happened.

On a gateway I run, all 40 usage-limit lines over two days said "retrying provider request after usage-limit block" while carrying `switched=false`: no credential switch, and the error went straight back to the client. Now the line names what the gateway actually did:

| `markReached` result | Debug line on main | Debug line now |
|---|---|---|
| `switched: true` (request is retried on an unblocked sibling credential) | `auth-gateway retrying provider request after usage-limit block` | unchanged |
| `switched: false` (no unblocked credential to switch to, or the failed one is no longer tracked; original error returned) | `auth-gateway retrying provider request after usage-limit block` | `auth-gateway usage-limit block, returning the error without retry` |

The fields (`format`, `provider`, `peer`, `switched`, `retryAfterMs`, `retryAtMs`, `error`) and the level are unchanged, so anything filtering on `switched` keeps working.

## Why

An operator reading the log after a client reported a usage-limit failure sees "retrying" and looks for a second attempt that is not there. `switched=false` was the only hint, and it contradicts the message. The new text names the decision, not a cause: `markReached` returns `switched: false` both when no sibling is free and when the failed credential was replaced mid-request, and the log cannot tell those apart.

Non-goals: the level stays `debug`; the credential-invalidation line next to it is accurate (that branch always re-resolves) and is untouched.

Related: #16560 adds a per-request line for how a streamed gateway reply ends; this PR touches only the usage-limit line in `dispatch.ts`.

## Testing

- New test in `packages/ai/test/auth-gateway-thinking-loop.test.ts`: a gateway with one stored credential whose provider returns a 429 `insufficient_quota`. The request fails, the provider is called once, and the single usage-limit debug line carries `switched: false` and does not say "retrying". The existing two-credential rotation test now also asserts its usage-limit line says "retrying" with `switched: true`.
- Negative control: with `main`'s `dispatch.ts` restored, the new test fails (`Expected to not contain: "retrying"`, received `auth-gateway retrying provider request after usage-limit block`); with the fix, 4/4 pass.

```
cd packages/ai && bun test test/auth-gateway-thinking-loop.test.ts
```

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
