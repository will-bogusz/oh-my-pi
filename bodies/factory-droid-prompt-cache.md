## What

I made Factory Droid's Claude models able to use Anthropic's 1-hour prompt cache, and brought them under omp's cache warmer and cache-timed idle compaction. On `main`, `long` retention still wrote 5-minute entries there, and neither the warmer nor #16198's compaction timer knew the entry lifetime.

| factory-droid Claude, Anthropic upstreams | `main` | This PR |
|---|---|---|
| Retention `long` | 5m entries (`ttl` dropped) | 1h entries, no beta header |
| Retention `short` (default) | 5m entries | 5m entries, unchanged |
| Cache warmer | never schedules (no lifetime declared) | replays at 4.5 min; moves to 54 min once a response reports a 1h write |
| Idle compaction (#16198) | falls back to the plain idle timeout | timed to the entry lifetime |

The default stays `short`.

## Why

Factory's proxy accepts `ttl: "1h"` and reports `ephemeral_1h` writes, but returns 400 when the request also carries the `extended-cache-ttl-2025-04-11` beta, which omp adds to API-key requests with a 1h breakpoint. Only Vertex rawPredict skipped it, by URL. Enabling long retention alone would turn every Factory `long` request into a 400 that the `cache_control` rejection fallback does not catch.

So the runtime Vertex URL check stays, and a compat axis, `extended-cache-ttl-beta`, lets a route opt out as well; unset, Vertex and direct API keys are unchanged. Factory Droid sets it `#false` and sets `supports-long-cache-retention` on the four upstreams that passed a live check; Snowflake was not probed and keeps 5m.

**Decisions.**
- An opt-out axis, not a second URL check: Factory's upstreams share one URL.
- The warmer starts Factory requests on the 5m tier and adopts 1h from the response, since long support is resolved per upstream.

**Maintenance.** A new Anthropic upstream, or Factory accepting the beta, is one KDL line. A rejected `ttl` returns a 400 naming `cache_control`, which omp already retries without `ttl`.

Related: #15505, #16198, #13965, #14867, #15764.

## Testing

Live on 2026-10-18, through omp's factory-droid provider with the upstream pinned, `ttl: "1h"` on every breakpoint, one request per cell (Haiku 4.5 on anthropic, vertex and bedrock; Factory's Azure route has no Haiku deployment, so Opus 4.6 there):

| Upstream | `ttl: "1h"`, no beta | reported write | `ttl: "1h"` + beta |
|---|---|---|---|
| `anthropic` | accepted | `ephemeral_1h` 15,050 | 400 `Unexpected value(s) extended-cache-ttl-2025-04-11` |
| `vertex_anthropic` | accepted | `ephemeral_1h` 16,254 | accepted |
| `bedrock_anthropic` | accepted | `ephemeral_1h` 16,856 | 400, same message |
| `azure_anthropic` | accepted | `ephemeral_1h` 14,449 | accepted |

This branch with `cacheRetention: "long"` sent `ttl: "1h"` without the beta on `anthropic` and `bedrock_anthropic` and got `ephemeral_1h` writes. A 1h entry read back after 7m55s, when a 5m one had expired.

Tests:
- `factory-droid-anthropic.test.ts`: retention `long` writes `ttl: "1h"` with no beta on each of the four upstreams, and no `ttl` on `snowflake`.
- `cache-warmer.test.ts`: on a Factory upstream that writes 5m entries (Snowflake), `long` still schedules at 4.5 min; a response reporting a 1h write moves it to 54 min.
- The existing `anthropic-alignment.test.ts` cases still pass: Vertex sends `ttl: "1h"` without the beta, and a direct API key with `long` still sends it.

Negative controls: with the source changes reverted, the four upstream cases, and the warmer case fail. With only `extended-cache-ttl-beta #false` removed, the upstream cases fail on the beta header.

`bun test` in `packages/ai` and `packages/catalog`, and `bun run check:ts`, pass.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

