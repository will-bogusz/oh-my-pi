## What

Follow-up to #16242: Codex reviewed it after the merge and found the `ts-set-map` condition could stall a streaming edit on a long one-line table, plus two shapes the rules missed, so I fixed all three here.

Streaming a 10,000-character single-line `Map` string value through the real `TtsrManager` took **4.8 s → 34 ms** (goliath, 10-character deltas); at 40,000 characters, 51.6 s → 0.44 s, which is what `ts-no-any` already costs on the same line.

| Rule | `main` | This PR |
|---|---|---|
| `ts-set-map` on a long one-line `Map`/`Set` value as it streams | each delta re-tests the unfinished line at about 2 µs per character (worst delta 33 ms at 10k, 171 ms at 40k) | one cheap pass per delta (worst 0.3 ms at 10k, 0.9 ms at 40k) |
| `new Map([["http", 80] as const, ["https", 443] as const])` | no reminder | reminder |
| `type Celsius = import("./units").温度` | no reminder | reminder |

## Why

TTSR re-tests a condition on the line being written after every streamed delta, so the cost of one failed test on an unfinished line is paid once per delta. The `Map` condition read string literals, block comments and `Map` values one character per alternation step, which runs in about 2 µs per character, so a 10k-character value cost 20-40 ms per delta. The fix rewrites each of those loops in the unrolled form `a*(?:b a*)*`: the same strings match, and the plain-character runs become a single character-class loop. The `Set` condition gets the same rewrite, since it hit the same cost on a 20k-character string (22 ms per test).

`as const` is accepted after each `["key", value]` pair. A member name after `import("x").` may now use any non-ASCII character except Unicode whitespace: conditions compile without the `u` flag, so `\p{ID_Start}` isn't available. Whitespace stays out so `import("x").then\u00a0(…)` is still read as a runtime `.then` call.

Rejected: skipping non-final checks for `interruptMode: never` rules, as Codex also suggested. It would fix this for every rule, but it changes when `ttsr_triggered` fires for all of them, which is a TTSR change rather than a fix to this rule.

`ts-no-tiny-functions` and `ts-promise-with-resolvers` (#16419) don't need this: on the same 40k inputs they cost the same as `ts-no-any`.

## Testing

- `bun test test/discovery/builtin-defaults.test.ts`: 18/18 pass. New: a `ts-set-map` timing test that streams four 10k-character tables (a string and an expression `Map` value, a `Set` string, a `Set` comment) in 20-character deltas, each of which must fire and finish under 500 ms (all four together: 100 ms); the `as const`, `温度` and `𐐀` hits; and `.then` / `.catch` misses with NBSP and U+2028 around the method name.
- Negative control: with `main`'s two rule files, those three tests fail (the timing test's first table took 2.6 s against its 500 ms bound).
- No change elsewhere: over every `.ts`/`.tsx` file in the repo (6,194 files, 2.0M lines, each line and each whole file), `main`'s and this PR's `ts-set-map` and `ts-import-type` conditions agree everywhere except the three new hit rows. A reviewer's generated set of 75,870 strings, escapes, templates, comments, generics and `Map` values found no difference in the rewritten loops.
- `bun run check` in `packages/coding-agent` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
