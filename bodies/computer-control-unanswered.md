## What

I made an unanswered computer-control prompt close a few seconds before the call's deadline and tell the script nobody answered, instead of the whole call dying on a generic timeout.

An unanswered `computer.control.acquire` prompt in a 120 s call: before, the call failed at 120 s with `Computer code execution timed out after 120000ms`; now `acquire` returns `{ active: false, reason: "unanswered" }` at 115 s and the script finishes inside the call.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/dda38b89-f777-4311-b969-455593f0c8ad">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/312a5a13-f527-41f1-b44c-fe4d08d9e1b0">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/a93907cc-a10b-4264-86c4-6762a04660ce">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/5cf48a13-9fe4-49a7-a446-2df895c37f10">
  <img width="780" alt="Timeline of a computer call whose control prompt nobody answers. main: the prompt stays open until the 120 s deadline and the call fails with &quot;Computer code execution timed out after 120000ms&quot;. This PR: the prompt closes at 115 s, control.acquire returns { active: false, reason: &quot;unanswered&quot; }, and the script finishes within the call." src="https://github.com/user-attachments/assets/312a5a13-f527-41f1-b44c-fe4d08d9e1b0" />
</picture>

- The confirmation expires when the call has 5 s left (a quarter of a call under 20 s), so the script still runs on the answer; the terminal and RPC hosts close it, an ACP client may leave its form up, and a late answer grants nothing.
- The tool prompt and docs list the new reason beside #16295's `"denied"` and `"no-ui"`, which are unchanged, as is `ask.timeout`.

## Why

#16295 told a refusal apart from a session with nobody to ask. A person who is away still fell through to the run's deadline: a main session's `acquire` failed after 120,017 ms with the generic timeout.

Decisions:
- **The deadline is the call's own less a reserve, not a fixed prompt timeout.** People take a while to answer: across 168 answered `ask` prompts in our sessions (39 root sessions) the median wait was 130 s and only 38% came within 60 s. A fixed 30 or 60 s deadline would cut those off; the call's timeout already bounds the wait, and `computer.run(…, { timeout: 300 })` buys more.
- **The supervisor aborts the dialog rather than passing its `timeout` option.** On timeout the TUI selector picks its highlighted option, which for a confirm is Yes; and a dialog with a `timeout` stops counting as a wait for the user, so the display would stay awake through the prompt (#15762's turn hold).

## Testing

- `bun test test/tools/computer.test.ts` (in `packages/coding-agent`): 120 pass. New cases, through the real supervisor and worker on the fake native session:
  - a 2 s call's unanswered prompt expires between 1 and 2 s in and returns `"unanswered"`, for a UI that settles on abort and one that never settles; a later yes grants nothing;
  - with less than the reserve left, no prompt is shown;
  - a 120 s call's prompt gets 114–115 s.
- Negative control: with the `src/tools/computer` changes reverted, all 4 new tests fail.
- Live, `omp --mode rpc-ui` on Haiku 5.5, a host that never answers the confirm, one eval calling `computer.control.acquire` (2 runs each):

| | Prompt open | Tool result | Then |
|---|---|---|---|
| `main` | 120.0 s, 120.1 s | error: `Computer code execution timed out after 120000ms` | run 1: the agent asked again 1.6 s later; run 2: it reported the error |
| this PR | 115.1 s, 115.1 s, then the host got `cancel` | `{'active': False, 'reason': 'unanswered'}` | the agent reported it and stopped |

- `bun run check` in `packages/coding-agent`: clean.
