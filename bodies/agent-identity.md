## What

I kept losing track of which subagent was which, so every agent now gets a fixed colour on its name in the Task tool rows and the agent hub, and when one agent's computer call gives up behind another's input lock, `InputBusy` says whose lock it was.

Main is blue; every subagent hashes its id into one of six other colours, the same colour in every row, live or finished.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/89922411-8596-4e66-9bcb-7e6aa106827c">
  <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/dc5d463c-857d-446f-96ee-8d1f036ce01b">
  <img width="1010" alt="Task tool agent rows on main and on this branch" src="https://github.com/user-attachments/assets/dc5d463c-857d-446f-96ee-8d1f036ce01b" />
</picture>

| Surface | main | this PR |
|---|---|---|
| Task tool agent rows | name in accent while live, text when done | name in the agent's colour; description unchanged; frozen snapshots stay dim |
| Agent hub roster | bold id; selected one in accent | unselected ids in the agent's colour; selection unchanged |
| `InputBusy` after waiting | unnamed input/focus owner | full agent id and omp pid when known; original message otherwise |

**For the maintainer:** rows are coloured by default, with no setting. Keep it on, or gate it? Gating is a check around the `agentColored` calls.

This PR is the base of two follow-ups that are not open yet: a browser cursor in OMP-driven tabs, and a desktop cursor where computer input lands on macOS. Both cursor settings default to off; neither cursor is included here.

## Why

A stable colour lets you follow one agent across the Task card and hub. A fixed palette, rather than the theme-dependent `session-color` hue, lets future cursors use that same colour outside the terminal. The cost is ignoring the theme: yellow and teal fall just under 3:1 on Solarized Light.

`InputBusy` names the full id so `A.Scout` and `B.Scout` stay distinct. The existing lock file carries the holder, is cleared with each lease, and is trusted only while its pid lives. Windows retains its named mutex and names only same-process holders.

Non-goals: Tern's native view, whose spans carry theme tokens rather than colours; `eval` `agent()` rows; text during the lock wait. Related: #11959 concerns identity the model can reference.

Review colour selection in `tui/src/overlays/agent-identity.ts`, then row rendering, then `buildComputerSnapshot` through the native control lease.

## Testing

- Linux/Xvfb live check using this branch's addon: a second process times out naming the `Scout` holder and its pid; same-process contention also names it. With the holder gone, the chord is sent.
- Row and agent-id tests fail with their source changes reverted; native tests fail without holder naming.
- No model sample run: this changes error text on contention, not the agent's options. Live macOS and Windows checks were not run.

<details><summary>Commands and covered paths</summary>

- `packages/tui`: `bun test test/agent-identity.test.ts test/task-progress-render.test.ts`
- `packages/coding-agent`: `bun test test/agent-hub-ordering.test.ts test/tools/computer.test.ts`; the agent-id case drives a host snapshot through the worker to the native session.
- `cargo test -p pi-natives --lib desktop::control`: `input_refused_by_another_sessions_control_names_its_agent` covers in-process refusal and lock-file naming; `independent_kernel_handles_contend_and_release` covers absent, stale and cleared records.

</details>
