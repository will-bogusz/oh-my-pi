## What

When a browser tab's worker crashed, my call just sat there for 20-odd seconds and then the tab was gone, so now the call fails right away and the next one picks up on the same page.

A tab's worker can exit on its own (Puppeteer rejecting a promise no `run` owns in an event handler); on `main` the call in flight waits out its timeout plus grace (about 21 s) and the tab is killed.

| | `main` | this PR |
|---|---|---|
| Call in flight when the worker dies | waits ~21 s, then `Browser code execution hung past grace; tab killed` | fails in ~20 ms: `Browser tab worker exited unexpectedly (exit code 1, <cause>); the tab is being reattached to a new worker on the same page. …` |
| Next call | `Tab "x" was killed …. Reopen it.` | runs on the same page (DOM, URL, login kept); routes, init scripts and other tab-level state reset, as after any worker recycle |
| New worker dies again within 10 s | – | tab closed (omp's headless page closed, a relay or connected tab released); the next call says why |

Takes over #14866 by alnaggar-dev, which closed the tab when its worker exited; its exit detection is kept, and the commit and CHANGELOG credit them.

## Why

`recoverWorkerTab(…, { recover: false, failedReason })` moves a relay tab to a new worker after Chrome detaches; this PR reuses it for a worker that exited, so there is one recovery path.

Decisions:
- **Reattach rather than close (#14866's shape).** Only the worker died; closing loses the agent's place and, in relay mode, the user's tab. Closing stays the fallback when reattaching fails.
- **No dialog dismissal or stop-loading on reattach** (`recover: false`): it would cancel the agent's navigation.
- **Crash loop guard:** a second exit within 10 s of the first closes the tab.
- **A call or an open that arrives during the reattach waits for it**, within its own timeout and abort signal, and only on that tab: a call whose tab was reopened under the same name meanwhile fails; an open whose tab the reattach closed opens a fresh one.

Kept from #14866: the worker handle's `onExit` and a clear error for a `run` sent to the dead worker; dropped its `forceKillTab` early return.

Non-goals: cmux and Tern tabs (in process, no worker).

Reading order: `attachTabWorker` → the waits atop `runInTabWithSnapshot` and `acquireTabImpl` → `wrapBunWorker.onExit`.

## Testing

- `test/tools/browser-worker-exit.test.ts`, real headless Chromium, 9 cases: the crashing call fails within 5 s with the cause and the next call reads a DOM mark set before the crash; host tool calls the crashed run started are aborted; a second crash closes the tab and reopening works; with the reattach held open, a waiting call runs on the reattached page, an aborted or timed-out one settles at once, and one whose tab was reopened under the same name fails without touching the new page; a worker that exits while a frozen tab is being resumed fails that call without its code reaching the new worker; an open during the reattach waits for it and reuses the reattached tab, or opens a fresh one if the tab was closed meanwhile. With the `tab-supervisor.ts` change reverted, they fail (the first with `hung past grace` after ~21 s).
- Relay mode, live (Chrome for Testing, relay extension, adopted user tab): the crashing call failed in 18 ms; the next read the mark.
- `bun run check:ts` and the supervisor, relay and freeze suites pass. Not run: `browser-relay-daemon.test.ts` (native rebuild).

---

- [ ] `bun check` passes (ran `bun run check:ts`; `check:rs` not run, no Rust changes)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution



