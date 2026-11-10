## What

I made a JavaScript eval cell that ends in an assignment print nothing, the way Python cells already do, because a trailing `globalThis.items = items` was dumping the whole array into the result.

On a cell that printed 23 matching listings and then kept all 122 on `globalThis`, the result goes from 34,878 characters to 536; on `main` the 50 KB output cap kept the tail of the dump and cut the 23 lines the cell printed on purpose.

| Cell ends with | `main` prints | this PR prints |
|---|---|---|
| `globalThis.items = items`, `x = await f()`, `n += 2`, `({ a } = obj)` | the assigned value | nothing |
| `(x = 5)` | `5` | `5`, like Python's `(x := 5)` |
| `[1, 2].length; const q = 5` (no top-level `await`) | `2` | nothing |
| `if (ok) { 42; }` (no top-level `await`) | `42` | nothing |
| a trailing expression, a string-only cell, or a top-level `return v` anywhere | the value | the value |

**Beyond the eval cell:** `tab.run` and `computer.run` code strings go through the same runtime, so one that ends in an assignment or a block now returns `undefined`; the function forms are unchanged.

## Why

`returnFinalExpression` turns any trailing expression statement into the cell's result, and an assignment is an expression statement in JavaScript. Python's runner only echoes a last statement that is an expression (`ast.Expr`), so `x = 1` is silent and `(x := 1)` prints; the parenthesized JS form keeps that way to ask for the value, except `({ a } = obj)`, whose parentheses are required syntax. Models end cells with an assignment to keep a value for the next cell: in my sessions 23 browser and desktop cells did it and echoed about 22,000 tokens, one of them an auth token the cell only meant to store, and in none did the model's later calls use a word only the echo showed.

A cell with no trailing expression and no top-level `await` runs as a plain script, and `JsRuntime.run` returned that script's completion value, whatever statement last produced one. It now returns nothing there; the async wrapper's value is kept because it is an explicit top-level `return`. Since the assigned value is no longer the result, an assigned promise is no longer awaited, as with Python's `x = asyncio.create_task(...)`.

Not changed: `i++` still prints, and the Python runner is untouched.

## Testing

- `test/eval/console-output.test.ts`: a trailing assignment, a trailing block and a parenthesized destructuring now return nothing (all three fail on `main` with the value); a guard test keeps `(x = 9)`, `"hello"` and an early top-level `return 7`, which pass on both.
- `bun test test/eval test/core/js-static-import-rewrite.test.ts test/eval-preludes.test.ts test/tools/browser-run-cancellation.test.ts` in `packages/coding-agent`: 511 pass.
- Live through `executeJs` with the listings-shaped cell: `main` 34,878 characters in 519 lines, this PR 536 in 16.
- No model sample set: the change removes text the model did not use in any of the 23 recorded cells (above), and it adds none.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
