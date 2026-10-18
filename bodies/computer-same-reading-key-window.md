## What

If I click a different window of my own app at the moment the agent's background target brings itself forward, I now get my app back with the window I clicked focused, not the window that had focus when the action started.

During macOS background input, the focus guard sends a target that activates itself back behind your app. Since 89892decd0, a click in your own app no longer counts as you choosing the target, so the guard sends the target back even when your click and its activation come together. The hand-back then restored the window that was key when the action began, which undid a click on another of your app's windows, and on its next poll the guard read your new key window as a switch of yours and stood down for the rest of the action. After a click in your app, the hand-back now restores the key window your app reports once it is back in front (the starting one if it reports none), and the guard keeps that window and stays armed.

**Non-goals.** Without a click in your app, the hand-back restores the starting window as before. With your app in front, a key window that changes without a hand-back still stands the guard down.

## Why

`guard_focus` restored `lease.key`, the key window read when the action started. A click on another window of your app changes it, but the guard reads the key window only on polls where your app is in front, so a click and the target coming forward between two polls never show it the change. The switch watch now notes a click it placed in your app (`own_click`). After such a click, the hand-back reads your app's key window once your app is in front again, which is when `GuardedDesktop::user_key` is meant to be read, at the cost of one accessibility read. Hand-backs with no click keep the starting window, so a panel that hides while its app is inactive can't swap in another window. macOS reports `AXFocusedWindow` for inactive apps too; I checked this live on ten inactive apps.

No CHANGELOG entry: no release has the same-reading hand-back. In v18.12.1 any click with the target in front disarmed the guard.

## Testing

- New `a_hand_back_restores_the_window_the_user_clicked_as_the_target_came_forward` drives `guard_focus` with a fake desktop whose user app reports key window 43 (42 at start). When the target comes forward in the same reading as a click placed in your app, your app comes back with 43 restored and kept, and the guard stays armed. With no click, 42 is restored. With the fix reverted, the click case restores 42 and the test fails.
- `cargo test -p pi-natives --lib`, `cargo check -p pi-natives --tests`, `CI=1 bun check`, `bun run build:native` and the computer tool TS tests on an Apple Silicon Mac.
- Not run: a live repro. The click and the activation have to land between two 10 ms polls.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
