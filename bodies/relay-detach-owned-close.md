## What

I made relay detach errors distinguish tabs omp opened from borrowed tabs, so agents stop searching the user's Chrome for an owned tab that omp has tried to close.

When reattachment fails or the user cancels Chrome's debugging bar, owned-tab errors say omp tried to close its tab and to open a new one. They do not claim closure succeeded: a refused `removeTab` can leave the tab open until the relay reconnects. Borrowed tabs keep their existing navigation/reopen guidance.

## Why

The old message described every tab as borrowed, even though teardown attempts to close owned tabs. Giving ownership-specific recovery guidance fixes that mismatch without promising a successful best-effort close or changing teardown behavior.

## Testing

The real headless Chromium relay harness covers refused reattachment and debugging-bar cancellation, each with both successful and refused `removeTab` replies. The refusal cases verify the Chrome target remains present and later calls retain truthful guidance. The regression fails against the previous head.

```sh
bun test packages/coding-agent/test/tools/browser-relay-detach.test.ts
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
