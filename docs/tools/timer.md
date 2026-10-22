# timer

> Set, inspect and control timers: standing work that fires later — at a time, on a schedule, or once a condition holds — and then wakes a session, runs a fresh agent, or runs a shell command. Timers live in this machine's registry, so they outlive the turn and the session that set them.

## Source
- Entry: `packages/coding-agent/src/tools/timer.ts`; shared views and approval tiers: `packages/coding-agent/src/tools/timer-view.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/timer.md`
- Transcript card: `packages/tui/src/tools/timer.ts`; `/timers` sheet: `packages/tui/src/overlays/timers-panel.ts`
- Store, ticker, delivery: `packages/coding-agent/src/timers/`
- `timer://`: `packages/coding-agent/src/internal-urls/timer-protocol.ts`
- Slash commands: `packages/coding-agent/src/slash-commands/builtin-timer.ts`
- CLI: `omp timer …` (`packages/coding-agent/src/cli/timer-cli.ts`), `omp poke <session> <message>` (`packages/coding-agent/src/cli/poke-cli.ts`)

## Input
`op` is one of `set | edit | list | show | runs | remove | fire | pause | resume`. `edit` changes only the fields it is given on an existing `id`; a new `at`/`every`/`when` replaces the whole schedule (and starts a new schedule generation), `expires: "never"` clears the expiry, and `session` cannot be changed (set the timer again).

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
  - `set`, `edit`, `fire`, `pause`, `resume`, `remove` on a timer that wakes the calling session: **write**.
  - **exec** when the request or the stored timer runs a shell command, starts a fresh agent session, targets another session, or names another host. `set` and `edit` on an existing id also take that timer's tier, so re-arming another session's timer is never cheaper than controlling it. A stored spec that exists but cannot be read is treated as exec.

## Result and rendering
- The model gets a text card rendered from the stored record, never from the request: next fire, cadence, action, gate and its dry-run verdict, limits, reason, last run, ticker liveness, and warnings (no tick recorded / ticker stale, condition already holds, gate failed its dry run). `list` returns the table `omp timer ls` prints.
- The transcript draws the same facts as a framed card (`⏰ Timer armed <id> [armed]`, labeled rows, warning lines, `/timer show <id> · /timer rm <id>` in the bottom border); expanding it shows the full prompt or command. `list` draws an aligned listing; `runs`, `fire`, `remove` and errors draw sanitized text. While arguments stream, the call line previews the op, id, schedule (`in 2h`, `every 30m`, `when CI on o/r#12`) and the prompt or command.
- All displayed text is sanitized (control sequences stripped, tabs expanded, home shortened to `~`, lines truncated to width).

