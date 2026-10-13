## What

I want the model to know where its keys will land and what is selected before it types, without a second call to find out, so every tree it reads now ends by saying it.

| At the end of an `ax()` / `observe()` tree | #15282 | this PR |
|---|---|---|
| Where keys go | not shown; `(focused)` on a row if it is in this tree | `Focused: outline "list view" [ref=e93]` |
| Focus outside the window's tree (Finder's rename field) | nothing | `Focused: textfield [ref=e165] (not in this tree), selected text "alpha"`; the ref acts on it |
| Selected text (macOS) | `attributes()` probe | `, selected text "…"` on the Focused line, cut at 200 chars |
| Selected rows, cells, icons | `(selected)` on 20 rows and cells of a 163-line tree (4 files) | `Selected: e101, e110, e119, e128` (outermost selected lines) |
| Extra AX reads per tree | — | 1 for the selected text, 1 more only when focus is outside the rows |

Reading order: `snapshot` and `LineMarks` in `crates/pi-natives/src/desktop/ax.rs` (marks gathered while `format_tree` writes lines), then `selected_text` in `desktop/backend.rs` and `macos/ax.rs`.

## Why

Keys go to the app's focused element, and the user's typing goes to whatever has focus in their app, so the model has to know where its own keys land before it sends them. #15282 marks only the focused row `(focused)`, which the model has to find in a long tree, and says nothing when focus is in a field outside the tree's window (Finder's rename field, a sheet). Selection had the same problem: selecting 4 files in a Finder list marked 20 rows and cells across a 163-line tree.

The marks are gathered while the tree is written, so the cost is one attribute read for the selected text per tree, plus one element read when focus is outside the printed rows. The selected text rides on the `Focused:` line so a selection that clears changes that line instead of removing one, which keeps #15280's after-input diff honest. Linux and Windows get the `Focused:` line from their per-element focus flag and no selected text.

## Testing

- Rust: `cargo test -p pi-natives --lib desktop::ax` 24 pass on bench-mac; the trailer tests fail with the trailer emission reverted. `CI=1 bun scripts/run-rs-task.ts check:rs` clean.
- Live, guest macOS 26.5.2 VM, scripted cells: Finder list with 4 files selected (`Selected: e101, e110, e119, e128`), Finder's rename field (`Focused: textfield [ref=e165] (not in this tree)` while the list's window was read), a TextEdit selection (`Focused: textarea [ref=e167], selected text "first line\nsecond line"`). Tree reads take the same time: Finder 93-106 ms on #15282 vs 95-117 ms here, TextEdit 54-72 ms vs 55-90 ms (4 and 3 reads per arm).
- Dev set, 4 runs per arm on the same guest, GPT-6.1 Sol medium, #15280 + #15282 without and with this PR (289 of the after arm's tool results carried a `Focused:` line):

| Finder sort, Automator, Calendar recurring event, Font Book collection | before | after |
|---|---|---|
| Passed | 16/16 | 15/16 |
| Steps (sum of per-task medians) | 131.5 | 129 |
| Tokens | 3.32M | 3.12M |
| Tool time | 92.6 s | 93.9 s |
| Wall time | 927 s | 997 s |

  The failed run is an Automator run that saved its workflow inside the folder it was listing.

  <details><summary>Finder sort's wall time</summary>

  Each task's median stays inside the other arm's range except Finder sort's wall time (210 s [160-280] vs 315 s [224-494]), all of it model time per step. That gap does not hold up: 6 more Finder sort runs per arm, alternating which arm ran first, came out 204 s [123-412] before and 181 s [103-230] after, and over all 10 runs per arm it is 204 s [123-412] vs 218 s [103-494]. Steps (34.5 vs 35), tool time (19.7 s vs 21.1 s) and output tokens match; model time per step spans 4.1-10.8 s before and 3.6-10.6 s after, and the slow runs track the API, not the prompt: the slowest run before (10.8 s per step) had a smaller median prompt (17.3k tokens) than the fastest after (3.6 s, 17.8k). The trailers add about 7% to tool output (53k vs 49k characters per run, inside the before arm's range).

  </details>

  Neither arm probed for focus or selection on these tasks (no `focusedElement()` or `attributes()` call in 1,049 tool calls), so this set shows the cost is flat, not a step saving.

---
- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
