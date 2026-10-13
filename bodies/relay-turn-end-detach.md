## What

Chrome's "started debugging this browser" bar sat across every tab of my browser the whole time omp had one relay tab attached, even while I was just reading; now omp lets go of its tabs when the agent hands back to me and picks them up again on its next call.

A release lets go of Chrome's debugger only: what the agent built on a tab stays for its next turn.

| relay browser, between turns | before | this PR |
|---|---|---|
| Chrome's debugging bar | on every tab until omp closes its tabs | leaves about 5 s after the agent hands back (run end, interrupt included); back on the next browser call |
| omp's relay tabs | attached | open, owned and grouped, detached |
| next call on such a tab | — | reattaches first, with the tab's state carried over (below) |
| tab with routes, a capture, a recording or held keys, or a page waiting on a dialog or held chooser | — | stays attached, and the next result says why |
| page that opens a dialog while released | — | next call fails at once naming it; works after the user answers |
| `persist: true` or `allowed_domains` tabs, or `browser.relayReleaseOnTurnEnd: false` | — | stay attached |

What survives a release:

| state | after the reattach |
|---|---|
| element ids (`tab.observe`, `tab.id`) and ARIA refs (`tab.ref`) | survive, naming the same elements |
| console, error and request logs, response bodies included | survive with their entries; what the page did while released is not in them |
| run globals, uploaded files, downloads, WebMCP catalog and events | survive |
| `tab.emulate()` overrides, the open's user agent and HTTPS setting, init scripts (same ids), dialog policy, focus emulation, popups the tab opened | restored |
| `tab.route` routes, HAR, trace, CPU profile, screen recording, keys or buttons held down | keep the tab attached |
| a pending dialog or a held file chooser | keeps the tab attached |

Model steps and a continuing steer keep the attachment; `app.cdp_url` tabs are untouched. Reading order: `agent-session.ts` → `tab-supervisor.ts` (`reattachReleasedTab`) → `tab-worker.ts` (`#release`, `#reattach`) → `relay/bridge.ts`.

## Why

> **Relay context.** Chrome shows the bar on every tab while an extension has the debugger on any tab, and drops it about 5 s after the last detach.

- **Maintainer call: on by default.** The bar flaps once per turn instead of staying up; `browser.relayReleaseOnTurnEnd: false` keeps main's behaviour. Per-call detach would flap per call; closing the tabs would lose the agent's page.
- **One worker across the release.** The tab's worker keeps its state and moves it onto the new attachment; a new worker replaying settings would lose run globals, ids and logs. A new one takes over only if the worker died while released, saying what started fresh.
- **Kept attached:** routes, captures and held keys act only while attached, so the gap would slip past them; `allowed_domains` likewise; an orphaned dialog can't be answered later; `persist` opts out.
- **Relay contract 2** (`OMP.releaseTarget`) detaches the tab and its popups (#15590), keeping the claim and group; the extension is unchanged.
- **Also fixed:** on main, `tab.id(n)` called an element stale in a later run once an earlier run had used it.
- **Maintenance:** a new per-tab instrument with state must move in `#reattach`, or keep the tab attached in `#release`.
- Non-goals: managed, spawned, Tern and cmux browsers.

## Testing

Live, isolated relay harness (real extension), n=5 per arm: turn 1 observes, clicks by id, logs, fetches, uploads and sets a timezone; turn 2 reuses the id and ARIA ref and reads it back. Same result 5/5, release off and on; first call after a reattach median 54 ms (50 ms attached). Earlier head, macOS VM, visible Chrome, n=5: bar between turns 5/5 → 0/5.

`browser-relay-turn-release.test.ts` "gives the next turn everything the last one built…" runs those turns with the setting on and off and compares. Dropping any one carry-over fails it; the keep-attached and out-of-time tests fail with their checks removed. Browser suite: 8 relay-daemon failures as on main, 9 needing the native addon rebuilt (pass with a null `macOSFrontApp`).

Not run: Chrome on Windows and Linux.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
