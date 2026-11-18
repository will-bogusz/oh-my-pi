## What

When my agent typed a letter on a closed dropdown in a Mac app and then read the window, it saw the old option and kept trying other ways to pick it. Now that read waits until the dropdown shows the option the letter chose.

`press(letter)` then `ax()` in the same call: the chosen option showed 0 of 40 times before and 40 of 40 after, on AppKit pop-up buttons and SwiftUI pickers, in the background and in front.

| | before | after |
|---|---|---|
| `el.press("r")` on a focused native pop-up | returns about 0.5 s after the key | unchanged |
| `ax()`, `find`, `value()` of that pop-up right after | the option from before the key | waits until the option changes (about 0.5 s later), at most 1.5 s after the last key |
| a letter that matches nothing, or the current option | read at once | read about 1.0 s later, unchanged, no error |
| Limit: a pop-up with no readable value before the keys | read at once | waits the full 1.5 s after the last key (about 1.0 s after the call returns): with nothing read before, no change can end it early |
| `el.click({menu: ["Zulu"]})` on that pop-up 100 ms after the letter's call | reports ok, but the letter's late choice replaces Zulu (20 of 20) | waits for the letter's choice before taking input, then chooses Zulu (20 of 20) |
| Chrome and Electron `<select>`, other keys, reads of other elements and windows, typing into text fields | | unchanged |

## Why

AppKit pop-ups, SwiftUI menu pickers included, collect the letters and apply them together about 1 s after the last key (1001 to 1033 ms, 40 of 40). A web `<select>` applies each key at once.

The wait sits on the read, not on the key: blocking each key until its choice shows would make `m`, `e`, `d` sent as three calls into three separate searches. It applies by role, surface and key kind only: a character other than a space, with Shift at most, sent to an `AXPopUpButton` outside web content.

<details><summary>Shape of the change</summary>

- `macos/ax/type_ahead.rs`: before type-ahead keys, the target (the element, or the focused element for `win.press`) is read for role and value; once the keys went out the pop-up is marked with that value and a deadline 1.5 s after the last key. Marks live on the session's worker thread. A further letter to the same pop-up takes its own value-before and moves the deadline.
- `MacAx::props`, `walk_node` and `attributes` settle a marked element before reading it: poll its `AXValue` every 10 ms until it differs or the deadline passes, then clear the mark. A cancelled read keeps the mark.
- `macos/input.rs`: `window_chord` and `window_type` watch and mark; a key call that fails after its letters went out still marks.
- Nothing waits under the input lease, which keeps every other session's input out: `Worker::execute` settles the element of an element action other than keys and typing (`AxBackend::settle`) before it takes the lease, and a read made with the lease held returns at once and keeps the mark (`control::input_held`). Returning at once alone (no wait before the lease) left a menu click's item replaced by the letter's choice 20 of 20, as on main.
- Polling, not notifications: SwiftUI pickers post no `AXValueChanged` (0 of 20); AppKit posts one 2 to 11 ms after the change.
- What a letter does: one letter picks the first option starting with it; pressed again, a native pop-up stays there while a web select moves on to the next match. A whole title typed on a web select passes through the options on the way and fires the page's change handlers for each (typing "medium": Mediocre, then Medium); a native pop-up applies it once.

</details>

## Testing

macOS 26 VM: a fixture's AppKit pop-up and SwiftUI picker (Alpha, Bravo, Delta, Mediocre, Medium, Zulu), Chrome and Electron selects, the app's own log as truth; this PR and its base alternating, 10 tries per cell.

**press(letter) then ax() in the same cell: the control's line shows the new option**
| control | mode | base: shows new | fix: shows new | base press / ax ms | fix press / ax ms | errors |
|---|---|---|---|---|---|---|
| popup | bg | 0/10 | 10/10 | 579 / 11 | 581 / 495 |  |
| popup | fg | 0/10 | 10/10 | 588 / 18 | 586 / 488 |  |
| picker | bg | 0/10 | 10/10 | 586 / 17 | 589 / 491 |  |
| picker | fg | 0/10 | 10/10 | 587 / 18 | 589 / 492 |  |
| chrome | bg | 10/10 | 10/10 | 591 / 28 | 589 / 27 |  |
| chrome | fg | 10/10 | 10/10 | 74 / 13 | 76 / 14 |  |
| electron | bg | 10/10 | 10/10 | 601 / 21 | 599 / 22 |  |
| electron | fg | 10/10 | 10/10 | 77 / 10 | 75 / 10 |  |

**a letter, 1.2 s, a second letter, then ax(): shows the second choice**
| control | base | fix | base / fix ax ms |
|---|---|---|---|
| popup | 0/10 | 10/10 | 26 / 495 |
| picker | 0/10 | 10/10 | 20 / 500 |

**m, e, d as three calls and type("med"): where the control ends (app log), from Alpha**
| control | mode | how | base ends | fix ends | identical | base / fix changes per try | base / fix call ms |
|---|---|---|---|---|---|---|---|
| popup | bg | three | Mediocre 10/10 | Mediocre 10/10 | 10/10 | [2] / [2] | 1761 / 1763 |
| popup | bg | typed | Mediocre 10/10 | Mediocre 10/10 | 10/10 | [2] / [2] | 603 / 604 |
| popup | fg | three | Mediocre 10/10 | Mediocre 10/10 | 10/10 | [2] / [2] | 1768 / 1766 |
| popup | fg | typed | Mediocre 10/10 | Mediocre 10/10 | 10/10 | [2] / [2] | 616 / 613 |
| picker | bg | three | Mediocre 10/10 | Mediocre 10/10 | 10/10 | [1] / [1] | 1801 / 1801 |
| picker | bg | typed | Mediocre 10/10 | Mediocre 10/10 | 10/10 | [1] / [1] | 609 / 615 |
| picker | fg | three | Mediocre 10/10 | Mediocre 10/10 | 10/10 | [1] / [1] | 1801 / 1800 |
| picker | fg | typed | Mediocre 10/10 | Mediocre 10/10 | 10/10 | [1] / [1] | 617 / 616 |

