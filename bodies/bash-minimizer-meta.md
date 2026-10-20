## What

When the minimizer rewrites a bash result, I want the session to say which filter did it and how much it cut, instead of leaving that to guesses from the command text.

On 26 minimized results recorded with this branch, naming the filter by the command's leading program was right 19 of 26 times; the recorded filter is the one that ran.

<img width="860" alt="Bash card footer on main (Wall, Timeout, Artifact) and with this PR (adds Minimized: git 27.6KB → 9.5KB)" src="https://github.com/user-attachments/assets/6ccc4dd8-49f3-4b8a-90f2-e57053be5c0e" />

`executeBash` already gets `{ filter, inputBytes, outputBytes }` from the native minimizer and hands it to `onMinimizedSave`, whose three callers drop it. This PR keeps it, with the raw-output `artifactId`, as `details.meta.minimized`, and the bash card shows it in its footer. User `!` commands keep it on their `bashExecution` message. The model's text is unchanged: the `[raw output: artifact://N]` footer stays and `formatOutputNotice` adds nothing.

## Why

Today only the footer text shows that a result was minimized, and which filter ran has to be guessed from the command. That guess misses every `&&`/`;` chain (minimized per segment and labelled `chain`), `jq` (`pipeline+builtin`), and command lines whose first word is a flag or a path with a space. Replaying the saved raw output through `minimizer::apply` doesn't recover it: on 10,755 older minimized results it reproduced the rewrite for 2,510 (23%).

Decisions:
- **Meta, not model text.** The model already has the footer; the field serves the card and anything reading sessions.
- **`chain` stays one label.** Naming each segment's filter needs a native change; this records what the native side reports.
- **RPC.** `BashResult` is the RPC `bash` result, so its wire schema gains optional `minimized` (regenerated, same shape as `artifactError`).
- **Sharing.** `/share` redacts the filter label like other meta strings (a `user_bash` extension can return any label) and keeps the counts; the anonymizer leaves the new key opaque.

Related: #5795 writes opt-in gain records to a separate JSONL file for a dashboard; with this field, a dashboard could read the same numbers from sessions.

**Cost:** 83 bytes per minimized result (median, max 96), none on other results. `executeBash` on a minimized `git log -40`: 12.4 ms median with this PR against 11.6 ms on `main`, whose own runs spread 7.2–18.7 ms, so no measurable difference.

## Testing

- `bun test packages/coding-agent/test/bash-failure-result.test.ts`: a minimized result with a saved raw capture carries the filter, both byte counts and the artifact id, keeps its footer with no new notice, and both card renderings show `Minimized lint 1.9KB → 27B`; the unsaved case has no `minimized`. With the source change reverted it fails (1 fail, 14 pass).
- Live: 59 real bash calls through `AgentSession` on this branch and on `main` (git, ls, grep, rg, find, cat, wc, jq, bun, cargo, gh; 25 chains or pipes). All 26 results with the footer had `meta.minimized` naming the same artifact, no other result had it, and their model text matched `main` apart from the wall-time line.

<details><summary>Leading-program guess vs recorded filter, 26 recorded results</summary>

| Command shape | Guess | Recorded |
|---|---|---|
| `cd repo && git log -30`, `cd repo; git show HEAD` | `git` | `chain` (×2) |
| `cd repo && git status && git log -5` | `git` | `chain` |
| `git fetch --dry-run; git log -20` | `git` | `chain` |
| `git show bad-ref; git log -30` | `git` | `chain` |
| `bunx tsc --version && git log -15` | `bunx` | `chain` |
| `jq . package.json` | `jq` | `pipeline+builtin` |
| the other 19 (git ×10, ls ×2, grep ×2, find ×2, rg, cat, wc) | same | same |

Sizes: the raw artifact's length matched `inputBytes` on all 26; the result text's length was within 5% of `outputBytes` on 23 of 26 (it also carries the footer and notices). Among the 33 non-minimized calls, the two builds differed only in timings, live counters, tie order in a `sort`, and one call that auto-backgrounded on the slower branch run.

</details>

---

- [x] `bun check` passes (`bun run check:ts` at the root)
- [x] Tested locally (focused tests: `bash-failure-result`, `bash-executor`, `agent-session-bash-session-ownership`, `tools/output-caps` in coding-agent; `bash-render`, `tools-native-shell` in tui)
- [x] CHANGELOG updated with the required attribution
