## What

On macOS, a background drag that starts on no slider, scroll bar or splitter, such as a middle-button drag, was sent and returned done with nothing read. When the application ignored it, the result was the same as for a drag that worked. In a Cua Driver Bench re-measure, a background middle-button drag in BenchLab's reorder task (MB-09, background) returned success and moved nothing.

Such a drag now reads the elements under its start and end before posting: role, title or description, value, and frame. After the release it reads them again, and hit-tests both points again, every 40 ms for up to 560 ms. If nothing there changed, the result carries a note that nothing readable changed and the application may have ignored the drag. The call still returns: a drawing surface changes nothing accessibility shows, so no change is not proof of failure. The first change seen ends the wait. Nothing new is sent, no drag is refused, and drags on tracked controls keep #19195's checks.

## Testing

On a macOS 26.5 VM, a small AppKit window stood behind my app's front window. The window has a button "Box" that a middle-button drag moves and a label "Static" that ignores one. Each cell is 10 background middle-button drags of 120 px, with #19195's head interleaved against this one:

| Drag starts on | Moved (both builds) | Returned done (both builds) | This change: branch | Call ms, median: before → after |
|---|---|---|---|---|
| "Static" (the app ignores it) | 0 of 10 | 10 of 10 | nothing changed, so the note | 685 → 1329 |
| "Box" (the app moves it) | 10 of 10 | 10 of 10 | the change seen at once, no note | 694 → 686 |

The VM harness keeps only a call's return value, not its output lines, so the note's text is checked by unit tests, as in #19195. The VM shows which branch ran through the time it took: about 645 ms more only where nothing changed.

`cargo test -p pi-natives --lib -- desktop::macos` passes on macOS. `nothing_changed`'s whole-wait test fails when it is made to report a change every time; the others pin the early stop, the unreadable ends (no wait) and both note texts. Clippy and rustfmt are clean on macOS, Linux and Windows.

## Risk

Review first: `DragEnds::read` and `nothing_changed`. A drag whose only effect is away from its two ends, or arrives more than 560 ms after the release, gets the note although something changed; the note says what was read and where, so it does not claim more. A drag that changes nothing readable now takes up to 560 ms longer; one that changes something stops waiting at the first change. Stacked on #19195.

---
- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
