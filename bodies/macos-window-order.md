## What

A background `computer` click on macOS (pixel or element), a key into an app that needs the activating press, or an accessibility action that opens a pop-up's menu brought the target window in front of the window I was typing in and left it there until I moved it. Now my window goes back in front of the target within the call, and a takeover's hand-back does the same.

The input itself orders the window, so the guard repairs the order: while my app stays in front and I neither switch away nor come to the target, it raises my key window with `AXRaise` when the target is in front of it. It checks once per 10 ms poll, reading only the windows in front of my key window.

Only my key window is put back: `AXRaise` makes a window key, and when both were restored 12 of 520 keys I typed landed in the other one. Please don't restore both without a way to order a window that does not make it key.

## Why

Every background click left the target in front of my window, 10 of 10 tries on each toolkit, until I moved it. The repair adds about 5 ms of CPU per background call at 5, 60 or 150 windows and no WindowServer time above the noise. A first version that read the whole window list every millisecond cost 13 to 56 ms of CPU per call, more with more windows, and about as much again in WindowServer.

## Testing

macOS 26.5 VM, my one-window app in front, each target behind it, 10 tries per cell, builds interleaved:

| Target | Input | In front at 0.5 s and at the end: `main` → this head | Visible ms, median (max): 1 ms checks → this head | Call ms: `main` → this head |
|---|---|---|---|---|
| TextEdit | click / element click / key | 10, 10, 9 → 0, 0, 0 | 13 (29) → 31 (62) / 14 (66) → 49 (66) / 13 (28) → 22 (39) | 673 → 669 / 670 → 664 / 552 → 545 |
| Chrome | click / element click / key | 10, 10, 0 → 0, 0, 0 | 13 (28) → 13 (17) / 13 (15) → 13 (14) / - | 663 → 667 / 666 → 663 / 544 → 549 |
| LibreOffice Calc | click / element click / key | 10, 10, 9 → 0, 0, 0 | 13 (64) → 27 (65) / 13 (61) → 18 (70) / 13 (27) → 23 (28) | 676 → 672 / 669 → 667 / 541 → 546 |
| Electron app | click / element click / key | 10, 10, 9 → 0, 0, 0 | 12 (13) → 20 (63) / 13 (32) → 39 (63) / 13 (31) → 18 (28) | 667 → 666 / 658 → 668 / 548 → 547 |
| TextEdit, two windows of mine | click | 10 → 0 | 13 (28) → 13 (52) | - → 667 |
| TextEdit, through a takeover | click / drag / key | 10, 10, 0 → 0, 0, 0 | until the hand-back: 122 (159) → 115 (134) / 181 (222) → 179 (190) / - | 217 → 239 / 354 → 377 / 309 → 315 |

"1 ms checks" is the first version of this change. Every call succeeded; my key window was key at the end of all but one takeover key, read before its hand-back.

Cost per background call against `main`, TextEdit target, median of 10 (last row: the final head):

| Windows on screen | CPU added per call, click / key / drag, ms: first version → this head | Same, my window beside the target, this head | WindowServer CPU per click, ms: `main` / first version / this head |
|---|---|---|---|
| 5 | +16 / +13 / +18 → +6 / +4 / +6 | +6 / +5 / +6 | 68 / 135 / 83 |
| 60 | +27 / +23 / +27 → +5 / +5 / +5 | +6 / +5 / +4 | 91 / 175 / 96 |
| 150 | +41 / +38 / +42 → +7 / +4 / +5 | +6 / +4 / +5 | 139 / 276 / 148 |
| 150, final head | +54 / +48 / +56 → +6 / +4 / +5 | +5 / +4 / +5 | 147 / 281 / 150 |

Call time did not move (within 5 ms of `main`). Takeover clicks and drags take about 22 ms more for the raise after the hand-back; the hand-back's takeover situations match the first version (details).

Two windows of mine over the target, a background click while I type 52 keys (first version):

