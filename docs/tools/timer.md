# timer

> Set, inspect and control timers: work that fires later — at a time, on a schedule, or once a condition holds — and then wakes a session, runs a fresh agent, or runs a shell command.

## Source
- Entry: `packages/coding-agent/src/tools/timer.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/timer.md`
- Store, ticker, delivery: `packages/coding-agent/src/timers/`
- CLI: `omp timer …`, `omp poke <session> <message>` (`packages/coding-agent/src/cli/timer-cli.ts`)

## Input and availability
`op` is one of `set | list | show | runs | remove | fire | pause | resume`. `set` needs `reason`, one of `at` / `every` / `when` (`cmd`, `ci`, or `pid`), and one of `prompt` / `shell`. The tool is top-level (essential) in root sessions only; subagents do not get it because they cannot be resumed. Approval: `list`/`show`/`runs` read; waking this conversation is write; `shell`, `fresh`, or another session's target is exec.

## Behavior
- Each timer is a spec file `<agentDir>/timers/specs/<id>.md` (YAML frontmatter, prompt as body); run history is `timers/state/<id>/runs.jsonl`. `OMP_TIMERS_DIR` overrides the root.
- Nothing fires by itself: `omp timer tick` evaluates due timers, runs condition gates (exit 0 fire once, 1 not yet, anything else a failure; three failures in a row retire it), and dispatches. It is meant to run once a minute from one OS unit per host. Missed slots coalesce into one run; a one-shot more than 12 h late is recorded `missed`.
- Session targets get a message in `timers/mail/<session>/`. A live omp holding that session (interactive, RPC, print) injects it as a `timer-fire` custom message that starts a turn when idle or follows the current turn. If no live omp holds it, the tick resumes the session headless (an RPC host on `--resume`) so the turn lands in the same session file; `whenClosed: "hold"` leaves the message for the next opener instead.
- Condition output reaches the run inside `<timer-data untrusted="true">`.
- The tool result is a card rendered from the stored record: next fire, action, gate, limits, reason, last run, and ticker liveness.
- Run outcomes (`fired`, `gated-not-yet`, `skipped-overlap`, `missed`, `failed`) are recorded separately from delivery (`queued`, `delivered-live`, `resumed-headless`, `held`).

## Related surfaces
- `omp timer ls [--json]`, `show`, `runs`, `rm`, `pause`, `resume`, `fire <id>`, `tick`.
- `omp poke <session> <message>` posts to the same mailbox from any script or cron job.