## Behavior
- Each timer is a spec file `<agentDir>/timers/specs/<id>.md` (YAML frontmatter, prompt as body; every write is rev-checked, so two concurrent edits never lose one). Run history, delivery records, per-timer slot state and incidents live in `<agentDir>/timers/timers.db` (SQLite). `OMP_TIMERS_DIR` overrides the root.
- Nothing fires by itself: `omp timer tick` evaluates due timers, runs condition gates, and dispatches. It runs once a minute from one OS unit per host, installed by `omp timer install` (launchd agent `sh.omp.timer-tick` on macOS, systemd user `omp-timer-tick.timer` on Linux). Install ticks once right away on both platforms, so a unit that cannot run fails the install; `omp timer install --dry-run` prints the unit files and commands and changes nothing. `omp timer doctor` checks that the unit is installed and loaded, that every path in its recorded command (the omp or bun binary and, for a source install, its `cli.ts`) still exists, the unit's last exit status with the tail of its journal (systemd) or tick log (launchd), the heartbeat age, and the store.
- Granularity: the ticker runs once a minute, so a timer fires at the first tick at or after its due instant. A one-shot or interval timer keeps the seconds it was set at and fires up to about a minute late (`in 2m` set at 10:00:40 is due at 10:02:40 and fires at the 10:03 tick); the card of a one-shot says so. Clock schedules (`daily 09:00`, cron) are due on a minute boundary and fire on that minute's tick.
- `--wake-machine` (macOS, one-shot): `sudo -n pmset schedule wake` 2 minutes before `at`, so a sleeping Mac is awake when the timer is due. The scheduled wake follows the timer: removing it, pausing it, moving its `at`, turning `wakeMachine` off, or the timer retiring cancels the wake (`pmset schedule cancel wake`), and resuming reschedules it while it is still ahead.
- Catch-up: slots missed while the machine slept or no ticker ran coalesce into one late run of the newest slot. A recurring timer runs that slot however late (it is never older than one period); a one-shot runs up to 12 h late. A spec `grace` caps the lateness, and `catchup: skip` records any slot reached more than 5 minutes late as `missed` instead; a missed slot is notified once.
- Failures: a run that fails (shell exit ≠ 0, broken gate, model error, runner lost) counts toward `pauseAfter` (default 3); at the limit the timer pauses with the reason and raises one alert. Alerts go to `timer.notify` (`desktop` or `none`) and `timer.alertCommand` (run with `OMP_TIMER_*` env and the alert JSON on stdin). `resume` clears the streak.
- Session targets get a message in the session's mailbox, delivered exactly once. A live omp that has the session open injects it as a `timer-fire` message: it starts a turn when idle and joins the running turn at its next step otherwise. If no omp has it open, the session is resumed headless so the turn lands in the same session file; if it is open in a process that does not deliver timer mail (an SDK embedder, an older omp), or `whenClosed: "hold"`, the message waits for the next opener and a `held` notice is raised.
- Condition output and data passed to a manual fire reach the run inside `<timer-data untrusted="true">`; the saved prompt is the authority.
- Agent-set recurring timers expire after 7 days and condition timers after 24 hours unless `expires` says otherwise.
- Run outcomes (`fired`, `gated-not-yet`, `skipped-overlap`, `missed`, `failed`) are recorded separately from delivery (`queued`, `delivered-live`, `resumed-headless`, `held`).

## Related surfaces
- **`/timer`** (TUI, RPC, ACP): `/timer in 2h <prompt>`, `/timer at 8:00 <prompt>`, `/timer at 2026-12-01 09:30 <prompt>`, `/timer every 30m <prompt>` set a wake of the current session; the prompt is also the reason (and the id is derived from it). The schedule takes the `at`/`every` grammar of the tool. The CLI verbs work too: `/timer ls`, `show <id>`, `runs <id>`, `logs <id> [seq]`, `fire <id> [data]`, `pause <id>`, `resume <id>`, `rm <id>`, `/timer set [<id>] --reason … --at|--every|--until|--ci|--pid … --prompt|--shell …` (the `omp timer set` flags; the target defaults to the current session), and `/timer edit <id> --<field> <value>` (`none` clears `at`, `every`, `until` or `expires`). The TUI shows the card or listing as a report; elsewhere the text is printed.
- **`/timers`**: in the TUI, a sheet listing every timer beside the selected one's card. ↑/↓ select, ↵ card, `l` newest run log, `f` fire now, `p` pause/resume, `d` twice remove, Esc close. Elsewhere it prints the listing.
- **Timers pill**: the status line (and the native HUD pill row) shows `⏰ <n> · next <HH:MM>` for armed timers the current session set; clicking the native segment opens the sheet. It refreshes after every `timer` call or `/timer`, and every 30 s.
- **`timer://`**: `read timer://` lists timers; `timer://<id>` is the card plus the full prompt or command; `timer://<id>/runs` the run history; `timer://<id>/runs/<seq|latest>` one run and its log (shell and fresh-agent runs write one; `grep`/`bash` can address it). Writes: `timer://<id>/fire` (content, if any, is passed to the run as untrusted data), `timer://<id>/edit` (content is a JSON object of tool-shaped fields, e.g. `{"at":"in 3h"}`), `timer://<id>/pause`, `/resume`, `/remove` (no content needed). Writes follow the tool's approval tiers, are blocked in plan mode, and are refused when `timer.enabled` is off.
- **Guidance elsewhere**: while the timer tool is active, the `bash` and `wait` descriptions point waits longer than a few minutes, or for a clock time or something the agent did not start, at `timer`, and a `wait` that hits its 30-minute cap says to set a timer instead.
- **CLI**: `omp timer set|edit|ls|show|runs|logs|fire [--data]|pause|resume|rm|tick|install|uninstall|doctor`, each with `--json`; `omp timer ls --all [--host <name>|all]` adds systemd/launchd/cron jobs omp did not create. `omp poke <session> <message>` posts to the same mailbox from any script or cron job.
