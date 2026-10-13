## What

I kept seeing new Finder folders come out with the first letters of their name missing, because the agent's typing went out while Finder was still putting the name field up; input now waits for the app to finish reacting to the previous input, the same way reads already do.

| `computer.press("cmd+shift+n")` then `computer.type("probe-folder-N")` in Finder | #15280 | this PR |
|---|---|---|
| Folder named right | 10/30 (`robe-folder-1`, `r-2`, `-3`...) | 70/70 |
| Cell time, median [range] | 0.85 s [0.76-0.90] | 1.65 s [1.42-1.73] |

Reading order: `InputObserver.input` in `packages/coding-agent/src/tools/computer/worker.ts` (one `settle` before dispatch), then `InputObserver.settle` / `#restore`.

## Why

#15280 makes every read after input wait until the apps that input reached go quiet (250 ms without an accessibility notification, 5 s at most), so nothing reads a half-drawn window. Input did not wait: the second call in `press(...); type(...)` was sent while the first one's UI was still appearing, so keys landed on whatever had focus at that instant. On macOS a sheet, popover, rename field or new window takes a few hundred milliseconds to take focus, and that is where the lost and misrouted keys come from.

The wait is the one #15280 already runs, paid once before the next input instead of only before the next read. It covers every app earlier input reached, not just the one about to receive keys, because effects cross apps (a copy in one and a paste in another, a save sheet that belongs to the document's app). A wait cut short by cancelling its cell leaves that input owed, so the next call still waits for it instead of treating it as settled.

Cost: chained input pays one quiet window per step, here about 0.8 s for Finder to finish the new folder: Finder starts reacting 160-355 ms after the key, and the 250 ms window has to pass after its last notification. A cell with one input and a read pays nothing new, since the read already waited. Two ways to cut it lost more than they saved, so neither is here.

<details><summary>The two rejected cuts</summary>

Counting the quiet that had already passed since the input, instead of starting the window when the wait starts, saved 0.07 s per cell (1.58 s) and named the folder wrong 2 times in 40, both on the shortest waits: with credit from the input, the window can close before Finder's first notification. Keeping each app's observer registered between waits saved 0.03 s (1.63 s, 39/40).

</details>

## Testing

- Live, guest macOS 26.5.2 VM, scripted cells, no model: the table above, 10 runs per session on the same Finder window, sessions of the two arms interleaved (#15280: 4/10, 1/10 and 5/10; this PR: 10/10 in all seven).
- Dev set, 3 runs per arm on the same guest, GPT-6.1 Sol medium, #15280 + #15282 without and with this PR. None of these tasks sends input into a sheet or rename field that is still appearing, so they show the cost, not the fix:

| Finder sort, Automator, Calendar recurring event, Font Book collection | before | after |
|---|---|---|
| Passed | 12/12 | 12/12 |
| Steps (sum of per-task medians) | 130 | 134 |
| Tokens | 3.28M | 3.64M |
| Tool time | 93 s | 111 s |
| Wall time | 930 s | 988 s |

  Steps, tokens and wall time stay inside each task's run-to-run range. Tool time moved: 0.1-0.2 s more per input cell, out of range on three tasks (Finder sort 19.5 s [18-20] to 25.3 s [23-27]).
- `test/tools/computer.test.ts` (4 new or changed settle tests fail on #15280; the cancel test fails without `#restore`), `prelude-cell-settle`, `computer-history-rewrite`: 136 pass. `bun run check:ts` clean.

Non-goals: per-app scoping (tried first; it let a paste go out before its copy settled), and Linux/Windows, which keep #15280's fixed half-second wait and now pay it before input too.

---
- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
