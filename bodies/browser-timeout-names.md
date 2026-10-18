## What

I kept getting raw `Og:`/`Dg:` errors and stuck tabs from the browser tool in the release binary, and it turns out minification renames Puppeteer's error classes, so I switched our timeout checks to compare the class instead of its name.

In the released binary a browser timeout now behaves as it already did from source: omp's `tab.goto("…") timed out after 7000ms; pending navigation stopped …` instead of `Dg: Navigation timeout of 7000 ms exceeded`, and the tab keeps answering instead of hanging until it is killed.

| Release binary | `main` | this PR |
|---|---|---|
| `tab.goto` past its budget | raw `Dg: Navigation timeout …`; the load keeps running, the next call hangs and the tab is killed | omp's timeout message; the pending load is stopped |
| `browser.open` whose page never commits | `Browser open timed out …`; the new tab is rolled back | omp's goto timeout; the tab stays open on what loaded |
| Relay/CDP attach when no page target appears | raw `Og: Timed out after waiting 10000ms` | `No page targets available …` / `Selected tab did not become available …; retry` |

## Why

Puppeteer sets `this.name = this.constructor.name`. Release builds pass `minifyIdentifiers: true` (`scripts/ci-release-build-binaries.ts`) to `compileCodingAgent`, which already sets `keepNames: true` (`packages/coding-agent/scripts/compile-binary.ts`), yet Bun still renames these classes, so every `error.name === "TimeoutError"` check in the browser tool was false in the binary and true from source and in tests.

- `launch.ts` keeps Puppeteer's `TimeoutError` class from the lazy safe-cwd import that already keeps `JSHandle`, and exports `isPuppeteerTimeout()`; the two checks in `attach.ts` and two in `tab-worker.ts` use it.
- `navigation.ts` raised its own main-frame timeout as a plain `Error` named `TimeoutError`. It now builds Puppeteer's class through `launch.ts` (`puppeteerTimeoutError()`), so one identity check covers both and the module still imports no `puppeteer-core` value.
- Only Puppeteer's class counts now: an error merely named `TimeoutError` (thrown by page code, or a `DOMException` from an abort timer) no longer gets omp's timeout message; an action's own deadline is still caught through its signal.
- Not changed: build settings (`keepNames` is on and does not cover this) and error display such as `xd: Protocol error`, which no omp branch reads.

Related: #16101 makes the same change at the two `attach.ts` checks inside its empty-relay diagnostic; the two PRs touch the same lines there and in `launch.ts`.

## Testing

Release-style binaries (`compileCodingAgent` with `minifyIdentifiers: true`) of `main` and of this branch, headless managed Chromium on Linux, Haiku 5.5 running one eval cell against a local page that never answers (`main`'s binary gave the same on macOS):

| Cell | `main` binary | this branch |
|---|---|---|
| `tab.run('await tab.goto(hang)', { timeout: 8 })`, then `page.url()` | `Dg: Navigation timeout of 7000 ms exceeded`; `Browser code execution hung past grace; tab killed` | `tab.goto("…/hang") timed out after 7000ms; pending navigation stopped …`; `…/ok` |
| `browser.open({ name: "probe", url: hang, timeout: 15 })`, then `browser.tabs()` | `Browser open timed out after 15000ms …`; `["warm"]` | goto timeout plus `Tab "probe" stays open on what loaded`; `["warm","probe"]` |

The tests rename Puppeteer's class as minification does and drive the real paths: `browser-release-build-timeouts.test.ts` runs `tab.goto` to a page that never commits on an inline tab worker and checks the next call answers; `browser-attach.test.ts` lets Puppeteer's own `waitForTarget` time out on a connected browser with no targets. With `attach.ts` and `tab-worker.ts` reverted to `main`, both fail (`Navigation timeout of 2000 ms exceeded`, `Timed out after waiting 50ms`). `browser-attach`, `browser-nav-frames-dialogs`, `browser-open-lease`, `browser-tab-worker-startup` and `browser-interactions` pass, as does `bun run check` in `packages/coding-agent`; root `bun check` was not run (Rust half).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
