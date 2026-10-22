## What

I kept asking the agent to check back on something in an hour, and it would either sit in a `sleep` loop or promise to and never come back, so I wanted it to be able to set the timer itself.

The agent gets a `timer` tool to wake its own session later or on a schedule, or run a shell command on one; on an integration build with more timer features, tuning it took held-out scheduling asks done right from 83% → 94% (Claude Haiku 5.5 and GPT-5.4 mini), against the tool before tuning.

| Asked to… | Before | Now |
|---|---|---|
| "check the deploy in an hour" | a `sleep` or polling loop that holds the turn, or a promise nothing keeps; you type `/timer` yourself | `set` arms a wake of this session; its card names the id and fire time, and the ticker fires it with omp closed |
| "run the sweep every 15 min" | a crontab or launchd job the agent writes | `set` with `shell`, at `exec` approval |
| "has the market check fired?" | it greps the repo | the description lists this session's and project's timers; `list`, `show`, `runs` |
| change or stop one | `timer://` writes | `edit`, `pause`, `resume`, `remove`, `fire` |
| a `wait` that hits its cap | "background work may still be running" | adds "To wait longer, set a `timer`…" |

| Op | Approval |
|---|---|
| `list`, `show`, `runs` | read |
| the others, on a timer that wakes this session (`session` omitted, `origin`, `this` or `current`) | write |
| a shell command or another session's timer, also when `set` replaces one, or `allowTimers` | exec |

<details><summary>Reading order</summary>

`tools/timer.ts` → `prompts/tools/timer.md` → `timers/snapshot.ts` → `timers/duplicates.ts`, `confirm.ts` (refusals) → `tools/timer-view.ts` (`timerArgsTier`) → `tools/bash.ts`, `tools/wait.ts` (the hint) → tui `tools/timer.ts` (the card).

</details>

## Why

An agent can't keep a promise to come back: it sleeps in `bash`, writes its own crontab, or says "I'll check later" and ends the turn. In an eval of 16 scheduling asks on both models, the ask got done in 32% of runs with no tool and 91% with a stub of this one. #2763 and #8757 ask for this. Related: #5838's `wakeup` tool waits once inside the open session; these timers fire after omp exits, repeat, and run commands. Also #7381, #16690, #6336.

Decisions:
- **Top level, not under `xd://`**: hidden there, correct calls fell from 92% to 75%.
- **A tool, not `omp timer` through `bash`**: that route made the most invalid calls and stray test timers.
- **Root sessions only**: a subagent can't be resumed when its timer fires.
- **The description lists this session's and project's timers** (up to 12, secrets redacted), tuning's biggest gain.
- **A refused duplicate, or `fire` into this session, goes through when repeated** within 10 min; a `force` flag was passed unasked in 25/252 runs.
- **Recurring session wakes it sets expire after 7 days** by default; shell timers don't.
- **`session` defaults to `origin` (also `this`, `current`): this conversation**; without it, "wake yourself every 30 minutes" got 6/12 vs 12/12 (integration build).
- **A fired turn may change only its own timer and prompt timers that wake this session** (not `fire`), unless set with `allowTimers: true` or `--allow-timers`.

The one decision for the maintainer: a default-on, always-visible `timer` tool plus one line each in `bash` and `wait`, in every root session: about 975 o200k tokens with no timers listed, 1,350 with 12. `timer.enabled: false` removes all three. What that text bought:

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/f710fdcc-4f96-45b7-9ee8-109272a9dd02">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/89288953-e486-4efc-9d9d-3f74bb953f59">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/0d983c1d-42d0-42a6-ae42-c5eb596fb2ef">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/24ddd94c-fbcc-42bf-9946-1d87fa5f235d">
  <img width="780" alt="Change in scheduling asks done right, with 95% intervals. The tuning comparison used integration builds with condition timers and fresh-session agent runs, not this PR's head; the hint comparison pools three builds. Tuning the timer tool (it lists this session's timers and refuses duplicates; before = the tool before tuning), 12 held-out asks: Claude Haiku 5.5 74% → 90% (17 pts more, within noise), GPT-5.4 mini 93% → 97% (4 pts more, within noise), both models 83% → 94% (10 pts more, clear). The one-line timer hint in bash and wait: Haiku 70% → 84% (14 pts more, clear), GPT-5.4 mini 86% → 83% (3 pts fewer, within noise). With the hint, Haiku runs that slept or polled instead went 14% → 5% (9 pts fewer, clear); GPT-5.4 mini's stayed at 0%." src="https://github.com/user-attachments/assets/89288953-e486-4efc-9d9d-3f74bb953f59" />
</picture>

<details><summary>Exact numbers</summary>

| Text measured | Model | Before → after | Change, points [95%] |
|---|---|---|---|
| Tuned tool (listing, refusals); 12 held-out asks × 6 runs | Claude Haiku 5.5 | 53/72 74% → 65/72 90% | +17 [−1, +38] |
| | GPT-5.4 mini | 67/72 93% → 70/72 97% | +4 [−1, +12] |
| | both | 120/144 83% → 135/144 94% | +10.4 [+1, +22] |
| `bash`/`wait` line off → on; 9–10 wait asks per build, 3 builds, 3–6 runs | Claude Haiku 5.5 | 70% → 84% | +14 [+2, +28] |
| | GPT-5.4 mini | 86% → 83% | −3 [−15, +8] |
| same; runs that slept or polled instead | Claude Haiku 5.5 | 14% → 5% | −9 [−17, −2] |

</details>

Maintenance: the duplicate check is word overlap; a false match costs one repeated call. Non-goals: condition timers, fresh-session agent runs, subagents, other hosts.

## Testing

