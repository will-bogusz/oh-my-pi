## What

I made `scroll` on a WPF list scroll it when the app is in front and stop reporting success when nothing moved; behind other windows it now refuses and names what works.

WPF list, `scroll(x, y, { dy: 3 })` (one notch): in front, scrolled 0/10 → 10/10; behind other windows, a false `ok` 30/30 → refused 29/29 with nothing sent (Windows 10 22H2 and Windows 11, n=5 per cell).

> **Windows context.** WPF draws a whole window in one HWND and drops posted and sent `WM_MOUSEWHEEL` (0 of 30 each, below). UI Automation's `ScrollPattern` moves a WPF scroll viewer but brings the window to the front; `ScrollItemPattern.ScrollIntoView` does not.

| WPF list, `scroll` one notch | v19.0.1 | this branch |
|---|---|---|
| in front, Windows 10 22H2 | false `ok` 5/5 | scrolled **5/5** |
| in front, Windows 11 | false `ok` 5/5 | scrolled **5/5** |
| behind (beside, covered, user typing), Windows 10 22H2 | false `ok` 15/15 | refused **15/15**, nothing sent |
| behind (beside, covered, user typing), Windows 11 | false `ok` 15/15 | refused **14/14**, nothing sent (one trial void: the app had exited before the call) |

Reading order: `pointer` and `wpf_scroll_behind` in `win32/input.rs`; `Win32Ax::scroll_at_point`, `Axis::sample` and `changed_from`, then `scroll_into_view_shown`, in `win32/ax.rs`.

## Why

`delivery.rs` already refused posted clicks and text to WPF but not the wheel, so a dropped wheel was reported as delivered.

Decisions:
- In front, the scroll goes to the innermost scroll container under the point that can move on a requested axis, by the user's wheel setting; an axis it cannot scroll is left out.
- One `ScrollPattern` step at a time, each checked against the reading before it and never past the run's end; a step that resized the list counts only if the row under the point moved; a shortfall is `InputFailed` saying where the list stopped.
- Behind other windows the scroll throws `Unsupported` naming what works: bring the window forward, `takeover: true` (the real wheel), or `scrollintoview` on the item. Not `BackgroundUnavailable`, which the tool reruns in takeover: with the user's window beside the app, 4 of 20 such takeovers saw Windows refuse the activation, then bring the app forward anyway (an existing takeover defect).
- A hosted native window (`WindowsFormsHost`) under the point keeps the posted wheel, which reaches it.
- `scrollintoview` on a WPF element runs behind other windows (30/30, foreground left alone); it fails if the element stays off screen and is `AxUnconfirmed` if the run ends first.

Limits:
- In front with no scroll container under the point, the default mode takes over.
- WinUI 3 and other XAML hosts: not measured, unchanged.

## Testing

`wpf_scrolls_go_through_ui_automation_in_front_and_report_what_moved` (ignored; needs a signed-in desktop) drives a real WPF list beside a hosted WinForms list. Behind: `scrollintoview` scrolls without the foreground, the hosted list takes the posted wheel, an explicit takeover sends the real wheel, and a background wheel is `Unsupported` with nothing sent. In front: one notch moves by the wheel setting; a scroll past the end stops there; a list that grows is not counted; late answers are unconfirmed; losing the foreground stops it. It passes at the head on Windows 10 22H2 and Windows 11 and fails on both with the fix reverted.

<details><summary>Builds and runs behind the numbers</summary>

- Table: release v19.0.1 (`f40f335845f`) against an addon of this branch at `6d125a6d870`, whose production code is the head's (later commits change only the unit test), 1 round of 5 per cell, interleaved, default mode (Windows 10 08:50-08:56Z, Windows 11 09:04-09:10Z).
- The 4 of 20 late activations and the 30 of 30 `ScrollIntoView` trials come from the previous build (`9c9c7f3d02d`, same routes).
- Explicit `takeover: true` through the harness could not be shown: Windows refused the harness's activation on both builds (5 of 5 each, "Windows refused to activate the exact target window"), so the unit test carries that case.
- Runs from Windows 11 between 07:39 and 08:12Z and from Windows 10 between 07:44 and 08:25Z were discarded: other input ran on those guests.

</details>

<details><summary>Route probes without omp (Windows 10 22H2)</summary>

| target | route | cond | n | acted | took fg | z changed | observer fg left user | keys lost (typing) | errors |
|---|---|---|---|---|---|---|---|---|---|
| wpf-list | move-wheel-root | covered | 10 | 0/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | move-wheel-root | side | 10 | 0/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | move-wheel-root | typing | 10 | 0/10 | 0/10 | 0/10 | 0/10 | 0 |  |
| wpf-list | posted-wheel-root | covered | 10 | 0/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | posted-wheel-root | side | 10 | 0/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | posted-wheel-root | typing | 10 | 0/10 | 0/10 | 0/10 | 0/10 | 0 |  |
| wpf-list | sent-wheel-root | covered | 10 | 0/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | sent-wheel-root | side | 10 | 0/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | sent-wheel-root | typing | 10 | 0/10 | 0/10 | 0/10 | 0/10 | 0 |  |
| wpf-list | uia-scroll | covered | 10 | 10/10 | 10/10 | 10/10 | 10/10 | - |  |
| wpf-list | uia-scroll | side | 10 | 8/10 | 8/10 | 8/10 | 8/10 | - | probe error x2 |
| wpf-list | uia-scroll | typing | 10 | 0/10 | 10/10 | 10/10 | 10/10 | 247 |  |
| wpf-list | uia-scrollitem | covered | 10 | 10/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | uia-scrollitem | side | 10 | 10/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | uia-scrollitem | typing | 10 | 10/10 | 0/10 | 0/10 | 0/10 | 0 |  |

Wheel routes are posted or sent to the list's window from outside it, or a move then wheel; `uia-scroll` is one `ScrollPattern.Scroll` (SmallIncrement), `uia-scrollitem` is `ScrollItemPattern.ScrollIntoView` of a row below the view. Typing rows: the user types into their own window during the call; `uia-scroll` brought the window forward every time and lost 247 of the user's keys over 10 trials.

</details>

`scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: pass, recorded for the head.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
