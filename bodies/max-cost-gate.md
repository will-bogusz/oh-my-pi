## What

I picked this up from #7978 because unattended runs need a hard stop on spend. I kept @zhang17-24's flags and settings, and moved the accounting into one ledger so subagents and side requests can't slip past the cap.

`omp --max-cost 2` now refuses the next model request once the session has spent $2, subagents included. `--warn-cost 1` warns once at $1. Both are also settings (`session.maxCost`, `session.warnCost`) and apply mid-session.

| Surface | When the cap is reached |
|---|---|
| Interactive | `Warning: cost-gate: …` once at `warnCost`. At the cap, `Error: cost-gate: Cost cap reached: this session spent $X of its $Y cap …`; the run stops, and a prompt sent while capped goes back to the editor, unsent |
| `-p` (text or `--mode json`) | The run stops, the refusal goes to stderr (a `cost-gate` `notice` frame in JSON), and the exit status is **3** |
| RPC | `prompt_result` reports `status: "error"`, `error.code: "cost_cap"`; the server stays up |
| Also refused and counted | Compaction, handoff, advisor, `/btw`, cache warming, eval `completion()`/`judge()`/`judge_batch()`, judgment `find`, job widgets; no title is generated |
| `/new`, resume, switch | The budget follows the session file: `/new` starts at $0, and resume or switch starts from the file's recorded spend |

**Known limit:** that recorded spend is the total the footer and `/usage` show, so it leaves out earlier runs' background-subagent and side-request spend. Within a run everything counts. Changing that total would also change the footer and `/usage`.

Non-goals: no cost estimate before a request is sent, so one already in flight can finish past the cap. No per-turn or per-subagent budgets.

## Why

Fixes #7802. Nothing stops a long or scheduled run on spend. The footer only shows the cost, and an extension reacting to `turn_end` has already paid for the response that crossed the line.

This carries #7978 by @zhang17-24, which stalled on review findings and conflicts with `main`. Their commit comes first; mine follow with `Co-authored-by`.

- **One ledger per session tree** adds each response's cost as it finishes. #7978 summed live session stats, which count a subagent only after its result is written back, so a running or detached child kept spending (the roboomp and Codex P1s).
- **The check runs on each provider attempt**, inside the concurrency slot and the image-retry loop, so a queued request is checked when it goes out.
- **Thresholds are read at each check**; #7978 froze them at startup.
- **Exit 3** tells a capped run apart from a failed turn (exit 1).

Related: #5177 (task-tree request budgets).

Reading order: `session/cost-gate.ts`, then `sdk.ts` (`guardStreamFn`; the primary stream's check), `agent-session.ts` (`#refuseOverCostCap`, `#reseedCostGate`), `modes/print-mode.ts`, `modes/rpc/rpc-prompt-results.ts`.

## Testing

Live on `claude-haiku-4-5`, in a dir holding `notes.txt`:

- `omp -p --max-cost 0.0001 "Use the read tool to read notes.txt, then reply with its first line."` exits 3 after the first response (`…spent $0.0026 of its $0.0001 cap…`); the follow-up request is never sent.
- `--warn-cost 0.0001` exits 0 with the answer and a warning on stderr.
- `-p --continue --max-cost 0.0001` exits 3, makes no provider call and writes nothing to the session.
- RPC, two prompts: both report `cost_cap`, then `session_settled`.
- Interactive with `--max-cost 0.002`: the refusal appears after the first response, and a second prompt comes back to the editor.

`bun test test/cost-gate.test.ts test/rpc-prompt-result.test.ts test/eval/completion-bridge.test.ts test/eval/judgment-bridge.test.ts`: 115 pass. Each fix's test fails with that fix reverted.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
