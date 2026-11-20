## What

On Windows, choosing an item from a WPF app's right-click menu was refused as "can take foreground" even with that app already in front; now the open menu of the window in front counts as in front with it.

WPF context menu, app in front, right-click then `press()` on the menu item: refused 20/20 → pressed 15/15, the app's window kept in front (Windows 10 22H2 n=10, Windows 11 n=5; default mode).

> **Windows context.** A WPF context menu or dropdown is a top-level popup window of its own (`WS_POPUP` with `WS_EX_NOACTIVATE`, measured `0x96000000` / `0x08080088`), owned by the window that opened it. While it is open, that window keeps the foreground; the popup never takes it.

| WPF context menu item, `press()` with the app in front | `main` (v19.0.1) | this PR |
|---|---|---|
| Windows 10 22H2, default mode | 0/10 refused | **10/10** pressed |
| Windows 11, default mode | 0/10 refused | **5/5** pressed (one block of 5 void: the harness's control lost a user key) |
| either, refuse mode | 0/10 refused | 0/10 refused (the right-click that opens the menu is itself refused there) |

Interleaved v19.0.1 / this branch, 2 rounds of 5, through the harness's right-click then `press()`.

**Custom popups** (the reviewer's case: any owned non-activating popup is admitted, not only menus). A custom owned WPF `Popup` (`StaysOpen`, styles `0x96000000` / `0x08000088`, owned by the window in front) with a `TextBox` and a `Button`, plain and with focusable content, while a user types 24 keys into the owner's own text box during each call: UI Automation `setValue` on the popup's box and `press` on its button. On Windows 10 22H2 and Windows 11, n=5 per popup, action and OS (40 calls): every call acted (the box set, the button clicked), the foreground never changed (polled every 2 ms), keyboard focus stayed in the user's box with no focus or activation event in the app, and all 960 typed keys reached the user's box (0 lost or redirected). So the rule admits these popups too, and the guard keeps refusing a popup once its owner is no longer in front.

Reading order: `in_front` and `ensure_pattern_safe` in `win32/window.rs`.

## Why

`ensure_pattern_safe` refuses UI Automation actions on WPF, XAML and Chromium windows that do not hold the foreground, because those actions bring the window to the front. It compared the foreground with the target's own top-level window, and a popup is its own top-level window, so an item of the open menu of the app in front was refused.

Decisions:
- A target counts as in front when it holds the foreground, or when it is a popup that never takes activation (`WS_POPUP` and `WS_EX_NOACTIVATE`) whose owner holds the foreground. Ownership alone is not enough: a modeless dialog the window owns can activate itself, so it stays refused, as does the menu once another window is in front.

Limits:
- In refuse mode the right-click that opens a WPF menu is itself refused (WPF drops posted clicks), so this changes the default mode's outcome, where the right-click runs in takeover.
- Measured on WPF only; a XAML or Chromium popup with the same styles is admitted by the same rule.

## Testing

TESTING

- `an_item_of_the_open_context_menu_of_the_window_in_front_is_pressed` (ignored; needs a signed-in desktop) opens a real WPF context menu and drives `Request::AxElementAt`, `Request::AxQuery` and `Request::AxPerform`: the menu item is pressed with its window in front and none of the app's windows gains or loses activation; a button in a modeless dialog the window owns, and the menu item once another window is in front, are refused with nothing run. Passes on Windows 10 22H2 and Windows 11; with the popup rule disabled (the target compared with the foreground's top-level window, as on `main`) it fails at the menu item's press with `BackgroundUnavailable`.
- `scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: pass, recorded for the final head.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