| | Keys landing in my other window | My key window key at the end | Order at the end, front to back |
|---|---|---|---|
| Before this change | 0 of 520 | 10 of 10 | target, my window, my window |
| This change | 0 of 520 | 10 of 10 | my key window, target, my other window |
| Restoring both windows (earlier revision) | 12 of 520, in 8 of 10 calls | 10 of 10 | both mine, then target |

Nothing raised, nothing changes: 250 background actions on six apps while a simulated user types 3,000 keys, first version → this head: p50 532 → 532 ms, none left in front, all 3,000 keys arrived on both (details).

`cargo test -p omp-natives --lib desktop` on macOS: 706 pass; the 2 failures, `desktop::macos::input` Unicode-typing tests, fail the same on `main`.

| Limit | Behaviour |
|---|---|
| Second window of mine the target covered | Stays behind the target (above) |
| Another background app's windows the target covered | Stay behind; `AXRaise` from outside that app leaves the order as it is |
| My key window behind another window of mine at entry | Nothing raised; target stays in front, as on `main` (10 of 10, no keys elsewhere, key window key at the end 10 of 10) |
| I bring another of my windows in front of my key window, pick one with a click, or click into a floating panel of my app, during the call | Left alone, also while the guard is looking my window up for the raise, except a choice made during the guard's last stacking read (about 0.15 ms, any window count) or before its `AXRaise` reaches my app: that gets one raise of my old key window |
| Target's own windows | Never moved: a sheet or menu it opened stays above its parent |
| Target keeps ordering itself in front | Raised at most three times during the call; the last poll raises once more and, if the target is still in front, the call throws `InputFailed` naming my window ("… the input was sent to the target"), after the usual "input may already have been delivered … inspect the desktop" |
| Key window accessibility no longer lists | Dropped silently |
| Target shows in front before the raise | 13 to 49 ms median by app and input (max 70), from the input to the next check plus macOS drawing the raise; 12 to 14 ms with the first version's 1 ms checks |
| Read-back of a raise | Runs under the input lease, as the guard does on `main`: at most 18 ms of scheduled waits during the action's 500 ms settle, and 40 ms on the last pass, which follows the settle and runs only when the target is in front then (the original entry: 40 ms on every pass) |
| Asking my app which window is key before a raise | Its focused window only, under the input lease, only when a raise is about to go out: at most 0.5 s if my app does not answer (517 ms measured against a stopped app); unreadable or no window means unknown, and nothing is raised |
| Takeover hand-back | Raises my key window once, unless I switched, clicked or used a shortcut after the hand-back's request, another window of mine was in front of the key window at entry, or the target is in my own app |

<details><summary>How the order was measured and why once a poll</summary>

What orders the window, measured per route on TextEdit, Chrome and LibreOffice: a click raises it whether or not the faked activation event or the activating press are sent; a key raises it only when the activating press is sent (never in Chrome); a pop-up opened by `AXPress` alone raises it too. So nothing short of not sending the input prevents it, and the guard repairs the order afterwards.

Where the time goes, on TextEdit, Chrome and Calc clicks with a 1 ms window sampler and the first version's 1 ms checks: the guard saw the raise within 1 ms, `AXRaise` took about 1 ms, and macOS then took 4 to 17 ms to show my window on top again. A checker sampling every 50 ms caught the excursion on 2 to 3 calls in 10 (a pop-up opened through accessibility: 2 to 6 in 10); with checks at the 10 ms poll it was 3 to 7 in 10.

How often to check, on the first version with the interval set by an experiment-only variable, TextEdit, 150 windows on screen, whole-list reads, 10 tries each:

| Check every | Reads per click / key | Process CPU per click / key, ms | Target visible after a click, ms median (max) | After a key | In front at the end |
|---|---|---|---|---|---|
| 1 ms | 189 / 169 | 74 / 64 | 19 (52) | 12 (32) | 0 of 10 |
| 5 ms | 77 / 66 | 46 / 37 | 38 (81) | 24 (29) | 0 of 10 |
| 10 ms | 47 / 39 | 37 / 30 | 28 (99) | 25 (35) | 0 of 10 |
| 20 ms | 29 / 24 | 29 / 21 | 90 (119) | 28 (45) | 0 of 10 |

