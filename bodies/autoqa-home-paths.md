## What

Auto-QA reports quote paths and commands verbatim, so my home directory and login name were going to qa.omp.sh with them; this rewrites both before the report is stored or sent.

Of the 384 grievances in my local `autoqa.db`, 12 carried my home path or login name; after this change none of the 743 replayed reports (those rows plus every `xd://report_issue` write in my transcripts) do, and no report without them changed.

| In a report | Stored and sent on `main` | With this PR |
|---|---|---|
| `/Users/jdoe/proj/a.ts:4` | as written | `~/proj/a.ts:4` |
| `see /Users/jdoe.` | as written | `see ~.` |
| `gui/501/com.jdoe.agent`, `jdoe@host`, `-Users-jdoe-proj` (encoded session dir), `/c/Users/jdoe` | as written | `com.<user>.agent`, `<user>@host`, `-Users-<user>-proj`, `/c/Users/<user>` |
| `Ask will.`, `./node_modules`, `/usr/local/bin` (login `will`, `node`, `bin`) | as written | unchanged |

Rows already queued (recorded before this change) are rewritten when they are sent, the same way the 128-byte tool-name clamp is applied at both points.

## Why

The collector stores report text as is, and reports are written by models that paste whatever path the tool printed. One of the twelve rows above also held the login name inside a launchd label, which a home-path rewrite alone misses.

Decisions:
- The login name is rewritten only where it names the user (a home path, reverse-DNS label, `name@`), not as a bare word: common logins (`will`, `node`, `test`, `bin`) are also words and directory names, and a broader match corrupted ordinary paths in review.
- `root` is not rewritten: it names no one, and `/root` is still covered as a home path.
- Not done here: deduplicating repeated reports. Over the same 359 transcript writes, near-identical reports within a session numbered 1 at any window from 10 to 60 minutes, so that would not pay for itself.

## Testing

- Replay: every local grievance row and every recorded `xd://report_issue` write (359, across 207 sessions and 4 model families) pushed through `flushGrievances` from `main` and from this branch into a capturing collector: identity strings in sent entries 12 → 0 (database rows) and 13 → 0 (transcript writes); 0 entries without one changed.
- `bun test packages/coding-agent/test/tools/report-tool-issue.test.ts`: 30 pass. The new cases stub `os.homedir()`/`os.userInfo()`; with the source reverted to `main`, 4 fail (send-time legacy row, label/home path, sentence-final path and `user@host`, encoded and MSYS paths) and the prose/`node_modules` guard case passes on both.
- Not run: Windows (`C:\Users\…` with backslashes is covered by the home-path rewrite but was not exercised on a Windows host).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
