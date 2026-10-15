## What

I made omp notice when Chrome drops its relay connection because a password manager's autofill menu popped up in the tab, so the call says what happened and omp picks the same tab back up instead of hanging.

On `main`, a click that opened another extension's inline menu left a relay tab dead: the call failed with `Detached while handling command.`, each later call timed out after 8 s or hit `Attempted to use detached Frame`, and `close` + `open` waited 10 s for `No page targets available`.

| | `main` | this PR |
|---|---|---|
| The call Chrome detached omp during | bare protocol error | fails at once: Chrome detached omp, likely another extension's frame, input may have landed |
| Later calls | 8 s timeout or detached Frame | same tab reattached without reload, next call works; if Chrome refuses, each call fails at once with that explanation |
| Detach between two calls, or before a call's code starts | next call fails | the call reattaches and runs, with a note |
| `close` + `open` | 10 s `No page targets available` until the page navigates | adopts it again once the other frame is gone (a tab where Chrome refuses the attach itself stays hidden until it navigates, as on `main`) |

> **Relay context.** omp drives the user's Chrome through the relay extension's `chrome.debugger` attachment. Chrome ends it by itself when another extension's frame loads in the tab (`target_closed`), or when the user cancels the debugging bar (`canceled_by_user`).

Read `RelayBridge#onTabDetached`, `#forwardToTab`, `WorkerCore#onDebuggerDetached`, `runInTabWithSnapshot`.

## Why

The bridge banned a tab on any detach it had not requested, until its URL changed. Now only the user's cancel bans; other detaches announce the tab again. The bridge first sends the tab's sessions a relay-private `OMP.debuggerDetached` event; the worker answers the run in flight and the supervisor re-adopts the same Chrome tab on a new worker. Chrome can fail the command in flight before reporting the detach, so the bridge holds a root-session `Detached while handling command` failure (up to 1 s) until the report; headless, connected and child-session paths are untouched.

<details><summary>Decisions</summary>

- No recover pass on re-adoption: stopping the page's loading would cancel a navigation the call started.
- The interrupted call fails instead of retrying, since its input may have landed; a call that found the tab already detached ran nothing and runs on the new worker. A cancel during re-adoption is reported as a cancel.
- The ban change is here because re-adoption needs it: with the event alone, every reopen still took 10 s (21/68 below).

</details>

Non-goal: staying attached while the other extension's frame is open; Chrome refuses, and reopening fails at once with `Selected tab is not ready`.

Related: #12314 (another author) in `relay/bridge.ts`: it also limits the ban to `canceled_by_user`, within a broader lazy-reattach change.

## Testing

Live relay harness: Chrome for Testing 150, the relay extension, and a stand-in extension injecting a `chrome-extension://` inline menu on credential-field focus like 1Password 8; four menu behaviours, 17 steps each (click, type, reopen, close, open).

| | `main` | this PR |
|---|---|---|
| steps ok (of 68) | 29 | 37 |
| 8 s timeouts | 11 | 0 |
| 10 s reopens | 4 | 0 |
| slowest failure | 10,022 ms | 401 ms |
| user opens and closes the menu between calls: next call | detached Frame, then 8 s timeout | reattached, value returned (348 ms) |

Remaining failures happen while the menu stays open.

- `bun test packages/coding-agent/test/tools/browser-relay-detach.test.ts packages/coding-agent/test/tools/browser-relay-bridge.test.ts`: 64 pass (headless Chromium, fake relay extension). Measured before rebasing onto current `main`: with `src` reverted, 9 fail; without only the bridge's hold, the cancel check, the code-started mark or the tool-call abort, their tests fail.
- `bunx oxlint .`, `oxfmt --check` on the changed files and every package's `check:types` pass. (`bun run check:ts` stops at `main`'s unformatted `test/discovery/builtin-hooks.test.ts`, which this PR doesn't touch.)

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated
