## What

I had a subagent start two `omp -p` test runs from my Tern pane, and their browser tabs popped up as picture-in-pictures over my own session, so an omp started from another session's commands now leaves that session's pane alone.

The interactive TUI claims its terminal at startup (`PI_TERMINAL_OWNER_PID`, its pid). Every command it runs inherits the claim, so an omp started from its bash tool, an eval cell or a service sees a Tern pane or cmux workspace owned by another process and skips automatic Tern and cmux, going on to managed Chromium.

| open without `app`, inside a Tern pane or cmux workspace | main | this PR |
|---|---|---|
| interactive session and its subagents | Tern PiP / cmux split | unchanged |
| `omp -p` you type into the pane yourself | Tern PiP / cmux split | unchanged |
| `omp -p` an interactive omp started from its bash tool or an eval cell | PiP over the parent's pane | managed Chromium |
| `app.tern: true`, `app.target`, `PI_BROWSER_TERN=1`, `PI_BROWSER_CMUX=1` | Tern / cmux | unchanged |

## Why

Tern and cmux show a tab beside the omp drawn in that terminal. A child omp inherits `TERN_PANE`/`TERN_PANE_SOCKET` and `CMUX_SOCKET_PATH` from its parent, so a harness, a script or a subagent's test run put its tabs over the parent's transcript, where the user never asked to see them.

The claim comes from the process that owns the pane rather than from the child's mode: gating on `hasUI` would also change a user's own `omp -p` in a pane and every subagent, and a marker only the bash tool sets (`PI_SESSION_ID`) would miss children of eval kernels and services. An interactive omp always claims for itself, so a fork or split that opens its own pane keeps Tern there.

## Testing

- On a Mac with a fake Tern pane env (`TERN_PANE_SOCKET` at no daemon), an interactive omp in tmux ran `omp -p` with Haiku through its bash tool, and that child did one bare `browser.open`. On main the child tried Tern first ("Tern cannot show a browser here (Cannot reach the Tern daemon …); opened Chromium instead"). On this branch the child saw `PI_TERMINAL_OWNER_PID` set to the parent's pid and opened "headless browser (hidden, shared)" with no Tern attempt.
- `bun test test/tools/browser-tern-kind.test.ts`: the "another omp owns the terminal" case fails on main's resolver and passes here; the owner's own pid, an unclaimed pane and the explicit selectors keep Tern. The Tern adopt, relay and open-lease suites clear an inherited claim so they pass when run from an omp session's bash tool.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
