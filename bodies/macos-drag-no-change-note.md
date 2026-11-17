## What

A middle-button drag I sent to an app that ignored it came back as done, so nothing told me it had moved nothing.

On macOS, a background drag that starts on no slider, scroll bar or splitter, such as a middle-button drag, was sent and returned done with nothing read. In a Cua Driver Bench re-measure, a background middle-button drag in BenchLab's reorder task (MB-09, background) returned success and moved nothing. Such a drag now reads what accessibility shows at its two ends before and after, and when nothing there changed its result carries a note saying so and how long after the release its last read ended.

| Background middle-button drag, macOS 26.5 VM (drags per arm: previous / this) | This entry's previous head (`341a3c341f6`, watch under the lease) | This change (`f6c3de1bd99`, before restacking on #19195's current head) |
|---|---|---|
| On "Static", which ignores it (10 / 5 drags) | 0 moved, call 1324-1401 ms | 0 moved, call 1252-1319 ms |
| On "Box", which it moves (10 / 5) | all moved, 684-701 ms | all moved, 691-705 ms |
| Another session's hover call during a "Static" drag, longest (alone it takes about 620 ms) (5 / 3) | 1.86-1.92 s | 1.29-1.33 s |
| Same during a drag on "Slow", which answers every AX getter 25 ms late (5 / 3) | 5.0 s, each `InputBusy` after its 5 s wait | 1.84-1.87 s |
| The drag call on "Slow" | 6.9-8.8 s | 1.9-2.4 s |

## Why

Before posting, the drag reads the elements under its start and end (role, title or description, value, frame), within 500 ms. Once the rest of the call is done and the input lease is released, it reads them again, and hit-tests both points again, every 40 ms for 560 ms, each request given only the time left of 700 ms, so other sessions' input does not wait for it.

The call still returns either way: a drawing surface changes nothing accessibility shows, so no change is not proof of failure. A change, a read the deadline cuts short, or a cancel ends the watch with no note. Nothing new is sent, no drag is refused, and drags on tracked controls keep #19195's checks.

## Testing

On that VM, a small AppKit window stood behind the person's front window, with a button "Box" that a middle-button drag moves, a label "Static" that ignores one, and a view "Slow" whose accessibility getters each sleep 25 ms. In the hover rows a second OMP process moves the pointer in an empty corner of the same window in a loop, and its longest call overlapping the drag shows how long the drag kept the input lease. The harness keeps a call's return value, not its note, so the note's text is pinned by unit tests; the watch shows in call time, about 560 ms more on "Static" than on "Box".

`cargo test -p pi-natives --lib -- desktop::macos desktop::tests` passes on macOS on #19195's current head (399). The fake-clock test of `nothing_changed` pins reads 40 ms apart from the watch's start, even 650 ms after the release, and a slow reader cut off at 700 ms with no note; the others pin the early stop and the unreadable ends (no wait). Clippy and rustfmt are clean on macOS, Linux and Windows.

## Risk

Review first: `DragEnds::read`, `nothing_changed`, and where `Worker::execute` runs the watch after dropping the lease. Under the lease the drag adds only the read before posting, at most 500 ms: each AX request's timeout is the time left, so the last one ends by then. The watch holds no lease and makes the call at most 700 ms longer. A drag whose only effect is away from its two ends, or shows only after the watch, gets the note although something changed; the note says what was read and where, so it does not claim more. Another session's input during the watch can change what it reads, which only withholds the note. Stacked on #19195.

---
- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
