## What

I added Muse Spark 1.3 to the Factory Droid provider, which Factory serves differently from every other model it hosts, so Droid subscribers with the flag can pick it in `/models`.

A Factory login with the `muse_spark_1_3` flag now lists `factory-droid/muse-spark-1.3`; `main` has no row for it.

| | Muse Spark 1.3 on Factory |
|---|---|
| Wire | OpenAI Responses, `x-api-provider: google` (Vertex Model Garden) |
| Region | Global only (no US or EU upstream) |
| Effort | low, medium, high, xhigh; default high (Vertex rejects none and max) |
| Pool · rates | Standard · 0.5 / 3.4 / 0.12 credits, list price from Meta |
| Limits | 908,928 in / 131,072 out, text only |
| Gate | `muse_spark_1_3` flag |

**Also:** discovery stops hiding a model when live routing's family defaults name none of its upstreams; like Droid, it uses the model's registry upstream. Factory's live defaults for its own models are Baseten and Fireworks, which kept 1.3 out of the list. An explicit per-model route the registry can't serve still hides the model, as on `main`.

Reading order: `factory-droid.kdl` (seed row, registry block, request block after `grok-*`), `runtime/behavior.kdl`, then `resolveRotation` in `discovery/factory-droid.ts`.

## Why

1.3 is the one Factory-hosted model on Responses rather than Chat Completions. The request follows Droid 1.1.0's body for it, with existing axes only:

- `filter-reasoning-history`: Droid asks for `reasoning.encrypted_content` but never sends reasoning items back for Factory-hosted models; omp would have replayed them to Vertex.
- `clamp-output-to-model-max`: Droid sends the full 131,072 output cap; the generic Responses clamp would cut it to 64,000.
- No `text.verbosity`, `tool_choice`, `safety_identifier` or service tier, which Droid sets for OpenAI models only. Tools stay non-strict functions (Vertex rejects `custom` tools).
- `priority=1` on the effort ladder, as for Muse Spark 1.2, so Meta's minimal-to-max class ladder doesn't win.

Maintenance: if Vertex starts accepting none or max, or Factory moves 1.3 to another upstream, it's a KDL edit to this row.

## Testing

- ai `test/factory-droid-responses.test.ts`, 16 pass. New: body and headers (Responses path, `x-api-provider: google`, xhigh effort with summary, encrypted-content include, `store: false`, 131,072 output, function tools, none of the OpenAI-only fields); effort mapping; a reasoning + `Read` turn followed by its tool result, whose request has the call and output but no reasoning item.
- catalog `test/factory-droid-provider.test.ts`, 47 pass. New: the row (route, pool, ladder, Global only, hidden without the flag) and the family-default fallback.
- Negative controls: without `filter-reasoning-history` turn 2 replays the reasoning item; without the clamp it sends 64,000; with the KDL reverted all new cases fail; with `resolveRotation` reverted the fallback test fails.
- Full catalog suite 1311 pass, ai `factory-droid*` 267 pass, `check:types` passes for both.
- Live, with the flag on: `omp models factory-droid` lists muse-spark-1.3, its first request had the shape above, and a "read a.txt and b.txt, reply with their sum" turn ran both `read` calls and answered `SUM=4817`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

