## What

I kept main-world waits from exposing Puppeteer's internal query functions to the page.

ARIA query bindings are installed only in the named utility world, where selectors run; main-world waits still use Puppeteer's pollers without installing those globals.

## Why

A page script could identify an OMP main-world `waitForFunction` after it finished by enumerating four internal ARIA functions on `window`. Avoiding the installation also removes the exposure during the wait, rather than deleting the functions only afterwards.

This fixes raw Puppeteer waits marked `//!world=main`, including frame waits. Related: #18751 avoids these bindings in its separate `tab.run` wrapper; this does not change that wrapper.

## Testing

Headless Chrome for Testing 157.0.8103.50:

| Page-readable internal globals after a wait | main | this change |
| --- | --- | --- |
| Five fresh pages | 4 on each | 0 on each |

`bun test packages/coding-agent/test/tools/puppeteer-main-wait-globals.test.ts` fails on main with the four leaked names and passes with this change. It checks a main-world wait and a subsequent utility-world ARIA selector wait.

Review first: the binding guard in `ExecutionContext.puppeteerUtil` in the pinned Puppeteer patch. The real-Chrome test also checks that utility-world ARIA queries still work when the dependency is updated.

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
