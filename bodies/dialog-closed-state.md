## What

If I click OK on a page's confirm myself, the agent's next browser call still says a dialog is open, so the tool now notices when Chrome closes it.

After a `confirm` or `prompt` is answered outside the browser tool (the user's click on it, or another CDP client), the next page call runs and `tab.dialog()` reports `{ open: false }`. Before, page calls failed on the answered dialog until `tab.handleDialog()` itself failed and cleared it.

| 10 tries each, Chrome 157 | before | after |
|---|---|---|
| `tab.dialog()` once the dialog closed | `open: true` 10/10 | `open: false` 10/10 |
| next page call (`tab.text`) | fails: `a confirm("Leave?") dialog is open and blocks the page until it is answered` | runs |
| `tab.handleDialog({ accept: true })` | fails: `Protocol error (Page.handleJavaScriptDialog): No dialog is showing` | fails: `tab.handleDialog() found no pending confirm or prompt` |

Both ways of closing it gave the same cells: a real click on the dialog's Cancel button in headed Chrome, and a second CDP client in headless Chrome.

## Why

The dialog controller forgot a pending dialog only when omp answered it, a dialog policy did, or the main frame navigated. Chrome sends `Page.javascriptDialogClosed` for every close, and the worker already listens for it; it now calls `RuntimeDialogController.closed()`. Since page calls fail at once while a dialog is pending, the stale state cost the model a false report about the page and two failed calls.

Dialogs omp answers itself (`tab.handleDialog`, `tab.setDialogs`, auto-accepted alerts) report and return as before.

## Testing

- `bun test packages/coding-agent/test/tools/browser-nav-frames-dialogs.test.ts`: the new "forgets a confirm that the user or another client answered" (a second CDP client answers) fails without the fix and passes with it; the existing handleDialog test still gets `true`, `"Ada"` and policy `false`.
- That file with `browser-interactions` and `browser-attach` on Linux, headless Chrome: 117 pass, 1 skip. `bun run check:ts` passes.
- The table: omp's browser tool driven against Chrome 157 on Linux, 10 tries per cell, headed under Xvfb for the click. A confirm inside a cross-site (out-of-process) iframe reports its open and close on the page's own session, and is forgotten the same way: 10/10.

## Limits

After a prerendered page activates, the worker's listeners stay on the session it started with, so a close there is missed as before (from reading the code; not measured). Tern keeps its own held-dialog state, which is not changed or measured here. Chrome did not close a pending confirm when its tab was hidden with CDP attached (0/10), so a tab switch alone does not trigger the stale state.

---

- [x] `bun check:ts` passes; no Rust changed
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
