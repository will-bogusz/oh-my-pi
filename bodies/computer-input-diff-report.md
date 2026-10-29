## What

After every click the model was spending its next call reading the window back, so I made the cell that sent the input wait for the app to go quiet and end with only what changed in each window it touched.

On real tasks (GPT-6.1 Sol, 3 runs per build), the long Automator task took 23–24 steps and 0.50–0.52M tokens per run with this PR, against 36–45 steps and 1.15–1.59M on `main` and 30–36 steps and 0.85–1.07M with the quiet wait alone; three short tasks moved less, and both ways.

> **Computer context.** `win.ax()` prints a text tree whose rows carry `[ref=eN]` handles; input calls like `el.press()` return nothing.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/9ea9e875-5eac-4f58-9ade-938d89ca0cc7">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/552b20d7-2388-4815-a5bd-0b824a25b835">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/3403ad13-db0a-4d04-94aa-9f6744aec344">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/97b09467-29e3-4e18-adaa-7198b3844ddd">
  <img width="780" alt="Real cell outputs, main against this PR, on a macOS 26 VM. main returns (no output) after every input cell (&quot;opened&quot; for apps.open). This PR: typing into TextEdit returns the changed row ~ textarea [ref=e3]: &quot; hellofirst line &quot;; Shift returns &quot;no change since your last tree&quot;; a Chrome click returns + statictext [ref=e54]: &quot;loading&quot; and a note that the read may predate a load; opening a Save sheet prints the document whole and the sheet as &quot;shown above in window 157 as e66&quot;; cancelling it names the gone sheet and the window now focused in its place with its changes; a Finder double-click returns Finder's change and the new TextEdit window whole; apps.open returns Font Book's own window whole." src="https://github.com/user-attachments/assets/552b20d7-2388-4815-a5bd-0b824a25b835" />
</picture>

<details><summary>The same, as a table</summary>

| Cell (macOS 26 VM) | main | this PR |
|---|---|---|
| `te.type(" hello")` in TextEdit | `(no output)` | `window "143" TextEdit "note.txt": 1 change since your last tree` / `~ textarea [ref=e3]: " hellofirst line " (focused)` |
| `te.press("shift")` after a fresh `te.ax()` | `(no output)` | `window "143" TextEdit "note.txt": no change since your last tree` |
| click "Fetch data" in Chrome | `(no output)` | `+ statictext [ref=e54]: "loading" (in e44)` under `~ webarea`, then a line that the read may predate a load |
| File ▸ Export as PDF… in TextEdit | `(no output)` | the document's tree whole (the sheet doubled it), then `new window "160" TextEdit "Save" 422×182 (focused): shown above in window "157" as e66` |
| Cancel that sheet | `(no output)` | `window "160" is gone from the window list …` / `window "157" TextEdit "omp-report-probe.txt" (now focused in place of window "160"): 15 changes since your last tree` |
| double-click `gamma.txt` in Finder | `(no output)` | Finder's changed row, then `new window "175" TextEdit "gamma.txt" 673×439 (focused):` and its whole tree |
| `apps.open("com.apple.FontBook")` while TextEdit has focus | `opened` | `opened`, then `window "165" Font Book "All Fonts":` and its whole tree (328 rows), not TextEdit's |

</details>

**Cost:** the cell returns once its apps go quiet and each touched window is read back: typing 74 → 416 ms, other input cells +320 to +833 ms (wait plus read-back, against c6ec2ff47a, before `main` waited for apps to go quiet). The report counts toward the cell's 50 KB output cap.

## Why

On `main` an input cell returns nothing, so the model reads the window back in another call.

