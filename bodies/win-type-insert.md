## What

I'd like Windows takeover `type` to put text into a focused multi-line edit control with the control's own insert instead of keys, because Windows 11 Notepad throws typed keys away and we report success.

Into Notepad, 240 typed characters keep 15 to 20 on `main`, reported as success, and all 240 with the insert (5 of 5); 2,000 keep 16 to 23 against all 2,000, in 0.1 s a call.

| n = 5 per cell, Windows 11 | `main`: keys | keys, then wait until the app read them (the preceding PR) | insert (this branch) |
|---|---|---|---|
| Notepad, 240 characters | 0/5 whole (15-20 kept), success, 0.2 s | 0/5 (15-23), success, 0.3 s | 5/5, 0.1 s |
| Notepad, 2,000 | 0/5 (16-23), success, 0.8 s | 0/5 (16-20), success, 0.9 s | 5/5, 0.1 s |
| Win32 multi-line EDIT, 240 | 5/5, 0.2 s | 5/5, 0.5 s | 5/5, 0.1 s |
| Win32 multi-line EDIT, 2,000 | 5/5, 0.7 s | 5/5, 2.8 s | 5/5, 0.1 s |
| Notepad, non-ASCII + a line break (prototype) | 0/5 (8-9 of 39), success | not run | 5/5 (line break as text) |

It applies only where the focused control answers `WM_GETDLGCODE` with `DLGC_HASSETSEL` and has `ES_MULTILINE`, not `ES_READONLY`: Notepad, Win32 and RichEdit multi-line fields. Everything else keeps keys.

**What the control sees instead of keys** (WinForms fixture, 11 characters):

| | keys | insert |
|---|---|---|
| Change notifications | one per character (TextChanged 11) | one per stretch (1) |
| Key events | one per character (KeyPress 11) | none (0) |
| Undo | a typing run | one step per stretch; Ctrl+Z in Notepad took it back |
| Per-key validators (`ES_NUMBER`, a KeyPress filter) | run: "abc 123 def" leaves "123" | skipped: all of it goes in, which is why single-line fields keep keys |
| Read-only field | keys ignored | never inserted: the style bit is read first (an insert overwrote a read-only EDIT) |
| Length limit | keeps what fits, success | `InputFailed` naming what the control holds |

## Why

Notepad's spell check discards keys queued when its text changes, after its thread read them, so waiting until they are read (the preceding PR) cannot save them:

| Notepad, one `SendInput` array | spell check on | spell check off |
|---|---|---|
| 240 characters | 0/15 whole (9-54 kept); autocorrect and Copilot on or off change nothing | 10/10 |
| 2,000 | 0/5 (16-28 kept) | 10/10 |

Every key shape loses (6-36 of 240 kept); `WM_CHAR` and `EM_REPLACESEL` arrive whole (10/10). AutoHotkey's `EditPaste` and pywinauto's `set_edit_text` send that message.

**Questions for you**, each with what I'd pick:

1. **May window-addressed takeover `type` insert into a focused multi-line edit control?** I'd say yes: the only route that kept Notepad whole at both lengths, and faster. If no, Notepad keeps losing text behind a success; the fallback, posting `WM_CHAR` 4 ms apart, took 1.1 s at 240 and 8.3 s at 2,000, and its order around Return rests on sleeps.
2. **There, may a line break go in as text (CR LF in the same insert)?** I'd say yes: single-line fields, where Return is a command, never get here, and Notepad then took text with a line break 5/5. The branch keeps Return keys until you say so, so multi-line text into Notepad still fails at the first Return it drops (`InputFailed`). Price of yes: a multi-line field without `ES_WANTRETURN` gets a line break, not its command.
3. **Should fields only UI Automation can read be paced?** I'd say no. Settings' search box ends short even after the wait (234-239 of 240); only pacing by UI Automation reads kept it whole, at 33 s a call, and bounding those reads needs a thread per call. If yes, that comes first and every readable field pays for it.

This goes further than macOS, which inserts only for element or background typing (`inserts_first`), and our Linux `el.type` change (printable ASCII into GTK and Qt fields).

**Risk.** A non-edit control claiming both bits (Scintilla answers `DLGC_HASSETSEL`) gets one wrong insert, which the text proof turns into an error. RichEdit protected text and IME composition: not measured.

## Testing

Fresh builds on a Windows 11 VM; each field read by another route until two reads agreed. The cause table and line-break row come from a prototype that proved an insert by the caret; this branch proves it from the text.

On the VM, `takeover_typing_into_a_multi_line_edit_proves_the_insert_from_its_text`, `takeover_typing_into_notepad_arrives_whole` and the preceding PR's busy-target test pass; `edit.rs` has host tests.

<details><summary>An independent review's five objections to the prototype, and how this branch meets them</summary>

1. The caret check could call a cut or caret-moving insert whole, and its "unchanged, so send keys" could type twice. Met: the proof is from the control's text, keys go only when the text is provably unchanged, and an insert with no answer is never followed by keys.
2. Accepting either line-break count (an EDIT keeps CR LF, RichEdit one CR) is a normalisation. Met: line breaks stay Return keys unless question 2 says otherwise, so no stretch holds one.
3. The macOS and Linux precedents are narrower than first claimed. Met: stated as narrower above.
4. `DLGC_HASSETSEL` promises `EM_SETSEL`, not `EM_REPLACESEL`. Kept as a risk: with the multi-line style bit also required, a wrong guess costs one insert and an error, not silent loss.
5. Waiting until the app read the keys proves "read", not "kept", and its marker key (unassigned VK 0xE8) reaches the app as a KeyDown. Stated: that wait is the preceding PR's, and a plain success there means "sent and read".

</details>

<details><summary>How an insert is proved, and the rig</summary>

Each stretch between line breaks goes in with one `SendMessageTimeout(EM_REPLACESEL, TRUE)` (2 s, `SMTO_ABORTIFHUNG`), and is proved from the control's text read before and after (250 ms each): only "before with one range replaced by the text" counts. Unchanged text sends the stretch as keys; anything else fails with `InputFailed`, and no keys ever go on top of an insert that was tried. Line breaks stay Return keys, drained before the next insert, which would otherwise overtake them.

Windows 11 build 26200, Notepad 11.2501.31.0, n = 5 per cell: `main` at ced5efc0c2 with PR 18919 (addon sha256 `3ee87f97…81f2`), the preceding PR (`e702a753…61e0`), this branch on it (`2990c7d3…089a`). Each field was emptied and read back empty and File Explorer was in front before each call. The review asked for the text proof because a limit plus a line break, or a handler that moves the caret, could pass the caret check.

</details>

<details><summary>Rows not in the tables</summary>

From the prototype, n = 5 unless given, each field read until two reads agreed:

| cell | `main` | prototype |
|---|---|---|
| Win32 EDIT, WPF, RichTextBox: "héllo ✓ 日本 😀", a line break, more | 5/5 | 5/5 |
| WinForms single-line TextBox, 240 (not routed: keys and the wait) | 5/5, 0.2 s | 5/5, 0.8 s |
| An EDIT that cannot scroll, holds 34 characters and hangs 0.3 s into the call (n = 1) | 34 of 240 kept, success | `InputFailed` "kept only the first 34 of 240", 0.04 s |
| A password field | refused activation in every arm, no row; without OMP, an insert and keys both arrive whole | |

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
