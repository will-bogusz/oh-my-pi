## What

I kept seeing agents call `tab.run(fn, [url])` or `browser.open("https://…")`, get back "expects an options object", and then guess at the fix, so I made the error just tell them the shape.

| Call | `main` | this PR |
|---|---|---|
| `tab.run(fn, ["https://…"])` | `tab.run() expects an options object` | `tab.run() expects an options object; pass the function's arguments as { args: [...] }: tab.run(async ({ page }, url) => …, { args: [url] })` |
| `browser.open("https://…", { … })` | `browser.open() expects an options object` | `browser.open() expects an options object; pass the URL inside it: browser.open({ url, name })` |

Every other non-object options value keeps the bare message, including a code string run with an array (it takes no `args` at all, so pointing at `{ args }` would send the retry into PR 16149's "a code string receives none" error).

## Why

Both shapes are what models reach for first: positional run arguments, and Playwright's `goto(url, opts)`. The bare message names the problem but not the fix, so the next call is a guess; we saw agents retry with other wrong shapes before reading the tool docs. #16149 added the same kind of hint for a non-array `args` value; this covers the two shapes that fail one step earlier, in the options check.

Related: #16105, whose item 1 asks for exactly this error (or for accepting `open(url, opts)`); its item 2 is #16107.

Non-goals: accepting `open(url, opts)` or positional run args (an API change, left to you as roboomp noted on #16105); `computer.run` has the same bare message for an array and can follow separately. Python's browser helpers take keyword arguments, so Python already raises its own `TypeError` naming the parameters.

## Testing

- Two tests in `test/eval/browser-prelude-facade.test.ts`, one per shape, run the shipped prelude in a VM: each asserts the new hint, that a non-matching bad value (`"fast"`, a code string with `[1]`, `42`) keeps the bare message, and that nothing reached the browser. With the `prelude.js` change reverted both fail (6 pass, 2 fail); with it, 8 pass.
- Live, real `eval` cell through omp on `claude-haiku-5-5` (`bun packages/coding-agent/src/cli.ts -p --no-session …`) calling both shapes: `main` printed the two bare messages, this branch printed the two hints above.
- `bun run check:ts` passes (no Rust changed; `check:rs` not run).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
