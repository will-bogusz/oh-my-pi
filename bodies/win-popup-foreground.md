## What

I made `press()` work on the items of a WPF app's open right-click menu on Windows, which omp refused as "can take foreground" even with that app in front.

WPF context menu item, app in front, right-click then `press()`: pressed 0/10 → 10/10 on both Windows 10 22H2 and Windows 11 at this branch's head, the app's window kept in front.

> **Windows context.** A WPF context menu or dropdown is a top-level popup window of its own (`WS_POPUP` with `WS_EX_NOACTIVATE`), owned by the window that opened it. While it is open, that window keeps the foreground. The style stops a click or show from activating it; the app can still do so explicitly.

| WPF context menu item, `press()` with the app in front | v19.0.1 | this branch |
|---|---|---|
| Windows 10 22H2, default mode | pressed 0/10 (refused) | pressed **10/10** |
| Windows 11, default mode | pressed 0/10 (refused) | pressed **5/5** |
| Windows 10 22H2, default mode, at the head (`c270cca520f`) | pressed 0/10 (refused) | pressed **10/10** |
| Windows 11, default mode, at the head (`c270cca520f`) | pressed 0/10 (refused) | pressed **10/10** |
| either, refuse mode | right-click refused 10/10 | right-click refused 10/10 |

Reading order: `in_front` and `ensure_pattern_safe` in `win32/window.rs`, then `Win32Ax::contained` and `PatternAction` in `win32/ax.rs`.

## Why

`ensure_pattern_safe` refuses UI Automation actions on WPF, XAML and Chromium windows not in front, since those actions bring the window forward. It compared the foreground with the target's own top-level window, which for a menu item is the popup, so the open menu of the app in front was refused.

Decisions:
- A target counts as in front when it holds the foreground, or when it has both `WS_POPUP` and `WS_EX_NOACTIVATE` and its direct owner holds the foreground. Ownership alone is not enough: a modeless dialog the window owns can activate itself, so it stays refused, as does the menu once another window is in front.
- The check runs again after the pattern lookup, right before sending: the user can switch windows while the app answers the lookup.
- Admitting any such popup, not only menus, is deliberate: in a standalone UI Automation probe (no omp build loaded), `setValue` and `press` on a custom owned WPF `Popup` acted 40/40 on Windows 10 and 11 while a user typed into the owner, with the foreground, focus and all 960 typed keys untouched.

Limits:
- In refuse mode the right-click that opens a WPF menu is itself refused (WPF drops posted clicks), so this changes only the default mode.
- Measured on WPF only; a XAML or Chromium popup with these styles and owner is admitted too.

## Testing

`an_item_of_the_open_context_menu_of_the_window_in_front_is_pressed` (ignored; needs a signed-in desktop) opens a real WPF context menu and drives `AxElementAt`, `AxQuery` and `AxPerform`. The item is pressed with its window in front, and no window of the app gains or loses activation. Refused with nothing run: a button in a modeless dialog the window owns, the item once another window is in front, and the item when the app activates another window while answering the pattern lookup. Passes on Windows 10 22H2 and Windows 11 at the head. With the check after the lookup removed it fails at that last case, where the press goes through; with the popup rule removed (as on `main`, run at an earlier head with the same rule) it fails at the first press with `BackgroundUnavailable`.

<details><summary>Builds and runs behind the numbers</summary>

- First rows: release v19.0.1 (`f40f335845f`) against an addon of this branch at `ce8c03e8340`, whose popup rule is the one here (the dispatch-time recheck came later), interleaved in 2 rounds of 5 per OS through the harness's right-click then `press()`. A third Windows 11 block of 5 was dropped: its no-action control, a user typing during the call, lost 30 keys.
- Head rows: v19.0.1 against an addon of `c270cca520f`, interleaved, 2 rounds of 5 per OS (Windows 10 08:39-08:48Z, Windows 11 09:11-09:19Z). Unit test at the head: passed on Windows 10 (05:31Z) and Windows 11 (08:51Z); with the post-lookup recheck removed it failed at the lookup-switch press on both. Windows 11 runs between 07:39 and 08:12Z were discarded: another session's input ran on that guest.
- Styles `0x96000000` / `0x08080088`: read with Win32 from the fixture's open menu during a v19.0.0 run.
- Custom popup probe: `StaysOpen` WPF `Popup` (styles `0x96000000` / `0x08000088`) owned by the window in front, plain and with focusable content, `ValuePattern.SetValue` on its text box and `InvokePattern.Invoke` on its button, n=5 per popup, action and OS, 24 keys typed into the owner's box during each call, foreground polled every 2 ms.

</details>

`scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: pass, recorded for the head.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
