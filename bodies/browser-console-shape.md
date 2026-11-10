## What

I kept seeing agents call `.slice()` or `.filter()` on what `tab.console()` returns and fail with `… is not a function`, so the browser prompt now states the shape and the JavaScript result says what to read.

`tab.console()` and `tab.errors()` return `{ entries, nextSeq, dropped }`. Called directly from a JavaScript cell, an array method, `length` or iteration on that result now throws a `TypeError` that names `.entries`, e.g. `tab.console() returns { entries, nextSeq, dropped }, not an array, so it has no .slice(); read its entries: (await tab.console()).entries.slice()`. On `main` the same code threw `….slice is not a function`, read `undefined` for `length`, or threw `… is not iterable`. The browser tool prompt and docs now give the shape, and how to read `entries` and page with `nextSeq` in both languages.

## Why

The prompt listed `console` and `errors` by name only, so agents guessed a list. In the archived Oct 15–Nov 9 calls, 32 of 47 non-harness agents hit a console/errors array-method error, counting each agent separately per root session; the cohort contains 311 calls.

Shape of the fix:
- The return type stays. `requests()` and the other log helpers return objects too, and `nextSeq`/`dropped` are needed for paging.
- The prompt line is the fix for every language; it names the field as `r.entries` (JavaScript) and `r["entries"]` (Python).
- The JavaScript prelude adds non-enumerable members, so the hint shows only on misuse. Printing, serialisation (`JSON.stringify`, `structuredClone`, the tool bridge) and destructuring stay unchanged. This follows the computer prelude, whose `find()` array explains how to pick one element when used as an element.
- Python is unchanged in code: there the result is a plain `dict`, and only the prompt line applies.

Known edge: a result kept in a global is not copied into Eval's speculation snapshot, so a later cell that builds tool arguments from it just runs without speculation.

## Testing

The JavaScript Haiku samples below were not blind: the after arm exposed `browser-console-shape` in Eval stack traces in 3 of 6 runs for each task.

- `bun test test/eval/browser-prelude-facade.test.ts test/tools/browser-console.test.ts test/eval/worker-core.test.ts`: `slice`, `length`, spreading and `map` on `console()`, and `slice` on `errors()`, throw the `.entries` hint; `.entries` and JSON output are unchanged; a real JS runtime prints the result as on `main`. The new case fails with the prelude change reverted.
- Headless sessions, low thinking, main vs this branch, scored from the transcripts:

  | model, task | sessions per arm | answered: `main` / branch | read `entries` in code: `main` / branch |
  |---|---|---|---|
  | Haiku 5.5, "which errors and warnings did the page log" | 6 | 2 / 3 | 0 / 4 |
  | Haiku 5.5, "last three console messages, in order" | 6 | 6 / 6 | 0 / 5 |
  | Haiku 5.5, the same in a Python cell | 4 | 4 / 4 | 4 / 4 |
  | GPT-6.1 Sol, both JavaScript tasks | 4 each | 8 / 8 | printed the whole result on both |
  | GPT-6.1 Sol, the Python task | 4 | 4 / 4 | 4 / 4 |

  On `main`, Haiku read the log through `window` globals or printed the whole result; with the line it read `entries` directly. No session on either arm called an array method on the result, so these runs show what the prompt line does, while the unit test shows what the hint does.
- `bun run check:ts` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
