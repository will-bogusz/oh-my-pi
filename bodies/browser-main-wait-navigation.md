## What

I kept main-world waits alive when a navigation replaces the page after an earlier wait.

Puppeteer's wait task now treats Chrome's replaced-world argument error like its existing destroyed-context errors: the replacement context rearms the wait. User-supplied handles and selector roots still reject rather than waiting forever on an invalid handle.

## Why

A raw `waitForFunction` marked `//!world=main` could reject with `Waiting failed` across navigation after an earlier main-world wait initialized its cached utility handle. Chrome can reuse the numeric context id in a new process, so that old handle fails with `Argument should belong to the same JavaScript world as target object` rather than the destroyed-context error the wait already retries.

Related: #18751 implements its own polling inside `tab.run`; this fixes the underlying Puppeteer wait without replacing its polling or timeout behavior.

## Testing

Headless Chrome for Testing 157.0.8103.50:

| Wait across navigation after an earlier wait | main | this change |
| --- | --- | --- |
| Five fresh pages | 5 rejected | 5 resolved |

`bun test packages/coding-agent/test/tools/puppeteer-main-wait-navigation.test.ts` fails on main with that exact protocol cause and passes with this change. It exercises RAF, mutation and numeric polling across actual navigation, and verifies that a stale user handle still rejects rather than timing out.

Review first: the additional transient-error classification in `WaitTask.getBadError` in the pinned Puppeteer patch. The regression checks the protocol error that dependency or Chrome updates could change.

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
