## What

Follow-up to #17417: on a busy machine `fill` on a Slate editor still sometimes put the new text in front of the old, so I select the editor's text before focusing it, and a fill now refuses an editor whose focus ends up on a wrapper or the page.

Under CPU load, `fill("new query")` on a Slate editor holding "old query text" left "new queryold query text" in 20 of 30 fills on `main` and 0 of 30 with this PR.

- **Select, then focus.** `focusTextEntryTarget` selects a contenteditable's contents before calling `focus()` when the action is a fill, so focusing keeps the selection instead of putting the caret at the start.
- **Focus inside the editing host.** `fillViaHandle` requires the root's `activeElement` to be the editing host or an element between it and the target, instead of any element containing the target, which the body or a focusable wrapper always is. That was Codex's finding on #17417 after it merged.

## Why

Focusing a contenteditable puts the caret at its start. Slate copies that caret into its own selection and writes it back to the page when it next renders, and until that render lands it applies input at its own selection. When the render ran after #17417's select-all, it collapsed the selection and `Input.insertText` went to the start. Timing logs from a Slate page show the caret sync, then the select-all collapsing to `#text:0`, then the insert at offset 0. Selecting first means the only selection Slate copies is the one the fill replaces.

Rejected: yielding page tasks (`MessageChannel`) between focus and select. Two yields fixed Slate, but posted messages do not run on a tab with paused virtual time, so the existing "tab that produces no animation frames" test hung until its per-op timeout.

With an inert editor, focus stays on the body; with a focus handler that moves focus to a `tabindex` wrapper, it lands there. Both contain the target, so `main` sent the text to an element that cannot take it and reported success.

## Testing

- `fills an editor that applies input at the selection it read once after focus`: a page editor that, like Slate mid-render, reads the page's selection once after focus and applies the next input there. `main`: `"new queryold query"`, 3 of 3 runs; this PR: `"new query"`.
- `refuses to fill a contenteditable whose focus handler moves focus off it` now covers a focusable wrapper too; on `main` that fill returns without an error. `fills an element inside an editing host whose host hands focus to it` keeps the case `main` already filled.
- Real Slate 0.147 (+ React 19) page, 30 fresh fills each under 28 busy-loop processes on a 14-core Mac: `main` 20/30 wrong, this PR 0/30. Lexical, ProseMirror and Slate fill/clear sequence: 0 of 18 steps wrong, headless and through the relay in an isolated Chrome for Testing profile.
- `bun test test/tools/browser-interactions.test.ts` (and the run-output, frames, tab-call and snapshot-plus browser files) passes; root `bun run check:ts` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
