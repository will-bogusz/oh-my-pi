## What

I wanted to say "wake me when CI on my PR is green" and have the agent arm that condition timer itself, instead of sleeping in a loop or leaving me to type `omp timer set --ci`.

The `timer` tool takes `when: {cmd|ci|pid}` on `set` and `edit`, the same conditions `omp timer set --until/--ci/--pid` arms: checked by the ticker every minute with no model tokens, firing once when it holds.

| Asked to… | Before | Now |
|---|---|---|
| "once CI on #482 is green, tag v2.3" | the tool has no condition: the agent polls in its turn, or types `omp timer` into `bash` | `set` with `when: {ci: "o/r#482"}`; the card shows the gate and its test run (`now: not-yet`) |
| wait on a condition that already holds | — | refused once: a shell check is told how to wait; a CI or process condition is named and the agent told to do the work now. The same call again arms it |
| a second watcher on the same condition | — | refused as a duplicate, naming the first |
| the timers listed in the tool description | — | a CI or process condition by its label; a shell check only as `when a shell check passes`, never its text |
| how long a condition timer it set lives | — | 24 hours, unless `expires` says otherwise |

| `when` | Approval |
|---|---|
| `ci`, `pid` on a timer that wakes this session | write |
| `cmd`, and any later call on a timer that stores a shell check | exec, like `shell` |

<details><summary>Reading order</summary>

`tools/timer.ts` (the `when` field, `timerEditPatch`) → `timers/conditions.ts` (`typedCondition`: is a stored check a `ci`/`pid` one) → `timers/service.ts` (`gateMetRefusal` on `set`, and on `edit` inside the spec lock; the 24 h expiry) → `timers/duplicates.ts` → `tools/timer-view.ts` (`timerArgsTier`, `timerSpecTier`, call line, pill) → `timers/snapshot.ts` → `prompts/tools/timer.md` → tui `tools/timer.ts` (the gate row).

</details>

## Why

The conditions exist for the CLI, but an agent asked to wait for CI could not set one: in the eval's first canary on the timer series without this change, the agent could not arm a condition timer at all.

Decisions:
- **A condition that holds at `set` is refused, not armed**: it would fire at the next tick. A repeat within 10 min arms it, like the tool's other refusals.
- **Typed conditions are compared by their check, shell checks by words**: two different CI or process checks never match, an identical one always does. By words, every compiled `ci` check is the same shell template: an earlier version's first eval run had 21 of 22 duplicate refusals false (#482 refused as #479's) and passed "push, then once CI is green tag v2.3" 4 of 9 times.
- **Shell-check text stays out of the description**: it can carry tokens or credentials.
- **Condition timers the agent sets expire after 24 hours**, so a check that never holds doesn't run for days.

The one decision for the maintainer: the agent can now set condition timers. A `when.cmd` check is an arbitrary shell command the ticker runs every minute (and once at `set`, as its test run), so it needs exec approval like `shell`, as does any later call on a timer that stores one; `ci` and `pid` compile to fixed checks and stay at write.

Maintenance: none new; the checks are `omp timer`'s own. Non-goals: conditions that fire repeatedly.

## Testing

Live at `c02e9b0da55` (the head only rewords the pid refusal), claude-haiku-4-5 over RPC, isolated stores: asked to wake the session when process N exits, the agent set `when: {pid: N}`, which fired into the live session the tick after the process exited (`BUILD_DONE`). A real `when.ci` on a finished commit, checked against GitHub, was refused by label. Under `--approval-mode write`, `when.cmd` asked approval and `when.pid` didn't.

<details><summary>Telling lines from the live runs</summary>

```
tool timer {"op":"set","id":"build-3077035","when":{"pid":3077035},"prompt":"BUILD_DONE",…}
gate   process 3077035 exited, checked each minute · now: not-yet
$ omp timer tick
  build-3077035 gated-not-yet — check #1
$ omp timer tick   # a minute after the process exited
  build-3077035 fired build-3077035#2 — mailed to live session 01a165c1-…
message_end role=custom customType=timer-fire <timer-fire id="build-3077035" run="2" … via="live">
message_end role=assistant  BUILD_DONE

# --approval-mode write
tool timer {"op":"set","id":"dist-app-js-build","when":{"cmd":"test -f dist/app.js"},…}
ui_request select "Allow tool: timer" ["Approve","Approve timer for this session","Deny"]
tool timer {"op":"set","id":"pid-3077991-exit","when":{"pid":3077991},…}
approval requests during the pid turn: 0

# TimerTool.execute set, when.ci can1357/oh-my-pi@0b5c27ab…, real gh against GitHub
not armed: the condition already holds — CI on can1357/oh-my-pi@0b5c27ab2471 finished, checked just now (printed: Resolve release metadata: SUCCESS) — so this timer would fire at the next tick instead of waiting.
It has already happened: do the work now instead. To arm it anyway, send this same call again within 10m.
```

</details>

`bun test`, 17 timer-related files in coding-agent and tui at `c02e9b0da55`: 319 pass; at the head `timer-set-guards` + `timer-surfaces`: 49 pass. Each new test fails with its code reverted: both refusals (an edit keeps the old condition), the 24 h expiry, typed-condition duplicates, both exec tiers, shell-check text kept out of the description, and each typed refusal's wording. `bun run check` in coding-agent and tui.

Eval (the series' sandboxed harness, real omp, Claude Haiku 5.5 and GPT-5.4 mini), this head vs the pre-split build: C10 haiku 6/6, mini 2/3 (was 6/6, 3/3); C12, a process on another host, mini 9/11 (was 2/6); suite C train haiku 62/66 (was 56/66). A replay of the 22 refusals kept only the true one.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
