## What

I type in my own app while the agent works in another one behind it, and when that app pulled itself to the front my typing sometimes just kept going into it, because one keystroke at the wrong moment made omp give up on putting my app back.

Fixes a regression from #15195 (merged in `4d956dad0f`, unreleased): a background target that activates itself more than 500 ms after the action's last send stays in front again, and the user's typing goes to it. With this change it is sent back as before #15195, in 6/6 runs where main left it in front in 6/6.

| Guest A (macOS 26.5 VM), n=3 per case | main before #15195 (`509105c1ef`) | main now (`cad87a899d`) | this PR |
|---|---|---|---|
| Click in the user's busy app (iTerm2 stopped for 0.5 s), then TextEdit (the target, holding ⇧ for 4 s) activates itself | user's app back 3/3 | TextEdit stays 3/3 | user's app back 3/3 |
| Pick an item from the user's context menu over TextEdit, then TextEdit activates itself | user's app stays 3/3 | TextEdit stays 3/3 | user's app stays 3/3 |
| Click on the target's window (Safari page) | Safari kept 3/3 | Safari kept 3/3 | Safari kept 3/3 |

## Why

#15195 sent back an app the action brings forward (Finder's ⌘O bringing TextEdit) only if it came forward within 500 ms of one of the action's sends, so an app the user opens later is left alone. That limit also applied to the target itself (`action_brought = caused && …` in `BackgroundFocusLease::observe`): in a held key or any action longer than half a second, the target activating itself later counted as the user's switch, and the guard stood down with the target in front.

The 500 ms limit now applies only to other apps; the target is sent back whenever the user did not pick it with a click on it, ⌘/⌃, or a panel such as Spotlight. An ⌥ or F-key switcher to the target, which shows none of those, is sent back too, as it was before #15195.

## Testing

`only_an_app_that_comes_forward_right_after_the_actions_acts_is_sent_back` now has the target activating itself 1.3 s after the last send, idle and with ⌥ held: sent back, and the action fails if it is still in front at the end. With the one-line fix reverted it fails on both. A third app coming forward that late still ends the guard.

The table runs drive the real computer tool in the VM through the VNC keyboard and pointer, comparing front-app samples every 150 ms for 0.9 s after the click.

On bench-mac: `cargo check -p pi-natives --tests`, `CI=1 bun run check:rs` (clippy), `CI=1 bun check`, `cargo test -p pi-natives --lib` and the computer TS tests pass, except `a_click_placed_in_the_users_app_does_not_let_the_target_keep_the_front`, which fails the same way on main `58349dc80d` (it reads an idle counter after a click as a new click) and is not touched here.

Not run: a hardware keyboard and mouse (the VM's VNC input stands in).

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation): unreleased regression, no entry
