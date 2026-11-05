## What

Parallel async bash starts came back as bare `bg_5`/`bg_6` in whatever order they finished, so my agent paired them by position and blamed omp for swapping their outputs; now each notice says which command it is.

A backgrounded bash job's start result names its command (and its directory when that is not the session's), and its completion notice names the same command, alone or in a batch:

```diff
- Backgrounded as job bg_1 (killed once it has run 300s in total; …); its output is injected …
+ Backgrounded as job bg_1 for `bun test` in packages/ai (killed once it has run 300s in total; …); its output is injected …

- Background job bg_1 has completed. Resume your work using the result below.
+ Background job bg_1 (bun test) has completed. Resume your work using the result below.
```

Reading order: `formatCommandIdentity` and `formatBackgroundNotice` (tui), `BashTool`'s three backgrounding paths, then `buildAsyncResultBatchMessage`.

## Why

Fixes #12607.

A turn's tool results reach the model in completion order, by design; call ids pair them on the wire, but a model reading by position pairs a job with the wrong call (#11179). The harness knew each command and never said so.

Decisions:

- The command sits on the notice's own line, not in separate `Command:`/`Working directory:` lines, so the TUI's prefix strip still removes it and no wider rule can clip command output. Line breaks are written `\n`. Related: #12633 takes the separate-lines route.
- The whole command is named, not the 120-character job label, so commands differing late stay distinguishable; past 2,000 characters (the approval prompt's budget) the middle is elided.
- Task and eval single-job headers read as before. Header labels are now escaped like job output: the batch header rendered them raw, so a `</system-notice>` in one could close the notice.

## Testing

- `bash-job-lifecycle.test.ts`: two parallel async calls sharing their first 130 characters; the first call's cwd check is held until the second returns, so starts arrive reversed, and it also finishes last. Each start result and completion header names its own command. On `main` the reversal reproduces and the test fails at the first notice.
- `agent-session-async-delivery.test.ts`: a long multi-line command with `</system-notice>` renders on one escaped line in both headers; a task's single header stays bare. Fails on `main`.
- `bash-render.test.ts`: a notice naming a command and a directory with line breaks is still stripped from the card.
- Live, print mode: two parallel async calls with identical output, 3 runs each on Claude Haiku 5.5 and GPT-6.1 Sol, on `main` and the branch: 12/12 mapped job to call, with no wait or poll calls. Starts came back in call order there, so this shows no regression; the reversal is the first test.

`bun test packages/coding-agent/test/bash-job-lifecycle.test.ts packages/coding-agent/test/agent-session-async-delivery.test.ts packages/tui/test/bash-render.test.ts`

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
