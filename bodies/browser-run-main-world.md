## What

I made `page.evaluate` inside `tab.run` see the page the way `tab.evaluate` does, because agents read page state through it, got `null` for every page global, and concluded the page was broken.

On Chromium tabs, code handed to the run's `page.evaluate`, `evaluateHandle`, `$eval`, `$$eval` and `waitForFunction` now runs in the page's main world: `tab.run(({ page }) => page.evaluate(() => String(customElements)))` returns `"[object CustomElementRegistry]"`, as `tab.evaluate` does. On `main` it returns `"null"`. omp's stealth patch runs Puppeteer page evaluations in an isolated world that shares the DOM but nothing page scripts define, so page globals read `undefined` and custom elements look un-upgraded.

## Why

The prompt calls this a raw Puppeteer `page`. In 15 Browser Use tasks 6 hit this. One agent reported a shadow-DOM form submitted when nothing was, and in one of Will's sessions an agent polled 580 s for a value the isolated world always reads as `null`.

`main` isolates so Puppeteer's own machinery (query handlers, `waitForFunction` bindings) stays invisible to page scripts. `tab.evaluate` already runs user code in the main world (`8c8afaf4779`), and this gives the run's `page` the same, nothing more.

Shape of the fix (`createRunPage` in `tab-worker.ts`, wrapping the run's `page`):
- The five methods evaluate in `page.mainFrame().mainRealm()`, adopting element-handle arguments as `tab.evaluate` does (`evaluateInRealm`, now shared). `$eval`/`$$eval` selectors still resolve in the isolated world.
- `waitForFunction` polls by evaluating instead of calling Puppeteer's wait, which would install its bindings as main-world globals. It retries across navigations, throws Puppeteer's `TimeoutError` message, and stops with the run.
- Every other member is the tab's own page; one returning the page (`page.on(…)`) returns the wrapper.
- Unchanged: `frame.evaluate`, `elementHandle.evaluate` and other `Page` objects (`tab.page`, `browser.pages()`); the docs now say so.

## Testing

- `bun test test/tools/browser-tab-worker-startup.test.ts`, "runs code handed to the run's page evaluation methods in the main world", on real headless Chromium: a page global, a custom-element member, an adopted element argument, `$eval`/`$$eval`, `waitForFunction` resolving on a later global and timing out, a chained `page.on(…).evaluate`, and no Puppeteer binding on the page's globals. With the change reverted the page-global reads come back `null`/`undefined`.
- Sample set: call the shadow-DOM form's `collectFormData()` through the run's `page`, 2 runs each:

| | `main` | this branch |
|---|---|---|
| Haiku 5.5 | 0 / 2: both reported the method missing ("custom element registry is `null`") | 2 / 2, first call |
| GPT-6.1 Sol | 2 / 2, each after a failed call and a switch to `page.mainFrame().mainRealm()` | 2 / 2, first call |

- The three Browser Use local tasks that failed this way (shadow-DOM form, autocomplete, flight booking) each finished once on this branch with GPT-6 Luna; the form's success banner showed after a real submit.
- `bun run check:types` and `oxfmt --check` pass.

Review first: the `Proxy` in `createRunPage`, which binds every other member to the real page so Puppeteer's private fields still work.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
