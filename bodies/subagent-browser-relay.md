## What

I keep `browser.relay` on so my own omp session can use my signed-in Chrome, but every subagent read the same setting and opened its tabs in my Chrome too, so the user's own browser and pane are now the main session's defaults and a subagent has to ask for them.

For a subagent (task child, eval `agent()`, `/tan` clone), an open without `app` skips the relay, Tern and cmux and goes on to `browser.cdpUrl` or managed Chromium. `app.relay: true` and `app.tern: true` still take it there.

| open without `app` | main | this PR |
|---|---|---|
| main session, relay on or in a Tern pane | user's Chrome / Tern PiP | unchanged |
| subagent, relay on (setting or `PI_BROWSER_RELAY=1`) | user's Chrome | `browser.cdpUrl`, else managed Chromium |
| subagent in a Tern pane or cmux workspace | PiP / split over the parent's pane | `browser.cdpUrl`, else managed Chromium |
| subagent with `app.relay: true` / `app.tern: true` | user's Chrome / Tern | unchanged |

**Decision for the maintainer:** whether a subagent reaches the user's own browser and pane only when it asks. The alternative is a setting (say `browser.subagentRelay`) for users who hand signed-in work to subagents; I left it out because `app.relay: true` already covers that per open and the parent writes the subagent's task. Advisors share their owner's browser and keep its defaults.

## Why

The relay is the user's real browser, signed in as them, among their windows; Tern and cmux put tabs beside the session they are reading. Subagents opening there by default meant parallel workers' tabs piling into the user's Chrome or over one pane. Across our last month of sessions, 143 of 305 browser opens passed `app.relay: false` and 138 passed `app.tern: false` by hand, and one orchestrator banned the default after a subagent's tab appeared in the user's Chrome, then spent about 240 shell calls running private headless Chrome instead.

`PI_BROWSER_RELAY=1` is process-wide, so subagents inherit it whether or not the user meant them; it is treated like the setting, and `PI_BROWSER_RELAY=0` still disables the relay everywhere. Subagent-ness comes from the session (`isSubagentSession` in the SDK), not `taskDepth`, which is 0 for `/tan` clones. A subagent reopening a relay tab name its parent opened now needs `app.relay: true`; without it the open fails with the existing browser-kind mismatch error.

## Testing

- On a Mac, Haiku, an `omp -p` parent spawning one task subagent, relay on with no extension connected: on omp 18.18.6 the subagent's bare `browser.open` went to the relay, timed out after 30 s, failed again ("extension never connected"), and reached Chromium only with `app.relay: false` on its fourth call. On this branch the same bare open returned "Opened tab … on headless browser (hidden, shared)" first time.
- `bun test test/tools/browser-relay-kind.test.ts`: a subagent session (a `/tan`-shaped one, depth 0) with the relay on, `PI_BROWSER_RELAY=1` and a Tern/cmux env opens headless or the configured CDP URL, `app.relay: true`/`app.tern: true` still select those, and it gets no relay guidance; all three fail with the gate reverted.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
