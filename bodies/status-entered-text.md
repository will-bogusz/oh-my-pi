## What

I want an agent that reads a password inside an Eval cell and types it into a field to leave no copy of it on disk, and the status line for that call was the one place still writing it down.

A cell that read a throwaway password into a variable and called `tab.fill("#password", pw)` never showed the value to the model, but the session file held it in 10 of 10 runs, in the status event the eval tool keeps for each browser or computer call. With this change, 0 of 10.

| | main | this branch |
|---|---|---|
| status line for `tab.fill("#password", pw)` | `main.fill("#password", "<the password>")` | `main.fill("#password", <hidden>)` |
| runs whose session file holds the password (10 each) | 10 | 0 |
| runs that signed in | 10 | 10 |

Status lines are built by `describeBrowserCall` and `describeComputerCall` through `renderCallChain`, which renders every argument verbatim. They now use `renderStatusCallChain`, which shows every argument from the entered text on as `<hidden>`:

- browser `fill` and `type` after the selector on a tab or frame, from the first argument on an element handle; `clipboardWrite` and `handleDialog` from the first argument;
- computer `type`, `setValue` and `clipboard.write` from the first argument.

Hiding by position rather than by type covers a numeric PIN and Python's keyword form (`tab.fill("#password", value=pw)` arrives as a trailing object). Other calls render as before, and `renderCallChain`, which also builds the code a tab runs, is unchanged.

Not covered here: `evaluate` arguments, `setCookies`/`setStorage`, URLs with credentials in `goto`/`open`, and the output that `sh()` records in its status event. Those are not entered text, and changing what they show is a separate decision.

## Why

`docs/secrets.md` keeps registered secrets out of what the model sees, and a cell that never prints a value it read keeps it out too. The status tree was the gap: its lines are not sent to the model (the measured runs found the value in no request), but the session file keeps them and the terminal draws them, so the password sat in plain text in every transcript of a sign-in. Related: PR 15502 masked password values in ARIA snapshots.

## Testing

- `test/eval/browser-prelude-facade.test.ts` "keeps text a cell enters out of the status events the session keeps" runs a real JavaScript cell (password fill, numeric `type`, element-handle fill, frame fill, `clipboardWrite`, `handleDialog`) plus the Python keyword shape, and `test/tools/computer.test.ts` "keeps text it types, sets or copies out of status lines" covers `setValue`, `type` and `clipboard.write`. Both fail on `main` and pass here; both files pass whole (155 tests).
- Live: a scripted model drove `omp -p` 10 times on `main` and 10 times on this branch, each reading a throwaway password inside a Python cell and filling a local login page in headless Chromium; every model request and session file was searched for the value. The same leak through `setValue` was measured on a GTK login fixture through the computer tool (10 of 10 on `main`).
- Status lines never reach the model, so this cannot change what an agent does; no model sample set was run.
