## What

I made Windows takeover `type` wait until the app has read the keys before giving focus back, and say so when it can't tell, because Chrome lost the end of the text while we reported success.

Typing 2,000 characters into a Chrome field kept 218 to 237 of them on `main`, each call reporting success; with this change all 2,000 arrive (5 of 5), at 2.8 s a call instead of 0.9 s.

| n = 5 per cell | 240 characters: `main` | 240: this PR | 2,000: `main` | 2,000: this PR |
|---|---|---|---|---|
| Chrome field | 0/5 whole (kept 0-102), 4 success, 1 error | 4/5, 0.3 s (1 error) | 0/5 (kept 218-237), success | 5/5, 2.8 s |
| WPF TextBox | 5/5, 0.2 s | 5/5, 0.6 s | 5/5, 0.6 s | 5/5, 3.5 s |
| WinForms TextBox | 5/5, 0.2 s | 5/5, 0.7 s | 5/5, 0.6 s | 5/5, "unconfirmed", 5.6 s |
| Win32 EDIT | 5/5, 0.2 s | 5/5, 0.5 s | 5/5, 0.7 s | 5/5, 2.8 s |
| Qt QLineEdit | 5/5, 0.2 s | 5/5, 0.2 s | 5/5, 0.7 s | 5/5, 0.8 s |
| Windows Terminal, a program reading stdin | 0/5: text arrived, the closing Return did not; success, 0.2 s | 5/5, 0.3 s | 0/5: same; success, 0.7 s | 5/5, 1.6 s |
| A window that stops responding at the first key (10 s) | 5/5, 0.1 s | 5/5, "unconfirmed", 5.1 s | 5/5, 0.3 s | 5/5, "unconfirmed", 5.3 s |

**Cost:** a call now lasts as long as the app takes to read the keys; WinForms needs over 5 s for 2,000, so those calls say "not confirmed" though the text arrived.

**Not fixed here:** Windows 11 Notepad keeps 15 to 30 of 240 characters on both, reported as success: its spell check throws away keys its thread already read. The Settings search box can still end a few characters short after reading (234-239 of 240). Both need text that does not go in as keys, a separate proposal.

Before handing the foreground back, takeover typing sends an unassigned key (VK 0xE8) behind the text and waits, at most 5 s, until the focused control's thread has read it. When it cannot see that, the call still succeeds and the run output adds `type sent the text but could not confirm it arrived: <why>`; `typeText` and `axType` resolve to `{ unconfirmed, focusReturn }`.

## Why

The takeover guard handed the foreground back 40 ms after the last key, so keys the app had not read yet went to the next window in front: the user's.

- The wait follows the app's pace: no fixed gap suits both Qt (0.8 s for 2,000 characters) and WPF (3.5 s). Cua's Windows driver waits for the same marker key.
- It joins the focused control's thread, which reads the keys; a UWP frame's own thread refuses to be joined.
- Pacing keys by UI Automation reads of the field was tried and dropped: it still lost Notepad's text and made WPF 15 times slower.
- Success means "sent and read by the app's thread"; nothing reads the field back. If the text held a Return and the foreground moved, the Return moved it and nothing is reported.

## Testing

Windows 11 (build 26200) VM, fresh builds: `main` at ced5efc0c2 with PR 18919 (addon sha256 `3ee87f97…81f2`) and this branch on it (`e702a753…61e0`). Each cell types a unique text with File Explorer in front, and counts only when that setup and an emptied field were confirmed. The field is read by another route until two reads agree, so late text counts. One Chrome cell per arm at 240 stopped with `InputFailed` when Chrome took the foreground mid-send.

The VM's takeover tests (`cargo test -p pi-natives -- --ignored desktop::win32::tests`, foreground lock timeout at 0 so the test process may take the foreground): `takeover_typing_hands_the_foreground_back_once_a_busy_target_read_the_text` (the target sleeps 1.5 s at the first key) passes, and with `drain` removed fails with the target still empty when focus went back; `takeover_typing_into_a_hung_target_says_the_text_is_unconfirmed` (8 s) passes, and without `drain` reports nothing; `element_takeover_hands_the_foreground_back_to_the_users_window` still passes.

`bun test packages/coding-agent/test/tools/computer.test.ts`: 145 pass; the new case fails with the worker change reverted.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
