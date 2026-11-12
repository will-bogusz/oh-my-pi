## What

I kept losing track of which subagent was which, so every agent's name now takes a colour of its own in the Task tool rows and the agent hub, picked from the active theme, and when one agent's computer call gives up behind another's input lock, `InputBusy` says whose lock it was.

Main takes the theme's `accent`. Subagents take one of six colours in order of arrival; the seventh reuses the first, and an agent keeps its colour for the session, also after earlier agents end. A theme can set the six with new optional tokens `subagent1`–`subagent6`; otherwise each slot comes from the theme's own `terminal.ansi` hues (red left to errors), then hues derived from the accent by the session-colour code, then the old fixed palette as a last resort.

A candidate must be at least 3:1 against the terminal background and the three Task card tints, and 0.10 apart in OKLab from the accent, the error colour and colours already taken. A declared token is used as written.

<img width="1092" alt="Agent hub roster and a finished Task card with six subagents under dark-tokyo-night, dark-nord and light-solarized" src="https://github.com/user-attachments/assets/f93c3dcc-6aa3-4e71-bd6b-ba704d45937d" />

| Surface | main | this PR |
|---|---|---|
| Task tool agent rows | name in accent while live, text when done | name in the agent's colour; description unchanged; frozen snapshots stay dim |
| Agent hub roster | bold id; selected one in accent | unselected ids in the agent's colour; selection unchanged |
| `InputBusy` after waiting | unnamed input/focus owner | agent id and omp pid when known; cross-process ids keep their last 64 characters; original message otherwise |

**For the maintainer:** rows are coloured by default, with no setting. Keep it on, or gate it? Gating is a check around the `agentColored` calls.

This PR is the base of two follow-ups not open yet, a browser cursor and a macOS desktop cursor; they take the row's hex (`agentColorHex`) and default to off.

## Why

A stable colour lets you follow one agent across the Task card and the hub. An earlier revision used seven fixed colours, which ignored the theme: on 55 of 102 built-in themes one fell under 3:1 on a background it is drawn on. Allocating by arrival rather than by hashing the id also keeps the first six subagents apart.

`InputBusy` names the full id in-process and its last 64 characters cross-process, keeping the most specific dotted segment. The lock file carries the holder, is cleared with each lease, and is trusted only while its pid lives. Windows names only same-process holders.

Non-goals: Tern's native view; `eval` `agent()` rows; text during the lock wait. Review `resolveAgentPalette` and the arrival slots in `tui/src/overlays/agent-identity.ts` first.

## Testing

| over 102 built-in themes | fixed palette | this PR |
|---|---|---|
| themes with a subagent colour under 3:1 on a surface it is drawn on | 55 | 0 |
| themes with six subagent colours, each 0.10 apart from the others, accent and error | | 102 |
| colours from the theme's own palette / derived / fixed fallback, mean of 6 | 0 / 0 / 6 | 3.96 / 2.00 / 0.04 |

- Linux/Xvfb live check using this branch's addon: a second process times out naming the `Scout` holder and its pid; same-process contention also names it.
- The real hub and Task renderer drawn offscreen under three themes (above): every name is readable. Two pairs are close though 0.10 apart: yellow and tan on `dark-nord`, orange and pale yellow on `dark-tokyo-night`.
- Colour-blind mode shifts only `toolDiffAdded`; it moves a derived colour on 8 themes and every bound above still holds.
- Not done: distinguishability for colour-blind viewers; Tern rows; live macOS and Windows checks; a model sample run (this changes error text on contention, not the agent's options).

<details><summary>Commands and covered paths</summary>

- `bun run check:ts` (coding-agent's `bench-auth-fallback.test.ts` fails on `main` as well)
- `packages/tui`: `bun test test/agent-identity.test.ts test/task-progress-render.test.ts test/session-color.test.ts`: six readable, distinct colours on every built-in theme, a declared token wins, slots follow creation time and wrap after six.
- `packages/coding-agent`: `bun test test/agent-hub-ordering.test.ts test/tools/computer.test.ts`: hub rows keep their colour across re-renders and after an earlier agent is unregistered.
- `cargo test -p pi-natives --lib desktop::control`: `input_refused_by_another_sessions_control_names_its_agent` covers in-process refusal and lock-file naming; `independent_kernel_handles_contend_and_release` covers absent, stale and cleared records, plus long dotted ids retaining their suffix.
- The table comes from a script that calls `agentPalette` for each built-in theme and checks contrast against the terminal background and the three card tints.
- Related: #11959 concerns identity the model can reference.

</details>

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
