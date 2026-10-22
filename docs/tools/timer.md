# timer

> Set, inspect and control timers: standing work that fires later — at a time, on a schedule, or once a condition holds — and then wakes a session, runs a fresh agent, or runs a shell command. Timers live in this machine's registry, so they outlive the turn and the session that set them.

## Source
- Entry: `packages/coding-agent/src/tools/timer.ts`; shared views and approval tiers: `packages/coding-agent/src/tools/timer-view.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/timer.md`
- Transcript card: `packages/tui/src/tools/timer.ts`; `/timers` sheet: `packages/tui/src/overlays/timers-panel.ts`
- Store, ticker, delivery: `packages/coding-agent/src/timers/`
- `timer://`: `packages/coding-agent/src/internal-urls/timer-protocol.ts`
- Slash commands: `packages/coding-agent/src/slash-commands/builtin-timer.ts`
- CLI: `omp timer …`, `omp poke <session> <message>` (`packages/coding-agent/src/cli/timer-cli.ts`)

## Input
`op` is one of `set | list | show | runs | remove | fire | pause | resume`.

| Field | Used by | Meaning |
| --- | --- | --- |
| `id` | all but `list` | `[a-z0-9][a-z0-9._-]*`. Optional for `set` (derived from `reason`); `set` on an existing id re-arms it and keeps its history. |
| `reason` | `set` (required) | Why the timer exists, in the user's terms. Shown on every surface. |
| `at` | `set` | One-shot: `now`, `in 2h`, `08:00` (next occurrence), `2026-10-22 08:00`, ISO. |
| `every` | `set` | Recurring: `15m`, `2h`, `daily 09:00`, or a 5-field cron. |
| `when` | `set` | Condition checked each minute without model tokens; fires once when it holds. Exactly one of `cmd` (exit 0 = fire, 1 = not yet, anything else = failure), `ci` (`owner/repo#123`, a PR URL, or `owner/repo@sha`: every check finished), `pid` (the process exited). |
| `prompt` / `shell` | `set` (exactly one) | A self-contained instruction for the target session, or a command to run instead. |
| `session` | `set` | `origin` (default: this conversation), `fresh` (a new agent session per run), or a session id. |
| `whenClosed` | `set` | Target session not open when it fires: `resume` it headless (default) or `hold` the message until it opens. |
| `tz`, `cwd`, `expires`, `maxRuns`, `model` | `set` | IANA zone for clock times; working directory (default the session's); `7d`, a date, or `never`; retire after N runs; model for fresh runs. |

## Availability and approval
- Top-level (essential) in root sessions only, gated by `timer.enabled` (default `true`). Subagents do not get it: they cannot be resumed when the timer fires.
- Approval tiers (`timerArgsTier`):
  - `list`, `show`, `runs`: **read**.
  - `set`, `fire`, `pause`, `resume`, `remove` on a timer that wakes the calling session: **write**.
  - **exec** when the request or the stored timer runs a shell command, starts a fresh agent session, targets another session, or names another host. `set` on an existing id also takes that timer's tier, so re-arming another session's timer is never cheaper than controlling it. A stored spec that exists but cannot be read is treated as exec.

## Result and rendering
- The model gets a text card rendered from the stored record, never from the request: next fire, cadence, action, gate and its dry-run verdict, limits, reason, last run, ticker liveness, and warnings (no tick recorded / ticker stale, condition already holds, gate failed its dry run). `list` returns the table `omp timer ls` prints.
- The transcript draws the same facts as a framed card (`⏰ Timer armed <id> [armed]`, labeled rows, warning lines, `/timer show <id> · /timer rm <id>` in the bottom border); expanding it shows the full prompt or command. `list` draws an aligned listing; `runs`, `fire`, `remove` and errors draw sanitized text. While arguments stream, the call line previews the op, id, schedule (`in 2h`, `every 30m`, `when CI on o/r#12`) and the prompt or command.
- All displayed text is sanitized (control sequences stripped, tabs expanded, home shortened to `~`, lines truncated to width).

## Behavior
- Each timer is a spec file `<agentDir>/timers/specs/<id>.md` (YAML frontmatter, prompt as body); run history and per-timer state live beside it under the timers root. `OMP_TIMERS_DIR` overrides the root.
- Nothing fires by itself: `omp timer tick` evaluates due timers, runs condition gates, and dispatches. It is meant to run once a minute from one OS unit per host. Missed slots coalesce into one late run; a one-shot more than 12 h late is recorded `missed`.
- Session targets get a message in the session's mailbox. A live omp holding that session injects it as a `timer-fire` message that starts a turn when idle or follows the current turn. If none holds it, the session is resumed headless so the turn lands in the same session file; `whenClosed: "hold"` leaves the message for the next opener.
- Condition output and data passed to a manual fire reach the run inside `<timer-data untrusted="true">`; the saved prompt is the authority.
- Agent-set recurring timers expire after 7 days and condition timers after 24 hours unless `expires` says otherwise.
- Run outcomes (`fired`, `gated-not-yet`, `skipped-overlap`, `missed`, `failed`) are recorded separately from delivery (`queued`, `delivered-live`, `resumed-headless`, `held`).

## Related surfaces
- **`/timer`** (TUI, RPC, ACP): `/timer in 2h <prompt>`, `/timer at 8:00 <prompt>`, `/timer at 2026-12-01 09:30 <prompt>`, `/timer every 30m <prompt>` set a wake of the current session; the prompt is also the reason (and the id is derived from it). The schedule takes the `at`/`every` grammar of the tool. The CLI verbs work too: `/timer ls`, `show <id>`, `runs <id>`, `logs <id> [seq]`, `fire <id> [data]`, `pause <id>`, `resume <id>`, `rm <id>`, and `/timer set [<id>] --reason … --at|--every|--until|--ci|--pid … --prompt|--shell …` (the `omp timer set` flags; the target defaults to the current session). The TUI shows the card or listing as a report; elsewhere the text is printed.
- **`/timers`**: in the TUI, a sheet listing every timer beside the selected one's card. ↑/↓ select, ↵ card, `l` newest run log, `f` fire now, `p` pause/resume, `d` twice remove, Esc close. Elsewhere it prints the listing.
- **Timers pill**: the status line (and the native HUD pill row) shows `⏰ <n> · next <HH:MM>` for armed timers the current session set; clicking the native segment opens the sheet. It refreshes after every `timer` call or `/timer`, and every 30 s.
- **`timer://`**: `read timer://` lists timers; `timer://<id>` is the card plus the full prompt or command; `timer://<id>/runs` the run history; `timer://<id>/runs/<seq|latest>` one run and its log (shell and fresh-agent runs write one; `grep`/`bash` can address it). Writes: `timer://<id>/fire` (content, if any, is passed to the run as untrusted data), `timer://<id>/pause`, `/resume`, `/remove` (no content needed). Writes follow the tool's approval tiers, are blocked in plan mode, and are refused when `timer.enabled` is off.
- **Guidance elsewhere**: while the timer tool is active, the `bash` and `wait` descriptions point waits longer than a few minutes, or for a clock time or something the agent did not start, at `timer`, and a `wait` that hits its 30-minute cap says to set a timer instead.
- **CLI**: `omp timer ls [--json]`, `show`, `runs`, `rm`, `pause`, `resume`, `fire <id>`, `tick`; `omp poke <session> <message>` posts to the same mailbox from any script or cron job.
