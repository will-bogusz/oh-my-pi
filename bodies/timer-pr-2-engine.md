## What

I wanted to leave omp jobs for later, like "run the backup every night" or "come back to this session at 9 and check the deploy", and have them happen even when I've closed omp by then.

`omp timer set` schedules a shell command, or a prompt into an existing session, at a time, every N or on a cron, and the once-a-minute OS ticker that `omp timer install` sets up fires it whether or not omp is open.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/6287c895-82e0-4bc7-8039-e68a750cb96c">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/40376833-c29f-41aa-8ab8-915698b07941">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/500ef721-782d-4287-b360-5e22ef1216ad">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/55e1524a-5073-4b47-97dd-ecd0a1c680a3">
  <img width="780" alt="Decision flow for routing after a timer fire passes the schedule, grace and overlap checks. Shell timer: a detached runner runs it with /bin/sh -c and logs its output. Prompt timer whose session is open in an omp that delivers mail: idle, it starts a turn, also after Esc; busy, it joins at the next step; an ACP client with autonomous turns off gets it with its next prompt. Session open only in a process that does not deliver mail: held for the next opener that delivers, with a held alert, never resumed headless. Closed session set with --when-closed hold: held until an opener delivers mail, with a held alert. Otherwise a detached runner attempts a headless resume to deliver the fire in the session's own file. Before resuming headless, the runner rechecks whether another process has opened the session and leaves the mail to it if so." src="https://github.com/user-attachments/assets/40376833-c29f-41aa-8ab8-915698b07941" />
</picture>

| Command | Does |
| --- | --- |
| `omp timer set <id> --at 'in 2h' \| --every 'daily 09:00' \| --every 'cron 0 9 * * 1'` | `--shell <cmd>`, or `--session <id> --prompt <text>`; `--reason` required; limits: `--expires`, `--max-runs`, `--overlap`, `--grace`, `--catchup`, `--pause-after` |
| `edit`, `ls`, `show`, `runs`, `logs`, `fire`, `pause`, `resume`, `rm` | manage one timer; every verb takes `--json` |
| `omp timer install`, `uninstall`, `doctor` | the ticker: a launchd agent on macOS, a systemd user timer on Linux |

> **Timer context.** *Ticker*: one OS unit per user and host running `omp timer tick` every minute. *Store*: `<agentDir>/timers`, a Markdown spec per timer plus `timers.db` (SQLite) run state. Prompt fires go through `omp poke`'s session mailbox, so each lands once.

<details><summary>Reading order</summary>

