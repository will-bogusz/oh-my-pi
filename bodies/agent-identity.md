## What

I kept losing track of which subagent was which, so every agent now gets a fixed colour on its name in the Task tool rows and the agent hub, and when one agent's computer call gives up behind another's input lock, `InputBusy` says whose lock it was.

Main is blue; every subagent hashes its id into one of six other colours, the same colour in every row, live or finished.

<!-- IMAGE: upload with `pr-images upload --themed --scale 2 --alt "Task tool agent rows on main and on this branch" ~/tmp/trycua-omp/next-round/CursorChecks/identity/agent-rows-dark.png ~/tmp/trycua-omp/next-round/CursorChecks/identity/agent-rows-light.png` and replace this comment with its Markdown -->

| Surface | main | this PR |
|---|---|---|
| Task tool agent rows | name in accent while live, text when done | name in the agent's colour; the description keeps main's colours; a frozen snapshot stays dim |
| Agent hub roster rows | bold id, the selected one in accent | unselected ids in the agent's colour; the selected row keeps accent |
| `InputBusy` after waiting for another session | `another desktop operation owns input/focus control; no input was sent` | `agent "CursorChecks.Scout" (omp pid 4242) owns input/focus control; no input was sent`; main's text when the holder has no agent id or its process is gone |

**For the maintainer:** rows are coloured by default, with no setting. Keep it on, or gate it? Gating is a check around the `agentColored` calls.

<details><summary>Reading order</summary>

- `tui/src/overlays/agent-identity.ts`: `agentIdentity`, `AGENT_COLOR_HEX`, `agentColored`.
- Rows: `renderAgentTreeRow` (`agentId`), `renderAgentResult`, `AgentHubOverlayComponent#renderEntry`.
- Lock holder: `buildComputerSnapshot` (`agentId`) → worker `#ensureSession` → `DesktopSessionOptions.agent_id` → `CancellationSource::counting_escapes` → `KernelOwner::acquire` → `ProcessLease::name` (same omp), `KernelLease::record` / `KernelLease::holder` (other omp processes).

</details>

## Why

With several subagents running, rows differ only by name; a stable colour lets you follow one agent across the Task card and the hub. The palette is fixed names with one hex each, at least 3:1 against white and `#1e1e1e`, so a later agent cursor in a browser or on the desktop can draw an agent in the same colour without a theme. The agent cannot pick its colour.

- A fixed palette rather than `session-color`'s hue: that hue follows the active theme, and a cursor outside the terminal has none. The cost: it ignores the theme, and yellow and teal fall just under 3:1 on Solarized Light's background.
- `InputBusy` names the full agent id, not its last segment: `A.Scout` and `B.Scout` stay distinct, and the waiting agent can message the holder.
- The holder's name goes in the existing lock file: every new lease clears it, a named lease writes it, release clears it, and a waiter trusts it only while that pid is alive. A second file would be one more thing to keep in step with the lock.
- Windows keeps its named mutex, so there only a holder in the same omp is named.

Non-goals: Tern's native view (its spans carry theme tokens, not colours); `eval` `agent()` rows; text during the 5 s wait (there is none). Related: #11959 is about an identity the model can reference.

## Testing

- Live on Linux (Xvfb, this branch's addon): one process takes control as `Scout`; a second sends a key chord and fails after 5,061 ms with `agent "Scout" (omp pid 967685) owns input/focus control; no input was sent`, the holder's pid. Two sessions in one process: `agent "Scout" (omp pid 962789)`. With the holder gone the chord is sent.
- Each row test and the agent-id test fail with their source change reverted; the natives tests fail when the message stops naming the holder.
- No model sample run: the change is the text of an error on a rare contention path, and the agent's options after it are the same.
- Not run: the live check on macOS and Windows.

<details><summary>Commands</summary>

- `packages/tui`: `bun test test/agent-identity.test.ts test/task-progress-render.test.ts`
- `packages/coding-agent`: `bun test test/agent-hub-ordering.test.ts test/tools/computer.test.ts` (the agent-id test drives a computer call through the host snapshot and the worker and checks the native session gets `agentId: "CursorChecks.Scout"`)
- `cargo test -p pi-natives --lib desktop::control`: `input_refused_by_another_sessions_control_names_its_agent` (a held session's id reaches the in-process refusal and the lock file, and leaves with its control) and `independent_kernel_handles_contend_and_release` (no record, a record whose process exited, cleared on release, a dead host's record cleared by the next lease)

</details>
