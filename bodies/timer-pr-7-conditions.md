## What

I kept watching agents sit in sleep loops waiting for CI or a long build to finish, so I wanted a timer that checks the condition for free and only wakes the session once it holds.

`omp timer set --until '<shell>'`, `--ci owner/repo#123` (or `owner/repo@<sha>`) or `--pid <pid>` now fires a timer once its condition holds, checked by the ticker every minute with no model tokens; the check's output reaches the woken session.

> **Context.** A condition is a shell check with the same exit contract as `/loop --until`. `--ci` and `--pid` compile to such a check, so the ticker has one mechanism.

| Check exits | Timer |
|---|---|
| 0 | fires once and retires; stdout (first 16 KB) reaches the session as fenced untrusted data |
| 1 | not yet: checked again next minute; a not-yet streak is one recorded run |
| anything else (127, a signal, the 60 s timeout, cannot start) | broken: counts as a failed run, so it pauses after `--pause-after` (3) with one alert |

`set` and `edit` run the check once and show on the card whether it already holds or is broken; `--every`, `--at` and `--expires` set cadence, start and deadline.

Reading order: `timers/gate.ts` → `conditions.ts` → `run-command.ts` (`runInProcessGroup`) → `tick.ts` (`checkGates`) → `service.ts` → `cli/timer-cli.ts`.

## Why

"Tell me when CI finishes" today means a turn that sleeps and polls, spending tokens per check and dying with the session. The ticker already runs every minute while omp is closed, so it can run the check and start a turn only when there is news. Related: #2763, #10363.

Decisions:
- **Checks run outside the tick lock**, at most 4 at a time, each in its own process group with a 60 s timeout, so a hung check never holds up other timers or `fire`. The verdict is then decided against the timer as it is now: one paused, edited or removed meanwhile does not fire.
- **Typed `--ci`/`--pid`**, since hand-written checks are easy to invert: `--ci` waits for every check run and status to finish, whatever the result (one GraphQL read); `--pid` counts only "No such process" from `kill -0` as exited.
- **Fire once, then retire**; `--overlap` applies.

The one decision for the maintainer: the ticker runs user-written shell checks every minute (as the user, like `--shell` timers), spending no model tokens.

Maintenance: `--ci` reads `statusCheckRollup` counts via `gh api graphql`; if GitHub changes that shape, the read fails as a broken check and the timer pauses with an alert, never fires. Non-goals: native Windows checks (checks use `/bin/sh` like shell timers), conditions that fire repeatedly, webhooks.

## Testing

Live on GitHub from this branch: `--ci kubernetes/kubernetes@86e24819…` → not yet (6 pending status contexts; before the review fixes it said met); `--ci oven-sh/bun#46528` → met, summary listing its FAILURE checks; an unknown sha → broken, "no such commit". On macOS the `--pid` probe exited 0 for a dead pid and 1 for pid 1 ("Operation not permitted").

End to end on a Mac, before the review fixes (ticks by hand): a `--pid` timer recorded one not-yet run, fired the minute after the process exited and retired; a missing command showed `now: broken (exit 127 …)`.

<details><summary>That run</summary>

```
$ omp timer set waiter --pid <sleep pid> --shell 'echo exited >> done.out' --reason 'live check pid'
gate   process <pid> exited, checked each minute · now: not-yet
$ omp timer tick
  waiter gated-not-yet — check #1
$ omp timer tick  # next minute, after the process exited
  waiter fired waiter#2 — runner (shell)
$ omp timer runs waiter
#1  2026-10-22T16:24:01.416Z  gate  gated-not-yet  slot 2026-10-22T16:24:00.000Z
#2  2026-10-22T16:25:03.733Z  gate  fired  slot 2026-10-22T16:25:00.000Z  end=ok 0s
$ omp timer show waiter
timer waiter (rev 1) — done (gate-met), once, when its condition holds
$ omp timer set bad --until nosuchcmd-xyz --shell true --reason r
gate   `nosuchcmd-xyz` exits 0, checked each minute · now: broken (exit 127: /bin/sh: nosuchcmd-xyz: command not found)
⚠ the gate failed its test run; it counts as a failure each tick
```

</details>

Timer and mailbox suites: 136 pass. With the review fixes reverted, 17 tests of `timers.test.ts` fail, all of them new. `bun run check` in `packages/coding-agent`.

<details><summary>What the condition tests cover</summary>

Verdict mapping; a pid condition against a real process; a check's timeout kills its whole process group, and a child left holding stdout is killed when the shell exits; output capped at 16 KB on a character boundary, also for a check that writes until killed; a check that cannot start counts as a failure and pauses after 3; met checks obey `--overlap` skip and queue; no fire for a timer paused, edited or removed while its check ran, and expiry crossed during the check retires it; other timers and `fire` proceed while a check runs, and one check per timer across two ticks; `--ci` against a stand-in `gh` applying the real `--jq` to saved GraphQL responses (pending status context outside the listed checks, queued check run, finished with failures, unknown commit, failed read); a failed condition action alerts at once.

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
