## What

Chrome's "started debugging this browser" bar sat across every tab of my browser the whole time omp had one relay tab attached, even while I was just reading; now omp lets go of its tabs when the agent hands back to me and picks them up again on its next call.

| relay browser, between turns | before | this PR |
|---|---|---|
| Chrome's debugging bar | on every tab until omp closes its tabs | leaves about 5 s after the agent hands back (run end, interrupt included); back on the next browser call |
| omp's relay tabs | attached | open, owned and grouped, detached |
| next call on such a tab | — | reattaches first (about 330 ms), putting back `tab.emulate()` overrides, init scripts under their ids, the open's user agent, downloads folder and HTTPS setting, and the dialog policy; its result says what ended (routes, HAR, trace, profile, recording) |
| page waiting on a dialog or held chooser at hand-back, or starting to while omp lets go | — | stays attached, and the next result says why |
| page that opens a dialog while released | — | next call fails at once naming it; works after the user answers |
| `persist: true` or `allowed_domains` tabs, or `browser.relayReleaseOnTurnEnd: false` | — | stay attached |

Model steps and a continuing steer keep the attachment; `app.cdp_url` tabs never show the bar and are untouched.

Reading order: `agent-session.ts` (`#releaseRelayBrowserTabs`) → `tab-supervisor.ts` (`releaseRelayTabsForOwner`) → `tab-worker.ts` (`#release`) → `relay/bridge.ts` (`OMP.releaseTarget`).

## Why

**Builds on #15105, #15110, #15493, #15498, #15494, #15508, #15489, #15490, #15510, #15491, #15492, #15503, #15559, #15554, #15556, #15590, #15611, #15555, #15575** (merge in that order): its first 121 commits are theirs; merge those first, or merge this alone to land them all.

Its last commit, "release the popups a released relay tab opened with it", lets go of the popups #15590 owns for a released tab together with that tab, so they don't keep the bar up between turns.

> **Relay context.** Chrome shows the bar on every tab while an extension has the debugger on any tab, and drops it about 5 s after the last detach (Chromium's `kAutoCloseDelay`).

- **Maintainer call: detach between turns by default.** The bar flaps once per turn instead of staying up, and the first call of a turn pays a reattach; `browser.relayReleaseOnTurnEnd: false` keeps main's behaviour. Per-call detach would flap per call; closing the tabs would lose the agent's page.
- **Kept attached on purpose:** `persist` is the explicit opt-out; `allowed_domains` is enforced only by the attachment; a dialog orphaned by a detach can't be answered from a new attachment.
- **Relay contract 2** (`OMP.releaseTarget`): drops the connection's sessions for the tab and detaches unless another client holds it, keeping the claim and group. omp replaces a broker-owned relay reporting contract 1 and tells the user to restart a manually started one. The extension is unchanged: release uses its `detach`.
- **Maintenance:** a new per-tab worker-init setting must join `ReattachReplay`, or it resets after a turn.
- Non-goals: managed, spawned, Tern and cmux browsers.

## Testing

Live, macOS VM, Chrome 155, visible, n=5 per arm (this branch before review fixes): bar between turns, stack without this PR 5/5, this PR 0/5. A dialog opened while released fails the next call in 1.86 s (5/5); after the user answers, the next call reattaches (5/5).

Headless relay harness, n=5 per setting:

| setting | attached between turns, before → after | put back after reattach | first call after reattach (median) |
|---|---|---|---|
| viewport, timezone, user agent, focus, init script, chooser, print | 5/5 → 0/5 each | 5/5 each | 312–349 ms |
| page waiting on a confirm | 5/5 → 5/5 (kept) | 5/5 | 1 ms |

`bun test test/tools/browser-relay-turn-release.test.ts` with the other relay suites: 226 pass. Each fix has a test that fails with it reverted (dialog during release, interrupted reattach, worker exit during release, late bridge attach, init script ids, reused viewport, hand-back hook and its setting).

Not run: Chrome on Windows and Linux.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)



