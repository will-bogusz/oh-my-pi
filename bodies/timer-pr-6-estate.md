## What

I had scheduled jobs spread over launchd, systemd and cron on two machines and kept finding out days later that one had been failing, so I wanted them listed next to omp's own timers with the broken ones called out.

`omp timer ls --all` now also lists the scheduled work omp did not create (systemd timers and long-running services, `~/Library/LaunchAgents`, your crontab), read-only, with its next and last run, last result and health flags; `--host <name>|all` adds other machines over ssh.

<details><summary>What the listing looks like (4 of 11 rows of the anonymized Linux recording <code>test/fixtures/timer-estate/server.json</code>, through this branch's renderer)</summary>

```
external (11)
HOST    SOURCE        ID                                SCHEDULE                              NEXT      LAST        RESULT   FLAGS
server  systemd       chat-bot-poll.timer               OnUnitActiveSec=10min; OnStartupSec…  in 2m     7m ago      success  no-failure-alert,interval-only
server  systemd       feed-import.timer                 OnCalendar=Mon..Fri *-*-* 18:45:00;…  in 9h15m  8h29m ago   exit 1   failed
server  systemd       nightly-build-rerun-1021.service  started once                          —         22h54m ago  exit 1   failed,no-failure-alert
server  systemd(sys)  server-backup.timer               OnCalendar=*-*-* 06:15:00             in 3h1m   20h56m ago  success  ok

needs attention
  server feed-import.timer: failed · last exit 1 · state active/waiting · log journalctl --user -u feed-import.service · source /home/dev/.config/systemd/user/feed-import.timer
```

</details>

| Flag | Meaning (from OS state) |
|---|---|
| `failed` | last run failed as the scheduler judges it (systemd `Result=`, launchd exit, a signal) |
| `never-ran` | scheduled, no run recorded |
| `unarmed` | nothing will start it: no next elapse, plist not loaded or disabled |
| `no-failure-alert` | no `OnFailure=`; any launchd job; cron output that never reaches mail |
| `interval-only` | systemd timer with only monotonic triggers, no `Persistent=` catch-up |
| `sleep-lossy` | launchd `StartInterval`: intervals during sleep are dropped |

Reading order: `timers/external/types.ts` → `systemd.ts`, `launchd.ts`, `crontab.ts` → `estate.ts` (`scanHost`, `scanRemoteHost`, `parseRemoteListing`) → `render.ts` → the `ls` branch of `cli/timer-cli.ts`.

## Why

A machine running omp timers usually runs other schedulers too, and nothing shows them together or says which stopped working: a unit failing every night stays quiet until you look. Related: #2763.

Decisions:
- **Read-only**: omp never edits, pauses or adopts these jobs; it shows the source file and log so you fix them where they live.
- **A remote omp answers for itself**: `--host` first asks the remote's `omp timer ls --json --all` (its omp timers included, each row validated), else runs the same listing commands over ssh.
- **Next runs in the scanned host's zone**, not the caller's.
- **A failed listing command is an error for its scheduler**, never an empty list; the other schedulers keep their rows.

The one decision for the maintainer: `omp timer ls --all` reads this host's (and, with `--host`, ssh hosts') systemd, launchd and cron configuration and state, read-only.

Maintenance: parses `systemctl`, `launchctl`, `plutil` and `crontab -l` output; a format change shows as that scheduler's error in the listing, and `timer-estate.test.ts` replays recorded output of each. Non-goals: editing external jobs, `/Library/LaunchDaemons`, other users' crontabs, Windows Task Scheduler.

## Testing

Live, from this branch on a Linux host: `omp timer ls --all --json` returned 60 rows, no host errors. With `--host` a Mac whose remote shell has no omp, it fell back to ssh and said why, then listed 22 rows (21 launchd, 1 cron) with next runs in the Mac's zone, not the caller's.

<details><summary>Telling lines</summary>

```
hosts[1]: via "ssh", fallback "`omp timer --help` failed: sh: omp: command not found", errors []
daily 12:30 → next 2026-10-22T19:30:00Z (Mac in America/Los_Angeles, inspecting process in New York)
disabled and not-loaded LaunchAgents flagged unarmed
```

</details>

`bun test test/timer-estate.test.ts test/timers.test.ts test/timers-install.test.ts`: 98 pass (34 estate tests). With the review fixes reverted, 25 of the 34 fail; the 9 that pass are the original adapter cases and boundary rows. `bun run check` in `packages/coding-agent`.

<details><summary>What the estate tests cover</summary>

Replays of a recorded Linux host and Mac; every required listing command failing (launchd dump, state probe, `print-disabled`, systemd `list-units`/`list-unit-files`, both `show` stages) becomes that scheduler's error while the others keep rows; launchctl exit 113 reads "not loaded", any other exit an error; a `launchctl enable` override beats plist `Disabled`; cron and launchd next runs in the host zone, `CRON_TZ=` only on cronie; systemd `SuccessExitStatus=` counts as success, signals named by the host's `kill -l`; cron redirection table for `no-failure-alert`; control characters and tabs in plists, units and remote rows rendered inert; malformed remote listings fall back to ssh, malformed rows are skipped and counted.

</details>

Not run: the remote-omp (`via: "omp"`) path against a live host (no reachable host had an omp with `--all` on its ssh PATH; covered by the replay tests), and Windows (no scheduler adapter).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
