## What

I watched headless computer runs quit two steps in because `control.acquire` said nobody could approve foreground control, even though the clicks they needed run in the background anyway, so the `computer` tool prompt now says window input needs no grant and that a `no-ui` answer means keep going.

On 13 native and cross-app tasks run headless with GPT-6.1 Sol, 14/35 runs passed on `main` → 26/26 with this wording.

The changed clauses of the `control.acquire` bullet in the tool prompt:

```diff
-requires live human confirmation for task-scoped control and returns `{active: true}` or `{active: false, reason}`:
+requires live human confirmation for task-scoped control; window input needs no grant (it runs in the background with or without acquired control). It returns `{active: true}` or `{active: false, reason}`:
-`"no-ui"` (this session has nobody to ask, e.g. a subagent or headless run; asking again cannot succeed, so tell the user or your parent the step needs foreground control)
+`"no-ui"` (this session has nobody to ask, e.g. a subagent or headless run, and asking again cannot succeed: keep working through background window input, and tell the user or your parent only about a step that needs foreground control)
```

Only the prompt changes; the verdicts and the runtime stay as they are.

## Why

#16295 added `no-ui` so a headless run could tell "nobody to ask" apart from a refusal. Its instruction, "tell the user or your parent the step needs foreground control", reads as "stop here": on `main`, 21 of 85 headless runs called `acquire` early, got `no-ui`, and 19 of them ended within 2 to 6 steps with answers like "the approval interface is unavailable". The 2 that kept going passed, because background window input covers these tasks.

Rejected: answering `denied` or dropping `no-ui`. The verdict is right; only the instruction around it sent the model home. Letting an unattended machine grant foreground control without a UI is a setting question, not part of this fix.

## Testing

Each run is one task prompt to `omp -p` in a fresh macOS VM (GPT-6.1 Sol, medium effort), graded by a checker on the VM's end state.

| 13 tasks where a `main` run hit `no-ui` | `main` | this PR |
|---|---|---|
| runs passed | 14/35 | 26/26 |
| runs whose `acquire` answered `no-ui` | 21 | 0 |
| of those, ended unfinished | 19 | – |

With this wording no run called `acquire` at all: the "window input needs no grant" clause is what changed behaviour, so these runs did not exercise the "keep working" clause after a `no-ui`. Across all 32 tasks (85 runs on `main`, 64 here), the three tasks that fail on both arms fail the same way (a tab closed at exit, an extension frame), unrelated to this prompt.

Not run: other models; the measurement is GPT-6.1 Sol only.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