`timers/types.ts` → `schedule.ts` → `store.ts` → `tick.ts` (`fire`, `sideEffects`, `settleRuns`) → `runner.ts` → `policy.ts` + `notify.ts` → `install/plan.ts`, `launchd.ts`, `systemd.ts`, `doctor.ts` → `cli/timer-cli.ts` (registered in `cli-commands.ts` with the file's existing lazy `import()` loader); mailbox side: the `timer-fire` kind in `mailbox/types.ts` and `watcher.ts`.

</details>

## Why

Today a job for later is a crontab line you write yourself, and nothing wakes a session at 9. #2763 and #8757 ask for scheduled work. Related: #10363 (job-completion wakeups in print/headless mode), #7381 (durable cron prompts), #5838 (an in-session wakeup tool), #6336 (a scheduler extension). This one fires while omp is closed and delivers from outside, exactly once.

Decisions:
- **The OS schedules, no omp daemon**: launchd and systemd already run a unit each minute across reboots (Linux: with linger, checked by `doctor`). Ticks recompute due slots: missed recurring slots coalesce into the newest; grace and overlap can still skip it.
- **Prompts wake an existing session only**, at most every 5 min.
- **Fires go in after Esc**, unlike pokes: you set them up.
- **By default, 3 failures in a row pause a timer**, with one alert (`timer.notify`, `timer.alertCommand`).
- **Recursion guard**: timer changes from a fired run, or a live fired turn's `bash`, are limited to its own timer unless `--allow-timers`.

The one decision for the maintainer: `omp timer install` adds a per-user launchd or systemd unit that runs `omp timer tick` every minute, and a tick may start a headless turn in a closed session (unless `--when-closed hold`). `omp timer uninstall` removes it.

Maintenance: new dependency `croner` 10.0.1 for cron and calendar slots; a SQLite store at schema v1 that refuses a newer one; units bake the omp binary, `PATH`, store and profile: if omp moves, `omp timer doctor` names the missing path and rerunning install fixes it; a launchctl or systemctl change fails install at its first tick. Non-goals: Windows support, fresh agent runs, a model-facing tool or in-session UI, other hosts.

## Testing

Live from this branch (claude-haiku-4-5, isolated stores). Linux, 5 of 5 passed: a shell timer per slot, a live RPC wake, a headless resume, the recursion guard's refusal, and a real systemd install, tick, `doctor` and `uninstall`. macOS: the same install checks with real launchd.

<details><summary>Telling lines from the live run</summary>

```
$ omp timer tick
  beat fired beat#1 — runner (shell)
$ omp timer tick  # same minute again
tick: 0 action(s)

  wake fired wake#1 — mailed to live session 01a164c9-…
message_end role=custom customType=timer-fire <timer-fire id="wake" run="1" … late="3s" via="live">
message_end role=assistant  TIMER_WAKE_OK
#1  …  schedule  fired  …  delivery=delivered-live

  closed fired closed#1 — resuming session 01a164c9-… headless
#1  …  schedule  fired  …  delivery=resumed-headless  end=ok 5s
"text":"HEADLESS_OK"            # in the session file; each run id once

  guard fired guard#1 — mailed to live session 01a164c9-…
error: this run was started by timer guard (OMP_TIMER_RUN=guard#1); it may set only timer guard, not timer sneaky. …
# control: the user's next prompt ran the same command: timer usermade armed (rev 1)

$ omp timer install
  ran systemctl --user enable --now omp-timer-tick.timer → exit 0
  ran systemctl --user start omp-timer-tick.service → exit 0
tick.log: tick: 0 action(s)          # first tick at install
$ omp timer doctor
doctor: ok
Oct 22 14:07:00 goliath systemd[…]: Starting omp-timer-tick.service …
  sysbeat fired sysbeat#1 — runner (shell)
$ omp timer uninstall
$ systemctl --user list-unit-files "omp-timer*"
0 unit files listed.

# macOS, real launchd (gui/501)
  ran launchctl bootstrap gui/501 …/sh.omp.timer-tick.plist → exit 0
runs = 1   last exit code = 0
doctor: ok                                           # 13 ✓
2026-10-22T18:18:03.596Z tick: 1 action(s)
  livefile fired livefile#1 — runner (shell)
2026-10-22T18:19:04.644Z tick: 1 action(s)
  livefile fired livefile#2 — runner (shell)
$ omp timer uninstall
Could not find service "sh.omp.timer-tick" in domain for user gui: 501
# tick.log still ends at 18:19:04Z more than 70 s later
```

</details>

`bun test test/timers.test.ts test/timers-install.test.ts test/mailbox.test.ts test/session-mailbox.test.ts`: 113 pass. 16 negative controls: each fix's test fails with the bug put back. `bun run check` in `packages/coding-agent`.

<details><summary>What the unit tests cover</summary>

Schedules: intervals keep their seconds, calendar slots in the timer's zone across DST gaps and repeats, cron day-of-month or day-of-week, catch-up coalescing, `--grace`/`--catchup skip`, queued slots past their grace recorded missed. Delivery: a fire re-dispatched after a crash reaches the session once; it counts as delivered only once the session file has it; a lost headless runner fails its run and its mail is withdrawn; a re-dispatch takes the route the session needs now; a live fired turn's `bash` commands carry `OMP_TIMER_RUN` and the user's next turn doesn't; after Esc a fire starts a turn. Runs: the revision a run was fired from; a timed-out command's descendants killed; overlap skip and queue; two concurrent ticks decide a slot once. Store: concurrent edits rev-checked, revisions kept across remove and re-create. Ticker: plist and systemd units, install fails when the first tick fails, the unit bakes the profile or agent dir, doctor's checks.

</details>

Not run: Windows.