- **Delta, a stated deviation from `compaction.supersedeReads`** (the newer copy replaces the older): reprinting the window after each input (#14343) cost 113k chars of post-input output per task, the diff 25.8k, Codex 27.9k (390 reads replayed from 2026-10-10 transcripts).
- **Recovery follows precedent:** as cut tool output names `artifact://N`, a window left out names `win.ax()`, which returns the whole tree; a rewrite that drops a tool result (compaction, pruning, a rewind) bumps `Agent.historyRevision`, and the next report prints every window whole.
- **Whole where a diff has no base or reads worse:** a window the model has no tree of, such as one the input opened, and a diff of half the tree or more. A sheet its parent's printed tree holds prints once, as a pointer.
- **Web pages: a line, not a longer wait.** Chrome posts no notification while a page waits on the network or a timer.

No report after the user's Escape or a cancel. Maintenance: the diff reads native tree rows only through `parseTreeRow`.

<details><summary>Reading order, limits, dated measurements</summary>

- `eval/preludes.ts` `settleCell`; `tools/computer.ts` `settleCell`; `supervisor.ts` `settle`; `worker.ts` `ComputerWorkerCore.#settle`, `#report`; `observation.ts` `ObservationLedger`, `diffTree`, `renderReadBack`, `subtreeRef`; `Agent.historyRevision`.
- Targets: a touched window that left the window list (sheet, popover, chooser) is followed by its app's window that took the focus. `apps.open` is reported on the window it returned. A new window of another app prints only after input that reached a window.
- Bounds: the cell's output and its report stay within the 50 KB inline cap (a window past it gets one line naming it and saying `win.ax()` prints it, and keeps the model's last tree as its baseline); reads stop 2 s before the settle's 16 s budget; input is kept per Eval cell.
- Seen live: TextEdit's title-bar "Edited" rows appear seconds after the first edit and land in the next report (the Shift cell before a fresh read reported 5 changes). A changed row shows what the element displays, not that the app stored it: in 16 of 58 writes measured on 2026-10-10 (Contacts fields, Finder renames, Reminders and Calendar titles) the field showed a value the app never took.
- Delta replay (2026-10-10 transcripts, 390 reads): no ref the next cell used was only in the reprint. No "`win.ax()` prints all of it" line on every report: in 94 reports (2026-10-10) the model fetched a whole tree 13 times, always by plain `ax()`/`observe()` (9) or a screenshot (4).
- Web (2026-10-11): watching Chrome for 59 notifications, none fired while a page waited on a 700 ms fetch, an 800 ms navigation or form post, or 400 ms timers.
- New windows whole (2026-10-11 dev set, on that day's series 1 plus open fixes, not today's `main`): of 32 whole-window reads after 200 reports, 9 went to a window the report only named or never listed (a rename field, a date picker, a sheet, a document another app opened), 2 to a diff nearly as long as the tree.

</details>

## Testing

- Live, macOS 26 VM, model-free `EvalTool` cells: `main` c6ec2ff47a once, this PR's code (064c956c29) twice, the same after window ids but for Finder's status row.
- Dev set, guest macOS VM, GPT-6.1 Sol (medium), 4 tasks × 3 runs per build (chart below; builds in its `<details>`): all 36 passed; 19 runs Codex refused before their first step are left out. Automator's context peak: 44–52k on `main`, 31–32k here.
- The report, the new-window, half-tree and sheet-pointer rules, the history-rewrite flags, the Escape mapping and each review fix fail their tests when reverted.
- bench-mac, 064c956c29: native build; agent 58 and computer, cell-settle and history-rewrite 195 tests pass. No Rust changes.
- Merged on `main` with the other series 2 branches (quiet wait, `ax()` lines, rich-text): `bun check` exit 0, Rust 936 pass / 0 fail, native build, computer tool tests 192 + 7 and agent and cell tests 68 pass.
- Not run: Linux and Windows (fixed wait; unit tests only).

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/38ad3049-832e-47f8-8817-224e1f3f64a5">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/b2f6fb26-b98b-4394-8f25-efff3735ba84">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/f7ebb6e0-824b-48a4-bfc0-d54fc00bc11c">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/90ae6a8d-5549-43ed-a264-b64ee52984c2">
  <img width="780" alt="Every dev-set run as a dot, GPT-6.1 Sol, 3 runs per task per build. Finder: sort files into three new folders: main 14–21 steps, 0.24–0.32M tokens; quiet wait 11–14 steps, 0.19–0.26M tokens; this PR 20–25 steps, 0.35–0.39M tokens. Automator: build and run a workflow (long): main 36–45 steps, 1.15–1.59M tokens; quiet wait 30–36 steps, 0.85–1.07M tokens; this PR 23–24 steps, 0.50–0.52M tokens. Font Book: make a font collection: main 14–15 steps, 0.27M tokens; quiet wait 11–15 steps, 0.21–0.29M tokens; this PR 10–14 steps, 0.19–0.35M tokens. Calendar: add a recurring event: main 16–24 steps, 0.42–0.58M tokens; quiet wait 17–27 steps, 0.39–0.72M tokens; this PR 17–20 steps, 0.33–0.36M tokens. The long Automator task changes most; the short tasks moved less, and both ways." src="https://github.com/user-attachments/assets/b2f6fb26-b98b-4394-8f25-efff3735ba84" />
</picture>

<details><summary>Dev set: every run (n = 3 runs per task per build)</summary>

