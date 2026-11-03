## What

Killed test runs kept leaving headless Chromes running on my machines, so I made the in-process launch use a DevTools pipe, which Chrome exits on when its owner dies.

A headless Chrome that the browser tool starts inside its own process now exits when that process is killed: 3 s after the owner's SIGKILL, 10 → 0 Chrome processes are still running, on macOS and on Linux.

That in-process launch is what `bun test` runs and SDK embeddings get; the omp CLI uses the project-shared, broker-owned browser, which this PR does not touch. On one Linux workstation, a week of killed test runs left 12 Chrome trees behind (143 processes, 4.7 GB RSS), each with its `omp-chrome-profile-*` temp profile.

`launchHeadlessBrowser` now talks to Chrome over a DevTools pipe and still opens a debugging port, whose WebSocket endpoint it returns; tab workers attach through that endpoint, on first open and when a timed-out tab's worker is recycled.

<details><summary>Reading order</summary>

- `launch.ts`, `launchHeadlessBrowser` / `launchedEndpoint`: `--remote-debugging-pipe` plus `--remote-debugging-port=0` (or the port a caller passed in `args`); the endpoint comes from `<profile>/DevToolsActivePort` for port 0 and from `/json/version` for a caller's port.
- `registry.ts`, `PuppeteerBrowserHandle.wsEndpoint`: set for every browser kind; for the others it is the connection's own `browser.wsEndpoint()`, as before.
- `tab-supervisor.ts`, `buildInitPayload` and `recycleTimedOutWorkerTab`: hand workers the handle's endpoint instead of `browser.wsEndpoint()`, which is empty for a pipe connection.

</details>

## Why

`@puppeteer/browsers` starts Chrome detached, in its own process group, on Linux and macOS (`opts.detached ??= process.platform !== 'win32'`). Only its exit and signal hooks stop it, and none runs when the owner gets SIGKILL; a `timeout` or a harness killing the job's process group misses it too. Over a pipe, Chrome shuts down at the pipe's EOF, however the owner dies.

- Pipe plus a port, not the pipe alone: tab workers are separate threads that attach over WebSocket, and a pipe-connected `Browser` has no WebSocket endpoint.
- Not reaping orphans at the next launch, as #9448 does for the shared daemon: that waits for another launch and guesses ownership from a profile directory and a pid.

Maintenance cost: the port-0 endpoint comes from Chrome's `DevToolsActivePort` file, which Puppeteer's `connect({ channel })` also reads. If Chrome or Puppeteer changes that, launches fail with `Chromium did not serve its DevTools endpoint after launch` or the new test times out.

Related: #7900 / #9448 (shared-daemon Chrome on Windows), #9922 (temp-dir producers without a reaper).

## Testing

Leak repro: a child launches through `launchHeadlessBrowser` and SIGKILLs itself; 3 s later, count processes still running on its profile. Three runs each:

| Chrome processes alive after the owner's SIGKILL | macOS arm64, Chrome for Testing 150 | Linux x64, Chrome 150 |
|---|---|---|
| `main` | 10, 10, 10 | 10, 10, 10 |
| this PR | 0, 0, 0 | 0, 0, 0 |

- `bun test test/tools/browser-launch.test.ts -t process-local`: the owner-SIGKILL case fails without `--remote-debugging-pipe` (times out); the caller-port case fails when port 0 is always appended.
- `bun test test/tools/browser-*.test.ts` (macOS): 755 pass, 3 skip, 0 fail; their in-process tabs all attach through the new endpoint.
- Browser tool end to end, in-process: open, `run`, `tab.goto`, a run that timed out (worker recycled), then runs on the new worker against the same page and Chrome.
- `bun check`: lint and types pass; `oxfmt --check` flags two files this PR does not touch, as on `main`.
- Not run: Windows, where the pipe launch now applies too (the sign-in browser in `utils/browser-session.ts` already uses `pipe: true`).

---

- [x] `bun check` passes (lint and types; the two `oxfmt` failures are on `main` too)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
