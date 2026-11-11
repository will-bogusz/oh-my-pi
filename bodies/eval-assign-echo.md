## What

I made a JavaScript eval cell that ends in an assignment print nothing, the way Python cells already do, because a trailing `globalThis.items = items` was dumping the whole array into the result.

In the listings-shaped live check, the cell's intended listings survive instead of being cut off by the output cap: 34,878 characters become 536.

| Cell ends with | `main` prints | this PR prints |
|---|---|---|
| `globalThis.items = items`, `x = await f()`, `n += 2`, `({ a } = obj)` | the assigned value | nothing |
| `(x = 5)` | `5` | `5`, like Python's `(x := 5)` |
| `[1, 2].length; const q = 5` without top-level `await` | `2` | nothing |
| `if (ok) { 42; }` without top-level `await` | `42` | nothing |
| trailing expression, string-only cell, or top-level `return v` | the value | the value |

`tab.run` and `computer.run` code strings share this runtime: assignment- or block-ending strings now return `undefined`; function forms are unchanged. `i++` still prints, and Python is untouched.

## Why

`returnFinalExpression` treated assignments as results because they are JavaScript expression statements. Python assignments are silent; a parenthesized JavaScript assignment remains an explicit request for its value, except object destructuring whose parentheses are required syntax.

`JsRuntime.run` also exposed plain-script completion values from blocks or expressions before a trailing declaration. Those are now silent; the async wrapper's explicit top-level return remains a result. An assigned promise is no longer implicitly awaited.

The recorded-session audit found 23 assignment-ending browser/desktop cells echoing about 22,000 tokens; no later call used information available only in those echoes.

## Testing

- Existing regression coverage: trailing assignments, blocks and parenthesized destructuring are silent; `(x = 9)`, `"hello"` and early top-level returns retain their values.
- `bun test test/eval test/core/js-static-import-rewrite.test.ts test/eval-preludes.test.ts test/tools/browser-run-cancellation.test.ts` in `packages/coding-agent`: 511 pass.
- Blind headless model comparison, four web tasks with three runs per arm; ratios are branch/main with 95% stratified bootstrap intervals. These test the same runtime patch as this rebased head.

| Model / set | Steps | Input tokens | Pass main / branch |
|---|---|---|---|
| Haiku 5.5, web | 1.039 [0.890, 1.215] | 1.094 [0.901, 1.307] | 10/12 / 8/12 |
| GPT-6.1 Sol, web | 0.960 [0.872, 1.055] | 0.956 [0.843, 1.080] | 12/12 / 12/12 |
| Haiku 5.5, assignment handoff | 0.976 [0.864, 1.081] | 0.982 [0.886, 1.094] | 12/12 / 12/12 |
| Opus 5.5, assignment handoff | 1.000 [1.000, 1.000] | 0.996 [0.995, 0.997] | 6/6 / 6/6 |

Natural retention probes produced no assignment endings on Haiku or Opus. The handoff probes therefore required the collection cell to end with an assignment, leaving subsequent cells unrestricted: all 18 successful handoffs per arm went directly to filtering, with zero extra print/inspection cells. This exercises the changed path but does not establish how often real tasks take it; the web intervals do not establish an improvement.

Leakscan found zero arm-label hits in all 144 valid runs. Forty-eight startup failures made zero model requests and were excluded; no fixture-bind failures occurred in the rerun.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
