## What

I made the relay detach error say omp closed the tab when it was a tab omp opened, instead of saying it may still be open and to navigate it in Chrome, which sent agents looking through the user's Chrome for a tab that was already gone.

| Chrome detached omp, then | Tab omp opened, `main` | Tab omp opened, this PR |
|---|---|---|
| re-adoption refused (a password manager's frame) or the tab closed | "omp could not reattach to the tab, so it was released: either the tab was closed, or Chrome refuses the attach while … If the tab is still open, open it again once that frame is gone; if Chrome refused the attach, the relay hides the tab until its URL changes, so navigate it in Chrome first" | "omp could not reattach to the tab it had opened, so it closed it: either the tab had closed, or Chrome refuses the attach while … Open a new tab to continue; if another extension's frame was the cause, it can detach omp there again" |
| the user cancelled Chrome's debugging bar | "omp released the tab; the relay hides it until its URL changes, so navigate it in Chrome, then open it again" | "omp closed the tab it had opened; open a new one to continue" |

Borrowed tabs (opened with `app.target`) keep the old wording: they stay open in the user's Chrome.

## Why

When Chrome detaches omp and omp cannot take the tab back, it kills the tab, and the kill closes a tab omp opened (`forceKillTabTeardown` closes any `ownsPage` target). The message only described a borrowed tab. In one real session an agent got it on a tab omp had opened, listed the relay's pages over HTTP and ran AppleScript over the user's Chrome to close the leftover tabs; there were none. The wording now follows `tab.ownsPage` in `runInTab`'s `DebuggerDetachedError` branch (`tools/browser/tab-supervisor.ts`), the only place both messages are built; a later call on the killed tab repeats the same text.

## Testing

The detach harness's stand-in extension now answers `createTab` with its page and closes it on `removeTab`, so an open without `app.target` gives omp a tab it owns. A new test detaches that tab mid-call for both paths (refused re-adoption, cancelled debugging bar) and checks that the error says omp closed the tab it had opened, no longer says to navigate it in Chrome, and that the page really closed. With the fix reverted both cases fail on the old text; the page closes either way, so `main` already did the cleanup and only the message was wrong.

```
cd packages/coding-agent && bun test test/tools/browser-relay-detach.test.ts   # 18 pass
```

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
