## What

A background `computer` click on macOS (pixel or element), a key into an app that needs the activating press, or an accessibility action that opens a pop-up's menu brought the target window in front of the window I was typing in and left it there until I moved it. Now that window goes back in front of the target during the call. The target still shows in front for about 15 ms (11 to 16 ms median per cell) before macOS draws mine back; that part is not removed.

Only my key window is put back. If a second window of mine was also in front of the target, it stays behind the target after the call. That is deliberate: `AXRaise` on a window that is not key makes it key until the key one is raised after it, and on a VM 12 of 520 keys typed through such a call landed in that second window (8 of 10 calls), against none with the key window alone. Please don't "fix" it back without a way to order a window that does not make it key.

What orders the window is the input itself, measured per route on TextEdit, Chrome and LibreOffice: a click raises the window whether or not the faked activation event or the activating press are sent; a key raises it only when the activating press is sent (not in Chrome); a pop-up opened by `AXPress` alone raises it too. So the guard repairs order rather than preventing it: at entry it records whether my key window is in front of the target, and while my app is in front and I have neither switched away nor come to the target, it checks the stacking every millisecond and raises my key window (`AXRaise`) once the target, or a window that appeared during the call outside my app, is in front of it. It does nothing once I have brought another of my windows in front of my key window myself, and never moves the target's own windows (a sheet or menu it opened stays above its parent) or another background app's. A target that keeps ordering itself in front is raised over three times at most; if it is still in front at the end, the call fails with `InputFailed` naming my window, as other restoration failures do.

## Testing

On a macOS 26.5 VM with my one-window app in front, each target behind it, 10 tries per cell, the build before this change against this one, interleaved:

| Target | Input | Target in front at 0.5 s and at the end: before → after | Visible ms, median (max) | Call ms, before → after |
|---|---|---|---|---|
| TextEdit | click / element click / key | 10, 10, 9 → 0, 0, 0 | 14 (16) / 14 (61) / 14 (19) | 673 → 660 / 670 → 657 / 552 → 547 |
| Chrome | click / element click / key | 10, 10, 0 → 0, 0, 0 | 11 (16) / 16 (18) / - | 663 → 665 / 666 → 669 / 544 → 549 |
| LibreOffice Calc | click / element click / key | 10, 10, 9 → 0, 0, 0 | 15 (22) / 15 (18) / 16 (22) | 676 → 668 / 669 → 661 / 541 → 551 |
| Electron app | click / element click / key | 10, 10, 9 → 0, 0, 0 | 16 (30) / 12 (23) / 15 (20) | 667 → 665 / 658 → 669 / 548 → 548 |

Every call returned success on both builds. These were measured on the revision before key-window-only restore, which behaves the same with one window of mine; on this head TextEdit click, Chrome click, Calc key and Electron element click were measured again with the same result (0 of 10 in front at the end each, call time within 10 ms).

With two windows of mine over the target, the front one key, a background click on the target while I type 52 keys through the call (10 tries each):

| | Keys landing in my other window | My key window key at the end | Order at the end, front to back |
|---|---|---|---|
| Before this change | 0 of 520 | 10 of 10 | target, my window, my window |
| This change | 0 of 520 | 10 of 10 | my key window, target, my other window |
| Restoring both windows (earlier revision) | 12 of 520, in 8 of 10 calls | 10 of 10 | both mine, then target |

When my key window was behind another window of mine (the front one not key), nothing is raised and the order stays as both builds leave it, target in front: 10 of 10, no keys elsewhere, my key window key at the end 10 of 10.

Where the time goes, on TextEdit, Chrome and Calc clicks with a 1 ms sampler: the guard sees the raise within 1 ms, `AXRaise` takes about 1 ms, and macOS then takes 4 to 17 ms to show my window on top again. A checker sampling every 50 ms catches the excursion on about 2 to 3 calls in 10 (a pop-up opened through accessibility: 2 to 6 in 10); with the guard checking at its 10 ms poll it was 3 to 7 in 10. The 1 ms checks cost about 50 ms of CPU per call; call time did not move.

Nothing raised, nothing changes: 250 background actions on six apps, with a simulated user typing 3,000 keys into their app, p50 533 → 533 ms per action, 39 and 42 targets that took the front sent back on the two builds with none left in front, and all 3,000 keys arrived on both. `cargo test -p pi-natives -- window_order the_guard` covers the planner (`to_raise`, `keep`) and the guard's order passes.

## Risk

Review first: `EntryOrder::to_raise` and `keep` in `window_order.rs`, and the order checks in `guard_focus`. While the order is kept, every guarded call reads the window list every millisecond. A second window of mine that the target covered stays behind it (above). The guard asks whether it still keeps the order right before each raise, after reading the stacking, so a switch of mine during that read is honoured; one landing in the microseconds between that check and `AXRaise` still gets one raise of my key window, and the next poll leaves things alone. Needs #19208, which this is built on.
