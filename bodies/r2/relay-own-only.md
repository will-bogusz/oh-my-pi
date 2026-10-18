## What

Whenever omp touched the relay, Chrome's debugger got attached to every tab I had open, so one stuck dialog in a tab of mine could hang omp; now the relay only attaches the tabs omp opened and the ones I point it at with `app.target`.

| | before | this PR |
|---|---|---|
| tabs the relay attaches when omp connects | every eligible tab in every connected browser | only tabs omp opened or borrowed with `app.target` |
| a user tab blocked on `confirm()` | `browser.pages()` on omp's relay connection hangs | returns at once; omp never touches that tab |
| `app.target` | the supervisor attaches tabs to pick one | picked from the relay's `/json` listing; the tab worker claims it, which attaches only that tab |
| popup or `target=_blank` from omp's tab | attached but unowned: in `browser.pages()`, no `popup` event | not attached until adopted with `app.target`; this PR does not own popups (below) |
| a relay client attaching a tab it never opened or claimed | allowed | refused; the error names `OMP.claimTarget` and `app.target` |
| an attachment left by an earlier relay process | stays | taken off at the extension's hello when nobody holds it |

Reading order: `relay/bridge.ts` (`Target.setAutoAttach`, `OMP.claimTarget`, `#attachFor`, `#onHello`) → `attach.ts` `pickRelayTarget` → `tab-supervisor.ts` `buildInitPayload` (`relay`) → `tab-worker.ts` `#init` → `relay/claim.ts`.

## Why

> **Relay context.** The relay is a CDP façade over `chrome.debugger`. Every `puppeteer.connect` sends `Target.setAutoAttach`, omp opens one relay connection per tab worker plus the supervisor's, and the bridge answered each by attaching every tab, including a tab an extension's hello announces later (151bc26cdc).

- **Ownership is explicit.** A connection owns tabs it created or claimed with the relay-private browser-level `OMP.claimTarget { targetId }` (replacing the worker's page-session claim after attaching). `main` already records these claims per connection (`#claimTab`, `#claimed()`), but only for grouping and for where omp opens a tab; now only owned tabs are attached, and the rest stay listed for `app.target`.
<details><summary>More decisions: popups, targetFilter, the relay's protocol version, races</summary>

- **Popups stay unowned here.** Telling omp's popup from a tab the user opens at the same moment needs the extension to report the opener (`webNavigation.onCreatedNavigationTarget`); a bridge-only guess from `Page.windowOpen` timing attached a hand-opened tab in review.
- **Not Puppeteer's `targetFilter`:** it filters after the attach.
- **Bridge-side only.** The relay ships with omp; `/json/version` now reports `ompRelayCdpProtocol`, so omp replaces a relay from before this change (#14416's restart) instead of using it, or reports a hand-started one out of date. The extension is unchanged.
- **Races.** Every client attach goes through `#attachFor`: a client that left or gave the tab up meanwhile gets no session, and the attachment comes off unless another client owns the tab.

</details>
- **Maintenance.** A third-party CDP client must claim a tab before attaching it; the refusal says how.
- Non-goals: Chrome's "started debugging" bar (branded Chrome shows it on every tab while any one is attached); isolation between relay clients.
- Related: #14881, #9009.

## Testing

Live (2026-10-13, on this change before its rebase onto #16119): isolated Chrome for Testing with the relay extension (headless), three user tabs open, through omp's `acquireTab`/`runInTab`, n=5 per arm:

| | before | this PR |
|---|---|---|
| user tabs attached, omp's own tab open | 3/3 every run | 0/3 every run |
| after `app.target` adopts one | 3/3 | 1/3, the adopted one |
| foreign `Target.attachToTarget` on a user tab | accepted 5/5 | refused 5/5 |
| click in omp's tab; read in the adopted tab | 5/5 | 5/5 |
| user tab blocked on `confirm()`: omp's `browser.pages()` | hit the 10 s cap 5/5 | returned at once 5/5 |
| popup (`_blank` link, `window.open`, with features) from omp's tab: attached / in `pages()` | 15/15 / 15/15 | 0/15 / 0/15 |

- `browser-relay-tab-isolation.test.ts` (real extension) adds "attaches the debugger only to tabs omp opens or adopts", failing on `main` 9d5d4ac5b5 (with "adopts a page on a CDP endpoint that rejects unknown methods…"). New bridge tests (owned-only attach, refusal, claim failure in both answer orders, a client leaving mid-attach with another owner as control, discard cancelling a claim, create and hello cleanup) each fail without the fix.
- `browser-attach`, `browser-background-input` and the `browser-relay-*` files: 235 pass, 1 skipped; `bun check` passes.
- Relay running a build from before this change with another CDP client connected, this PR's omp, n=3 per arm: without the `ompRelayCdpProtocol` check omp used it, `app.target` failed with `'OMP.claimTarget' wasn't found` and both user tabs got the debugger (3/3); with it omp stopped at "is out of date" (3/3). `browser-relay-probe.test.ts` "rejects a relay from before tab claims, even while CDP clients use it" fails without the check.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)




