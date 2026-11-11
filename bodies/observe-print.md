## What

Printing an observe() result quietly dropped every element after the 100th, so the model never knew those controls existed; I made it print every element, one per line.

For a 160-element page, printing goes from 100 elements plus `... 60 more items` to all 160. The compact form applies only while the observation still matches the data returned by `observe()`: prototypes, own keys, data-property values and enumerability. Any edit switches to plain `util.inspect` with the array limit lifted, rather than teaching the formatter every value Eval code could add.

## Why

A control past the cut has no id the model can see. The custom inspect hook is limited to observations and their original `.elements` array; ordinary arrays, filtered copies and JSON retain native behavior. Raising the limit globally would expand unrelated large values too.

Of 8,479 recorded Eval cells, none edited, copied or wrapped an observation. Unedited output is byte-identical on 623/623 replayed observations, so the replay's input-token saving of 4.1% and cache-weighted input-cost saving of 5.5% stand; the model runs were not repeated for this revision.

At 600 elements, snapshotting adds 0.33 ms per `observe()` and printing takes 1.2 ms. This trades work for a clear boundary: edited data goes to native inspection, with getters left uncalled and symbols preserved.

## Testing

- Goliath: `bun test test/eval/browser-prelude-facade.test.ts` in `packages/coding-agent`: 20 pass. Reduced annotation table: 11 cases, 10 fail on the old head.
- Headless Chromium on bench-mac, real browser transport: 160 buttons print as 160 compact lines; filtering prints all 80 matches; edited data prints all 160 through plain inspect with its annotation preserved and no throw. Replay/model comparisons remain evidence for unchanged compact output, not a new model evaluation.
- `bun check` stops at main's `agent-session-async-delivery.test.ts` formatting. Package `OMP_TEST_CONCURRENCY=1 bun run test`: 21,321 pass, 121 fail, 386 skip, 3 errors; all failing chunks rerun on exact main have identical failures.
- Limit: three hostile cases need a non-plain payload before `observe()` returns (private prototypes or functions); this patch does not sanitize arbitrary pre-existing objects. Plain-inspect fallback disables custom inspect hooks and can expand an outer cycle one extra level.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