The end state never depended on the interval: the last poll always checks and raises. 10 ms is the guard's own poll; 20 ms left a clicked target visible for 90 ms.

One read of the window list, in a Swift loop of 3,000 using the same CoreGraphics calls, and what the first version made of it per call (my window over the target):

| Windows on screen | Whole list: CPU / WindowServer per read, µs | Down to my key window (this head) | Reads per call, first version: click / key / drag | This head |
|---|---|---|---|---|
| 5 | 53 / 80 | 52 / 77 | 215 / 188 / 210 | 61 / 47 / 52 |
| 60 | 120 / 327 | 53 / 83 | 196 / 192 / 175 | 61 / 46 / 52 |
| 150 | 191 / 630 | 47 / 90 | 174 / 157 / 164 | 60 / 46 / 50 |

A whole-list read at 150 windows takes about 0.8 ms of wall time, so fewer of them fit in a call, which is why the first version's read count falls as its cost per call rises. One whole-list read per call remains, at entry, to record the order.

An earlier run of the cost cells, before rebasing onto `main` and before the 2 ms read-back, measured +32 to +52 ms of CPU per call for the first version and +3 to +7 ms for this head, with WindowServer per click 82 / 117 / 90 ms (`main` / first version / this head) at 5 windows and 143 / 263 / 147 at 150.

After a raise the guard reads the stacking back until the raise shows. Read back every 10 ms, half of TextEdit clicks (5 of 10) showed the target for about 77 ms: a click orders the target two or three times, and its second ordering landed before the first raise showed, so the pass waited out its readings with the target in front. Reading back every 2 ms for 20 ms removed that (max 70 ms). The last pass reads back for 40 ms: with 20 ms one takeover click in 10 failed with `InputFailed` although its raise held.

The hand-back's takeover situations, first version → this head, 10 tries each (I type 20 keys after the call; the ⌘-Tab race delays the hand-back's key request by 700 ms in an experiment-only build):

| Situation | My key window key at 0.5 s | My keys in the right window | Result | Call ms |
|---|---|---|---|---|
| Typing, one window | 10 → 10 | 10 → 10 | ok | 375 → 372 |
| Typing, two windows | 10 → 10 | 10 → 10 | ok | 365 → 372 |
| I switch windows | 10 → 10 | 10 → 10 | `InputFailed` (lost exact keyboard) 10 → 9, ok 0 → 1 | 583 → 589 |
| I switch apps | 0 → 0 | 1 → 0 | `UserIntervened` 10 → 10 | 5333 → 5335 |
| Chrome | 10 → 10 | 10 → 10 | ok | 360 → 359 |
| ⌘-Tab racing the key request | 1 → 1 | 1 → 1 | ok | 944 → 931 |

The guard keys on stacking, not overlap, so my window beside the target costs the same as over it. In the theft check, 44 and 40 targets that took the front were sent back (first version → this head); an earlier run of `main` against the first version gave p50 533 → 533 ms with 39 and 42. The check's per-action window misattributed the last key of each burst on the first version's arm (2,750 of 3,000 counted, all 3,000 in my app's log). `window_order`'s tests and `the_guard_asks_again_after_a_refusal_for_typing_but_not_for_a_switch` cover the planner, the read-back and the once-a-poll passes.

I switch to my other window 10 to 55 ms into a background click, 20 tries, previous head → this head: the window I picked is key at the end 17 → 20 and in front of my first window 17 → 19; the one left behind it while key is unexplained (1 of 20). The target stays above the window I picked in all 20 on both: a pick of mine ends the keeping.

</details>

## Risk

Review first: `keep` in `window_order.rs`, `stacked_down_to` in `capture.rs` and the order pass in `guard_focus`. A switch of mine is honoured unless it lands during the last stacking read or before `AXRaise` reaches my app.

