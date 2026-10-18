## What

If I click another window of my own app just as the agent's background target brings itself forward, I now keep my app in front with the window I clicked, instead of losing the front to the target about half the time.

During macOS background input, the focus guard sends a target that activates itself back behind your app. A click on another of your app's windows makes that window key, and the guard read the changed key window as you switching away and stood down. A target that came forward right then stayed in front. After a click the guard placed in your own app, it now keeps the window you clicked: it sends the target back, and the hand-back restores that window.

Guest run on a macOS VM. iTerm2 is your app with two windows and TextEdit is the target, holding a background `holdKeys`. You click the second iTerm2 window, and TextEdit activates itself as the button goes down. The front app was sampled throughout:

| n=6 each | TextEdit came forward | sent back | your app in front after | key window after |
|---|---|---|---|---|
| before (c0435fa702) | 6/6 | 3/6 | 3/6 | the clicked window, 6/6 |
| this PR | 6/6 | 6/6 | 6/6 | the clicked window, 6/6 |

**Non-goals.** A key window that changes with no click of yours in your app, such as a window you open from the keyboard, still stands the guard down.

## Why

The guard compares your key window with the one the action started with, and any change disarmed it, so your own click on another window lost you the front to the target. The switch watch now records a click it placed in your app (`own_click`). After one, a changed key window becomes the one the lease keeps. When the click and the target land in the same reading, the guard never sees the new window before the hand-back, so the hand-back then restores the key window your app reports once it is in front again, which costs one accessibility read. macOS reports `AXFocusedWindow` for inactive apps too; I checked this on ten inactive apps. Without such a click, the hand-back restores the starting window as before.

## Testing

- `a_window_the_user_clicked_in_their_app_is_kept_when_the_target_comes_forward`: after a click placed in your app, a key window of 43 (42 at start) is kept and the target coming forward is sent back. With no click, 43 still disarms.
- `a_hand_back_restores_the_window_the_user_clicked_as_the_target_came_forward` drives `guard_focus` with a fake desktop. When the click and the target land in the same reading, your app comes back with 43 restored and kept, and the guard stays armed. With no click, 42 is restored.
- With the fix reverted, both tests fail.
- `cargo test -p pi-natives --lib`, `cargo check -p pi-natives --tests`, `CI=1 bun check`, `bun run build:native` and the computer tool TS tests pass on an Apple Silicon Mac.
- The guest table above comes from the agent-cells rig on a macOS VM, with clicks sent over VNC. Clicking the key window instead was sent back 3/3 on both arms.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
