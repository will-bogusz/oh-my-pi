## What

I made omp hold a page's `window.print()` because the agent's next browser call just hung and the tab got killed; now the page carries on and the agent is told to use `tab.pdf()` instead.

| Page prints (Chrome for Testing 150, macOS) | main | this PR |
|---|---|---|
| Visible managed tab, agent clicks Print | 17.0 s timeout, tab killed | 33 ms, result reports print |
| Background relay tab, page script prints | 16.8 s timeout, tab killed; reopening times out | 12 ms |
| Foreground relay tab, agent clicks Print | 16.8 s timeout, tab killed | 46 ms |
| Managed page prints 2.5 s after a click | next call times out, tab killed | held, next result reports it |
| Headless managed tab | returns without notice | returns with notice and `afterprint` |

**Hold-scope decision:** hold for the tab's life on pages omp creates in browsers it launches; on connected, relay, and borrowed app pages, hold during calls plus 1.5 s. Calls-only everywhere misses delayed prints. A person's page Print button does nothing in a managed tab, but Chrome's menu and Cmd+P still work. On borrowed pages a print after the tail can still freeze the next call. The scope choice lives in `printHoldScope()`.

## Why

Chromium's print preview stops page script until someone closes it, so subsequent browser calls hang. Read `print-hold.ts`, then the `tab-worker.ts` hooks.

<details><summary>Mechanism and limits</summary>

Held prints fire `beforeprint`/`afterprint` and report through a CDP binding. A Proxy preserves the native function's name, length and source. Each attachment keeps its deadline on the page's clock, including document starts and back/forward-cache restores. `beginCall` runs under the run's timeout, before emulation is reapplied.

Windows opened from the tab share its deadline; managed Chromium arms new windows before resuming them. In the relay only windows `open()` hands back are held. Windows without a route back to the opener cannot report their prints without enabling Runtime, an automation tell. Cross-site iframes print as on main: arming them let a stuck frame time out subsequent calls.

Print notices from internal open runs join recovery notices. A successful relay reattach keeps the same tab; navigation that never started still fails. Failed-call notices carry to the next successful call unless worker recycling drops them.

Non-goals: file choosers and other native windows. Requires writable `window.print` and `Runtime.addBinding`.

</details>

## Testing

- Rebased regression run: `bun test test/tools/browser-nav-frames-dialogs.test.ts test/tools/browser-relay-detach.test.ts` in coding-agent: 64 pass, 0 fail, 146 assertions.
- `bun run --filter './packages/coding-agent' check:types`: no errors in 4,838 files. `bunx oxfmt --check` passes on all five changed TypeScript files.
- Historical live probes: managed and relay headful Chrome on macOS, relay tab foreground/background; later headless relay arming and a connected-Chrome receipt window. Later fixes have regression tests. Headful Linux and Windows were not run.

<details><summary>Regression coverage</summary>

Tests cover managed clicks, between-call prints and open navigation; connected navigation, release, back/forward restores, busy init and restore handlers, replaced timers and clocks, concurrent attachments, a stuck cross-site iframe, lost script registrations, setup navigation and emulation arming. Popup tests cover direct and nested windows, links and noopener, later documents, another tab's windows, relay-style windows without browser target access, opener navigation, print-event intrinsics and notice delivery. Relay-detach tests cover successful recovery and navigation that never started.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