Live at `d522965b8c7` (before the guard, `allowTimers`, `origin`), claude-haiku-4-5 over RPC: asked to remind me in 2 minutes, the agent set a timer and the live session answered its fire (`delivered-live`). An SDK session in a second project lists only its project's timer, credential redacted. At the head, 4/4 "wake this conversation…" asks got `origin`.

<details><summary>Telling lines from the live runs</summary>

```
> prompt "Remind me in 2 minutes to stretch. When the reminder fires, reply with exactly: STRETCH_REMINDER_OK"
tool timer {"op":"set","id":"stretch-reminder","at":"in 2m","prompt":"Reply with exactly: STRETCH_REMINDER_OK","reason":"User requested stretch reminder"}
timer stretch-reminder armed (rev 1) — Thu 2026-10-22 14:32 EDT (today, in 2m), once
does   wake session 01a164e1-… (this session) → "Reply with exactly: STRETCH_REMINDER_OK"
assistant: Timer set! Reminder will fire in 2 minutes (`stretch-reminder`, 14:32 EDT).
$ omp timer tick
  stretch-reminder fired stretch-reminder#1 — mailed to live session 01a164e1-…
message_end role=custom customType=timer-fire <timer-fire id="stretch-reminder" run="1" … late="7s" via="live">
assistant: STRETCH_REMINDER_OK
#1  2026-10-22T18:33:05.111Z  schedule  fired  slot 2026-10-22T18:32:58.949Z  delivery=delivered-live
$ omp timer ls --json   → "by": "tool"

# reasons: project-a "FOREIGN_MARKER sync https://user:pass@example.com/x?token=abc", project-b "mirror https://user:pass@example.com/x?token=abc nightly"
$ (cd project-b) createAgentSession → timer tool description:
Timers this session or this project set, as of when this session started (`list` for every timer and its current state; …):
- b-sync · every 1h · mirror https://example.com/x?token=%5Bredacted%5D nightly
contains "user:pass@": false · "token=abc": false · "FOREIGN_MARKER": false

# at the head 9d4ec6280f9: "wake this conversation every 30 minutes to check the build"
tool timer {"op":"set","id":"check-build","every":"30m","prompt":"Check the build status. …","reason":"Monitor build progress every 30 minutes"}
does   wake session 01a165af-… (this session) → "Check the build status. …"
# 4 of 4 runs: no `session` field; 0 "No session matches"
```

</details>

`bun test`, 16 timer files at `9d4ec6280f9`: 261 pass; tui `timer-render`: 9 pass; each review fix's test, and each new guard, `origin`, `allowTimers`, `wait`-cap and availability test, fails with its code reverted. `bun run check` in coding-agent and tui.

<details><summary>What the unit tests cover</summary>

Approval (`timerArgsTier`, shared with `timer://…/edit`): reads `read`; own-session ops `write`, also with `session` `origin`, `this` or `current`; a shell command, another session's timer, `set` re-arming another session's id, or `allowTimers` `exec`; a padded id (`" foreign-shell "`) tiers and acts as the timer it names. Description: lists live timers as of its creation; another project's timer (stored by `/timer` with its prompt as reason) absent, one from there that wakes this session present, URL userinfo and token values redacted. Refusals: a duplicate job under a new id refused and named, also a re-check after a one-shot, while different PR numbers and unrelated timers arm; the same call within 10 min goes through, after that it is refused again; the CLI is never refused; `fire` into the calling session refused until repeated. Expiry: a recurring session wake gets 7 days, a recurring shell command none. Recursion: a fired turn arms and edits prompt timers that wake its own session, and is refused shell timers, other sessions' timers and firing another timer; `list` stays open. Render: a streaming `set` previewed from partial args; card, listing or error drawn. Availability: a root session gets the tool and both hints; a subagent (`taskDepth: 1`) and `timer.enabled: false` get none of them. `wait` at its cap: the timer hint appended to both cap messages only when the session has the tool.

</details>

<details><summary>The eval behind the numbers</summary>

Token cost: the native `countTokens` (o200k) on the tool's name, description and JSON schema at `d522965b8c7`, 901 with an empty registry and 1,276 with 12 listed timers, plus 37 for each of the `bash` and `wait` lines; content tokens, not a provider's wire framing.

Real omp builds in a sandboxed harness: real `timer` tool and store, every host-facing command stubbed, thinking `low`, scored by script from the store diff and call log. Tuning compared the tool before tuning (integration build `e26550bc52a`) with the tuned one (`27789caf651`) on the 12 asks of the held-out split; that build also carried condition timers and fresh-session agent runs, whose prompt lines this PR leaves out, and the eval was not rerun on this head. The split was not fully blind: earlier notes described how the two sweep asks below failed, and one negative's text was seen while editing. These runs used a harness that did not deliver async-job results; once that was fixed, follow-up cases improved with unchanged omp code, and these comparisons were not rerun. Its seeded timers are set from the project the agent runs in, so this PR's scoped listing shows them as the measured one did. The three asks that gained for Haiku (a duplicate sweep 0/6 → 6/6, editing the sweep's interval 3/6 → 6/6, a duplicate CI watcher 0/6 → 4/6) are ones where the right move is to find the existing timer. The `bash`/`wait` lines are word for word the ones measured; off/on pairs are per build and ask, pooled over three builds; rates are means of the 29 build × ask cells per model. Intervals are paired bootstraps (asks, then runs). The 32% → 91% comparison is an earlier 768-run eval of tool shapes on a stub store (judge-scored, 128 runs per arm, both models pooled). Opus 5.5 and GPT-6.1 Sol, one run per ask: 32/35 → 34/35 and 33/35 → 34/35, no refusal in 110 runs.

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
