## What

I wanted recurring agent work, like a nightly digest or a weekly review, to run by itself on a schedule inside a time and dollar limit I set, and to hear back in the session where I asked for it.

A prompt timer with `--session fresh` (a new session each run) or `own` (one session the timer keeps, so each run sees the last) now runs as an unattended omp agent when it fires, and its final message can report back to the session that set it.

| Flag (also `/timer`, `timer` tool) | Does |
| --- | --- |
| `--session fresh\|own` | only when named: the CLI still refuses a prompt without `--session`; `/timer` and the tool still default to waking this session (`session: origin`) |
| `--agent`, `--model`, `--thinking`, `--hermetic`, `--cwd run` | agent profile, model, thinking level, no rules/skills/extensions; `cwd run`: fresh directory for `fresh`, persistent directory for `own` |
| `--max-time` (default 30m), `--max-cost` (USD) | abort the run and fail it `timeout` or `budget` |
| `--expect <path>`, `--before`/`--after <cmd>` | outputs that must exist after the run; shell hooks around it |
| `--report said\|always\|failure\|never` | which results come back; `said` (default) skips successful runs whose final message ends with a `[quiet]` line |

Every run writes `result.json` (shown by `omp timer runs`, `/timers`, the tool), then:

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/61aa36d7-220e-471d-818e-aef70e974afb">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/160d3da4-fd41-4d22-baa0-73131e1e80df">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/8769c01a-6bbb-4237-bb7e-798a357e8955">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/c51993ac-e8d2-433e-87a2-7520a3c05290">
  <img width="780" alt="Decision flow for an unattended timer run's result, after result.json is written. If the timer's report setting holds it back (never; failure when the run passed; said, the default, when the run passed and its final message ended with a [quiet] line), there is no result report: it is kept in result.json and omp timer runs. Report settings do not suppress failure-policy alerts. If the timer was set from the CLI, with no session to report to, it goes to the configured notify sinks (desktop notification and/or alert command). If the session that set it (with /timer or the timer tool) is open right now in an omp that delivers mail, it arrives there as a timer-report turn: idle, it starts one, also after Esc; busy, it joins at its next step; in ACP with agent-initiated turns off, an idle session waits for the client's next prompt. Otherwise it waits in that session's mailbox until an omp can deliver it, and also goes to the configured notify sinks." src="https://github.com/user-attachments/assets/160d3da4-fd41-4d22-baa0-73131e1e80df" />
</picture>

<details><summary>Reading order</summary>

`timers/agent-run.ts` (`runAgent`, the RPC host and its limits, `reportRun`) → `agent-profile.ts` → `run-result.ts` → the run fields in `types.ts`, `service.ts` (`validateRunSettings`, `applyRunInput`) and `runner.ts` → `tools/approval.ts` (`NO_UI_APPROVAL_DENIAL`) and `extensions/wrapper.ts` → mailbox side: the `timer-report` kind in `mailbox/types.ts`, `message.ts` and `watcher.ts` → `cli/timer-cli.ts`, `tools/timer.ts`.

</details>

## Why

Running recurring agent work outside an open session means wiring an OS scheduler around `omp -p` and handling its limits and output yourself; #2763 asks for first-class scheduling. Related: #7381, #6336 (prompts into an open session), #16690, #5838 (a one-shot wakeup of the live session; this starts a separate agent).

Decisions:
- **Each run is its own `omp --mode rpc --no-ui` process**: a normal session's tools, settings and logins; the runner sees each call's cost as it ends and can abort the turn.
- **Approvals are denied, not waited on**: the run fails `approval`, naming the tools; `tools.approval.<tool>: allow` lets runs use one.
- **No implicit paid run**: editing a shell timer into a prompt is refused too.
- **An `own` run never forks its session**: while another omp has it open, the run fails `busy` without starting.
- **The run's final message is untrusted data**, fenced in `<timer-run-output untrusted="true">`.
- **Recurring agent runs the `timer` tool sets expire after 7 days** unless `expires` says otherwise.
- **An agent run may change only its own timer** unless set with `--allow-timers`.

The one decision for the maintainer: a timer can start an unattended, billed agent session on a schedule; tool calls needing approval are denied, and the agent is aborted at `maxTime` (default 30 min) or after crossing an optional `maxCost`; teardown and the after hook can extend the run.

