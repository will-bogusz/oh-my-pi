# timer

> Set, inspect and control timers: standing work that fires later — at a time or on a schedule — and then wakes a session, runs a fresh agent, or runs a shell command. Timers live in this machine's registry, so they outlive the turn and the session that set them. The store, ticker, delivery and the `omp timer` CLI are described in [Timers](../timers.md).

## Source
- Entry: `packages/coding-agent/src/tools/timer.ts`; shared views and approval tiers: `packages/coding-agent/src/tools/timer-view.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/timer.md`; registry listing: `packages/coding-agent/src/timers/snapshot.ts`
- Refusals: `packages/coding-agent/src/timers/duplicates.ts`, `packages/coding-agent/src/timers/confirm.ts`
- Transcript card: `packages/tui/src/tools/timer.ts`

## Input
`op` is one of `set | edit | list | show | runs | remove | fire | pause | resume`. `edit` changes only the fields it is given on an existing `id`; a new `at`/`every` replaces the whole schedule (and starts a new schedule generation), `expires: "never"` clears the expiry, and `session` cannot be changed (set the timer again).

| Field | Used by | Meaning |
| --- | --- | --- |
| `id` | all but `list` | `[a-z0-9][a-z0-9._-]*`. Optional for `set` (derived from `reason`); `set` on an existing id re-arms it and keeps its history. |
| `reason` | `set` (required) | Why the timer exists, in the user's terms. Shown on every surface. |
| `at` | `set` | One-shot: `now`, `in 2h`, `08:00` (next occurrence), `2026-10-22 08:00`, ISO. |
| `every` | `set` | Recurring: `15m`, `2h`, `daily 09:00`, or a 5-field cron. |
| `prompt` / `shell` | `set` (exactly one) | A self-contained instruction for the target session, or a command to run instead. |
| `session` | `set` | Where a prompt runs: `origin` (also `this` or `current`) for this conversation (default), `fresh` (a new agent session per run), `own` (one agent session the timer keeps and resumes every run), or a session id, id prefix or session file. |
| `whenClosed` | `set` | Target session not open when it fires: `resume` it headless (default) or `hold` the message until it opens. |
| `tz`, `cwd`, `expires`, `maxRuns` | `set` | IANA zone for clock times; working directory (default the session's; `run` = a fresh directory per agent run); `7d`, a date, or `never`; retire after N runs. |
| `model`, `agent`, `thinking`, `hermetic`, `maxTime`, `maxCost`, `expect`, `before`, `after`, `report` | `set`, `edit` (fresh/own prompt timers only) | [Agent-run settings](../timers.md#agent-runs). On `edit`, `"none"` clears a string key, `expect: []` and `maxCost: 0` clear those. |
| `allowTimers` | `set` | Let the turns and commands this timer fires create or change any timer, not only itself and prompt timers that wake the same session ([recursion guard](../timers.md#recursion-guard)). |

## Availability and approval
- Top-level (essential) in root sessions only, gated by `timer.enabled` (default `true`). Subagents do not get it: they cannot be resumed when the timer fires.
- In a turn a timer fire started or joined, it may change only that timer and prompt timers that wake this session (not fire them) unless the timer allows more ([recursion guard](../timers.md#recursion-guard)); `list`, `show` and `runs` stay open.
- Approval tiers (`timerArgsTier`, shared with `timer://<id>/edit`):
  - `list`, `show`, `runs`: **read**.
  - `set`, `edit`, `fire`, `pause`, `resume`, `remove` on a timer that wakes the calling session: **write**.
  - **exec** when the request or the stored timer runs a shell command (including `before`/`after` hooks), starts a fresh or own agent session, or targets another session, or the request sets `allowTimers`. `set` and `edit` on an existing id also take that timer's tier, so re-arming another session's timer is never cheaper than controlling it. A stored spec that exists but cannot be read is treated as exec.

## Result and rendering
- The model gets a text card rendered from the stored record, never from the request: next fire, cadence, action, limits, reason, last run, ticker liveness, and warnings (no tick recorded / ticker stale), followed by the `timer` calls that manage it. `list` returns the table `omp timer ls` prints.
- The tool description lists the live timers this session set or wakes, and those set from inside its project (id, schedule, reason; up to 12), as of the session's start, so an agent asked about "the market check" knows it is a timer. Other projects' timers are left out, and URL credentials and token-shaped secrets in a reason are redacted; `list` shows the whole registry.
- Refusals (tool only; the CLI and `/timer` are not refused): `set` of a new id whose job repeats an existing timer's (the same action kind about the same things: shared PR numbers, file names, most content words) names that timer and points at `show`/`runs`/`edit`/re-arming its id; `fire` of a timer that wakes the calling session says firing checks nothing. Each goes through when the agent sends the very same call again within 10 minutes.
- Recurring prompt timers the agent sets (session wakes, `fresh` and `own` runs) expire after 7 days unless `expires` says otherwise; recurring shell commands do not.
- The transcript draws the same facts as a framed card (`⏰ Timer armed <id> [armed]`, labeled rows, warning lines, `/timer show <id> · /timer rm <id>` in the bottom border); expanding it shows the full prompt or command. `list` draws an aligned listing; `runs`, `fire`, `remove` and errors draw sanitized text. While arguments stream, the call line previews the op, id, schedule (`in 2h`, `every 30m`) and the prompt or command.
- All displayed text is sanitized (control sequences stripped, tabs expanded, home shortened to `~`, lines truncated to width).
- The timers pill refreshes after every `timer` call.

## Guidance elsewhere
While the tool is active, the `bash` and `wait` descriptions point waits longer than a few minutes, or for a clock time or something the agent did not start, at `timer`, and a `wait` that hits its cap says to set a timer instead.
