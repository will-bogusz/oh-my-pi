## What

`ts-no-tiny-functions` kept telling me to inline exported helpers, public getters and test fakes that its own "Allowed" list exempts, and even plain `if (…) { return x; }` blocks, so this narrows it and `ts-promise-with-resolvers` to the code their bodies actually flag.

Replaying the 422 recorded firings of the two rules from my sessions since 10-01 that reproduce on `main`, 154 (36%) no longer fire: 153 on code the rule's text allows or that is no function at all, one on a helper inside a template-string browser script. Every replayed local function or arrow the rule flags still fires.

| Rule | Fired on (`main`) | Now fires only on | Replayed firings silenced |
|---|---|---|---|
| `ts-no-tiny-functions` | any `{ return …; }` block (methods, getters, object members, callbacks, `if`/`try`/`catch` bodies) and any `const f = (…) => expr`, exported or not | a non-exported `function f(…) { return …; }`, `const f = (…) => expr`, `const f = (…) => { return …; }`, or a private (`#f`, `private f`) method or arrow field; not type guards | 141 of 352 |
| `ts-promise-with-resolvers` | every `new Promise(` | an executor that takes a resolver: `resolve => …`, `(resolve, reject) => …`, `function (resolve)`, or a function reference such as `requestAnimationFrame` | 13 of 70 |

Non-goals: rule bodies, scopes and the other built-in rules are unchanged.

## Why

`ts-no-tiny-functions` matched `{ return …; }` anywhere, so it could not tell a free function from a method, a callback or a control-flow block, and its arrow alternative also matched `export const`.

Decisions:
- **A lexical approximation, not a parser.** Each alternative must start a line or follow `;`, `{` or `}`, which drops `export`, callbacks and members in one place. `export` on its own line or a function expression starting a line inside a call still fires, as on `main`.
- **Private methods still fire.** A `#m()` or `private m()` one-liner is not public API or a seam; public, `protected` and object-literal members are.
- **`ts-promise-with-resolvers` waits for the token after `(`.** `new Promise(() => {})` (a never-settling promise in tests and hang probes) has no resolver to replace, and a stream paused at `new Promise(` no longer fires early.
- **Linear time.** Every whitespace run sits between fixed tokens. `main`'s arrow alternative took 1.7 s on `const f = (x) =>` plus 32,000 spaces and `{`; this takes under 3 ms.

Silenced `ts-no-tiny-functions` firings: `if`/`try`/`catch` blocks 59, exported functions 39, both 7, public class or object members 30, callbacks 3, type guards 2, template-string script 1. All 13 silenced promise firings were `new Promise(() => {})`.

## Testing

- `bun test test/discovery/builtin-defaults.test.ts` (14 pass): per rule, a table of hits (the rule's own "Avoid" examples, multi-line and CRLF signatures, nested generics and defaults, private fields, commented and rest-param executors, split deltas) and replayed misses; plus a 32,000-space backtracking check. With `main`'s two rule files, all three fail.
- `omp ttsr test --rule <rule.md> --source tool --tool edit --path src/foo.ts '<snippet>'`: `export function isEmpty(…) { return …; }`, `if (!ok) { return null; }` and `await new Promise(() => {});` fire on `main` only; `function isEmpty(…) { return …; }` and `await new Promise(r => setImmediate(r));` fire on both.
- The counts replay each firing's tool-call arguments through `TtsrManager` in 6-character snapshots plus a final one, with both conditions; every silenced match was read and sorted. Excluding the one session that holds a third of them: 98 of 288 (34%).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
