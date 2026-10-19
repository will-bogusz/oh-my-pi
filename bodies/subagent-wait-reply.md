## What

Subagents kept asking their parent something and then faking a `wait` with `sleep` jobs, because `wait` refuses to block on a reply, so I let `wait` hold out for the answer while it still refuses the cycle where the parent is waiting on that same subagent.

In 56 headless runs per build where a subagent asks its parent for a value and gets it, the subagent's `wait` refusals went from 48 to 0 and its `sleep` calls from 53 to 0; in 8 where the parent never answers, the run ends in 19 s instead of 168 s (median wall time).

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/7b515d75-32e3-4d6b-b698-dabfb0271730">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/b1473fc3-31ec-4792-bbfb-efe97dba10b0">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/1e99232e-5a1e-497e-b3a3-93e35d02cef5">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/b73d45cb-8df2-4803-8b9c-57dfe04e6a43">
  <img width="780" alt="Timeline, four lanes. Parent answers after 45 s: on main, wait errors 'Nothing to wait for', the subagent sleeps 20 s, reads history://, then holds a sleep 45 job so wait can block, and the answer lands in that wait (run took 68 s, median); with this PR, wait blocks and returns the answer (run took 63 s). Parent never answers: on main, wait errors and the subagent loops on sleeps of 30, 60, 280 and 290 s and asks again until it gives up (run took 168 s median, up to 698 s); with this PR, wait blocks until the parent (Main) starts waiting on the subagent, then returns 'Main cannot reply before you finish' (run took 19 s). Times are whole-run wall-time medians over 8 runs per lane." src="https://github.com/user-attachments/assets/b1473fc3-31ec-4792-bbfb-efe97dba10b0" />
</picture>

With no owned job or service, `wait` now blocks when the caller messaged a still-running agent directly this run and hasn't heard back, and returns the reply (or any message). No reply can come once the agent asked finished its turn without replying or is blocked on the caller (a `wait` only the caller's result can end, entered after the question; an inline `blocking: true` spawn of it; an untimed eval `.wait()` on it): a wait already blocking then ends without an error, and a new one errors naming the agent. Broadcasts and past runs owe nothing.

## Why

7b8e04fa5c made `wait` refuse without a running job or service, so a subagent couldn't park while its parent waited on it. That left no way to wait for an answer: our recorded sessions show 100 `wait` refusals (88 subagents, mostly right after `write agent://<parent>`), and 44 were followed within two calls by a `sleep N` job (to 3500 s) or polling loop held open so `wait` could block: the deadlock again, bounded only by the sleep.

- **Detect the cycle instead of banning the wait.** Blocking waits record holds in the registry (`AgentAwaits`); a reply wait reads the holds of the agents it asked. A liveness check (what 7b8e04fa5c removed) can't see a parent waiting on the child.
- **End on the asked agent's turn end**, not only the 30-minute cap; a woken subagent's relayed reply lands first.
- Rejected: counting "awaiting a reply" as pending work in the yield ladder; without `yield` the run still ends on its first tool-less turn.

Non-goal: a workpool job names no single agent, so a parent waiting on a pool takes no hold; a member's reply wait ends on the parent's turn end or the cap. A missing hold degrades the same way, never to a hang.

Related: #14212.

Reading order: `tools/wait.ts` (`pendingReplies`, `#blockUntilWake`) → `registry/agent-awaits.ts` → holds in `task/structured-subagent.ts`, `eval/handle-bridge.ts` → `irc/bus.ts`.

## Testing

Headless `omp -p`, Haiku 5.5; the subagent must ask its parent for a codeword. main = 53a0377db6.

<details><summary>Per-scenario results (8 runs each; B 40)</summary>

| scenario | arm | n | subagent got the answer | out.txt written | parent ended turn without waiting | subagent `wait` refusals | subagent `sleep` calls | subagent agent:// / history:// reads | wall s median [min-max] |
|---|---|---|---|---|---|---|---|---|---|
| Q | main | 8 | 8/8 | 8/8 | 0 | 6 | 6 | 0 | 37 [13-64] |
| Q | this PR | 8 | 8/8 | 8/8 | 0 | 0 | 0 | 0 | 17 [11-24] |
| B | main | 40 | 40/40 | 37/40 | 3 | 34 | 32 | 1 | 33 [9-57] |
| B | this PR | 40 | 40/40 | 36/40 | 4 | 0 | 0 | 0 | 18 [9-65] |
| S | main | 8 | 8/8 | 8/8 | 0 | 8 | 15 | 1 | 68 [62-92] |
| S | this PR | 8 | 8/8 | 8/8 | 0 | 0 | 0 | 0 | 63 [58-67] |
| D | main | 8 | 0/8 | 0/8 | 0 | 8 | 24 | 15 | 168 [105-698] |
| D | this PR | 8 | 0/8 | 0/8 | 0 | 0 | 0 | 0 | 19 [15-27] |
| Y | main | 8 | 8/8 | 8/8 | 0 | 3 | 4 | 0 | 20 [14-97] |
| Y | this PR | 8 | 8/8 | 8/8 | 0 | 6 | 0 | 0 | 22 [15-26] |

Q: parent idle in `wait`. B: parent in a foreground `sleep 60` when asked. S: parent needs 45 s to get the answer. D: parent never answers and waits on the child. Y: child's agent type is `blocking: true`, so the parent's `task` call can't see the question. "Parent ended turn without waiting" happens on both arms: print mode exits with the subagent still running. Counts come from the subagent's recorded tool calls.

Replay of the 100 recorded refusals through the new rule (direct send this run, no reply yet, recipient not in a later `wait` on the caller): 64 would have blocked instead (45 of 70 excluding our largest research session), 33 of them getting a message within 30 minutes. The replay can't see whether the recipient's turn had ended, so 64 is an upper bound.

</details>

Tests (`wait.test.ts` *a reply wait*, `structured-subagent.test.ts`) cover each ending: the answer, the parent waiting on the child, the parent waiting on the child or a bash job (no cycle), the asked agent's turn ending, inline spawns, untimed and timed eval handle waits, broadcasts, past runs. Removing any rule fails its test.

`cd packages/coding-agent && bun test test/tools/wait.test.ts test/task/structured-subagent.test.ts`

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
