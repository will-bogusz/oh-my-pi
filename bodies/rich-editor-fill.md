## What

I hit this filling Discord's search box through the browser tool: the old query stayed and the new one came out mangled, so I made `fill` on a rich-text editor select what's in it and put the new text in with one insertion, the way a paste does.

In Chrome (managed and relay), `tab.fill` on a Slate or Lexical editor reported success while the editor kept its old text; it now replaces it, and `fill("")` clears it.

| Real editor library, holding "old query text" | `main`: `fill("new query")` | `main`: `fill("")` | this PR |
|---|---|---|---|
| Slate (Discord's search box and composer) | field shows empty, editor still holds "old query text"; every later fill or type is lost | same | "new query" / "" |
| Lexical | "new queryold query text" | old text stays | "new query" / "" |
| ProseMirror | "new query" | "" | unchanged |

In `fillViaHandle`, a contenteditable target gets its contents selected in the page, then one `Input.insertText` (`keyboard.sendCharacter`), or for an empty value a real Backspace when the selection draws anything. Inputs, textareas and pickers keep their path. Tern's `fill` already works this way (`prepareFill`). A per-op timeout after the insertion was sent now says so (`TypingInterruptedError`) instead of calling the element hidden or covered.

**Beyond the clear:** a newline in a contenteditable fill is inserted as text, as Tern does, instead of pressing Enter, which on `main` sends a chat message mid-fill. Restoring Enter between lines is a few lines if preferred.

## Why

`main` cleared a contenteditable with `innerText = ""`, then typed per key. Rich-text editors keep their own document and learn of edits only through input events, so that write is undone (Lexical, and the keys land in front of the old text) or leaves the editor out of step with its DOM (Slate). An insertion over a selection reaches the editor through `beforeinput`, like a user's paste.

- Rejected: select-all by shortcut (Ctrl vs Cmd, and headless macOS needs the edit command named); the Selection API is platform-neutral. Per-key typing over the selection: a round trip per key on the relay. `insertText("")` to clear: Slate ignores it.
- Non-goals: cmux (script fallback, no trusted input), and `tab.type`, which types at the start, where `focus()` leaves the caret.

Maintenance: editors must handle `beforeinput` `insertText` and `deleteContentBackward`, the path of pastes and IME, so a break shows there too.

## Testing

- New test with a page editor that, like Slate and Lexical, keeps its own model and undoes foreign DOM writes: with the fix reverted, fill and clear both leave `"new queryold query"`.
- Boundary tests: an empty fill removes an image-only editor's image and leaves the text around a blank span alone; an abort that lands after the insertion was sent reports it. Both fail without the second commit.
- Slate 0.147, Lexical 0.53 and ProseMirror 1.42 bundled into local pages, driven through `browser` `run` cells (fill, refill, `fill("")`, fill, type, emoji fill) and read from each editor's model: `main` 12 of 18 steps wrong, this PR 0, in headless Chromium and through the relay in an isolated Chrome for Testing profile.
- `bun test test/tools/browser-interactions.test.ts test/tools/browser-run-output.test.ts` in `packages/coding-agent` passes, with three more browser test files (62 tests); root `bun run check:ts` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
