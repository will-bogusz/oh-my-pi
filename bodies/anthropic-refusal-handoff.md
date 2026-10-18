## What

When Claude declined partway through a response and Anthropic handed it to the fallback model, omp could still run the tool call the declining model had started, so I now keep that model's tool calls and reasoning out of the turn and hold tool-call events until the response ends on requests with fallbacks enabled.

> **Fallback context.** With server-side fallback (`fallbacks` on the request), a model that declines mid-response hands it to a fallback model at a `fallback` block in the stream.

Case: the declining model reasons and starts `read a.txt`, declines, and the fallback model answers and calls `read notes.txt`.

| Surface | `main` | This PR |
|---|---|---|
| Finished turn | both calls, both models' reasoning | `notes.txt` call, fallback model's reasoning, text from both |
| Tools run by the agent | both | `notes.txt` only |
| Speculative launch (`task` batches, speculative `read`) | starts on the declined call while the response streams | never sees it |
| Auth-gateway clients | receive the declined `tool_use` | never receive it |
| Response that breaks after the handoff | error turn keeps the declined call, and transient-error recovery runs it | error turn has no declined call |
| Next request | replays the declined call and reasoning | replays only what was kept |

**Trade-off:** on requests that carry `fallbacks`, tool-call events arrive when the response ends instead of while the call streams, so the pending tool card and speculation start later. Text and thinking still stream live, and requests without `fallbacks` are unchanged.

## Why

The fallback model never saw the declined call, yet omp treated it as the serving model's: speculation and the auth gateway acted on it mid-stream, and the agent ran it after. Replaying reasoning signed on both sides of a handoff is also refused by the API. Text stays because the fallback model continued from it.

Decisions:
- One place, the shared Anthropic transport (`providers/anthropic.ts`), so direct Anthropic, Factory and other Anthropic-messages routes behave the same.
- Holding, not retracting: nothing downstream can take back a call it was shown, and a call is only known to be declined once the `fallback` block arrives.
- The `done`/`error` message gets a new content array (`withoutDeclinedFallbackOutput`); the live `partial` and released events keep the stream's indices, because queued events index into them.

Residuals: a gateway that turns fallbacks on for a request without `fallbacks` gets the drop but not the held events. A turn the user aborts after the handoff loses the declined call but keeps the declining model's reasoning.

Maintenance: if Anthropic renames the `fallback` block, nothing is dropped and behaviour returns to `main`'s.

## Testing

Scripted SSE over the provider's `fetch` option, no network:
- `packages/ai/test/anthropic-fallback-handoff.test.ts` (7): finished turn, tool-call events, a response cut after the handoff, auth-gateway SSE, replay with and without the marker, live events when fallbacks are off.
- `packages/agent/test/anthropic-fallback-handoff.test.ts` (3), agent loop with stream speculation on: the declined call never opens a session or runs; a cut response runs nothing; an abort after the handoff keeps it out.

With the transport change reverted, 9 of the 10 fail; the tenth (fallbacks off) passes on `main` by design and fails if events are held on every request. The full `packages/ai` and `packages/agent` suites, the coding-agent speculation tests and `bun run check:ts` pass.

Not run: a live handoff, since a refusal fallback cannot be triggered on demand.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
