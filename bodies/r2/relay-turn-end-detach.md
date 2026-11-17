## What

Chrome's "started debugging this browser" bar sat across every tab of my browser the whole time omp had one relay tab attached, even while I was just reading; now omp lets go of its tabs when the agent hands back to me and picks them up again on its next call.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/d7800b18-0dde-40ec-9a76-ab97d5c8cc84">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/f5bae185-5451-404e-a0cd-9a68a877894a">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/0815a0dd-02cd-459d-ac18-5e480504d7eb">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/b152edee-7e55-4119-8592-d358eec825d7">
  <img width="780" alt="Timeline across one hand-back. Main: Chrome's debugging bar stays on every tab through the agent's turn, the hand-back and the whole time you read. This PR: when the agent hands back, omp releases its relay tabs (still open, omp's, in its tab group) and the bar leaves about 5 s later; you read with no bar; the agent's next browser call reattaches the tab first, puts its settings back, and the bar returns. Carried over: the tab and its popups, element ids, run globals, console and request logs, emulated viewport and overrides, init scripts, user agent, downloads folder, HTTPS setting, dialog policy. While released: console output may be incomplete, and network requests are missing. A tab with a route, HAR, trace, profile or recording running, or a key or button held, stays attached and the next result says why." src="https://github.com/user-attachments/assets/f5bae185-5451-404e-a0cd-9a68a877894a" />
</picture>

A release lets go of Chrome's debugger only: what the agent built on a tab stays for its next turn.

<details><summary>Between turns, row by row</summary>

| relay browser, between turns | before | this PR |
|---|---|---|
| Chrome's debugging bar | on every tab until omp closes its tabs | leaves about 5 s after the agent hands back (run end, interrupt included); back on the next browser call |
| omp's relay tabs | attached | open, owned and grouped, detached |
| next call on such a tab | — | reattaches first, with the tab's state carried over (below) |
| tab with a route, HAR, trace, profile or recording running, a key or button held, or a page waiting on a dialog or held chooser | — | stays attached, and the next result says why |
| page that opens a dialog while released | — | next call fails at once naming it; works after the user answers |
| `persist: true` or `allowed_domains` tabs, or `browser.relayReleaseOnTurnEnd: false` | — | stay attached |

</details>

What survives a release:

| state | after the reattach |
|---|---|
| element ids (`tab.observe`, `tab.id`) and ARIA refs (`tab.ref`) | survive, naming the same elements |
| console, error and request logs, response bodies included | existing entries survive; console output from while released may be incomplete, and network requests from that time are missing |
| run globals, uploaded files, downloads, WebMCP catalog and events | survive |
| `tab.emulate()` overrides, the open's user agent and HTTPS setting, init scripts (same ids), dialog policy, focus emulation, popups the tab opened | restored |
| `tab.route` routes, HAR, trace, CPU profile, screen recording, keys or buttons held down | keep the tab attached |
| a pending dialog or a held file chooser | keeps the tab attached |

Model steps and a continuing steer keep the attachment; tabs opened with a CDP endpoint string in `app` are untouched. Reading order: `agent-session.ts` → `tab-supervisor.ts` (`awaitWorkerRecovery`, `reattachReleasedTab`) → `tab-worker.ts` (`#release`, `#reattach`) → `relay/bridge.ts`.

## Why

> **Relay context.** Chrome shows the bar on every tab while an extension has the debugger on any tab, and drops it about 5 s after the last detach.

- **Maintainer call: on by default.** The bar flaps once per turn instead of staying up; `browser.relayReleaseOnTurnEnd: false` keeps main's behaviour. Per-call detach would flap per call; closing the tabs would lose the agent's page.
- **One worker across a release.** It keeps run globals, ids and logs, moving its instruments onto the new attachment. Only a lost worker is replaced through main's recovery, and the next result says what started fresh.
- **Kept attached:** routes, captures and held keys act only while attached, so the gap would slip past them; `allowed_domains` likewise; an orphaned dialog can't be answered later; `persist` opts out.
- **Relay contract 2** (`OMP.releaseTarget`) detaches the tab and the popups omp owns from it, keeping the claim and group; the extension is unchanged.
- **Maintenance:** a new per-tab instrument with state must move in `#reattach`, or keep the tab attached in `#release`.
- Non-goals: managed, spawned, Tern and cmux browsers.

## Testing

Live, isolated relay harness (real extension), n=5 per arm, on an earlier build of this design: turn 1 observes, clicks by id, logs, fetches, uploads and sets a timezone; turn 2 reuses the id and ARIA ref and reads it back. Same result 5/5, release off and on; first call after a reattach median 54 ms (50 ms attached). Earlier head, macOS VM, visible Chrome, n=5: bar between turns 5/5 → 0/5.

On the rebased head, 356 tests pass, including unchanged main dialog/WebKit regressions; `bun run check:ts` passes. Re-run: `bun test packages/coding-agent/test/tools/browser-{relay*,nav-frames-dialogs,webkit-dialogs}.test.ts packages/coding-agent/test/agent-session-relay-release.test.ts`. The continuity case logs two identical objects: `4f0c6a0546d` replayed a third, while normalized replay preserves exactly two.

A real relay release/reattach probe logged before and during the gap and awaited a fetch while detached: both console messages returned after reattach, but the request log was empty. Console recovery is therefore partial, not a claim of complete capture while released.

Not run: Chrome on Windows and Linux.

---

- [x] `bun run check:ts` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

