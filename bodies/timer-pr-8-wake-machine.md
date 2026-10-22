## What

My Mac sleeps overnight, so a timer I set for the morning just fired whenever I next opened the lid; I wanted the timer to wake the machine and run on time.

`omp timer set --at … --wake-machine` now wakes a sleeping Mac 2 minutes before a one-shot timer is due, so it runs on time instead of on the next wake; the wake moves, cancels and comes back with the timer.

| You do | The macOS wake (`pmset -g sched`) |
|---|---|
| `set --at 'in 32m' --wake-machine` | scheduled 2 min before the timer |
| `edit --at` | moved; the old one cancelled |
| `pause` / `resume` | cancelled / scheduled again while still ahead |
| `edit --no-wake-machine` / `--wake-machine` | cancelled / scheduled again |
| `rm`, or the timer fires and retires | cancelled |
| `--wake-machine` with `--every` | refused: one-shots only |
| timer under 2 min away, pmset refused, or not macOS | no wake; the card says why, and the timer runs on wake |

Reading order: `timers/install/wake.ts` (`syncMachineWake`) → `store.ts` (`machine_wakes`) → `tick.ts` (`syncTimerWake`, `reconcileMachineWakes`) → `service.ts` → `cli/timer-cli.ts`.

## Why

A sleeping Mac runs no ticker, so every timer due during sleep fires late, on wake. launchd's own calendar jobs behave the same (they run on the next wake), and keeping the Mac awake all night to catch one timer costs far more than one scheduled wake. Related: #2763.

Decisions:
- **`sudo -n pmset schedule wake`**: pmset is macOS's wake scheduler and needs root. `-n` never prompts; without a sudoers line (`<user> ALL=(root) NOPASSWD: /usr/bin/pmset`, printed in the warning) nothing breaks, the timer just runs on wake.
- **Never leave a stray wake**: omp records a wake before asking pmset for it and forgets it only once a cancel succeeds or its time passes. A refused cancel stays on record and the next tick retries; the tick also cancels the wake of a timer retired or removed by any path, and never schedules a new one.
- **One lock per timer across processes**, so a `set` and an `edit` racing cannot orphan a wake.
- **A wake is its instant**, formatted in the Mac's current zone on every call, so cancels still match after a time-zone change.

The one decision for the maintainer: omp schedules OS wakes with `pmset`, which runs as root on macOS through a passwordless sudo rule the user adds.

Maintenance: depends on pmset's local-time `MM/dd/yyyy HH:mm:ss` argument; if it changes, pmset refuses, `set` prints the warning and the timer still fires on wake. Non-goals: Linux (`--wake-machine` is a warning there), recurring timers, condition timers, omp editing sudoers.

## Testing

Live from this branch on a Mac with real `pmset` and passwordless sudo, isolated timer store: 10 of 10 checks passed (the table's rows), and no `pmset` wake was left afterwards.

<details><summary>Telling lines (excerpt of the run log)</summary>

```
$ omp timer set lw --at in 32m --wake-machine --shell true --reason live check wake
timer lw armed (rev 1) — Thu 2026-10-22 11:36 PDT (today, in 32m), once
$ pmset -g sched  (after set)
 [0]  wake at 10/22/2026 11:34:05 by 'pmset'
$ omp timer edit lw --at in 45m
timer lw edited, re-armed (rev 2) — Thu 2026-10-22 11:49 PDT (today, in 45m), once
$ pmset -g sched  (after edit: moved)
 [0]  wake at 10/22/2026 11:47:05 by 'pmset'
$ omp timer pause lw
$ pmset -g sched  (after pause: none)
$ omp timer resume lw
$ pmset -g sched  (after resume: back)
 [0]  wake at 10/22/2026 11:47:05 by 'pmset'
$ omp timer edit lw --no-wake-machine
⚠ a sleeping Mac runs this late, once, on wake
$ pmset -g sched  (after --no-wake-machine: none)
$ omp timer rm lw
$ pmset -g sched  (after rm: none)
$ omp timer set lr --every 1h --wake-machine --shell true --reason live recurring
error: wakeMachine needs a one-shot: set at without every, or turn wakeMachine off
$ omp timer set ls --at in 1m --wake-machine --shell true --reason live too close
⚠ machine wake not scheduled: its time, 2 minutes before 2026-10-22T18:05:25.614Z, has passed
```

</details>

Timer, install, mailbox and wake suites: 142 pass. With the review fixes reverted, 23 of the 27 `timer-wake.test.ts` tests fail; three targeted mutations (dropping the record on a refused cancel, removing the wake lock, recording after scheduling) each fail only their own tests. `bun run check` in `packages/coding-agent`.

Not run live: a refused cancel and a time-zone change, which need pmset to refuse or the Mac's zone to change; `timer-wake.test.ts` covers both with a fake pmset that parses stamps in the current `TZ` and refuses to cancel an event it does not hold.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