| task | `main` c6ec2ff47a | quiet wait alone ee94355b9c | this PR 064c956c29 |
|---|---|---|---|
| Finder: sort files into three new folders | 3/3 pass; steps 21, 16, 14; tokens 0.32, 0.29, 0.24M; context peak 26, 23, 24k | 3/3 pass; steps 11, 14, 14; tokens 0.19, 0.23, 0.26M; context peak 22, 23, 26k | 3/3 pass; steps 24, 20, 25; tokens 0.36, 0.35, 0.39M; context peak 21, 20, 23k |
| Automator: build and run a workflow (long) | 3/3 pass; steps 36, 45, 38; tokens 1.17, 1.59, 1.15M; context peak 47, 52, 44k | 3/3 pass; steps 30, 36, 34; tokens 0.85, 1.07, 1.03M; context peak 41, 48, 47k | 3/3 pass; steps 24, 23, 23; tokens 0.52, 0.50, 0.51M; context peak 31, 31, 32k |
| Font Book: make a font collection | 3/3 pass; steps 14, 15, 15; tokens 0.27, 0.27, 0.27M; context peak 25, 21, 21k | 3/3 pass; steps 11, 15, 14; tokens 0.21, 0.29, 0.24M; context peak 22, 23, 20k | 3/3 pass; steps 10, 14, 12; tokens 0.19, 0.35, 0.27M; context peak 21, 29, 25k |
| Calendar: add a recurring event | 3/3 pass; steps 24, 18, 16; tokens 0.58, 0.43, 0.42M; context peak 30, 31, 37k | 3/3 pass; steps 22, 17, 27; tokens 0.43, 0.39, 0.72M; context peak 30, 28, 35k | 3/3 pass; steps 17, 20, 18; tokens 0.33, 0.36, 0.34M; context peak 24, 22, 22k |

Against `main`, geometric mean over the 4 tasks of each task's median of 3 runs (n = 3 runs per task per build): this PR 064c956c29: steps 0.92×, tokens 0.81×, context peak 0.84×; quiet wait alone ee94355b9c: steps 0.97×, tokens 0.89×, context peak 0.99×. Run-to-run spread is wide (`main`'s Finder runs took 21, 16 and 14 steps), so these means say little beyond the Automator task.

</details>

Agent behaviour, Haiku 5.5 and GPT-6.1 Sol at low effort, replaying this dev set's own transcripts under each build (table; no desktop): after an input, Sol no longer reads the window again. Haiku stops spending a turn on it but still reads inside its next input cell, so for Haiku the report adds to that read rather than replacing it.

| decision points × runs per build | Haiku `main` | Haiku this PR | Sol `main` | Sol this PR |
|---|---|---|---|---|
| after an input, the next call only reads (`ax()`, screenshot); 12 × 3 | 20/36 | 4/36 | 28/36 | 0/36 |
| the next input cell reads the window again | 15/15 | 29/30 | 8/8 | 0/36 |
| the task's first input cell reads the window again (only the prompt text differs); 24 × 2 | 25/34 | 27/36 | 29/39 | 18/42 |
| acts on a ref the real state lacks | 0/15 | 0/30 | 0/8 | 0/36 |

<details><summary>How the replay runs were made, and what the reports cost</summary>

Arms: `main` c6ec2ff47a (its computer prompt is today's `main` but for 2 lines) and this PR 99d2de7104, each through its own CLI, system prompt and rendered `xd://eval/computer` docs (this PR's are byte-identical to what the dev-set runs read). After-input points: the dev set's PR-build runs up to their first input cell that read nothing itself and got a report; `main`'s arm sees each result with its report removed, which is what `main` prints. First-input points: all 24 runs up to their first input cell; before it nothing was sent, so both builds see the same conversation. An omp extension blocks every desktop call and takes the first as the decision; Sol's acting moves under this PR matched the recorded run's next move in 30 of 36.

Cost at the after-input points: requests ran +4.4k tokens (Sol) and +6.5k (Haiku) with this PR, about 1–15k chars of report, plus `apps.open` printing its window whole when the same cell also printed `ax()` (10–23k chars in the Automator and Font Book runs). A read turn on `main` re-sends the whole 15–25k-token request and adds the tree (20–46k chars in Automator and Font Book).

In the dev-set transcripts themselves (Sol medium): input cells that also read the window 64% → 9%, read-only calls right after an input 0.23 → 0.05 per input cell, window output per input cell (median of runs) 3,729 → 3,230 chars.
</details>

<details><summary>Cell times (ms)</summary>

`main` c6ec2ff47a, one session; this PR 064c956c29 (code identical to the head), two sessions, median. The cell after the export (`sheet-id`, polling for the sheet) took 775 ms on `main`, where the sheet was not yet listed, against 61 and 65.

| cell | main | this PR | added |
|---|---|---|---|
| type " hello" | 74 | 411, 422 | +343 |
| Shift (Edited rows pending) | 192 | 503, 521 | +320 |
| Shift after a fresh read | 180 | 484, 525 | +325 |
| click "Fetch data" | 260 | 591, 615 | +343 |
| Export as PDF… | 59 | 871, 912 | +833 |
| Cancel the sheet | 182 | 725, 745 | +553 |
| `apps.open` Font Book | 1,612 | 2,123, 2,668 | +784 |
| double-click `gamma.txt` | 1,024 | 1,440, 1,423 | +408 |

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

