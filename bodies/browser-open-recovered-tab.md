## What

I kept the tab when an open successfully reattaches it, because closing the recovered page makes that recovery useless.

`browser.open` returns the same tab with its current URL and a recovery notice if Chrome detaches the relay during navigation and omp reattaches successfully. It does not reload or repeat the interrupted navigation; the caller can inspect what loaded.

## Why

The failed navigation used the same cleanup path as an outright navigation failure, even after reattachment had made the page usable again. A typed recovery error distinguishes that outcome from failed reattachment and carries whether navigation started. If recovery consumes the budget before navigation starts, open still fails but keeps the usable tab; cancellation and unsuccessful reattachment retain their cleanup paths.

Related: #16908 handles Chrome refusing attachment while a password manager's frame is present. This fix also applies to a generic recoverable detach on main, so it is independently useful.

## Testing

- A real headless Chromium-backed relay test detaches during fresh and reused opens. It fails without the fix and passes with it, including the recovery notice and a subsequent page-title read; refusal, cancellation and a budget exhausted before navigation starts are covered too: `bun test packages/coding-agent/test/tools/browser-relay-detach.test.ts`.
- Replayed the password-manager login shape in isolated headless Chrome for Testing with both unpacked extensions. Main still refuses attachment while the extension frame is present. The merged tree with #16908 returns the recovered login tab and its title; removing only this fix from that tree reproduces the failed open.
- `bun check` and the browser open-options, open-lease and tab-worker-startup tests passed, including ordinary navigation failure and cancellation cleanup.

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
