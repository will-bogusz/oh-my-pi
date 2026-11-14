## What

When my agent typed a letter on a closed dropdown in a Mac app and then read the window, it saw the old option and went on trying other ways to pick it. Now that read waits until the dropdown shows the option the letter chose.

`press(letter)` then `ax()` in the same call: the chosen option showed 0 of 40 times before and 40 of 40 after, on AppKit pop-up buttons and SwiftUI pickers, in the background and in front. The key call itself takes as long as before.

| | before | after |
|---|---|---|
| `el.press("r")` on a focused native pop-up | returns about 0.5 s after the key | unchanged |
| `ax()`, `find`, `value()` of that pop-up right after | the option from before the key | waits until the option changes (about 0.5 s later), at most 1.5 s after the last key |
| a letter that matches nothing, or the current option | read at once | read about 1.0 s later, unchanged, no error |
| Chrome and Electron `<select>`, other keys, reads of other elements and windows, typing into text fields | | unchanged |

## Why

A focused pop-up chooses the first option that starts with the letters typed on it. AppKit pop-ups, SwiftUI menu pickers included, collect the letters and apply them together about 1 s after the last key (1001 to 1033 ms, 40 of 40). The accessibility value is live, so the read was right, only early. A web `<select>` applies each key at once.

The wait sits on the read, not on the key: blocking each key until its choice shows would make `m`, `e`, `d` sent as three calls into three separate searches. Where the pop-up ends is unchanged (below). It applies by role and key kind only: a character other than a space, with Shift at most, sent to an `AXPopUpButton`.

<details><summary>Shape of the change</summary>

- `macos/ax/type_ahead.rs`: before type-ahead keys, the target (the element, or the focused element for `win.press`) is read for role and value; once the keys went out the pop-up is marked with that value and a deadline 1.5 s after the last key. Marks live on the session's worker thread. A further letter to the same pop-up takes its own value-before and moves the deadline.
- `MacAx::props`, `walk_node` and `attributes` settle a marked element before reading it: poll its `AXValue` every 10 ms until it differs or the deadline passes, then clear the mark. A cancelled read keeps the mark.
- `macos/input.rs`: `window_chord` and `window_type` watch and mark; a key call that fails after its letters went out still marks.
- Polling, not notifications: SwiftUI pickers post no `AXValueChanged` (0 of 20); AppKit posts one 2 to 11 ms after the change.
- What a letter does: one letter picks the first option starting with it; pressed again, a native pop-up stays there while a web select moves on to the next match. A whole title typed on a web select passes through the options on the way and fires the page's change handlers for each (typing "medium": Mediocre, then Medium); a native pop-up applies it once.

</details>

## Testing

Trials in a macOS 26 VM: a fixture app with an AppKit pop-up and a SwiftUI picker (Alpha, Bravo, Delta, Mediocre, Medium, Zulu), Chrome and Electron selects, the app's own selection log as truth; this PR and its base alternating per try, 10 tries per cell.

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

**a letter, 1.2 s with no read, a second letter, then ax(): shows the second choice**
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

**a letter that changes nothing, then ax(): value shown, errors, time of the read**
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

**type("<full title>") to the closed, focused control in the background, typist in front (fix)**
| control | title | n | ends on title | app changes per try | menus seen | typist keys lost | Probe lost key status | Probe still in front | call ms |
|---|---|---|---|---|---|---|---|---|---|
| popup | Medium | 5 | 5 | [2] | 0 | 0 of 100 | 0 | 5/5 | 668 |
| popup | Zulu | 5 | 5 | [2] | 0 | 0 of 100 | 0 | 5/5 | 628 |
| picker | Medium | 5 | 5 | [1] | 0 | 0 of 100 | 0 | 5/5 | 658 |
| picker | Zulu | 5 | 5 | [1] | 0 | 0 of 100 | 0 | 5/5 | 624 |

Unit tests: `cargo test -p pi-natives --lib type_ahead` (a mark counts from the last key and keeps the latest value-before; a read of the marked pop-up waits for its change, another element's read passes, an unchanged pop-up is read at the deadline, a cancel keeps the mark).

Limits: Chrome and Electron in front can return about 20 ms after the key, and a read then was stale 1 to 2 of 10 on the base, an accessibility lag of 8 to 26 ms this change leaves alone. In an `ax()` of the whole window, elements read before the pop-up are read before its wait. A click on the marked pop-up within 1.5 s waits for the choice first, since it reads the element's frame.

