## What

I wanted background clicks to stop killing the page they click in Chrome and Electron.

A background left click from the computer tool killed the page in Electron 45.3.0 on every click, and in Chrome whenever the click changed the URL in place (`history.pushState`), while the tool reported the click as done. Integer field 58 of a Quartz event is its timestamp, and the left-click route wrote a "click group" id there: the sub-second part of the wall clock. Every left click reached the app dated within the first second after boot, older than the page itself, and the renderer aborted with a trap (exit 5); for a navigating click trycua/cua#7292 traced it to the soft-navigation check in Chromium's `soft_navigation_heuristics.cc`.

The click group is gone. Nothing read field 58 as an id: the intervention taps read fields 40-42, double clicks pair on the click-state field, and every other routed pointer event already overwrote it with `stamp_now`. The left-click route now stamps each event with the current time like the rest. Hover, right and middle clicks, drags and holds send the same bytes as before; the wheel event still carries Quartz's 0, now said in a comment.

## Why

The wrong id has been written since v18.3.3. In Electron 45.3.0 the page was lost on every background left click, and the agent carried on as if the click had worked. That is the one Electron version measured: six weeks of real use on apps built with older Electron did not surface it, and why is not known, so this claims nothing for other Electron versions.

## Testing

Background `win.click` with TextEdit in front, macOS 26.5.2 VM, Electron 45.3.0 and the Google Chrome installed in that VM (its build was not recorded), addon swapped into `@oh-my-pi/pi-coding-agent@18.18.7`. Page died after the click:

| page | main | this branch |
|---|---|---|
| Chrome, click calls `pushState` | 30/30 | 0/30 |
| Electron 45.3.0, click calls `pushState` | 30/30 (renderer exit 5) | 0/30 |
| Safari, click calls `pushState` | 0/30 | 0/30 |
| Chrome, click changes nothing | 0/10 | 0/10 |
| Electron, click changes nothing | 10/10 | 0/10 |

In every cell the click landed and TextEdit stayed in front. On main the page read `event.timeStamp === 0` in all three browsers; here it reads the real time. Double clicks still pair on this branch: Chrome saw `detail` 1 then 2 (5/5), an AppKit view `clickCount` 1 then 2 (5/5). `background_left_clicks_carry_the_time_they_are_posted` fails on main (stamps under one second of uptime) and passes here.

Controls: on main, an untouched page read alive and a page whose renderer was killed read dead, on every target. On this branch two controls misfired: Chrome's kill control read alive (the kill hit no renderer that time) and Safari's untouched control read dead (the page was still loading), so those two checks were not shown both ways here.

Not tested: the scroll-wheel event, which still goes out with timestamp 0.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