**a letter, then el.click() 100 ms after its call, plain or with `menu: ["Zulu"]` (main / this PR, background)**
| control | click | ends on | call ok | call ms | input lease held, ms |
|---|---|---|---|---|---|
| popup | plain | letter 10 / letter 10 | 0 / 0 (menu closed, items listed) | 734 / 1113 | 731 / 726 |
| popup | menu Zulu | letter 10 / Zulu 10 | 10 / 10 | 733 / 1116 | 732 / 727 |
| picker | plain | letter 10 / letter 10 | 0 / 0 (menu closed, items listed) | 736 / 1117 | 735 / 727 |
| picker | menu Zulu | letter 10 / Zulu 10 | 10 / 10 | 734 / 1117 | 732 / 729 |

At 600 ms both end on Zulu 20 of 20 in the same time. Rerun against main: read 20 of 20 (Chrome, Electron 20 of 20 on both), `m`, `e`, `d` on Mediocre 20 of 20, letter, Tab and typing within 6 ms.

**a letter that changes nothing, then ax(): value shown, read time**
| control | mode | letter | base shown | fix shown | ok base / fix | base ax ms | fix ax ms (min-median-max) |
|---|---|---|---|---|---|---|---|
| popup | bg | nomatch | ['Bravo'] | ['Bravo'] | 10/10 / 10/10 | 14 | 992-996-999 |
| popup | bg | current | ['Bravo'] | ['Bravo'] | 10/10 / 10/10 | 19 | 994-997-1000 |
| popup | fg | nomatch | ['Bravo'] | ['Bravo'] | 10/10 / 10/10 | 21 | 994-998-1008 |
| popup | fg | current | ['Bravo'] | ['Bravo'] | 10/10 / 10/10 | 26 | 990-997-1003 |
| picker | bg | nomatch | ['Bravo'] | ['Bravo'] | 10/10 / 10/10 | 23 | 992-997-999 |
| picker | bg | current | ['Bravo'] | ['Bravo'] | 10/10 / 10/10 | 23 | 991-994-1001 |
| picker | fg | nomatch | ['Bravo'] | ['Bravo'] | 10/10 / 10/10 | 24 | 988-995-999 |
| picker | fg | current | ['Bravo'] | ['Bravo'] | 10/10 / 10/10 | 26 | 990-994-996 |
| chrome | bg | nomatch | ['Bravo'] | ['Bravo'] | 10/10 / 10/10 | 36 | 15-36-40 |
| chrome | bg | current | ['Bravo'] | ['Bravo'] | 10/10 / 10/10 | 36 | 23-35-42 |
| electron | bg | nomatch | ['Bravo'] | ['Bravo'] | 10/10 / 10/10 | 20 | 19-20-29 |
| electron | bg | current | ['Bravo'] | ['Bravo'] | 10/10 / 10/10 | 20 | 18-20-21 |

**time per call with no read of the pop-up after it (median ms, p10-p90)**
| mode | call | base | fix |
|---|---|---|---|
| bg | letter | 603 (594-613), n=10 | 609 (602-615), n=10 |
| bg | tab | 573 (570-585), n=10 | 576 (573-585), n=10 |
| bg | type16 | 548 (544-564), n=10 | 547 (539-562), n=10 |
| bg | other_window | 38 (27-40), n=10 | 34 (27-42), n=10 |
| fg | letter | 606 (600-617), n=10 | 610 (605-616), n=10 |
| fg | tab | 576 (568-580), n=10 | 573 (561-585), n=10 |
| fg | type16 | 544 (542-553), n=10 | 540 (536-560), n=10 |
| fg | other_window | 29 (25-32), n=10 | 28 (28-31), n=10 |

**type("<title>") to the closed, focused control, background, typist in front (fix)**
| control | title | n | ends on title | app changes per try | menus seen | typist keys lost | Probe lost key status | Probe still in front | call ms |
|---|---|---|---|---|---|---|---|---|---|
| popup | Medium | 5 | 5 | [2] | 0 | 0 of 100 | 0 | 5/5 | 668 |
| popup | Zulu | 5 | 5 | [2] | 0 | 0 of 100 | 0 | 5/5 | 628 |
| picker | Medium | 5 | 5 | [1] | 0 | 0 of 100 | 0 | 5/5 | 658 |
| picker | Zulu | 5 | 5 | [1] | 0 | 0 of 100 | 0 | 5/5 | 624 |

Unit tests: `cargo test -p omp-natives --lib -- type_ahead element_action refused_first` (waits with the lease free and the front app pinned; no wait under the lease; a refused first key marks nothing; web pop-ups unwatched).

The prompt line only describes what a letter does and points to `menu:`. In a 60-call sample (Haiku 5.5, GPT-6.1 Sol), an earlier wording advising typing moved Sol from the menu (13 of 15 on main) to typing (14 of 15), 4 of 15 wrong ("US Legal" typed as `USLegal`) against 0 on main.

Limits: Chrome and Electron in front can return about 20 ms after the key, and a read then was stale 1 to 2 of 10 on the base, an accessibility lag this change leaves alone. In an `ax()` of the whole window, elements read before the pop-up are read before its wait. An element click, `press()`, `perform()` or `setValue` on the pop-up within 1.5 s of the letter waits for its choice before taking the input lease: about 0.4 s more 100 ms after the letter's call, with the lease held for the click alone as on main.