Maintenance: denials are recognized by `NO_UI_APPROVAL_DENIAL`, one constant shared by the wrapper's error and the runner; `maxCost` sums RPC `message_end` usage, so it overshoots by the crossing call. Non-goals: subagents' spend in `maxCost`, a per-run turn limit, hooks on Windows (`/bin/sh`).

## Testing

Live, claude-haiku-4-5, isolated stores: a `fresh` run set by `/timer` in an RPC session reported back into it; a CLI-set one went to the sinks; with `bash` at `prompt`, a run failed `approval` without hanging; `--max-cost 0.001` aborted a run after one call; a second `own` run saw the first; a third, with the session open elsewhere, failed `busy`.

<details><summary>Telling lines from the live runs</summary>

Run at `d3d363e8a38`. The head `b8da397b409` sits on a parent that since changed the recursion guard and added `allowTimers` and `session: origin`; this PR's diff changed only to merge with them (`resolveTarget`, the schema, the docs' guard line), plus one guard test and a dropped stale CHANGELOG line.

```
> /timer set fresh-digest --session fresh --model anthropic/claude-haiku-4-5 --at 'in 1m' --max-cost 0.05 --prompt 'Reply with exactly: FRESH_RUN_OK' …
timer fresh-digest armed (rev 1) — Thu 2026-10-22 14:40 EDT (today, in 60s), once
does   fresh session in …/fresh/work → "Reply with exactly: FRESH_RUN_OK"
run    model anthropic/claude-haiku-4-5 · max $0.05 · report said
$ omp timer tick
  cli-digest fired cli-digest#1 — runner (agent run, fresh)
  fresh-digest fired fresh-digest#1 — runner (agent run, fresh)
message_end role=custom customType=timer-report <timer-report id="fresh-digest" run="1" outcome="ok" session="fresh" …> … finished run 1 in a fresh session: ok, $0.0040, 4s.
message_end role=assistant  Timer `fresh-digest` run 1 completed successfully. … reported back with status "ok" …
$ omp timer runs fresh-digest
#1  …  schedule  fired  …  delivery=delivered-live (report)  end=ok 4s  result=ok · $0.0040 · 17.7k tok · 4s · reported (mailed-live)
$ omp timer runs cli-digest          # set from the CLI: no session to report to
#1  …  schedule  fired  …  end=ok 5s  result=ok · $0.0038 · 17.7k tok · 5s · reported (notified)

# work/.omp/config.yml: tools.approval.bash: prompt
$ omp timer runs approve-check
#1  …  manual  failed  end=failed 9s (approval: needed an approval nobody can give an unattended run: bash)  result=failed: approval · … · $0.0394 · 36.0k tok · 9s · reported (notified)
$ omp timer logs approve-check 1
approvals denied: bash

$ omp timer runs budget-check       # --max-cost 0.001
#1  …  manual  failed  end=failed 4s (budget: spent $0.0363, over maxCost $0.0010)  result=failed: budget · $0.0363 · 17.9k tok · 4s · reported (notified)
"stopReason":"aborted"

$ omp timer runs own-check
#1  …  manual  fired  end=ok 4s  result=ok · $0.0044 · 17.9k tok · 4s
#2  …  manual  fired  end=ok 4s  result=ok · $0.0034 · 18.4k tok · 4s
#3  …  manual  failed  end=failed 0s (busy: its own session is open in another omp process (rpc, pid 2705485); …)  result=failed: busy · $0.0000 · 0 tok · 0s
$ omp timer logs own-check 2
final text:
OWN_RUN_OK 1
$ ls own session dir                # after run 3
2026-10-22T18-38-27-359Z_01a164e8-4a1f-72ac-afbc-a2633f941f8e.jsonl
```

</details>

At `b8da397b409`, `bun test` of the 17 timer test files: 286 pass, 0 fail. Each review fix (shell→prompt edit, tool expiry, `busy`, host not ready by `maxTime`, after-hook spawn failure) has a test that fails with it reverted, as does the new own-timer guard test. `bun run check` in `packages/coding-agent`.

Not run: Windows (the hook tests are skipped there).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
