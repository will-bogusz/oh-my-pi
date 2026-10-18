## What

I had an agent pass `{ args: { path } }` to `computer.run`, and it opened Finder and a new window before dying on an undefined `path`, so I made a bad `args` throw before anything runs.

`computer.run(fn, { args })` and the browser's `tab.run(fn, { args })` ran `fn` without its arguments when `args` was not an array, and dropped `args` given with a code string; both now throw a `TypeError` naming the array form, and nothing runs.

| Call | `main` | This PR |
|---|---|---|
| `computer.run(fn, { args: { path } })` | `fn` runs with `path` undefined | throws `computer.run() args must be an array of the function's arguments after its scope: computer.run(async ({ desktop }, path) => …, { args: [path] })` |
| `computer.run("code", { args: [path] })` | the code runs, `args` dropped | throws `computer.run() passes args only to a function; a code string receives none` |
| `tab.run(…)`, same two shapes | same as `computer.run` | the same two errors, naming `tab.run()` |
| `{ args: [path] }` with a function; `{ args: [] }` with a code string; `{ args: null }` | runs | runs, unchanged |

The `computer` tool prompt now says the `args` items follow the scope object and shows the call; the `browser` prompt says the same in words (its example already passes `{ args: ["!"] }`).

## Why

Both prompts said only that "plain data, functions, and `RegExp` values are supported in `args`", and an options object makes `{ args: { path } }` a natural reading. The facade replaced anything that was not an array with `[]`, so the function ran anyway. A run function acts step by step, so its first steps (opening an app, a window, a panel) had landed by the time the missing value threw, leaving the desktop half-changed. A code string has no way to receive arguments, so `args` with it was always lost.

Throwing was chosen over wrapping a lone object as the first argument: the model wrote the wrong shape, and guessing which shape it meant would hide the next mismatch. Python's `computer.run` and `tab.run` take keyword-only options and already reject unknown ones. Unknown keys in the JavaScript options object are still ignored, as documented ("the JavaScript facade forwards only recognized run options").

## Testing

- `computer.test.ts` and `browser-prelude-facade.test.ts` each add one case: an object `args` and a non-empty `args` with a code string both reject with no host call, while `{ args: [] }` with a code string and `{ args: null }` with a function still run. With the two prelude hunks reverted, both fail (`Received promise that resolved`): 76 pass, 2 fail. With them: 78 pass.
  `bun test packages/coding-agent/test/tools/computer.test.ts packages/coding-agent/test/eval/browser-prelude-facade.test.ts`
- Live, in a macOS 26 VM through the real Eval tool and computer prelude (no model), the same cell at `main` and at this branch:

  | Cell | `main` | This PR |
  |---|---|---|
  | `computer.run(async (_s, p) => \`p=${p}\`, { args: { p: "/tmp" } })` | `p=undefined` | throws `computer.run() args must be an array …` |
  | `computer.run("return 'ran code'", { args: ["/tmp"] })` | `ran code` | throws `computer.run() passes args only to a function …` |
  | `computer.run(async (_s, p) => \`p=${p}\`, { args: ["/tmp"] })` | `p=/tmp` | `p=/tmp` |
  | `computer.run("return 'ran code'", { args: [] })` | `ran code` | `ran code` |

- `bun run check:ts`: exit 0.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
