# Timers

A timer is standing work that fires later — at a time or on a schedule — and then runs a shell command or wakes an existing session with a prompt. Timers live in a per-host store outside any session, so they outlive the process that set them, and a once-a-minute OS unit (the ticker) fires them whether or not omp is open.

```sh
omp timer install                       # once per host: the ticker unit
omp timer set nightly --every 'daily 03:00' --shell 'make backup' --reason 'nightly backup'
omp timer set standup --at 'tomorrow 09:00' --session <id> --prompt 'Summarize yesterday' --reason 'standup notes'
omp timer ls
```

Source: `packages/coding-agent/src/timers/` (store, schedule, tick, runner, delivery), `src/timers/install/` (ticker units), `src/cli/timer-cli.ts` (CLI), `src/slash-commands/builtin-timer.ts` and `src/internal-urls/timer-protocol.ts` (in-session surfaces).

## CLI

`omp timer <verb> [id]`; every verb takes `--json` (errors too: `{"error","kind"}`). Exit codes: 0 ok, 1 failure, 2 usage.

| Verb | Does |
| --- | --- |
| `set [id]` | Create a timer, or re-arm an existing id (history kept). The id defaults to one derived from `--reason`. |
| `edit <id>` | Change only the given fields. A new `--at`/`--every`/`--when`/`--tz` starts a new schedule generation; `none` clears `at`, `every`, `expires` or `grace`. |
| `ls` (default) | Table of every timer with its status, next fire and last run, plus the ticker's heartbeat. |
| `show <id>` | The timer's card: next fire (with `today`/`tomorrow` when it is that close), cadence, action, limits, last run, open incidents, ticker. |
| `runs <id> [--limit N]` | Run history: trigger, outcome, slot, coalesced missed slots, delivery, end. |
| `logs <id> [seq]` | The runner log of a shell run or headless resume (default: the newest). |
| `fire <id> [--data text]` | Run it now, outside its schedule. `--data` reaches a prompt timer's session as untrusted data. |
| `pause <id>`, `resume <id>` | Pause; resume also clears an auto-pause and restarts the failure count. |
| `rm <id>` | Remove the spec (kept under `history/`); its run history stays. |
| `tick` | Evaluate every timer once. The ticker runs this; run it by hand to fire due timers now. |
| `install`, `uninstall`, `doctor` | Manage and check the ticker unit (see [Ticker](#ticker)). |

`set`/`edit` flags:

| Flag | Meaning |
| --- | --- |
| `--reason` | Why the timer exists (required on `set`). Shown everywhere. |
| `--at` | One-shot: `now`, `in 2m`, `in 1h30m`, `HH:MM` (next occurrence), `tomorrow 09:30`, `mon 09:00`, `2026-10-22 08:00`, or an ISO instant. A full date typed between midnight and 06:00 that lands a day after the same clock time's next occurrence is set as typed, with a warning on the card naming the sooner time. |
| `--every` | Recurring: a duration (`30m`, `2h`, `1d`), `hourly`, `daily 09:00`, `weekdays 09:00`, `weekends 10:00`, `mon,thu 18:30`, or a 5-field cron (`cron 0 9 * * 1`). With `--at`, the first slot is at or after it. |
| `--when` | Tern-style schedule mapped onto `--at` or `--every`: `in 20m`, `at 15:00`, `every 30m`, `daily 09:00`. A bare duration (`20m`) means `in 20m`. |
| `--shell` / `--prompt` | Exactly one: a command run with `/bin/sh -c`, or an instruction delivered to `--session`. |
| `--session` | Prompt timers: the session to wake, by id, id prefix or session file. A prompt timer without one is refused. |
| `--when-closed` | The session is not open anywhere when it fires: `resume` it headless (default) or `hold` the message until it is next opened. |
| `--tz` | IANA zone for clock times (default: this host's). Captured at set time, so a travelling laptop does not move the schedule. |
| `--cwd` | Working directory of a shell run or headless resume (default: the current directory). |
| `--expires` | `7d`, a date, or `never`: the timer retires after it. |
| `--max-runs` | Retire after this many runs. |
| `--overlap` | A fire while the previous run is still in flight: `skip` it (default) or `queue` exactly one. |
| `--grace` | How late a slot may still run; later slots are recorded `missed`. |
| `--catchup` | `run` (default) or `skip`; see [Catch-up](#catch-up-and-grace). |
| `--pause-after` | Consecutive failures that pause the timer (default 3). |
| `--allow-timers` | Let this timer's runs create or change other timers. |
| `--rev` | Fail unless the timer is at this rev (also on `pause`/`resume`). |

Recurring timers run at most every 5 minutes for prompts and every minute for shell commands.

## Ticker

Nothing fires by itself: `omp timer tick` evaluates due timers and dispatches them. One OS unit per host runs it once a minute:

- macOS: launchd agent `~/Library/LaunchAgents/sh.omp.timer-tick.plist`, logging to `<timers>/tick.log`.
- Linux: systemd user units `omp-timer-tick.timer` (`OnCalendar=minutely`, `Persistent=true`) and `omp-timer-tick.service`. User timers stop at logout unless linger is on (`loginctl enable-linger`); `doctor` warns when it is off.

`omp timer install` writes the unit with this shell's `PATH`, the store root, the mailbox root (`OMP_MAILBOX_DIR`) and the active profile (`OMP_PROFILE`) or agent dir (`PI_CODING_AGENT_DIR`, plus `PI_CONFIG_DIR` when set) baked in, so ticks, runs and headless resumes use the installing omp's settings and logins. It loads the unit and ticks once right away: systemd runs the service once; launchd's load-time run must exit 0 or write a fresh heartbeat within 30 seconds. A unit that cannot run fails the install. `--dry-run` prints the unit files and commands and changes nothing. `omp timer uninstall` unloads and removes them.

`omp timer doctor` checks that the unit is installed and loaded, that every path in its recorded command (the omp or bun binary and, for a source install, its `cli.ts`) still exists, that its store and its profile or agent dir match this omp's, the unit's last exit status with the tail of its journal (systemd) or tick log (launchd), the age of the last tick (older than 3 minutes fails), that the store is writable and at a schema this omp reads, version skew between the ticker and this omp, and linger on Linux.

Granularity: a timer fires at the first tick at or after its due instant. A one-shot or interval timer keeps the seconds it was set at and fires up to about a minute late (`in 2m` set at 10:00:40 is due at 10:02:40 and fires at the 10:03 tick). Clock schedules (`daily 09:00`, cron) fire on that minute's tick.

## Schedules

- A duration counts elapsed time from arming: `every 30m` set at 12:07:30 first fires at 12:37:30, never snapped to the clock. `every 24h` therefore drifts across DST; use `daily HH:MM` for wall-clock time.
- Calendar cadences run in the timer's `tz`. A wall time that does not exist (spring forward) runs at the same offset after the gap (02:30 → 03:30); a repeated wall time (fall back) runs once, at its first occurrence. A cron restricting both day-of-month and day-of-week matches either.
- A schedule change (`at`, `every`, `when`, `tz`) starts a new generation: slots and counters reset, history stays. A prompt, cwd or limit change keeps the current generation, so it never re-fires a slot.

## Catch-up and grace

Every tick re-derives due slots from the clock, so slots missed while the machine slept or no ticker ran coalesce into one late run of the newest slot (`runs` shows `coalesced N missed`). By default:

- a recurring timer runs that slot however late it is (it is never older than one period: systemd `Persistent=` semantics);
- a one-shot runs up to 12 hours late, then is recorded `missed`.

`--grace <duration>` caps the lateness for either. `--catchup skip` records any slot reached more than 5 minutes late as `missed` instead of running it. A slot buffered by `--overlap queue` is held to the same limit when its turn comes: past `--grace` (or the `--catchup skip` limit, or a one-shot's 12 hours) it is recorded `missed` instead of starting. A missed slot raises one `missed` alert per incident.

## Delivery

A shell timer runs in a detached runner (`omp timer exec`) that holds the timer's run lock for the run's life and records its end; its stdout/stderr go to the run log. A run executes the spec revision it was fired from (command, cwd, session): an edit applies from the next run.

A prompt timer posts a `timer-fire` message to its session's mailbox (`<agentDir>/mailbox/mail/<session>/`, shared with `omp poke`), delivered exactly once:

- **Open in an omp that delivers mail** (an interactive session, `omp --mode rpc`): the message starts a turn when the session is idle, also after Esc (a timer fire is standing intent you set up earlier), and joins a running turn at its next step otherwise. An ACP client that keeps agent-initiated turns off gets it with its next prompt.
- **Not open anywhere**: with `whenClosed: resume` (default) the runner resumes the session headless for one turn (`omp --mode rpc --resume <session>`), so the turn lands in the same session file; with `whenClosed: hold` the message waits for the next process that opens the session, and a `held` alert is raised.
- **Open only in a process that does not deliver mail** (an SDK host without `mailbox: { deliver: true }`, `OMP_MAILBOX=0`, an older omp holding its lease): the message waits for the next opener and a `held` alert is raised. omp never resumes a session headless while another process has it open, since that turn would land on a branch the other process never sees.

The message carries the instruction, why the timer exists, when it was scheduled and fired, how late it is (computed at delivery; 10 minutes or more asks the model to re-check the instruction), whether the turn runs headless, coalesced missed slots, and what happens next (retires, next fire, expiry). Data passed with `fire --data` arrives inside `<timer-data untrusted="true">`; the saved prompt is the authority.

A fire is in flight from the moment the tick commits it until its result is in — a shell run until its runner records an end, a prompt fire until its message is in the session file (or its headless resume failed) — and `--overlap` applies to any fire in that window, held mail included. The mailbox drops a copy of a message it already holds or delivered, so a fire re-dispatched after a crash reaches the session once; a re-dispatch takes the route the session needs at that moment (mail for a session opened since, a headless resume for one closed since). A runner that is gone two minutes after dispatch without recording a result fails the run (`lost`), and its message, if no session has taken it, is withdrawn so it never arrives after the failure was counted.

`runs` records each run's outcome (`fired`, `queued`, `skipped-overlap`, `missed`, `failed`) separately from its delivery (`queued`, `delivered-live`, `resumed-headless`, `held`); a delivery counts once the message is in the session file.

## Failures, pause and alerts

A run that fails (shell exit ≠ 0, headless resume failed, runner lost) counts toward `pauseAfter` (default 3). At the limit the timer pauses with the failure as its reason and raises one `paused` alert; `resume` clears the streak. Failures are grouped into incidents by a normalized error signature (paths, hex ids, numbers and quoted values stripped): an incident alerts once — at once for a one-shot, or after `pauseAfter` occurrences of a timer whose failures are separated by successes — and reminds after 24 hours if it keeps happening. A success closes alerted incidents. `ls` marks a timer with an open incident with `⚠`, and `show` lists them.

Alerts go to:

- [`timer.notify`](./settings.md): `desktop` (default; a macOS notification, or `notify-send` on Linux when a graphical session exists) or `none`;
- [`timer.alertCommand`](./settings.md): a shell command run once per alert with `OMP_TIMER_ID`, `OMP_TIMER_EVENT` (`failed`, `paused`, `missed`, `held`, `reminder`), `OMP_TIMER_SUMMARY`, `OMP_TIMER_COUNT` and, when known, `OMP_TIMER_RUN`, `OMP_TIMER_ERROR`, `OMP_TIMER_SIGNATURE`, `OMP_TIMER_LOG` in env, and the alert JSON on stdin.

Both are read from global settings, since the ticker runs outside any project. `omp poke` raises a `held` alert the same way when its message is held.

## In a session

- **`/timer`** (TUI, RPC, ACP): `/timer in 2h <prompt>`, `/timer at 8:00 <prompt>`, `/timer at 2026-12-01 09:30 <prompt>` and `/timer every 30m <prompt>` set a wake of the current session; the prompt is also the reason, and the id is derived from it. The CLI verbs work too: `/timer ls`, `show <id>`, `runs <id>`, `logs <id> [seq]`, `fire <id> [data]`, `pause <id>`, `resume <id>`, `rm <id>`, `/timer set [<id>] --reason … --at|--every|--when … --prompt|--shell …` (every `omp timer set` flag but `--json`; a prompt timer without `--session` wakes the current session), and `/timer edit <id> --<field> <value>` (the `omp timer edit` flags; `none` clears `at`, `every`, `expires` or `grace`). In the TUI the result is a card or listing above the editor, not a transcript entry.
- **`/timers`**: in the TUI, a sheet listing every timer beside the selected one's card. ↑/↓ select (a list taller than the sheet scrolls with the selection), ↵ card, `l` newest run log, `f` fire now, `p` pause/resume, `d` twice remove, Esc close. Elsewhere it prints the listing.
- **Timers pill**: the status line (and the native HUD pill row) shows `⏰ <n> · next <HH:MM>` for the armed timers the current session set; clicking the native segment opens the sheet. It refreshes after `/timer` and every 30 s.
- **`timer://`**: `read timer://` lists timers; `timer://<id>` is the card plus the full prompt or command; `timer://<id>/runs` the run history; `timer://<id>/runs/<seq|latest>` one run and its log (`grep`/`bash` can address the log). Writes: `timer://<id>/fire` (content, if any, reaches the run as untrusted data), `timer://<id>/edit` (content is a JSON object of the fields to change: `reason`, `at`, `every`, `tz`, `prompt`, `shell`, `whenClosed`, `cwd`, `expires`, `maxRuns`; e.g. `{"at":"in 3h"}`), `timer://<id>/pause`, `/resume`, `/remove` (no content needed). Acting on a timer that wakes the writing session needs `write` approval; a shell timer, another session's timer, or an edit that sets `shell` needs `exec`. Writes are refused when `timer.enabled` is off.

## Recursion guard

Every process a fire starts carries `OMP_TIMER_RUN=<id>#<seq>`, and so does every `bash` command of a turn a timer fire starts or joins in an open session (delivered live or held for the next opener), until your next message. Such a run may re-arm, edit, pause, remove or fire only its own timer, unless that timer was set with `--allow-timers`; reading stays open. A prompt timer's turn in the session it wakes, live or resumed headless, may also set, edit, pause, resume or remove prompt timers that wake that same session (not fire them): what they start lands in that one conversation, one turn at a time. Shell runs stay limited to their own timer. Without this, one fired run could arm timers that arm timers. Subagents a live fired turn spawns, and its `eval` cells, do not carry it.

## Files on disk

The store root is `<agentDir>/timers` (`~/.omp/agent/timers`); `OMP_TIMERS_DIR` overrides it.

| Path | Holds |
| --- | --- |
| `specs/<id>.md` | The timer: YAML frontmatter plus the prompt as the body. Every write is atomic and rev-checked under a per-spec lock, so two concurrent edits never lose one. |
| `history/<id>/<rev>.md` | Earlier revisions of a re-set, edited or removed spec. Revs keep counting when an id is removed and set again, so a rev names one revision for good. |
| `timers.db` | SQLite run state: per-timer slot state, runs, run ends, deliveries, incidents, and the ticker heartbeat. |
| `state/<id>/runs/<seq>.log` | Runner log of one shell run or headless resume. |
| `state/<id>/runs/<seq>.json` | Fire payload the tick hands to the runner. |
| `tick.log` | Output of the launchd ticker. |

Spec frontmatter keys: `version`, `rev`, `title`, `reason`, `at`, `every`, `tz`, `session` (a session id, or `fresh` for a shell timer), `session_file`, `when_closed`, `shell`, `cwd`, `expires`, `max_runs`, `overlap`, `grace`, `catchup`, `pause_after`, `allow_timers`, `paused`, `paused_reason`, `armed_at` (start of the schedule generation), `resumed_at`, and `created` (`at`, `by`, `host`, `cwd`, `session` and `session_file` when `/timer` set it, `when_text`, and `run` when a fired run set it). A spec whose `version` is newer than this omp reads is listed as invalid rather than misread.
