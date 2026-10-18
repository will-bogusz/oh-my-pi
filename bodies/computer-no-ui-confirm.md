## What

I kept seeing subagents get `{ active: false }` from `computer.control.acquire` in a fraction of a second and then tell their parent the user had refused, when nobody was ever asked, so the result now says which of the two happened.

`control.acquire` returns `{ active: false, reason: "no-ui" }` when the session has no interactive UI to ask through (a subagent, print mode, plain RPC, ACP without elicitation) and `{ active: false, reason: "denied" }` when the user declines or the confirmation is cancelled. When control is granted, nothing changes.

Reading order:
- `ControlVerdict` in `tools/computer/protocol.ts`: the confirmation reply is now `"approved" | "denied" | "no-ui"` instead of a boolean.
- `ComputerSupervisor.#confirmControl`: decides the verdict; no UI means `no-ui` without opening a dialog, as before.
- `ComputerWorkerCore.#confirmControl` and `control.acquire` in `worker.ts`: any reply that is not a verdict counts as `denied`, so a mismatched host can never grant control.
- The tool prompt and both computer docs describe the two reasons.

## Why

On `main` the supervisor replies `false` both when it skips the dialog for lack of a UI and when the user says no, so the model cannot tell "this session can't ask anyone" from "the user said no". In my transcripts a subagent got `{ active: false }` back in 135 ms and again in 76 ms, retried, then reported a refusal that never happened. The prompt now tells the model that in a no-UI session asking again cannot succeed, which is what stops the retry.

Decision: an extra `reason` field rather than throwing in the no-UI case, so code that checks `active` keeps working and both refusals stay plain values.

Not in scope: how long an unanswered confirmation waits; it still runs to the run's timeout.

## Testing

- Live, print mode on `claude-haiku-5-5`, JS eval `return await computer.control.acquire({ reason: "smoke test" })`:
  - installed omp 18.12.1: `{ active: false }`
  - this branch (native addon built from the same `main` commit): `{ "active": false, "reason": "no-ui" }`
- `bun test test/tools/computer.test.ts`: 118 pass. With the source change reverted, the denied row of the live-approval test and the headless test fail. With the worker's verdict mapping replaced by a pass-through, the three new rows (`true`, `"yes"`, `null` replies) fail.
- `bun run check:ts` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
